import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { validateProject } from './validate.mjs';
import { adapterFiles, commonFiles } from './package-files.mjs';

export async function buildPackages(root, output) {
  const errors = await validateProject(root);
  if (errors.length) throw new Error(errors.join('\n'));
  const { version } = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  await mkdir(output, { recursive: true });
  const archives = [];
  for (const [agent, entries] of Object.entries(adapterFiles)) {
    const payload = {};
    for (const filename of [...commonFiles, ...entries].sort()) {
      const content = (await readFile(path.join(root, filename), 'utf8')).replace(/\r\n/g, '\n');
      payload[filename] = [new TextEncoder().encode(content), { mtime: new Date(2000, 0, 1) }];
    }
    const archive = path.join(output, `etask-${version}-${agent}.zip`);
    await writeFile(archive, zipSync(payload, { level: 9 }));
    archives.push(archive);
  }
  return archives;
}

if (process.argv[1] && import.meta.url === pathToFileURL(path.resolve(process.argv[1])).href) {
  const root = fileURLToPath(new URL('..', import.meta.url));
  try {
    for (const archive of await buildPackages(root, path.join(root, 'dist'))) console.log(archive);
  } catch (error) {
    console.error(error.message);
    process.exitCode = 1;
  }
}
