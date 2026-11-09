import assert from 'node:assert/strict';
import { mkdtemp, mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { execFileSync, spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { parseTasks, renderBoard, validateTasks } from '../skills/etask/tools/tasks.mjs';
import { loadProject, validateProfile } from '../skills/etask/tools/project.mjs';
import { checkpoint, check, moveTask, status } from '../skills/etask/tools/workflow.mjs';

const cli = fileURLToPath(new URL('../skills/etask/tools/etask.mjs', import.meta.url));
const command = 'node -e "process.exit(0)"';
const task = (id, state = 'todo', dependencies = 'нет') => `## ${id} — Задача ${id}\n\n- Тип — feat\n- Исполнитель — any\n- Состояние — ${state}\n- Зависимости — ${dependencies}\n\n### Что сделать\n\nПроверить поведение.\n\n### Готово, когда\n\n- [x] Результат проверен.\n`;

async function fixture(t, backlog = task('ET-1')) {
  const root = await mkdtemp(path.join(tmpdir(), 'etask-flow-'));
  t.after(() => rm(root, { recursive: true, force: true }));
  await mkdir(path.join(root, '.etask'));
  const config = {
    version: 2,
    project: { name: 'Fixture', goal: 'PROJECT.md', owner: 'tester' },
    workflow: { mode: 'local', git: false, integrationBranch: null, productionBranch: null },
    paths: { backlog: 'BACKLOG.md', board: 'BOARD.md', queue: null, decisions: null, manualChecks: 'MANUAL.md' },
    checks: Object.fromEntries(['test', 'unit', 'integration', 'e2e', 'lint', 'build'].map(key => [key, { command, cwd: '.' }])),
    reviewers: [], jira: { enabled: false }
  };
  await writeFile(path.join(root, '.etask/config.json'), JSON.stringify(config));
  await writeFile(path.join(root, 'PROJECT.md'), '# Цель\nПроверить локальный процесс.\n');
  await writeFile(path.join(root, 'BACKLOG.md'), '# Бэклог\n\n' + backlog);
  await writeFile(path.join(root, 'MANUAL.md'), '# Проверки\n');
  await writeFile(path.join(root, 'app.mjs'), 'export const answer = 42;\n');
  return { root, config };
}

test('unit: board renders four agreed columns and stable task IDs', () => {
  const tasks = parseTasks(task('ET-1') + '\n' + task('ET-12', 'testing'));
  const board = renderBoard(tasks);
  for (const label of ['К выполнению', 'Выполняется', 'Тестируется', 'Выполнено']) assert.ok(board.includes(label));
  assert.equal(tasks[0].id, 'ET-1');
  assert.equal(tasks[1].state, 'testing');
});

test('unit: rejects duplicate IDs, missing dependencies and dependency cycles', () => {
  assert.throws(() => validateTasks(parseTasks(task('ET-1') + task('ET-1'))), /Duplicate/);
  assert.throws(() => validateTasks(parseTasks(task('ET-1', 'todo', 'ET-2'))), /Unknown dependency/);
  assert.throws(() => validateTasks(parseTasks(task('ET-1', 'todo', 'ET-2') + task('ET-2', 'todo', 'ET-1'))), /cycle/);
  assert.throws(() => parseTasks(task('ET-1', 'invented')), /state/);
});

test('unit: fenced Markdown examples are not tasks, fields or acceptance criteria', () => {
  for (const fence of ['```markdown', '~~~markdown', '   ````markdown']) {
    const closing = fence.trim().match(/^[`~]+/)[0];
    const markdown = task('ET-1') + `\n### Example\n\n${fence}\n` + task('ET-99') + '- Состояние — testing\n- [ ] Example only\n' + closing + '\n';
    const parsed = parseTasks(markdown);
    assert.deepEqual(parsed.map(entry => entry.id), ['ET-1']);
    assert.equal(parsed[0].criteria.length, 1);
    assert.equal(parsed[0].state, 'todo');
    assert.equal(parsed[0].block, markdown);
  }
});

test('integration: changed completed criteria block dependents until reverified', async t => {
  const { root } = await fixture(t, task('ET-1') + task('ET-2', 'todo', 'ET-1'));
  await moveTask(root, 'ET-1', 'in-progress');
  for (const kind of ['review', 'sanitize']) await checkpoint(root, 'ET-1', kind, 'Checked original task.');
  await moveTask(root, 'ET-1', 'testing');
  for (const kind of ['test', 'unit', 'integration', 'e2e', 'lint', 'build']) await check(root, 'ET-1', kind);
  await moveTask(root, 'ET-1', 'done');
  const backlog = path.join(root, 'BACKLOG.md');
  const original = await readFile(backlog, 'utf8');
  await writeFile(backlog, original.replace('- [x] Результат проверен.', '- [x] Результат проверен.\n- [ ] Новое требование.'));
  assert.ok((await status(root, 'ET-1')).blockers.some(value => /completion|definition/i.test(value)));
  await assert.rejects(moveTask(root, 'ET-2', 'in-progress'), /dependency/i);
  await writeFile(backlog, original);
  await moveTask(root, 'ET-2', 'in-progress');
});

test('integration: state transitions preserve fenced examples and example edits invalidate checks', async t => {
  const example = '```markdown\n- Состояние — todo\n```\n\n';
  const { root } = await fixture(t, task('ET-1').replace('- Тип — feat', example + '- Тип — feat'));
  await moveTask(root, 'ET-1', 'in-progress');
  const filename = path.join(root, 'BACKLOG.md');
  const markdown = await readFile(filename, 'utf8');
  assert.ok(markdown.includes(example));
  await checkpoint(root, 'ET-1', 'review', 'Read real task and fenced example.');
  await writeFile(filename, markdown.replace(example, example.replace('todo', 'testing')));
  assert.equal((await status(root, 'ET-1')).evidence.review.current, false);
});

test('unit: mode, goal and all test levels must be explicit', async t => {
  const { config } = await fixture(t);
  assert.deepEqual(validateProfile(config), []);
  for (const key of ['mode', 'git', 'integrationBranch']) {
    const changed = structuredClone(config);
    delete changed.workflow[key];
    assert.notDeepEqual(validateProfile(changed), []);
  }
  const missing = structuredClone(config);
  delete missing.checks.e2e;
  assert.notDeepEqual(validateProfile(missing), []);
  const skipped = structuredClone(config);
  skipped.checks.unit = { skip: 'No tests' };
  assert.notDeepEqual(validateProfile(skipped), []);
});

test('integration: migration is explicit and path traversal is rejected', async t => {
  const { root, config } = await fixture(t);
  await writeFile(path.join(root, '.etask/config.json'), JSON.stringify({ ...config, version: 1 }));
  await assert.rejects(loadProject(root), /migration/i);
  config.paths.backlog = '../outside.md';
  await writeFile(path.join(root, '.etask/config.json'), JSON.stringify(config));
  await assert.rejects(loadProject(root), /backlog|pattern/);
});

test('integration: review and sanitize are separate and edits invalidate both', async t => {
  const { root } = await fixture(t);
  await moveTask(root, 'ET-1', 'in-progress');
  await checkpoint(root, 'ET-1', 'review', 'Reviewed diff and acceptance.');
  await assert.rejects(moveTask(root, 'ET-1', 'testing'), /sanitize/);
  await checkpoint(root, 'ET-1', 'sanitize', 'Checked scope, names and temporary code.');
  await moveTask(root, 'ET-1', 'testing');
  await writeFile(path.join(root, 'app.mjs'), 'export const answer = 43;\n');
  const current = await status(root, 'ET-1');
  assert.equal(current.evidence.review.current, false);
  await assert.rejects(moveTask(root, 'ET-1', 'done'), /review|stale/);
});

test('integration: failed tests never become passing evidence', async t => {
  const { root, config } = await fixture(t);
  config.checks.unit.command = 'node -e "process.exit(7)"';
  await writeFile(path.join(root, '.etask/config.json'), JSON.stringify(config));
  const result = await check(root, 'ET-1', 'unit');
  assert.equal(result.passed, false);
  assert.equal((await status(root, 'ET-1')).evidence.unit.passed, false);
});

test('integration: a check that changes source files cannot validate its previous snapshot', async t => {
  const { root, config } = await fixture(t);
  config.checks.unit.command = 'node -e "require(\'node:fs\').writeFileSync(\'app.mjs\',\'changed\')"';
  await writeFile(path.join(root, '.etask/config.json'), JSON.stringify(config));
  const result = await check(root, 'ET-1', 'unit');
  assert.equal(result.exitCode, 0);
  assert.equal(result.passed, false);
  assert.equal(result.changedDuringCheck, true);
});

test('integration: a transferred local project can reverify completion without reopening a task', async t => {
  const { root } = await fixture(t, task('ET-1', 'done'));
  await assert.rejects(moveTask(root, 'ET-1', 'done'), /review/);
  for (const kind of ['review', 'sanitize']) await checkpoint(root, 'ET-1', kind, 'Rechecked after transfer.');
  for (const kind of ['test', 'unit', 'integration', 'e2e', 'lint', 'build']) await check(root, 'ET-1', kind);
  await moveTask(root, 'ET-1', 'done');
  assert.ok((await status(root, 'ET-1')).completion);
});

test('integration: completion requires all levels and finished dependencies', async t => {
  const { root } = await fixture(t, task('ET-1') + task('ET-2', 'todo', 'ET-1'));
  await assert.rejects(moveTask(root, 'ET-2', 'in-progress'), /dependency/i);
  await moveTask(root, 'ET-1', 'in-progress');
  for (const kind of ['review', 'sanitize']) await checkpoint(root, 'ET-1', kind, 'Checked task content.');
  await moveTask(root, 'ET-1', 'testing');
  await check(root, 'ET-1', 'test');
  await assert.rejects(moveTask(root, 'ET-1', 'done'), /unit/);
  for (const kind of ['unit', 'integration', 'e2e', 'lint', 'build']) await check(root, 'ET-1', kind);
  await moveTask(root, 'ET-1', 'done');
  assert.equal((await status(root, 'ET-1')).task.state, 'done');
  await moveTask(root, 'ET-2', 'in-progress');
});

test('e2e: installed-style CLI supports local doctor, board, status and resume without GitHub', async t => {
  const { root } = await fixture(t);
  for (const args of [['doctor'], ['board'], ['status', 'ET-1'], ['resume', 'ET-1']]) {
    const output = execFileSync(process.execPath, [cli, ...args, '--root', root], { encoding: 'utf8', env: { ...process.env, PATH: path.dirname(process.execPath) } });
    assert.ok(output.length > 0);
    assert.doesNotMatch(output, /gh auth|api.github.com/);
  }
  assert.match(await readFile(path.join(root, 'BOARD.md'), 'utf8'), /К выполнению/);
  const invalid = spawnSync(process.execPath, [cli, 'move', 'ET-1', 'done', '--root', root], { encoding: 'utf8' });
  assert.notEqual(invalid.status, 0);
});
