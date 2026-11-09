import { createHash, randomUUID } from 'node:crypto';
import { readFile, readdir, rename, rm, writeFile, mkdir } from 'node:fs/promises';
import path from 'node:path';
import { inside } from './project.mjs';

export async function readOptional(filename) {
  try { return await readFile(filename, 'utf8'); }
  catch (error) { if (error.code === 'ENOENT') return null; throw error; }
}

export async function replaceFile(filename, content, expected) {
  await mkdir(path.dirname(filename), { recursive: true });
  const lock = `${filename}.lock`;
  const temporary = `${filename}.${randomUUID()}.tmp`;
  await writeFile(lock, '', { flag: 'wx' });
  try {
    if (await readOptional(filename) !== expected) throw new Error(`Concurrent edit: ${filename}`);
    await writeFile(temporary, content, { flag: 'wx' });
    if (await readOptional(filename) !== expected) throw new Error(`Concurrent edit: ${filename}`);
    await rename(temporary, filename);
  } finally {
    await rm(temporary, { force: true });
    await rm(lock, { force: true });
  }
}

export async function fingerprint(project) {
  const { root, config } = project;
  const excluded = new Set([config.paths.board, config.paths.manualChecks, '.etask/state.json']);
  const directories = new Set(['.git', 'node_modules', 'dist', '.superpowers']);
  const digest = createHash('sha256');
  async function walk(directory, prefix = '') {
    for (const entry of (await readdir(directory, { withFileTypes: true })).sort((a, b) => a.name.localeCompare(b.name, 'en'))) {
      const relative = prefix ? `${prefix}/${entry.name}` : entry.name;
      if (excluded.has(relative) || relative.startsWith('.etask/runs/') || relative === '.etask/runs') continue;
      if (entry.isDirectory() && directories.has(entry.name)) continue;
      if (entry.isSymbolicLink()) throw new Error(`Snapshot does not follow symlinks: ${relative}`);
      const absolute = await inside(root, relative);
      if (entry.isDirectory()) await walk(absolute, relative);
      else if (entry.isFile()) {
        let content = await readFile(absolute);
        if (relative === config.paths.backlog) content = Buffer.from(content.toString('utf8').replace(/^- Состояние — .+$/gm, '- Состояние — <state>'));
        digest.update(JSON.stringify([relative, content.length, createHash('sha256').update(content).digest('hex')]) + '\n');
      }
    }
  }
  await walk(root);
  return digest.digest('hex');
}

export async function readState(project) {
  const filename = await inside(project.root, '.etask/state.json');
  const text = await readOptional(filename);
  const state = text === null ? { version: 1, tasks: {} } : JSON.parse(text);
  if (state.version !== 1 || !state.tasks || typeof state.tasks !== 'object' || Array.isArray(state.tasks)) throw new Error('Invalid state file; inspect it before continuing');
  if ('approvals' in state || 'permissions' in state) throw new Error('State cannot grant approvals');
  return { filename, text, state };
}
