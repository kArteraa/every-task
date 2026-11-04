import { readdir } from 'node:fs/promises';
import path from 'node:path';

const ignored = new Set(['.git', 'node_modules', 'dist', '.superpowers']);

export async function listFiles(root, relative = '') {
  const entries = await readdir(path.join(root, relative), { withFileTypes: true });
  const files = [];
  for (const entry of entries.sort((left, right) => left.name.localeCompare(right.name, 'en'))) {
    if (ignored.has(entry.name)) continue;
    const filename = path.posix.join(relative, entry.name);
    if (entry.isSymbolicLink()) throw new Error(`Symbolic link is not a package input: ${filename}`);
    if (entry.isDirectory()) files.push(...await listFiles(root, filename));
    else if (entry.isFile()) files.push(filename);
  }
  return files;
}

export function resolveInside(root, relative) {
  const resolved = path.resolve(root, relative);
  const fromRoot = path.relative(path.resolve(root), resolved);
  if (fromRoot === '..' || fromRoot.startsWith(`..${path.sep}`) || path.isAbsolute(fromRoot)) {
    throw new Error(`Path escapes package: ${relative}`);
  }
  return resolved;
}
