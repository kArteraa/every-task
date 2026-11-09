import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import { generateNotes, publish } from './plugin.mjs';
import { createSnapshot, calculateRelease, drainQueue } from './queue.mjs';

const repository = 'kArteraa/every-task';
const baseline = '1414dbd38d6cfdb4f268707c13b0b4b03e991ae2';
const cwd = process.cwd();
const command = (program, args, directory = cwd) => execFileSync(program, args, {
  cwd: directory, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], maxBuffer: 16 * 1024 * 1024
}).trim();
const git = args => command('git', args);
const gh = args => command('gh', args);

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Publishing is restricted to this repository main workflow');
}
if (git(['rev-parse', 'HEAD']) !== process.env.GITHUB_SHA) throw new Error('Checkout differs from release event');
if (!process.env.npm_execpath) throw new Error('Run through npm run release');
const published = new Set();
function tagFor(sha) {
  const tags = git(['tag', '--points-at', sha]).split('\n').filter(value => /^v\d+\.\d+\.\d+$/.test(value));
  if (tags.length > 1) throw new Error('Multiple release tags on the same commit');
  return tags[0];
}
function verifyMerge(sha) {
  const prs = JSON.parse(gh(['api', `repos/${repository}/commits/${sha}/pulls`, '--paginate', '--slurp'])).flat();
  if (!prs.some(pr => pr.merged_at && pr.merge_commit_sha === sha && pr.base.ref === 'main' && pr.head.ref === 'dev' && pr.head.repo?.full_name === repository)) {
    throw new Error(`Release ${sha} must originate from a merged dev -> main PR`);
  }
}

await drainQueue({
  readHead: async () => {
    git(['fetch', 'origin', 'refs/heads/main:refs/remotes/origin/main', '--tags']);
    const head = git(['rev-parse', 'refs/remotes/origin/main']);
    git(['merge-base', '--is-ancestor', baseline, head]);
    const releases = JSON.parse(gh(['api', `repos/${repository}/releases`, '--paginate', '--slurp'])).flat();
    for (const release of releases) if (!release.draft) published.add(release.tag_name);
    if (!git(['tag', '--list', 'v*'])) {
      git(['tag', 'v0.1.0', baseline]);
      git(['push', 'origin', 'refs/tags/v0.1.0']);
    }
    return head;
  },
  listCommits: async head => git(['rev-list', '--first-parent', '--reverse', `${baseline}..${head}`]).split('\n').filter(Boolean),
  isPublished: async sha => published.has(tagFor(sha)),
  release: async sha => {
    verifyMerge(sha);
    const snapshot = await createSnapshot(cwd, sha);
    try {
      const existing = tagFor(sha);
      let nextRelease;
      if (existing) {
        const previous = git(['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', `${sha}^`]);
        const commits = git(['rev-list', `${previous}..${sha}`]).split('\n').filter(Boolean).map(hash => ({ hash, message: git(['show', '-s', '--format=%B', hash]) }));
        nextRelease = { version: existing.slice(1), gitTag: existing, gitHead: sha };
        nextRelease.notes = generateNotes({ repository }, { commits, nextRelease });
      } else nextRelease = await calculateRelease(snapshot, repository);
      for (const args of [['ci', '--ignore-scripts'], ['test'], ['run', 'lint'], ['run', 'build']]) {
        console.log(command(process.execPath, [process.env.npm_execpath, ...args], snapshot.cwd));
      }
      const { buildPackages } = await import(pathToFileURL(path.join(snapshot.cwd, 'scripts/build.mjs')).href);
      const output = path.join(snapshot.cwd, 'dist', nextRelease.version);
      await mkdir(output, { recursive: true });
      await buildPackages(snapshot.cwd, output, { version: nextRelease.version, notes: nextRelease.notes, commit: sha });
      await writeFile(path.join(output, 'CHANGELOG.md'), nextRelease.notes);
      if (!existing) git(['tag', nextRelease.gitTag, sha]);
      git(['push', 'origin', `refs/tags/${nextRelease.gitTag}`]);
      publish({ repository }, { cwd: snapshot.cwd, env: process.env, nextRelease });
      published.add(nextRelease.gitTag);
    } finally {
      await snapshot.cleanup();
    }
  }
});
