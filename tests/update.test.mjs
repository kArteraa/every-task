import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, writeFile, rm, symlink, readdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { zipSync, strToU8 } from 'fflate';
import { readArchive } from '../skills/etask/tools/update-archive.mjs';
import { compareVersions, selectRelease, verifyPackage } from '../skills/etask/tools/update-release.mjs';
import { updatePlugin } from '../skills/etask/tools/update.mjs';
import { hostAdapter } from '../skills/etask/tools/update-hosts.mjs';

const sha = 'a'.repeat(40);
const manifests = { codex: '.codex-plugin/plugin.json', claude: '.claude-plugin/plugin.json', gemini: 'gemini-extension.json' };
function payload(host, version = '1.1.0') {
  const files = {
    [manifests[host]]: JSON.stringify({ name: 'etask', version }),
    'RELEASE.json': JSON.stringify({ version, commit: sha }),
    'CHANGELOG.md': '# Release\n',
    'skills/etask/SKILL.md': '# etask\n',
    'skills/etask/tools/etask.mjs': 'process.exit(0);\n'
  };
  if (host !== 'gemini') files[host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json'] = JSON.stringify({ name: 'every-task', plugins: [{ name: 'etask', source: host === 'codex' ? { source: 'local', path: './' } : './', ...(host === 'claude' ? { version } : {}) }] });
  return Object.fromEntries(Object.entries(files).map(([name, text]) => [name, strToU8(text)]));
}
function releaseFor(host, bytes, version = '1.1.0') {
  return { tag_name: `v${version}`, draft: false, prerelease: false, html_url: `https://github.com/kArteraa/every-task/releases/tag/v${version}`,
    assets: [{ name: `etask-${version}-${host}.zip`, size: bytes.length, digest: 'sha256:' + createHash('sha256').update(bytes).digest('hex') }] };
}
async function fixture(t, host = 'codex', current = '1.0.0', failure) {
  const root = await mkdtemp(path.join(tmpdir(), 'etask-update-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const installed = path.join(root, 'installed');
  const project = path.join(root, 'project');
  await mkdir(project);
  await writeFile(path.join(project, 'keep.txt'), 'Project stays intact\n');
  for (const [relative, bytes] of Object.entries(payload(host, current))) {
    const file = path.join(installed, relative);
    await mkdir(path.dirname(file), { recursive: true });
    await writeFile(file, bytes);
  }
  const bytes = zipSync(payload(host));
  const release = releaseFor(host, bytes);
  const calls = [];
  let version = current;
  let source = installed;
  const execute = async (program, args) => {
    calls.push([program, ...args]);
    if (program === 'gh') {
      if (args[0] === 'api') return JSON.stringify(args[1].endsWith('/latest') ? release : { object: { type: 'commit', sha } });
      if (failure === 'download') throw new Error('Download failed');
      await writeFile(path.join(args[args.indexOf('--dir') + 1], release.assets[0].name), bytes);
      return '';
    }
    if (args.includes('list')) {
      if (args.includes('marketplace')) return JSON.stringify(host === 'codex' ? { marketplaces: [{ name: 'every-task', root: source }] } : [{ name: 'every-task', source: 'directory', installLocation: source }]);
      if (host === 'codex') return JSON.stringify({ installed: [{ pluginId: 'etask@every-task', version, installed: true, enabled: true }] });
      if (host === 'claude') return JSON.stringify([{ id: 'etask@every-task', version, scope: 'user', enabled: true, installPath: installed }]);
      return JSON.stringify([{ name: 'etask', version, path: installed, isActive: true }]);
    }
    if (failure === 'install') throw new Error('Native install failed');
    if (args.includes('marketplace') && args.includes('add')) source = args[args.indexOf('add') + 1];
    if (!args.includes('marketplace') && (args.includes('add') || args.includes('update') || args.includes('install'))) version = failure === 'verify' ? current : '1.1.0';
    return '';
  };
  return { root, installed, project, bytes, release, calls, options: { host, scope: 'user', installedRoot: installed, store: path.join(root, 'releases'), cwd: project }, execute };
}

test('unit: update compares stable versions numerically and rejects ambiguous versions', () => {
  assert.equal(compareVersions('1.10.0', '1.9.9'), 1);
  assert.equal(compareVersions('1.0.0', '1.0.0'), 0);
  assert.equal(compareVersions('0.1.0', '1.0.0'), -1);
  for (const value of ['1.0.0-dev', 'v1.0.0', '01.0.0', 'unknown']) assert.throws(() => compareVersions(value, '1.0.0'), /version/i);
});

test('unit: update requires stable release, exact asset and checksum', () => {
  const bytes = zipSync(payload('codex'));
  const release = releaseFor('codex', bytes);
  assert.equal(selectRelease(release, 'codex').version, '1.1.0');
  for (const changed of [{ ...release, draft: true }, { ...release, prerelease: true }, { ...release, assets: [] }, { ...release, assets: [...release.assets, ...release.assets] }, { ...release, assets: [{ ...release.assets[0], digest: null }] }]) assert.throws(() => selectRelease(changed, 'codex'));
});

test('unit: release ZIP validates contents, integrity and filesystem-safe paths', () => {
  const bytes = zipSync(payload('codex'));
  assert.ok(readArchive(bytes)['RELEASE.json']);
  for (const name of ['../outside', '/absolute', 'a\\b', 'a/../b', 'a:stream', 'CON', 'a./file', 'a /file', 'a\u0000b']) assert.throws(() => readArchive(zipSync({ [name]: strToU8('bad') })), /path/i, name);
  assert.throws(() => readArchive(zipSync({ A: strToU8('a'), a: strToU8('b') })), /duplicate/i);
  assert.throws(() => readArchive(zipSync({ a: strToU8('a'), 'a/b': strToU8('b') })), /path|collision/i);
  const corrupt = Buffer.from(bytes);
  corrupt[40] ^= 1;
  assert.throws(() => readArchive(corrupt));
  assert.throws(() => verifyPackage(readArchive(bytes), 'codex', '1.1.0', 'b'.repeat(40)), /commit/i);
});

for (const host of ['codex', 'claude', 'gemini']) test(`e2e: ${host} update stages verified package and preserves old installation and project`, async t => {
  const f = await fixture(t, host);
  const result = await updatePlugin(f.options, f.execute);
  assert.equal(result.status, 'updated');
  assert.equal(result.version, '1.1.0');
  assert.equal(JSON.parse(await readFile(path.join(f.installed, manifests[host]))).version, '1.0.0');
  assert.equal(await readFile(path.join(f.project, 'keep.txt'), 'utf8'), 'Project stays intact\n');
  assert.equal(JSON.parse(await readFile(path.join(result.backup, manifests[host]))).version, '1.0.0');
  assert.equal(JSON.parse(await readFile(result.journal)).phase, 'complete');
  assert.ok(f.calls.every(call => call[0] === 'gh' || !call.some(value => /^https?:/.test(value))));
});

test('integration: current or newer installation does not download or mutate', async t => {
  for (const version of ['1.1.0', '2.0.0']) {
    const f = await fixture(t, 'codex', version);
    const result = await updatePlugin(f.options, f.execute);
    assert.equal(result.status, version === '1.1.0' ? 'current' : 'newer');
    assert.ok(!f.calls.some(call => call.includes('download') || call.includes('remove') || call.includes('add')));
    await assert.rejects(readFile(path.join(f.options.store, 'update.lock')), { code: 'ENOENT' });
  }
});

test('integration: download or integrity failures never change host registration', async t => {
  for (const failure of ['download', 'digest']) {
    const f = await fixture(t, 'codex', '1.0.0', failure);
    if (failure === 'digest') f.release.assets[0].digest = 'sha256:' + '0'.repeat(64);
    await assert.rejects(updatePlugin(f.options, f.execute), /download|digest|checksum/i);
    assert.ok(!f.calls.some(call => call.includes('remove') || call.includes('add')));
  }
});

test('integration: native failure and stale post-install version report recovery instead of success', async t => {
  for (const failure of ['install', 'verify']) {
    const f = await fixture(t, 'codex', '1.0.0', failure);
    await assert.rejects(updatePlugin(f.options, f.execute), /recovery|journal/i);
    assert.equal(JSON.parse(await readFile(path.join(f.installed, manifests.codex))).version, '1.0.0');
  }
});

test('integration: update refuses a destination inside the project or old installation', async t => {
  const f = await fixture(t);
  for (const parent of [f.project, f.installed]) await assert.rejects(updatePlugin({ ...f.options, store: path.join(parent, 'updates') }, f.execute), /store|destination/i);
  assert.equal(f.calls.length, 0);
});

test('e2e: update dispatch does not require a project profile and rejects missing host', () => {
  const cli = fileURLToPath(new URL('../skills/etask/tools/etask.mjs', import.meta.url));
  const result = spawnSync(process.execPath, [cli, 'update'], { encoding: 'utf8', cwd: tmpdir() });
  assert.notEqual(result.status, 0);
  assert.match(result.stderr, /host/i);
  assert.doesNotMatch(result.stderr, /--root|config.json/);
});

test('unit: ZIP links, encryption, oversized entries and truncation are rejected', () => {
  const original = Buffer.from(zipSync({ 'safe.txt': strToU8('safe') }));
  const central = original.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
  for (const change of [bytes => bytes.writeUInt32LE(0xa000 * 65536, central + 38), bytes => bytes.writeUInt16LE(1, central + 8), bytes => bytes.writeUInt32LE(60 * 1024 * 1024, central + 24)]) {
    const modified = Buffer.from(original);
    change(modified);
    assert.throws(() => readArchive(modified));
  }
  assert.throws(() => readArchive(original.subarray(0, original.length - 1)));
});

test('integration: host selection rejects missing, duplicate, disabled and wrong-project installs', async () => {
  const item = { pluginId: 'etask@every-task', installed: true, enabled: true, version: '1.0.0' };
  for (const installed of [[], [item, item], [{ ...item, enabled: false }]]) {
    await assert.rejects(hostAdapter('codex', 'user', async () => JSON.stringify({ installed })).inspect());
  }
  await assert.rejects(hostAdapter('claude', 'project', async () => JSON.stringify([{ id: 'etask@every-task', scope: 'project', enabled: true, projectPath: path.resolve('another-project') }])).inspect(), /another project/);
  assert.throws(() => hostAdapter('codex', 'project', () => {}), /scope/);
});

test('integration: update refuses linked stores and concurrent updates without touching registration', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.root, 'linked-target'));
  await symlink(path.join(f.root, 'linked-target'), f.options.store, process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(updatePlugin(f.options, f.execute), /symlink|junction/i);
  assert.equal(f.calls.length, 0);
  const store = path.join(f.root, 'locked');
  await mkdir(store);
  await writeFile(path.join(store, 'update.lock'), 'Existing process');
  await assert.rejects(updatePlugin({ ...f.options, store }, f.execute), { code: 'EEXIST' });
  assert.equal(await readFile(path.join(store, 'update.lock'), 'utf8'), 'Existing process');
  assert.ok(!f.calls.some(call => call.includes('remove')));
});

test('integration: stale verification preserves a readable recovery journal and backup', async t => {
  const f = await fixture(t, 'codex', '1.0.0', 'verify');
  await assert.rejects(updatePlugin(f.options, f.execute), /Recovery journal/);
  const [directory] = await readdir(f.options.store);
  const journal = JSON.parse(await readFile(path.join(f.options.store, directory, 'update.json')));
  assert.equal(journal.phase, 'failed');
  assert.equal(journal.previous.version, '1.0.0');
  assert.ok(journal.registration);
  assert.equal(JSON.parse(await readFile(path.join(journal.backup, manifests.codex))).version, '1.0.0');
});

test('integration: a legacy installed cache containing Git metadata can be backed up without copying it', async t => {
  const f = await fixture(t);
  await mkdir(path.join(f.installed, '.git'));
  await writeFile(path.join(f.installed, '.git/config'), 'Legacy metadata\n');
  const result = await updatePlugin(f.options, f.execute);
  assert.equal(result.status, 'updated');
  assert.equal(await readFile(path.join(f.installed, '.git/config'), 'utf8'), 'Legacy metadata\n');
  await assert.rejects(readFile(path.join(result.backup, '.git/config')), { code: 'ENOENT' });
});
