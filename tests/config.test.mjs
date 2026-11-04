import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import { validateConfig } from '../scripts/config.mjs';

const example = JSON.parse(await readFile(new URL('../skills/etask/assets/config.example.json', import.meta.url)));

test('accepts a local workflow and a configured Jira workflow', () => {
  assert.deepEqual(validateConfig(example), []);
  const jira = { ...example, jira: {
    enabled: true,
    site: 'https://example.atlassian.net',
    projectKey: 'DEMO',
    lookup: 'key',
    statuses: { inProgress: 'In Progress', inReview: 'In Review', done: 'Done' }
  } };
  assert.deepEqual(validateConfig(jira), []);
});

test('rejects incomplete checks instead of silently skipping them', () => {
  for (const value of [{}, { skip: '' }, { command: 'npm test' }, { command: 'npm test', cwd: '.', skip: 'N/A' }]) {
    const config = structuredClone(example);
    config.checks.test = value;
    assert.notDeepEqual(validateConfig(config), [], JSON.stringify(value));
  }
  const config = structuredClone(example);
  config.checks.build = { skip: 'Documentation-only repository with no build step.' };
  assert.deepEqual(validateConfig(config), []);
});

test('rejects unknown fields and credentials', () => {
  assert.notDeepEqual(validateConfig({ ...example, apiToken: 'example' }), []);
  assert.notDeepEqual(validateConfig({ ...example, jira: { enabled: false, token: 'example' } }), []);
});

test('requires Jira mappings only when enabled', () => {
  assert.notDeepEqual(validateConfig({ ...example, jira: { enabled: true } }), []);
  assert.deepEqual(validateConfig({ ...example, jira: { enabled: false } }), []);
});

test('rejects absolute paths and paths escaping the project', () => {
  for (const value of ['../outside', '/tmp/test', 'C:\\test', 'docs/../../test', 'docs\\test']) {
    const config = structuredClone(example);
    config.paths.backlog = value;
    assert.notDeepEqual(validateConfig(config), [], value);
  }
});

test('accepts project-relative Unicode paths with spaces', () => {
  const config = structuredClone(example);
  config.paths.backlog = 'Документы проекта/Задачи.md';
  config.checks.test.cwd = 'код приложения';
  assert.deepEqual(validateConfig(config), []);
});
