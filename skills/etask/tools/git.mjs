import { spawnSync } from 'node:child_process';

export function run(program, args, cwd) {
  const result = spawnSync(program, args, { cwd, encoding: 'utf8', timeout: 30000, windowsHide: true });
  if (result.error || result.status !== 0) throw new Error(`${program}: ${result.error?.message || result.stderr?.trim() || `exit ${result.status}`}`);
  return result.stdout.trim();
}

export function gitState(project) {
  if (!project.config.workflow.git) return null;
  const branch = run('git', ['branch', '--show-current'], project.root);
  const head = run('git', ['rev-parse', 'HEAD'], project.root);
  const changes = run('git', ['status', '--porcelain'], project.root);
  if (project.config.workflow.mode === 'github') {
    const origin = run('git', ['remote', 'get-url', 'origin'], project.root);
    const match = origin.match(/^(?:https:\/\/github\.com\/|git@github\.com:)([\w.-]+\/[\w.-]+?)(?:\.git)?$/);
    if (!match || match[1].toLowerCase() !== project.config.workflow.repository.toLowerCase()) throw new Error('Origin differs from configured GitHub repository');
  }
  return { branch, head, changes };
}

export function requireWorkingBranch(project) {
  const git = gitState(project);
  if (git && (!git.branch || [project.config.workflow.integrationBranch, project.config.workflow.productionBranch].includes(git.branch))) {
    throw new Error('Use a task branch before modifying project state');
  }
  return git;
}

export function readPr(project, id, number, execute = run) {
  if (!Number.isSafeInteger(number) || number < 1) throw new Error('Explicit PR number required');
  const pr = JSON.parse(execute('gh', ['pr', 'view', String(number), '--repo', project.config.workflow.repository,
    '--json', 'number,state,baseRefName,headRefName,headRefOid,mergeCommit,body,url'], project.root));
  if (pr.baseRefName !== project.config.workflow.integrationBranch) throw new Error('PR base differs from integration branch');
  if (!new RegExp(`^etask-id: ${id}\\s*$`, 'm').test(pr.body)) throw new Error('PR task marker differs');
  return pr;
}

export function findPr(project, id) {
  const prs = JSON.parse(run('gh', ['pr', 'list', '--repo', project.config.workflow.repository, '--state', 'all',
    '--search', `"etask-id: ${id}" in:body`, '--limit', '100', '--json', 'number,body,baseRefName'], project.root));
  if (prs.length === 100) throw new Error('PR search limit reached; specify and inspect the PR explicitly');
  const matches = prs.filter(pr => pr.baseRefName === project.config.workflow.integrationBranch && new RegExp(`^etask-id: ${id}\\s*$`, 'm').test(pr.body));
  if (matches.length > 1) throw new Error(`Multiple PRs for ${id}; resolve explicitly`);
  return matches.length ? readPr(project, id, matches[0].number) : null;
}
