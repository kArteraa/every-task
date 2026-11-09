import { access, stat } from 'node:fs/promises';
import path from 'node:path';
import { constants } from 'node:fs';

export async function commandAvailable(command, cwd, environment = process.env) {
  const match = command.match(/^(?:"([^"]+)"|'([^']+)'|([^\s]+))/);
  if (!match) return false;
  const program = match[1] || match[2] || match[3];
  const extensions = process.platform === 'win32' ? ['', ...(environment.PATHEXT || '.COM;.EXE;.BAT;.CMD').split(';')] : [''];
  const roots = /[\\/]/.test(program) ? [''] : (environment.PATH || '').split(path.delimiter);
  for (const root of roots) {
    for (const extension of extensions) {
      const filename = root ? path.resolve(root, program + extension) : path.resolve(cwd, program + extension);
      try {
        await access(filename, process.platform === 'win32' ? constants.F_OK : constants.X_OK);
        if ((await stat(filename)).isFile()) return true;
      } catch (error) {
        if (!['ENOENT', 'EACCES', 'ENOTDIR'].includes(error.code)) throw error;
      }
    }
  }
  return false;
}
