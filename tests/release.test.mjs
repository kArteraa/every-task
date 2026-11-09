import assert from 'node:assert/strict';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import semanticRelease from 'semantic-release';
import { analyzeCommits, generateNotes, publish } from '../scripts/release/plugin.mjs';

const commits = (...messages) => messages.map((message, index) => ({ message, hash: String(index + 1).padStart(40, 'a') }));

test('unit: Conventional Commits choose highest semantic release level', () => {
  for (const [messages, expected] of [
    [['fix: correct result'], 'patch'], [['docs: explain setup'], 'patch'],
    [['feat: add board', 'fix: correct result'], 'minor'], [['feat!: change contract'], 'major'],
    [['feat: replace schema\n\nBREAKING CHANGE: migration is required'], 'major']
  ]) assert.equal(analyzeCommits({}, { commits: commits(...messages) }), expected);
  assert.throws(() => analyzeCommits({}, { commits: commits('Random change') }), /Conventional/);
});

test('unit: release notes include every conventional change and exclude merge wrappers', () => {
  const notes = generateNotes({ repository: 'owner/repo' }, {
    commits: commits('Merge pull request #3 from owner/dev', 'feat: add board', 'test: cover resume'),
    nextRelease: { version: '0.2.0' }
  });
  assert.match(notes, /0\.2\.0/);
  assert.match(notes, /add board/);
  assert.match(notes, /cover resume/);
  assert.doesNotMatch(notes, /Merge pull request/);
});

test('integration: publishing uses gh and resumes a draft without creating duplicates', () => {
  for (const state of ['missing', 'draft', 'published']) {
    const calls = [];
    const execute = args => {
      calls.push(args);
      if (args[0] === 'api') return JSON.stringify([state === 'missing' ? [] : [{ tag_name: 'v0.2.0', draft: state === 'draft', html_url: 'https://example.invalid/release' }]]);
      return '';
    };
    publish({ repository: 'owner/repo' }, { cwd: '.', nextRelease: { version: '0.2.0', gitTag: 'v0.2.0' } }, execute);
    assert.equal(calls.some(args => args[1] === 'create'), state === 'missing');
    assert.equal(calls.some(args => args[1] === 'upload'), state !== 'published');
    if (state !== 'published') {
      const upload = calls.find(args => args[1] === 'upload');
      assert.equal(upload.filter(value => value.endsWith('.zip')).length, 3);
      assert.ok(upload.some(value => value.endsWith('CHANGELOG.md')));
      assert.ok(calls.at(-1).includes('--draft=false'));
    }
  }
});

test('e2e: actual semantic-release dry-run computes version against a local Git remote', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'etask-release-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const remote = path.join(root, 'remote.git');
  const work = path.join(root, 'work');
  const git = (args, cwd = root) => execFileSync('git', args, { cwd, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '--bare', remote]);
  git(['clone', remote, work]);
  git(['switch', '-c', 'main'], work);
  git(['config', 'user.name', 'Release Fixture'], work);
  git(['config', 'user.email', 'fixture@example.invalid'], work);
  await writeFile(path.join(work, 'fixture.txt'), 'baseline\n');
  git(['add', 'fixture.txt'], work);
  git(['commit', '-m', 'chore: baseline'], work);
  git(['tag', 'v0.1.0'], work);
  await writeFile(path.join(work, 'fixture.txt'), 'feature\n');
  git(['commit', '-am', 'feat: add workflow'], work);
  git(['push', 'origin', 'main', '--tags'], work);
  git(['symbolic-ref', 'HEAD', 'refs/heads/main'], remote);
  const stream = new Writable({ write(chunk, encoding, callback) { callback(); } });
  const env = { ...process.env, GIT_TERMINAL_PROMPT: '0' };
  for (const key of ['GITHUB_ACTIONS', 'GITHUB_REF', 'GITHUB_SHA', 'GITHUB_TOKEN', 'GH_TOKEN', 'CI']) delete env[key];
  const result = await semanticRelease({
    branches: ['main'], repositoryUrl: remote.replaceAll('\\', '/'), tagFormat: 'v${version}', dryRun: true, ci: false,
    plugins: [[fileURLToPath(new URL('../scripts/release/plugin.mjs', import.meta.url)), { repository: 'owner/repo' }]]
  }, { cwd: work, env, stdout: stream, stderr: stream });
  assert.equal(result.nextRelease.version, '0.2.0');
  assert.match(result.nextRelease.notes, /add workflow/);
  assert.equal(git(['tag', '--list', 'v0.2.0'], work), '');
});
