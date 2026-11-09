import { access, readFile } from 'node:fs/promises';
import path from 'node:path';
import { parse as parseYaml } from 'yaml';
import { parse as parseToml } from 'smol-toml';
import Ajv from 'ajv';
import { listFiles, resolveInside } from './files.mjs';
import { adapterFiles, commonFiles } from './package-files.mjs';
import { validateProfile } from '../skills/etask/tools/project.mjs';

export async function validateProject(root) {
  const errors = [];
  async function inspect(filename, operation) {
    try {
      const content = await readFile(resolveInside(root, filename), 'utf8');
      return await operation(content);
    } catch (error) {
      errors.push(`${filename}: ${error.message}`);
      return undefined;
    }
  }
  function expect(condition, message) {
    if (!condition) errors.push(message);
  }

  let files;
  try {
    files = await listFiles(root);
  } catch (error) {
    return [error.message];
  }
  const manifest = await inspect('package.json', JSON.parse);
  const version = manifest?.version;
  expect(/^\d+\.\d+\.\d+$/.test(version ?? ''), 'package.json: invalid version');

  for (const filename of ['.codex-plugin/plugin.json', '.claude-plugin/plugin.json', 'gemini-extension.json']) {
    const adapter = await inspect(filename, JSON.parse);
    if (!adapter) continue;
    expect(adapter.name === 'etask', `${filename}: name must be etask`);
    expect(adapter.version === version, `${filename}: version differs from package.json`);
    if (filename.startsWith('.codex')) {
      expect(adapter.skills === './skills/', `${filename}: invalid skills directory`);
      expect(adapter.interface?.displayName === 'etask', `${filename}: missing displayName`);
    }
    if (filename === 'gemini-extension.json') {
      expect(adapter.contextFileName === 'adapters/gemini/GEMINI.md', `${filename}: invalid contextFileName`);
      if (adapter.contextFileName) {
        await inspect(adapter.contextFileName, content => {
          expect(content.includes('activate_skill'), `${adapter.contextFileName}: missing skill activation`);
        });
      }
    }
  }

  const codexMarket = await inspect('.agents/plugins/marketplace.json', JSON.parse);
  const codexEntry = codexMarket?.plugins?.find(plugin => plugin.name === 'etask');
  expect(codexMarket?.name === 'every-task', 'Codex marketplace: invalid name');
  expect(codexEntry?.source?.source === 'local' && codexEntry?.source?.path === './', 'Codex marketplace: invalid local source');
  expect(codexEntry?.policy?.installation === 'AVAILABLE', 'Codex marketplace: invalid installation policy');
  expect(codexEntry?.policy?.authentication === 'ON_INSTALL', 'Codex marketplace: invalid authentication policy');
  expect(codexEntry?.category === 'Developer Tools', 'Codex marketplace: missing category');

  const claudeMarket = await inspect('.claude-plugin/marketplace.json', JSON.parse);
  const claudeEntry = claudeMarket?.plugins?.find(plugin => plugin.name === 'etask');
  expect(claudeMarket?.name === 'every-task', 'Claude marketplace: invalid name');
  expect(claudeEntry?.source === './', 'Claude marketplace: invalid local source');
  expect(claudeEntry?.version === version, 'Claude marketplace: version differs from package.json');

  await inspect('skills/etask/SKILL.md', content => {
    const frontmatter = content.match(/^---\r?\n([\s\S]*?)\r?\n---(?:\r?\n|$)/);
    if (!frontmatter) throw new Error('missing YAML frontmatter');
    const metadata = parseYaml(frontmatter[1]);
    expect(metadata.name === 'etask', 'SKILL.md: invalid name');
    expect(typeof metadata.description === 'string' && metadata.description.length <= 1024 && metadata.description.length > 0, 'SKILL.md: invalid description');
    const allowed = new Set(['name', 'description', 'license', 'metadata', 'allowed-tools']);
    for (const key of Object.keys(metadata)) expect(allowed.has(key), `SKILL.md: unsupported frontmatter ${key}`);
  });
  await inspect('skills/etask/agents/openai.yaml', content => {
    const metadata = parseYaml(content);
    expect(metadata.policy?.allow_implicit_invocation === false, 'openai.yaml: explicit invocation required');
    expect(metadata.interface?.default_prompt?.includes('$etask'), 'openai.yaml: default prompt must invoke $etask');
  });
  await inspect('commands/etask.toml', content => {
    const command = parseToml(content);
    expect(typeof command.description === 'string', 'commands/etask.toml: missing description');
    expect(command.prompt?.includes('{{args}}') && command.prompt?.includes('activate_skill'), 'commands/etask.toml: missing skill dispatch or arguments');
    expect(!command.prompt?.includes('!{'), 'commands/etask.toml: unexpected shell execution');
  });

  const schema = await inspect('skills/etask/assets/config.schema.json', JSON.parse);
  const example = await inspect('skills/etask/assets/config.example.json', JSON.parse);
  if (schema && example) {
    try {
      const validator = new Ajv({ allErrors: true, strict: true }).compile(schema);
      expect(validator(example), `config.example.json: ${JSON.stringify(validator.errors)}`);
    } catch (error) {
      errors.push(`config.schema.json: ${error.message}`);
    }
  }
  const v2Schema = await inspect('skills/etask/assets/config-v2.schema.json', JSON.parse);
  if (v2Schema) {
    const validator = new Ajv({ allErrors: true, strict: true }).compile(v2Schema);
    for (const mode of ['local', 'github']) {
      const filename = `skills/etask/assets/config.${mode}.example.json`;
      const profile = await inspect(filename, JSON.parse);
      if (profile) {
        expect(validator(profile), `${filename}: ${JSON.stringify(validator.errors)}`);
        for (const error of validateProfile(profile)) errors.push(`${filename}: ${error}`);
      }
    }
  }

  for (const required of [...commonFiles, ...Object.values(adapterFiles).flat()]) {
    expect(files.includes(required), `Missing package resource: ${required}`);
  }
  for (const filename of files) {
    if (filename.endsWith('.md')) {
      await inspect(filename, async content => {
        for (const match of content.matchAll(/\[[^\]\n]*\]\(([^)\n]+)\)/g)) {
          const target = match[1];
          if (/^(?:[a-z]+:|#)/i.test(target)) continue;
          const resource = decodeURIComponent(target.split('#')[0]);
          try {
            await access(resolveInside(root, path.join(path.dirname(filename), resource)));
          } catch {
            errors.push(`${filename}: broken local link ${target}`);
          }
        }
      });
    } else if (filename.endsWith('.json')) {
      await inspect(filename, JSON.parse);
    } else if (/\.ya?ml$/.test(filename)) {
      await inspect(filename, parseYaml);
    } else if (filename.endsWith('.toml')) {
      await inspect(filename, parseToml);
    }
  }
  return errors;
}
