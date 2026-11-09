import { readFileSync } from 'node:fs';
import { readFile, realpath, stat } from 'node:fs/promises';
import path from 'node:path';

const schema = JSON.parse(readFileSync(new URL('../assets/config-v2.schema.json', import.meta.url), 'utf8'));

function inspect(value, rule, location = '') {
  if (rule.$ref) return inspect(value, schema.definitions[rule.$ref.split('/').at(-1)], location);
  const errors = [];
  const fail = message => errors.push(`${location || '/'}: ${message}`);
  if (rule.oneOf || rule.anyOf) {
    const choices = (rule.oneOf || rule.anyOf).map(option => inspect(value, option, location));
    const matches = choices.filter(result => !result.length).length;
    if (rule.oneOf ? matches !== 1 : matches === 0) fail(`invalid choice (${choices.flat().join('; ')})`);
    return errors;
  }
  if ('const' in rule && value !== rule.const) fail(`must equal ${rule.const}`);
  if (rule.enum && !rule.enum.includes(value)) fail('unknown value');
  if (rule.type) {
    const type = value === null ? 'null' : Array.isArray(value) ? 'array' : typeof value;
    if (type !== rule.type) return [`${location}: expected ${rule.type}`];
  }
  if (typeof value === 'string') {
    if (rule.minLength && value.length < rule.minLength) fail('empty string');
    if (rule.pattern && !new RegExp(rule.pattern).test(value)) fail('invalid pattern');
  }
  if (rule.type === 'object') {
    for (const name of rule.required || []) if (!(name in value)) fail(`missing ${name}`);
    for (const [name, entry] of Object.entries(value)) {
      if (!(name in rule.properties)) {
        if (rule.additionalProperties === false) fail(`unknown field ${name}`);
      } else errors.push(...inspect(entry, rule.properties[name], `${location}/${name}`));
    }
  }
  if (rule.type === 'array') {
    if (rule.uniqueItems && new Set(value.map(entry => JSON.stringify(entry))).size !== value.length) fail('duplicate entries');
    value.forEach((entry, index) => errors.push(...inspect(entry, rule.items, `${location}/${index}`)));
  }
  return errors;
}

export function validateProfile(config) {
  const errors = inspect(config, schema);
  if (!errors.length) {
    const { workflow } = config;
    if (workflow.git && (!workflow.integrationBranch || !workflow.productionBranch)) errors.push('Git requires explicit branch names');
    if (!workflow.git && (workflow.integrationBranch || workflow.productionBranch)) errors.push('Branches require Git');
    if (workflow.git && workflow.integrationBranch === workflow.productionBranch) errors.push('Integration and production branches must differ');
    const documents = [config.project.goal, ...Object.values(config.paths).filter(Boolean)].map(value => path.posix.normalize(value));
    if (new Set(documents.map(value => value.toLowerCase())).size !== documents.length) errors.push('Document paths must be distinct');
    if (documents.some(value => /^(?:\.etask|\.git|node_modules|dist|\.superpowers)(?:\/|$)/i.test(value))) errors.push('Document paths cannot overwrite internal or excluded directories');
  }
  return errors;
}

export async function inside(root, relative) {
  const absolute = path.resolve(root, relative);
  function contained(candidate) {
    const resolved = path.relative(root, candidate);
    return resolved === '' || (!resolved.startsWith(`..${path.sep}`) && resolved !== '..' && !path.isAbsolute(resolved));
  }
  if (!contained(absolute)) throw new Error(`Path escapes project: ${relative}`);
  let ancestor = absolute;
  while (true) {
    try {
      if (!contained(await realpath(ancestor))) throw new Error(`Symlink escapes project: ${relative}`);
      break;
    } catch (error) {
      if (error.code !== 'ENOENT') throw error;
      ancestor = path.dirname(ancestor);
    }
  }
  return absolute;
}

export async function loadProject(directory) {
  const root = await realpath(directory);
  const configFile = await inside(root, '.etask/config.json');
  const config = JSON.parse(await readFile(configFile, 'utf8'));
  if (config.version === 1) throw new Error('Configuration v1 requires an explicit setup migration to v2');
  const errors = validateProfile(config);
  if (errors.length) throw new Error(errors.join('\n'));
  config.project.goal = path.posix.normalize(config.project.goal);
  config.paths = Object.fromEntries(Object.entries(config.paths).map(([key, value]) => [key, value === null ? null : path.posix.normalize(value)]));
  for (const relative of [config.project.goal, ...Object.values(config.paths).filter(Boolean)]) await inside(root, relative);
  const goal = await readFile(await inside(root, config.project.goal), 'utf8');
  if (!goal.replace(/^#.*$/gm, '').trim()) throw new Error('Project goal must describe an outcome');
  for (const entry of Object.values(config.checks)) {
    if (entry.cwd && !(await stat(await inside(root, entry.cwd))).isDirectory()) throw new Error(`Invalid cwd ${entry.cwd}`);
  }
  return { root, config, goal };
}
