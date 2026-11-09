import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { spawnSync } from 'node:child_process';
import path from 'node:path';
import { loadProject, inside } from './project.mjs';
import { parseTasks, validateTasks, renderBoard, labels } from './tasks.mjs';
import { fingerprint, readOptional, readState, replaceFile } from './storage.mjs';
import { gitState, requireWorkingBranch, readPr, findPr, run } from './git.mjs';
import { commandAvailable } from './diagnostics.mjs';

export const checkKinds = ['test', 'unit', 'integration', 'e2e', 'lint', 'build'];

async function context(root, id) {
  const project = await loadProject(root);
  const filename = await inside(project.root, project.config.paths.backlog);
  const markdown = await readFile(filename, 'utf8');
  const tasks = validateTasks(parseTasks(markdown));
  const task = id ? tasks.find(entry => entry.id === id) : null;
  if (id && !task) throw new Error(`Unknown task ${id}`);
  return { ...project, filename, markdown, tasks, task, saved: await readState(project) };
}

async function saveEvidence(project, kind, evidence) {
  const { saved, task } = project;
  const previous = saved.state.tasks[task.id] || {};
  saved.state.tasks[task.id] = { ...previous, evidence: { ...previous.evidence, [kind]: evidence } };
  await replaceFile(saved.filename, JSON.stringify(saved.state, null, 2) + '\n', saved.text);
}

export async function checkpoint(root, id, kind, note) {
  if (!['review', 'sanitize'].includes(kind)) throw new Error('Only review/sanitize can be manually attested');
  if (typeof note !== 'string' || !note.trim()) throw new Error('Describe the actual inspection in --note');
  const project = await context(root, id);
  requireWorkingBranch(project);
  const evidence = { passed: true, digest: await fingerprint(project), note, source: 'agent-attestation', at: new Date().toISOString() };
  await saveEvidence(project, kind, evidence);
  return evidence;
}

export async function check(root, id, kind) {
  if (!checkKinds.includes(kind)) throw new Error(`Unknown check ${kind}`);
  const project = await context(root, id);
  requireWorkingBranch(project);
  const entry = project.config.checks[kind];
  const before = await fingerprint(project);
  let result;
  if (entry.skip) result = { status: 0, stdout: `Explicitly agreed skip: ${entry.skip}`, stderr: '' };
  else result = spawnSync(entry.command, {
    cwd: await inside(project.root, entry.cwd), shell: true, encoding: 'utf8', timeout: 600000,
    maxBuffer: 8 * 1024 * 1024, windowsHide: true
  });
  const after = await fingerprint(project);
  const log = `${result.stdout || ''}${result.stderr || ''}${result.error?.message || ''}`;
  const logFile = await inside(project.root, `.etask/runs/${id}/${kind}.log`);
  await mkdir(path.dirname(logFile), { recursive: true });
  await writeFile(logFile, log);
  const evidence = {
    passed: result.status === 0 && !result.error && before === after,
    digest: before, command: entry.command ?? null, cwd: entry.cwd ?? null, skip: entry.skip ?? null,
    exitCode: result.status, changedDuringCheck: before !== after, at: new Date().toISOString()
  };
  await saveEvidence(project, kind, evidence);
  return { ...evidence, log };
}

export async function status(root, id) {
  const project = await context(root, id);
  const digest = await fingerprint(project);
  const git = gitState(project);
  const describe = task => {
    const saved = project.saved.state.tasks[task.id] || {};
    const evidence = Object.fromEntries(Object.entries(saved.evidence || {}).map(([kind, entry]) => [kind, {
      ...entry, current: entry.digest === digest && (checkKinds.includes(kind) ?
        entry.command === (project.config.checks[kind].command ?? null) && entry.skip === (project.config.checks[kind].skip ?? null) : true)
    }]));
    return { task: { id: task.id, title: task.title, state: task.state, label: labels[task.state], dependencies: task.dependencies },
      evidence, pr: saved.pr ?? null, completion: saved.completion ?? null };
  };
  const result = { mode: project.config.workflow.mode, project: project.config.project.name, git, digest,
    ...(id ? describe(project.task) : { tasks: project.tasks.map(describe) }), approvals: 'Require explicit user messages; never restored from files.' };
  if (project.config.workflow.mode === 'github') {
    for (const item of id ? [result] : result.tasks) {
      item.remote = item.pr ? readPr(project, item.task.id, item.pr) : findPr(project, item.task.id);
      if (item.remote?.state === 'MERGED') item.task = { ...item.task, state: 'done', label: labels.done };
    }
  }
  for (const item of id ? [result] : result.tasks) {
    item.blockers = [];
    for (const dependency of item.task.dependencies) {
      const dependencyTask = project.tasks.find(task => task.id === dependency);
      const finished = project.config.workflow.mode === 'github' ? findPr(project, dependency)?.state === 'MERGED' :
        dependencyTask.state === 'done' && Boolean(project.saved.state.tasks[dependency]?.completion);
      if (!finished) item.blockers.push(`Dependency ${dependency} is not verified done`);
    }
    if (item.task.state !== 'done') {
      const required = item.task.state === 'testing' ? ['review', 'sanitize', ...checkKinds] : item.task.state === 'in-progress' ? ['review', 'sanitize'] : [];
      for (const kind of required) if (!item.evidence[kind]?.passed || !item.evidence[kind]?.current) item.blockers.push(`Missing or stale ${kind}`);
    }
  }
  return result;
}

function requireEvidence(saved, digest, kind, config) {
  const evidence = saved?.evidence?.[kind];
  if (!evidence?.passed || evidence.digest !== digest) throw new Error(`Missing or stale ${kind} evidence`);
  if (checkKinds.includes(kind) && (evidence.command !== (config.checks[kind].command ?? null) || evidence.skip !== (config.checks[kind].skip ?? null))) {
    throw new Error(`Changed ${kind} command`);
  }
}

export async function board(root, persist = false) {
  const project = await context(root);
  if (project.config.workflow.mode === 'github') {
    const current = await status(root);
    const output = renderBoard(project.tasks.map(task => ({ ...task, state: current.tasks.find(item => item.task.id === task.id).task.state })));
    if (persist) {
      requireWorkingBranch(project);
      const filename = await inside(project.root, project.config.paths.board);
      await replaceFile(filename, output, await readOptional(filename));
    }
    return output;
  }
  requireWorkingBranch(project);
  const filename = await inside(project.root, project.config.paths.board);
  const output = renderBoard(project.tasks);
  await replaceFile(filename, output, await readOptional(filename));
  return output;
}

export async function moveTask(root, id, target, prNumber) {
  const project = await context(root, id);
  const git = requireWorkingBranch(project);
  const { task, tasks, saved, config } = project;
  const allowed = { todo: ['in-progress'], 'in-progress': ['testing'], testing: ['in-progress', 'done'], done: ['done'] };
  if (!allowed[task.state].includes(target)) throw new Error(`Invalid transition ${task.state} -> ${target}`);
  for (const dependency of task.dependencies) {
    const predecessor = tasks.find(entry => entry.id === dependency);
    const completed = saved.state.tasks[dependency];
    if (config.workflow.mode === 'github') {
      const pr = completed?.pr ? readPr(project, dependency, completed.pr) : findPr(project, dependency);
      if (pr?.state !== 'MERGED') throw new Error(`Unmerged dependency ${dependency}`);
    } else if (predecessor.state !== 'done' || !completed?.completion) throw new Error(`Unfinished dependency ${dependency}`);
  }
  const digest = await fingerprint(project);
  const current = saved.state.tasks[id] || {};
  if (['testing', 'done'].includes(target)) for (const kind of ['review', 'sanitize']) requireEvidence(current, digest, kind, config);
  if (target === 'done') {
    for (const kind of checkKinds) requireEvidence(current, digest, kind, config);
    if (task.criteria.some(criterion => !criterion.done)) throw new Error('Acceptance criteria remain unchecked');
    if (config.workflow.mode === 'github') {
      const pr = readPr(project, id, prNumber);
      if (pr.state !== 'MERGED' || !pr.mergeCommit?.oid) throw new Error('Task completion requires a merged PR');
      if (git.head !== pr.headRefOid) throw new Error('Checked HEAD differs from merged PR head');
      if (git.changes) throw new Error('GitHub completion requires a clean working tree');
      current.pr = pr.number;
    }
    current.completion = { digest, head: git?.head ?? null, at: new Date().toISOString() };
  }
  const block = task.block.replace(/^- Состояние — .+$/m, `- Состояние — ${target}`);
  const markdown = project.markdown.slice(0, task.start) + block + project.markdown.slice(task.end);
  saved.state.tasks[id] = { ...current, lastTransition: { from: task.state, to: target, at: new Date().toISOString() } };
  await replaceFile(saved.filename, JSON.stringify(saved.state, null, 2) + '\n', saved.text);
  if (target === 'done' && config.workflow.mode === 'github') return renderBoard(tasks.map(entry => entry.id === id ? { ...entry, state: 'done' } : entry));
  await replaceFile(project.filename, markdown, project.markdown);
  return board(root);
}

export async function resume(root, id) {
  if (!id) throw new Error('resume requires a task ID');
  const current = await status(root, id);
  current.next = current.task.state === 'done' ? 'Verify completion and remaining cleanup; new work requires a new task.' :
    'Read goal, task and instructions; reconcile Git/PR state, then agree missing work. Refresh stale review, sanitize and checks.';
  return current;
}

export async function doctor(root) {
  const project = await context(root);
  const checks = [{ name: 'config, goal, task graph', passed: true }, { name: 'Node.js >=22', passed: Number(process.versions.node.split('.')[0]) >= 22 }];
  for (const relative of [project.config.paths.manualChecks, project.config.paths.decisions, project.config.paths.queue].filter(Boolean)) {
    checks.push({ name: relative, passed: await readOptional(await inside(project.root, relative)) !== null });
  }
  for (const [kind, entry] of Object.entries(project.config.checks)) {
    if (entry.command) checks.push({ name: `${kind} executable`, passed: await commandAvailable(entry.command, await inside(project.root, entry.cwd)) });
  }
  try {
    const git = gitState(project);
    if (git) checks.push({ name: 'Git', passed: true, branch: git.branch });
    if (project.config.workflow.mode === 'github') {
      run('gh', ['api', 'user', '--jq', '.login'], project.root);
      run('git', ['show-ref', '--verify', `refs/heads/${project.config.workflow.integrationBranch}`], project.root);
      checks.push({ name: 'GitHub authorization and integration branch', passed: true });
    }
  } catch (error) { checks.push({ name: 'Git/GitHub', passed: false, error: error.message }); }
  return { mode: project.config.workflow.mode, checks, passed: checks.every(entry => entry.passed),
    commands: project.config.checks, note: 'Commands are displayed for inspection, not executed. Jira/MCP is not contacted.' };
}
