import { execFileSync } from 'node:child_process';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import path from 'node:path';
import { listFiles } from './files.mjs';
import { validateProject } from './validate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));
const errors = await validateProject(root);
for (const filename of await listFiles(root)) {
  if (!/\.(md|mjs|json|ya?ml|toml)$/.test(filename)) continue;
  const absolute = path.join(root, filename);
  const content = await readFile(absolute, 'utf8');
  if (content.startsWith('\uFEFF') || content.includes('\uFFFD')) errors.push(`${filename}: invalid text encoding`);
  if (!content.endsWith('\n')) errors.push(`${filename}: missing final newline`);
  for (const [index, line] of content.split(/\r?\n/).entries()) {
    if (/[ \t]+$/.test(line)) errors.push(`${filename}:${index + 1}: trailing whitespace`);
  }
  if (filename.endsWith('.mjs')) {
    if (content.trimEnd().split(/\r?\n/).length > 500) errors.push(`${filename}: exceeds 500 source lines`);
    if (/^\s*(?:\/\/|\/\*)/m.test(content)) errors.push(`${filename}: code comments are prohibited`);
    try {
      execFileSync(process.execPath, ['--check', absolute], { stdio: 'pipe' });
    } catch (error) {
      errors.push(`${filename}: ${error.stderr?.toString() || error.message}`);
    }
  }
}
if (errors.length) {
  console.error(errors.join('\n'));
  process.exitCode = 1;
} else {
  console.log('Package metadata, configuration, links, text and JavaScript syntax are valid.');
}
