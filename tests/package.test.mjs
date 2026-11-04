import assert from 'node:assert/strict';
import { cp, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';
import { unzipSync } from 'fflate';
import { buildPackages } from '../scripts/build.mjs';
import { validateProject } from '../scripts/validate.mjs';

const root = fileURLToPath(new URL('..', import.meta.url));

async function fixture(t) {
  const directory = await mkdtemp(path.join(tmpdir(), 'etask-package-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  await cp(root, directory, { recursive: true, filter: source => {
    const first = path.relative(root, source).split(path.sep)[0];
    return !['.git', 'node_modules', 'dist', '.superpowers'].includes(first);
  } });
  return directory;
}

test('validates all native adapters and their packaged references', async () => {
  assert.deepEqual(await validateProject(root), []);
});

test('reports a missing skill reference', async t => {
  const directory = await fixture(t);
  await rm(path.join(directory, 'skills/etask/references/git.md'));
  assert.match((await validateProject(directory)).join('\n'), /git\.md/);
});

test('rejects adapter version drift', async t => {
  const directory = await fixture(t);
  const filename = path.join(directory, 'gemini-extension.json');
  const manifest = JSON.parse(await readFile(filename, 'utf8'));
  manifest.version = '9.0.0';
  await writeFile(filename, JSON.stringify(manifest));
  assert.match((await validateProject(directory)).join('\n'), /version/);
});

test('rejects host-specific frontmatter in the shared skill', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'skills/etask/SKILL.md'), '---\nname: etask\ndescription: Use when invoking etask.\ndisable-model-invocation: true\n---\n# etask\n');
  assert.match((await validateProject(directory)).join('\n'), /unsupported.*disable-model-invocation/);
});

test('rejects broken TOML and missing context files', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, 'commands/etask.toml'), 'prompt = "unterminated');
  await rm(path.join(directory, 'adapters/gemini/GEMINI.md'));
  const errors = (await validateProject(directory)).join('\n');
  assert.match(errors, /etask\.toml/);
  assert.match(errors, /GEMINI\.md/);
});

test('builds reproducible complete archives without development files or secrets', async t => {
  const directory = await fixture(t);
  await writeFile(path.join(directory, '.env'), 'PRIVATE_TOKEN=do-not-package');
  await writeFile(path.join(directory, 'skills/etask/.env'), 'PRIVATE_TOKEN=do-not-package');
  await writeFile(path.join(directory, 'skills/etask/assets/private.json'), '{"token":"do-not-package"}');
  const output = path.join(directory, 'dist');
  const archives = await buildPackages(directory, output);
  assert.equal(archives.length, 3);
  const first = await Promise.all(archives.map(file => readFile(file)));
  await buildPackages(directory, output);
  for (let index = 0; index < archives.length; index++) {
    const contents = await readFile(archives[index]);
    assert.deepEqual(contents, first[index]);
    const files = unzipSync(contents);
    assert.ok(files['skills/etask/SKILL.md']);
    assert.ok(files['skills/etask/references/pipeline.md']);
    assert.ok(files['skills/etask/assets/config.schema.json']);
    assert.ok(files['README.md']);
    assert.ok(files.LICENSE);
    assert.equal(files['skills/etask/.env'], undefined);
    assert.equal(files['skills/etask/assets/private.json'], undefined);
    assert.equal(Object.keys(files).some(file => /^(\.env|\.git\/|node_modules\/|tests\/|scripts\/|PLAN\.md)/.test(file)), false);
    const agent = path.basename(archives[index]).split('-').at(-1).replace('.zip', '');
    const manifests = { codex: '.codex-plugin/plugin.json', claude: '.claude-plugin/plugin.json', gemini: 'gemini-extension.json' };
    assert.ok(files[manifests[agent]]);
    for (const [filename, bytes] of Object.entries(files)) {
      if (!filename.endsWith('.md')) continue;
      for (const match of new TextDecoder().decode(bytes).matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
        const target = match[1];
        if (/^(?:[a-z]+:|#)/i.test(target)) continue;
        const linked = path.posix.normalize(path.posix.join(path.posix.dirname(filename), target.split('#')[0]));
        assert.ok(files[linked], `${filename} references absent ${linked}`);
      }
    }
  }
});

test('refuses to package invalid input', async t => {
  const directory = await fixture(t);
  await rm(path.join(directory, 'skills/etask/SKILL.md'));
  await assert.rejects(buildPackages(directory, path.join(directory, 'dist')), /SKILL\.md/);
});
