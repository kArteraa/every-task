import { execFileSync } from 'node:child_process';
import semanticRelease from 'semantic-release';
import { generateNotes, prepare, publish } from './plugin.mjs';

const repository = 'kArteraa/every-task';
const baseline = '1414dbd38d6cfdb4f268707c13b0b4b03e991ae2';
const cwd = process.cwd();
const command = (program, args) => execFileSync(program, args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
const git = args => command('git', args);

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.GITHUB_REPOSITORY !== repository || process.env.GITHUB_REF !== 'refs/heads/main') {
  throw new Error('Publishing is restricted to this repository main workflow');
}
const head = git(['rev-parse', 'HEAD']);
process.env.GIT_AUTHOR_NAME = git(['show', '-s', '--format=%an', head]);
process.env.GIT_AUTHOR_EMAIL = git(['show', '-s', '--format=%ae', head]);
process.env.GIT_COMMITTER_NAME = process.env.GIT_AUTHOR_NAME;
process.env.GIT_COMMITTER_EMAIL = process.env.GIT_AUTHOR_EMAIL;
if (head !== process.env.GITHUB_SHA) throw new Error('Checkout differs from release event');
const prs = JSON.parse(command('gh', ['api', `repos/${repository}/commits/${head}/pulls`]));
if (!prs.some(pr => pr.merged_at && pr.merge_commit_sha === head && pr.base.ref === 'main' && pr.head.ref === 'dev' && pr.head.repo?.full_name === repository)) {
  throw new Error('Release must originate from a merged dev -> main PR');
}
const existingTags = git(['tag', '--list', 'v*']).split('\n').filter(Boolean);
if (!existingTags.length) {
  git(['merge-base', '--is-ancestor', baseline, head]);
  git(['tag', 'v0.1.0', baseline]);
  git(['push', 'origin', 'refs/tags/v0.1.0']);
}
const tag = git(['tag', '--points-at', head]).split('\n').find(value => /^v\d+\.\d+\.\d+$/.test(value));
if (tag) {
  const previous = git(['describe', '--tags', '--match', 'v[0-9]*', '--abbrev=0', `${head}^`]);
  const hashes = git(['rev-list', `${previous}..${head}`]).split('\n').filter(Boolean);
  const commits = hashes.map(hash => ({ hash, message: git(['show', '-s', '--format=%B', hash]) }));
  const nextRelease = { version: tag.slice(1), gitTag: tag, gitHead: head };
  nextRelease.notes = generateNotes({ repository }, { commits, nextRelease });
  const context = { cwd, env: process.env, nextRelease };
  await prepare({ repository }, context);
  publish({ repository }, context);
} else {
  const result = await semanticRelease({ branches: ['main'], repositoryUrl: `https://github.com/${repository}.git`,
    tagFormat: 'v${version}', plugins: [['./scripts/release/plugin.mjs', { repository }]] });
  if (!result) throw new Error('Main merge did not produce a release; inspect branch/head and rerun this event');
}
