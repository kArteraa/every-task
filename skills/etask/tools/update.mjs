import { readFile, writeFile, mkdir, mkdtemp, realpath, readdir, lstat, rm } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import path from 'node:path';
import { inside } from './project.mjs';
import { readArchive } from './update-archive.mjs';
import { manifests, repository, compareVersions, selectRelease, verifyPackage, releaseCommit } from './update-release.mjs';
import { executeHost, hostAdapter } from './update-hosts.mjs';

function contains(parent, child) {
  const relative = path.relative(parent, child);
  return relative === '' || (!relative.startsWith(`..${path.sep}`) && relative !== '..' && !path.isAbsolute(relative));
}

async function copyPackage(source, target) {
  await mkdir(target);
  async function copy(directory, destination) {
    for (const entry of await readdir(directory, { withFileTypes: true })) {
      if (['.git', 'node_modules', 'dist', '.superpowers', '.etask'].includes(entry.name)) continue;
      if (entry.isSymbolicLink() || !entry.isFile() && !entry.isDirectory()) throw new Error('Backup cannot contain symlinks or special files');
      const output = path.join(destination, entry.name);
      if (entry.isDirectory()) { await mkdir(output); await copy(path.join(directory, entry.name), output); }
      else await writeFile(output, await readFile(path.join(directory, entry.name)), { flag: 'wx' });
    }
  }
  await copy(source, target);
}

async function canonicalStore(directory) {
  const resolved = path.resolve(directory);
  await inside(path.parse(resolved).root, path.relative(path.parse(resolved).root, resolved));
  const missing = [];
  for (let ancestor = resolved; ; ancestor = path.dirname(ancestor)) {
    try { return path.join(await realpath(ancestor), ...missing); }
    catch (error) {
      if (error.code !== 'ENOENT' || path.dirname(ancestor) === ancestor) throw error;
      missing.unshift(path.basename(ancestor));
    }
  }
}

async function destination(options) {
  if (!options.installedRoot || !options.store || !path.isAbsolute(options.installedRoot) || !path.isAbsolute(options.store)) throw new Error('Explicit absolute --installed-root and --store required');
  const installed = await realpath(options.installedRoot);
  const cwd = await realpath(options.cwd || process.cwd());
  const store = await canonicalStore(options.store);
  if ([installed, cwd].some(root => contains(root, store) || contains(store, root))) throw new Error('Update store must be separate from the project and installed package');
  for (let ancestor = store; ; ancestor = path.dirname(ancestor)) {
    try { await lstat(path.join(ancestor, '.git')); throw new Error('Update store cannot be inside a Git checkout'); }
    catch (error) { if (error.code !== 'ENOENT') throw error; }
    if (path.dirname(ancestor) === ancestor) break;
  }
  return { installed, store, cwd };
}

export async function updatePlugin(options, execute = executeHost) {
  const { host, scope } = options;
  const adapter = hostAdapter(host, scope, execute, options.cwd);
  const { installed, store, cwd } = await destination(options);
  const previous = await adapter.inspect();
  const manifest = JSON.parse(await readFile(await inside(installed, manifests[host]), 'utf8'));
  if (manifest.name !== 'etask' || manifest.version !== previous.version) throw new Error('Installed package differs from host registration');
  const release = selectRelease(JSON.parse(await execute('gh', ['api', `repos/${repository}/releases/latest`])), host);
  const comparison = compareVersions(previous.version, release.version);
  if (comparison >= 0) return { status: comparison === 0 ? 'current' : 'newer', version: previous.version, latest: release.version, url: release.url };
  const registration = await adapter.registration();
  if (host !== 'gemini') {
    const marketRoot = host === 'codex' ? registration.root : registration.installLocation;
    if (!marketRoot || !path.isAbsolute(marketRoot)) throw new Error('Marketplace root unavailable');
    const actualRoot = await realpath(marketRoot);
    if (contains(actualRoot, store) || contains(store, actualRoot)) throw new Error('Update store overlaps the registered marketplace');
    const market = JSON.parse(await readFile(await inside(actualRoot, host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json'), 'utf8'));
    if (market.name !== 'every-task' || market.plugins?.length !== 1 || market.plugins[0].name !== 'etask') throw new Error('Refusing to replace a shared marketplace');
  }
  await mkdir(store, { recursive: true });
  const lock = path.join(store, 'update.lock');
  await writeFile(lock, JSON.stringify({ pid: process.pid, host }), { flag: 'wx' });
  let journal;
  let record;
  try {
    const work = await mkdtemp(path.join(store, `${host}-${release.version}-`));
    const download = path.join(work, 'download');
    const target = path.join(work, 'package');
    const backup = path.join(work, 'previous');
    await mkdir(download);
    const commit = await releaseCommit(execute, release.tag);
    await execute('gh', ['release', 'download', release.tag, '--repo', repository, '--pattern', release.asset.name, '--dir', download]);
    const bytes = await readFile(await inside(download, release.asset.name));
    if (bytes.length !== release.asset.size || 'sha256:' + createHash('sha256').update(bytes).digest('hex') !== release.asset.digest) throw new Error('Release checksum/digest mismatch');
    const files = readArchive(bytes);
    verifyPackage(files, host, release.version, commit);
    await mkdir(target);
    for (const [relative, content] of Object.entries(files)) {
      const filename = await inside(target, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content, { flag: 'wx' });
    }
    await copyPackage(installed, backup);
    journal = path.join(work, 'update.json');
    record = { phase: 'prepared', host, scope, cwd, previous, registration, installed, backup, target, version: release.version, commit, url: release.url };
    await writeFile(journal, JSON.stringify(record, null, 2) + '\n', { flag: 'wx' });
    const current = await adapter.inspect();
    if (JSON.stringify(current) !== JSON.stringify(previous)) throw new Error('Installation changed during preparation');
    if (JSON.stringify(await adapter.registration()) !== JSON.stringify(registration)) throw new Error('Marketplace changed during preparation');
    record.phase = 'installing';
    await writeFile(journal, JSON.stringify(record, null, 2) + '\n');
    await adapter.install(target);
    const actual = await adapter.inspect();
    if (actual.version !== release.version) throw new Error('Host did not activate the expected installed version');
    record.phase = 'complete';
    await writeFile(journal, JSON.stringify(record, null, 2) + '\n');
    return { status: 'updated', previousVersion: previous.version, version: actual.version, url: release.url, backup, journal, restartRequired: true };
  } catch (error) {
    if (journal) {
      record.phase = 'failed';
      record.error = error.message;
      try { await writeFile(journal, JSON.stringify(record, null, 2) + '\n'); }
      catch (journalError) { record.error += `; journal write failed: ${journalError.message}`; }
      throw new Error(`${record.error}. Recovery journal: ${journal}; previous package: ${record.backup}`);
    }
    throw error;
  } finally { await rm(lock); }
}

export async function updateFromArgs(args) {
  const fields = { '--host': 'host', '--scope': 'scope', '--installed-root': 'installedRoot', '--store': 'store' };
  const options = {};
  for (let index = 0; index < args.length; index += 2) {
    const field = Object.hasOwn(fields, args[index]) ? fields[args[index]] : undefined;
    if (!field || options[field] !== undefined || !args[index + 1] || args[index + 1].startsWith('--')) throw new Error('Usage: update --host HOST --scope SCOPE --installed-root PATH --store PATH');
    options[field] = args[index + 1];
  }
  return updatePlugin(options);
}
