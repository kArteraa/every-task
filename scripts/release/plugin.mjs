import { execFileSync } from 'node:child_process';
import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { buildPackages } from '../build.mjs';

export const types = ['feat', 'fix', 'perf', 'docs', 'chore', 'test', 'refactor', 'style', 'build', 'ci', 'revert'];

export function parseCommit(commit) {
  const message = commit.message.replace(/\r\n/g, '\n');
  if (/^Merge (pull request |branch |remote-tracking branch )/.test(message)) return null;
  const match = message.match(/^([a-z]+)(?:\(([^)\n]+)\))?(!)?: (\S[^\n]*)/);
  if (!match || !types.includes(match[1])) throw new Error(`Conventional Commit required: ${message.split('\n')[0]}`);
  return { type: match[1], scope: match[2], subject: match[4], breaking: Boolean(match[3]) || /^BREAKING[ -]CHANGE: \S/m.test(message), hash: commit.hash };
}

export function analyzeCommits(config, context) {
  const changes = context.commits.map(parseCommit).filter(Boolean);
  if (!changes.length) throw new Error('Release requires at least one Conventional Commit');
  if (changes.some(change => change.breaking)) return 'major';
  if (changes.some(change => change.type === 'feat')) return 'minor';
  return 'patch';
}

export function generateNotes(config, context) {
  const changes = context.commits.map(parseCommit).filter(Boolean);
  return [`# etask ${context.nextRelease.version}`, '', ...changes.map(change =>
    `- ${change.breaking ? '**BREAKING CHANGE** ' : ''}${change.type}${change.scope ? `(${change.scope})` : ''}: ${change.subject} ([${change.hash.slice(0, 7)}](https://github.com/${config.repository}/commit/${change.hash}))`), '',
  'Архивы содержат одинаковую версию общего процесса и соответствующие адаптеры.', ''].join('\n');
}

function gh(args, context) {
  return execFileSync('gh', args, { cwd: context.cwd, env: context.env, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'], windowsHide: true }).trim();
}

export function verifyConditions(config, context) {
  if (!/^[\w.-]+\/[\w.-]+$/.test(config.repository || '')) throw new Error('Explicit release repository required');
  if (!context.options.dryRun) gh(['repo', 'view', config.repository, '--json', 'nameWithOwner'], context);
}

export async function prepare(config, context) {
  const { cwd, nextRelease } = context;
  const output = path.join(cwd, 'dist', nextRelease.version);
  await mkdir(output, { recursive: true });
  await buildPackages(cwd, output, { version: nextRelease.version, notes: nextRelease.notes, commit: nextRelease.gitHead });
  await writeFile(path.join(output, 'CHANGELOG.md'), nextRelease.notes);
}

export function publish(config, context, execute = gh) {
  const { nextRelease } = context;
  const output = path.join(context.cwd, 'dist', nextRelease.version);
  const assets = ['codex', 'claude', 'gemini'].map(host => path.join(output, `etask-${nextRelease.version}-${host}.zip`));
  assets.push(path.join(output, 'CHANGELOG.md'));
  const releases = JSON.parse(execute(['api', `repos/${config.repository}/releases`, '--paginate', '--slurp'], context)).flat();
  const existing = releases.find(release => release.tag_name === nextRelease.gitTag);
  if (existing && !existing.draft) return { name: nextRelease.gitTag, url: existing.html_url };
  if (!existing) execute(['release', 'create', nextRelease.gitTag, '--repo', config.repository, '--verify-tag', '--draft',
    '--title', `etask ${nextRelease.version}`, '--notes-file', path.join(output, 'CHANGELOG.md')], context);
  execute(['release', 'upload', nextRelease.gitTag, ...assets, '--repo', config.repository, '--clobber'], context);
  execute(['release', 'edit', nextRelease.gitTag, '--repo', config.repository, '--draft=false', '--latest',
    '--notes-file', path.join(output, 'CHANGELOG.md')], context);
  return { name: nextRelease.gitTag, url: `https://github.com/${config.repository}/releases/tag/${nextRelease.gitTag}` };
}
