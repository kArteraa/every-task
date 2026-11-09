import { execFileSync } from 'node:child_process';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import semanticRelease from 'semantic-release';

export async function drainQueue({ readHead, listCommits, isPublished, release }) {
  const processed = [];
  let head = await readHead();
  while (true) {
    for (const sha of await listCommits(head)) {
      if (await isPublished(sha)) continue;
      await release(sha);
      processed.push(sha);
    }
    const next = await readHead();
    if (next === head) return processed;
    head = next;
  }
}

export async function createSnapshot(source, sha) {
  if (!/^[a-f0-9]{40}$/.test(sha)) throw new Error('Exact release SHA required');
  const parent = path.resolve(tmpdir());
  const directory = await mkdtemp(path.join(parent, 'etask-release-snapshot-'));
  const cwd = path.join(directory, 'source');
  const remote = path.join(directory, 'remote.git');
  const cleanup = async () => {
    if (path.dirname(path.resolve(directory)) !== parent || !path.basename(directory).startsWith('etask-release-snapshot-')) throw new Error('Invalid snapshot cleanup path');
    await rm(directory, { recursive: true, force: true });
  };
  const git = (args, working = directory) => execFileSync('git', args, { cwd: working, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  try {
    git(['init', cwd]);
    git(['config', 'core.autocrlf', 'false'], cwd);
    git(['fetch', '--no-tags', path.resolve(source), sha, 'refs/tags/*:refs/tags/*'], cwd);
    git(['switch', '-c', 'release-snapshot', sha], cwd);
    git(['clone', '--bare', '--no-hardlinks', cwd, remote]);
    return { cwd, remote, sha, cleanup };
  } catch (error) {
    await cleanup();
    throw error;
  }
}

export async function calculateRelease(snapshot, repository, streams = {}) {
  const env = Object.fromEntries(Object.entries(process.env).filter(([key]) => !key.startsWith('GITHUB_') && !['GH_TOKEN', 'CI'].includes(key)));
  const result = await semanticRelease({
    branches: ['release-snapshot'], repositoryUrl: snapshot.remote.replaceAll('\\', '/'), tagFormat: 'v${version}',
    dryRun: true, ci: false,
    plugins: [[fileURLToPath(new URL('./plugin.mjs', import.meta.url)), { repository }]]
  }, { cwd: snapshot.cwd, env, ...streams });
  if (!result || result.nextRelease.gitHead !== snapshot.sha) throw new Error('Snapshot did not produce the expected release');
  return result.nextRelease;
}
