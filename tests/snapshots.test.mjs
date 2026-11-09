import assert from 'node:assert/strict';
import { execFileSync, spawnSync } from 'node:child_process';
import { mkdtemp, mkdir, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { fingerprint } from '../skills/etask/tools/storage.mjs';

const cli = fileURLToPath(new URL('../skills/etask/tools/etask.mjs', import.meta.url));
const ignored = ['Library', 'Temp', 'Logs', 'UserSettings'].map(name => `/Unity/TestGame/${name}/`).join('\n') + '\n';
const task = '# Tasks\n\n## ET-1 — Snapshot fixture\n\n- Тип — fix\n- Исполнитель — tester\n- Состояние — in-progress\n- Зависимости — нет\n\nVerify snapshots.\n\n- [x] Fixture ready.\n';
const git = (root, ...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000, stdio: 'pipe' });

async function put(root, relative, content) {
  const filename = path.join(root, relative);
  await mkdir(path.dirname(filename), { recursive: true });
  await writeFile(filename, content);
}

async function fixture(t, initialize = true) {
  const temporary = path.resolve(tmpdir());
  const root = await mkdtemp(path.join(temporary, 'etask-snapshot-'));
  assert.equal(path.dirname(root), temporary);
  t.after(() => rm(root, { recursive: true, force: true }));
  const config = {
    version: 2,
    project: { name: 'Snapshot fixture', goal: 'PROJECT.md', owner: 'tester' },
    workflow: { mode: 'github', git: true, integrationBranch: 'dev', productionBranch: 'main', repository: 'fixture/snapshots' },
    paths: { backlog: 'BACKLOG.md', board: 'BOARD.md', queue: null, decisions: 'DECISIONS.md', manualChecks: 'MANUAL.md' },
    checks: Object.fromEntries(['test', 'unit', 'integration', 'e2e', 'lint', 'build'].map(kind => [kind, { command: 'node cache-writer.mjs', cwd: '.' }])),
    reviewers: [], jira: { enabled: false }
  };
  await put(root, '.etask/config.json', JSON.stringify(config));
  await put(root, '.gitignore', ignored + '.etask/state.json\n.etask/runs/\n');
  await put(root, 'PROJECT.md', '# Goal\nKeep evidence tied to source files.\n');
  await put(root, 'BACKLOG.md', task);
  await put(root, 'DECISIONS.md', '# Decisions\nUse GitHub.\n');
  await put(root, 'MANUAL.md', '# Checks\n');
  await put(root, 'Unity/TestGame/Assets/Door.cs', 'class Door {}\n');
  await put(root, 'Unity/TestGame/Assets/Door.cs.meta', 'guid: source-guid\n');
  await put(root, 'cache-writer.mjs', "import { mkdirSync, writeFileSync } from 'node:fs';\nmkdirSync('Unity/TestGame/Library', { recursive: true });\nwriteFileSync('Unity/TestGame/Library/cache.bin', String(Date.now()));\n");
  if (initialize) {
    git(root, 'init', '--initial-branch=fix/snapshot-fixture');
    git(root, 'config', 'user.name', 'Snapshot Test');
    git(root, 'config', 'user.email', 'snapshot@example.invalid');
    git(root, 'remote', 'add', 'origin', 'https://github.com/fixture/snapshots.git');
    git(root, 'add', '.');
    git(root, 'commit', '-m', 'test: fixture');
  }
  return { root, config };
}

test('integration: GitHub snapshots ignore generated Unity caches listed in gitignore', async t => {
  const project = await fixture(t);
  const before = await fingerprint(project);
  for (const directory of ['Library', 'Temp', 'Logs', 'UserSettings']) {
    await put(project.root, `Unity/TestGame/${directory}/generated.bin`, 'first import');
    assert.equal(await fingerprint(project), before, directory);
    await put(project.root, `Unity/TestGame/${directory}/generated.bin`, 'second import');
    assert.equal(await fingerprint(project), before, directory);
  }
});

test('integration: tracked source stays visible even when an ignore rule covers it', async t => {
  const project = await fixture(t);
  await put(project.root, '.gitignore', ignored + '/Unity/TestGame/Assets/\n');
  const before = await fingerprint(project);
  await put(project.root, 'Unity/TestGame/Assets/Door.cs', 'class Door { public bool Open; }\n');
  assert.notEqual(await fingerprint(project), before);
  const edited = await fingerprint(project);
  await rm(path.join(project.root, 'Unity/TestGame/Assets/Door.cs'));
  assert.notEqual(await fingerprint(project), edited);
});

test('integration: GitHub snapshots include new FBX, meta files and changed acceptance criteria', async t => {
  const project = await fixture(t);
  for (const filename of ['Unity/TestGame/Assets/Дверь A.fbx', 'Unity/TestGame/Assets/Дверь A.fbx.meta']) {
    const before = await fingerprint(project);
    await put(project.root, filename, 'new asset');
    assert.notEqual(await fingerprint(project), before, filename);
  }
  let before = await fingerprint(project);
  await put(project.root, 'Unity/TestGame/Assets/Door.cs.meta', 'guid: changed-guid\n');
  assert.notEqual(await fingerprint(project), before);
  before = await fingerprint(project);
  await put(project.root, 'BACKLOG.md', task + '- [ ] New criterion.\n');
  assert.notEqual(await fingerprint(project), before);
  before = await fingerprint(project);
  await put(project.root, 'BACKLOG.md', (task + '- [ ] New criterion.\n').replace('in-progress', 'testing'));
  assert.equal(await fingerprint(project), before);
});

test('integration: required project definitions are fingerprinted even when untracked and ignored', async t => {
  const project = await fixture(t);
  const files = ['.etask/config.json', 'PROJECT.md', 'BACKLOG.md', 'DECISIONS.md'];
  git(project.root, 'rm', '--cached', '--', ...files);
  await put(project.root, '.gitignore', ignored + files.map(filename => `/${filename}`).join('\n') + '\n');
  for (const filename of files) {
    const before = await fingerprint(project);
    const original = await readFile(path.join(project.root, filename), 'utf8');
    await put(project.root, filename, original + '\n');
    assert.notEqual(await fingerprint(project), before, filename);
  }
});

test('integration: local snapshot rules remain unchanged with and without Git', async t => {
  for (const useGit of [false, true]) {
    const project = await fixture(t, useGit);
    project.config.workflow.mode = 'local';
    project.config.workflow.git = useGit;
    const before = await fingerprint(project);
    await put(project.root, 'Unity/TestGame/Library/cache.bin', 'local file');
    assert.notEqual(await fingerprint(project), before);
  }
});

test('integration: GitHub snapshots reject source directory links and missing repositories', async t => {
  const project = await fixture(t);
  await mkdir(path.join(project.root, 'assets-original'));
  await put(project.root, 'assets-original/model.fbx', 'model');
  await symlink(path.join(project.root, 'assets-original'), path.join(project.root, 'Unity/TestGame/Assets/Alias'), process.platform === 'win32' ? 'junction' : 'dir');
  await assert.rejects(fingerprint(project), /symlink|junction|symbolic/i);
  const missing = await fixture(t, false);
  await assert.rejects(fingerprint(missing), /git/i);
});

test('e2e: CLI check accepts generated caches while retaining source-change protection', async t => {
  const { root } = await fixture(t);
  const invoke = () => spawnSync(process.execPath, [cli, 'check', 'ET-1', 'unit', '--root', root], {
    cwd: root, encoding: 'utf8', windowsHide: true, timeout: 30000,
    env: { ...process.env, PATH: path.dirname(process.execPath) + path.delimiter + process.env.PATH }
  });
  const first = invoke();
  assert.equal(first.status, 0, first.stderr || first.stdout);
  assert.equal(JSON.parse(first.stdout).passed, true);
  await put(root, 'cache-writer.mjs', "import { writeFileSync } from 'node:fs';\nwriteFileSync('Unity/TestGame/Assets/Door.cs', 'class Changed {}');\n");
  const changed = invoke();
  assert.equal(changed.status, 1, changed.stderr || changed.stdout);
  const report = JSON.parse(changed.stdout);
  assert.equal(report.exitCode, 0);
  assert.equal(report.passed, false);
  assert.equal(report.changedDuringCheck, true);
});
