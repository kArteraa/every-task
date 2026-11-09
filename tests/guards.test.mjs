import assert from 'node:assert/strict';
import { mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import test from 'node:test';
import Ajv from 'ajv';
import { inside, validateProfile } from '../skills/etask/tools/project.mjs';
import { replaceFile } from '../skills/etask/tools/storage.mjs';
import { readPr } from '../skills/etask/tools/git.mjs';
import { commandAvailable } from '../skills/etask/tools/diagnostics.mjs';

test('unit: doctor detects unavailable commands without executing them', async () => {
  assert.equal(await commandAvailable('nonexistent-etask-executable --version', '.', { PATH: '' }), false);
  assert.equal(await commandAvailable(`"${process.execPath}" -e "process.exit(9)"`, '.'), true);
});

test('unit: PR validation checks exact marker, configured base and explicit number through gh', () => {
  const project = { root: '.', config: { workflow: { repository: 'owner/project', integrationBranch: 'integration' } } };
  const pr = { number: 12, body: 'etask-id: ET-12\n', baseRefName: 'integration', state: 'MERGED' };
  const runner = (program, args) => {
    assert.equal(program, 'gh');
    assert.ok(args.includes('owner/project'));
    return JSON.stringify(pr);
  };
  assert.equal(readPr(project, 'ET-12', 12, runner).state, 'MERGED');
  assert.throws(() => readPr(project, 'ET-1', 12, runner), /marker/);
  assert.throws(() => readPr(project, 'ET-12', NaN, runner), /number/);
  pr.baseRefName = 'main';
  assert.throws(() => readPr(project, 'ET-12', 12, runner), /base/);
});

test('integration: optimistic writes preserve a concurrent user edit', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'etask-storage-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  const filename = path.join(root, 'file.md');
  await writeFile(filename, 'User edit\n');
  await assert.rejects(replaceFile(filename, 'Agent edit\n', 'Earlier text\n'), /Concurrent edit/);
  assert.equal(await readFile(filename, 'utf8'), 'User edit\n');
});

test('integration: junctions and traversal cannot escape the target project', async t => {
  const root = await mkdtemp(path.join(tmpdir(), 'etask-path-'));
  const outside = await mkdtemp(path.join(tmpdir(), 'etask-outside-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  t.after(() => rm(outside, { recursive: true, force: true }));
  await symlink(outside, path.join(root, 'escape'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(inside(root, 'escape/new.md'), /escapes/);
  await assert.rejects(inside(root, '../outside.md'), /escapes/);
});

test('unit: runtime validation agrees with JSON Schema on malformed profiles', async () => {
  const schema = JSON.parse(await readFile(new URL('../skills/etask/assets/config-v2.schema.json', import.meta.url)));
  const example = JSON.parse(await readFile(new URL('../skills/etask/assets/config.local.example.json', import.meta.url)));
  const validate = new Ajv({ strict: true }).compile(schema);
  const variants = [example, null, {}, { ...example, version: 3 }, { ...example, secret: 'token' },
    { ...example, workflow: { ...example.workflow, mode: 'gitlab' } },
    { ...example, paths: { ...example.paths, backlog: '../secret' } }];
  for (const config of variants) assert.equal(validateProfile(config).length === 0, validate(config));
  assert.notDeepEqual(validateProfile({ ...example, paths: { ...example.paths, board: '.git/config' } }), []);
});

test('unit: document aliases cannot collide or target internal directories', async () => {
  const example = JSON.parse(await readFile(new URL('../skills/etask/assets/config.local.example.json', import.meta.url)));
  for (const board of ['./docs/BACKLOG.md', 'docs/./BACKLOG.md', './docs/./BACKLOG.md']) {
    const config = { ...example, paths: { ...example.paths, backlog: 'docs/BACKLOG.md', board } };
    assert.ok(validateProfile(config).some(error => error.includes('distinct')), board);
  }
  for (const directory of ['.etask', '.git', 'node_modules', 'dist', '.superpowers']) {
    const config = { ...example, paths: { ...example.paths, board: `././${directory}/./file.md` } };
    assert.ok(validateProfile(config).some(error => error.includes('internal')), directory);
  }
});
