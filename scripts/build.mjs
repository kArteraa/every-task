import { mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { zipSync } from 'fflate';
import { validateProject } from './validate.mjs';
import { adapterFiles, commonFiles } from './package-files.mjs';

export async function buildPackages(root, output, release) {
  const errors = await validateProject(root);
  if (errors.length) throw new Error(errors.join('\n'));
  const manifest = JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8'));
  const version = release?.version ?? manifest.version;
  if (!/^\d+\.\d+\.\d+$/.test(version)) throw new Error('Invalid release version');
  await mkdir(output, { recursive: true });
  const archives = [];
  for (const [agent, entries] of Object.entries(adapterFiles)) {
    const payload = {};
    for (const filename of [...commonFiles, ...entries].sort()) {
      let content = (await readFile(path.join(root, filename), 'utf8')).replace(/\r\n/g, '\n');
      if (release && ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json', '.claude-plugin/marketplace.json'].includes(filename)) {
        const metadata = JSON.parse(content);
        if (metadata.plugins) metadata.plugins.find(plugin => plugin.name === 'etask').version = version;
        else metadata.version = version;
        content = JSON.stringify(metadata, null, 2) + '\n';
      }
      payload[filename] = [new TextEncoder().encode(content), { mtime: new Date(2000, 0, 1) }];
    }
    if (release) {
      for (const [filename, content] of Object.entries({ 'CHANGELOG.md': release.notes, 'RELEASE.json': JSON.stringify({ version, commit: release.commit }, null, 2) + '\n' })) {
        payload[filename] = [new TextEncoder().encode(content), { mtime: new Date(2000, 0, 1) }];
      }
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
