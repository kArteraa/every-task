import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync } from 'node:child_process';
import { Writable } from 'node:stream';
import test from 'node:test';
import { createSnapshot, calculateRelease, drainQueue } from '../scripts/release/queue.mjs';

test('integration: release queue drains every merge including arrivals during publication', async () => {
  const history = ['a', 'b'];
  const published = new Set();
  const operations = {
    readHead: async () => history.at(-1),
    listCommits: async head => history.slice(0, history.indexOf(head) + 1),
    isPublished: async sha => published.has(sha),
    release: async sha => {
      published.add(sha);
      if (sha === 'a') history.push('c');
    }
  };
  assert.deepEqual(await drainQueue(operations), ['a', 'b', 'c']);
  assert.deepEqual(await drainQueue(operations), []);
});

test('integration: release queue resumes after a failure without repeating completed releases', async () => {
  const published = new Set();
  let fail = true;
  const operations = {
    readHead: async () => 'b', listCommits: async () => ['a', 'b'], isPublished: async sha => published.has(sha),
    release: async sha => {
      if (sha === 'b' && fail) throw new Error('Upload interrupted');
      published.add(sha);
    }
  };
  await assert.rejects(drainQueue(operations), /interrupted/);
  fail = false;
  assert.deepEqual(await drainQueue(operations), ['b']);
});

test('e2e: semantic-release plans both pending SHAs independently of an advanced main', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'etask-queue-test-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const git = args => execFileSync('git', args, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] }).trim();
  git(['init', '-b', 'main']);
  git(['config', 'user.name', 'Release Fixture']);
  git(['config', 'user.email', 'fixture@example.invalid']);
  await writeFile(path.join(root, 'source.txt'), 'baseline\n');
  git(['add', 'source.txt']);
  git(['commit', '-m', 'chore: baseline']);
  git(['tag', 'v0.1.0']);
  await writeFile(path.join(root, 'source.txt'), 'first\n');
  git(['commit', '-am', 'feat: first change']);
  const first = git(['rev-parse', 'HEAD']);
  await writeFile(path.join(root, 'source.txt'), 'second\n');
  git(['commit', '-am', 'fix: second change']);
  const second = git(['rev-parse', 'HEAD']);
  const silent = new Writable({ write(chunk, encoding, callback) { callback(); } });
  for (const [sha, version, content] of [[first, '0.2.0', 'first\n'], [second, '0.2.1', 'second\n']]) {
    const snapshot = await createSnapshot(root, sha);
    t.after(() => snapshot.cleanup());
    const release = await calculateRelease(snapshot, 'owner/repo', { stdout: silent, stderr: silent });
    assert.equal(release.version, version);
    assert.equal(release.gitHead, sha);
    assert.equal(await readFile(path.join(snapshot.cwd, 'source.txt'), 'utf8'), content);
    git(['tag', release.gitTag, sha]);
  }
  assert.equal(git(['rev-parse', 'HEAD']), second);
  assert.equal(git(['status', '--porcelain']), '');
});
