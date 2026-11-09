import assert from 'node:assert/strict';
import { cp, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
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
    const relative = path.relative(root, source).split(path.sep).join('/');
    const first = relative.split('/')[0];
    return !['.git', 'node_modules', 'dist', '.superpowers'].includes(first) && !['.etask/state.json', '.etask/runs'].includes(relative);
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

test('e2e: all release archives run standalone and carry the calculated version and changelog', async t => {
  const directory = await fixture(t);
  const release = { version: '1.2.3', notes: '# Release 1.2.3\n\n- Verified workflow.\n', commit: 'a'.repeat(40) };
  const archives = await buildPackages(directory, path.join(directory, 'dist'), release);
  const target = await mkdtemp(path.join(tmpdir(), 'etask-installed-project-'));
  t.after(() => rm(target, { recursive: true, force: true }));
  const profile = JSON.parse(await readFile(path.join(root, 'skills/etask/assets/config.local.example.json'), 'utf8'));
  for (const entry of Object.values(profile.checks)) entry.command = 'node -e "process.exit(0)"';
  await mkdir(path.join(target, '.etask'));
  await mkdir(path.join(target, 'docs'));
  await writeFile(path.join(target, '.etask/config.json'), JSON.stringify(profile));
  await writeFile(path.join(target, 'docs/PROJECT.md'), '# Goal\n\nCheck standalone installation.\n');
  await writeFile(path.join(target, 'docs/BACKLOG.md'), '# Backlog\n');
  await writeFile(path.join(target, 'docs/DECISIONS.md'), '# Decisions\n');
  await writeFile(path.join(target, 'docs/MANUAL_CHECKS.md'), '# Manual\n');
  for (const archive of archives) {
    const unpacked = await mkdtemp(path.join(tmpdir(), 'etask-installed-'));
    t.after(() => rm(unpacked, { recursive: true, force: true }));
    const entries = unzipSync(await readFile(archive));
    for (const [relative, content] of Object.entries(entries)) {
      const filename = path.join(unpacked, relative);
      await mkdir(path.dirname(filename), { recursive: true });
      await writeFile(filename, content);
    }
    const metadata = JSON.parse(new TextDecoder().decode(entries['RELEASE.json']));
    assert.equal(metadata.version, '1.2.3');
    assert.equal(metadata.commit, release.commit);
    assert.equal(new TextDecoder().decode(entries['CHANGELOG.md']), release.notes);
    for (const manifest of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json']) {
      if (entries[manifest]) assert.equal(JSON.parse(new TextDecoder().decode(entries[manifest])).version, '1.2.3');
    }
    const result = JSON.parse(execFileSync(process.execPath, [path.join(unpacked, 'skills/etask/tools/etask.mjs'), 'doctor', '--root', target], {
      cwd: target, encoding: 'utf8', env: { ...process.env, PATH: path.dirname(process.execPath) }
    }));
    assert.equal(result.passed, true);
    assert.equal(result.mode, 'local');
    assert.equal(Object.keys(entries).some(name => name.includes('node_modules')), false);
  }
  assert.equal(JSON.parse(await readFile(path.join(directory, 'package.json'), 'utf8')).version,
    JSON.parse(await readFile(path.join(root, 'package.json'), 'utf8')).version);
});
