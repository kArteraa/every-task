export const adapterFiles = {
  codex: ['.codex-plugin/plugin.json', '.agents/plugins/marketplace.json'],
  claude: ['.claude-plugin/plugin.json', '.claude-plugin/marketplace.json'],
  gemini: ['gemini-extension.json', 'commands/etask.toml', 'adapters/gemini/GEMINI.md']
};

export const commonFiles = [
  'README.md',
  'LICENSE',
  'docs/INSTALLATION.md',
  'docs/VALIDATION.md',
  'evals/scenarios.md',
  'skills/etask/SKILL.md',
  'skills/etask/agents/openai.yaml',
  'skills/etask/assets/config.schema.json',
  'skills/etask/assets/config.example.json',
  'skills/etask/assets/BACKLOG.example.md',
  'skills/etask/assets/QUEUE.example.md',
  'skills/etask/assets/MANUAL_CHECKS.example.md',
  'skills/etask/references/configuration.md',
  'skills/etask/references/git.md',
  'skills/etask/references/jira.md',
  'skills/etask/references/pipeline.md',
  'skills/etask/references/review.md',
  'skills/etask/references/setup.md'
];
