import { execFileSync } from 'node:child_process';
import path from 'node:path';

export async function executeHost(program, args) {
  if (!['gh', 'codex', 'claude', 'gemini'].includes(program)) throw new Error('Unsupported update executable');
  const options = { encoding: 'utf8', stdio: ['inherit', 'pipe', 'pipe'], timeout: 300000, maxBuffer: 8 * 1024 * 1024, windowsHide: true };
  try {
    if (process.platform === 'win32') return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '$taskArgs = ConvertFrom-Json $env:ETASK_UPDATE_ARGS; & $env:ETASK_UPDATE_PROGRAM @taskArgs; exit $LASTEXITCODE'], {
      ...options, env: { ...process.env, ETASK_UPDATE_PROGRAM: program, ETASK_UPDATE_ARGS: JSON.stringify(args) }
    }).trim();
    return execFileSync(program, args, options).trim();
  } catch (error) { throw new Error(`${program}: ${error.stderr?.toString().trim() || error.message}`); }
}

export function hostAdapter(host, scope, execute, cwd = process.cwd()) {
  if (!['codex', 'claude', 'gemini'].includes(host)) throw new Error('Explicit --host codex|claude|gemini required');
  if (!['user', 'project', 'local'].includes(scope) || (host !== 'claude' && scope !== 'user')) throw new Error('Explicit supported installation scope required');
  const listArgs = host === 'codex' ? ['plugin', 'list', '--marketplace', 'every-task', '--json'] : host === 'claude' ? ['plugin', 'list', '--json'] : ['extensions', 'list', '--output-format', 'json'];
  return {
    async inspect() {
      const raw = JSON.parse(await execute(host, listArgs));
      const items = host === 'codex' ? raw.installed : raw;
      if (!Array.isArray(items)) throw new Error('Unsupported host installation list');
      const matches = items.filter(item => host === 'codex' ? item.pluginId === 'etask@every-task' && item.installed === true : host === 'claude' ? item.id === 'etask@every-task' && item.scope === scope : item.name === 'etask');
      if (matches.length !== 1) throw new Error('Exactly one existing etask installation required in the selected scope');
      const item = matches[0];
      if (host === 'claude' && scope !== 'user') {
        const samePath = value => process.platform === 'win32' ? path.resolve(value).toLowerCase() : path.resolve(value);
        if (!item.projectPath || samePath(item.projectPath) !== samePath(cwd)) throw new Error('Claude installation belongs to another project');
      }
      if (host === 'gemini' ? item.isActive !== true : item.enabled !== true) throw new Error('Disabled or managed installation requires an explicit host-specific decision');
      return item;
    },
    async registration() {
      if (host === 'gemini') return null;
      const raw = JSON.parse(await execute(host, ['plugin', 'marketplace', 'list', '--json']));
      const items = host === 'codex' ? raw.marketplaces : raw;
      if (!Array.isArray(items)) throw new Error('Unsupported marketplace list');
      const matches = items.filter(item => item.name === 'every-task');
      if (matches.length !== 1) throw new Error('Ambiguous marketplace registration');
      return matches[0];
    },
    async install(directory) {
      if (host === 'gemini') {
        await execute(host, ['extensions', 'install', directory, '--consent']);
        return;
      }
      const scoped = host === 'claude' ? ['--scope', scope] : [];
      await execute(host, ['plugin', 'marketplace', 'remove', 'every-task', ...scoped]);
      await execute(host, ['plugin', 'marketplace', 'add', directory, ...scoped]);
      await execute(host, ['plugin', host === 'codex' ? 'add' : 'update', 'etask@every-task', ...scoped, '--json']);
    }
  };
}
