import { board, checkpoint, check, doctor, moveTask, resume, status } from './workflow.mjs';

const args = process.argv.slice(2);
function option(name) {
  const index = args.indexOf(name);
  if (index < 0) return undefined;
  if (!args[index + 1] || args[index + 1].startsWith('--')) throw new Error(`Missing ${name} value`);
  return args.splice(index, 2)[1];
}

try {
  const persist = args.includes('--save');
  if (persist) args.splice(args.indexOf('--save'), 1);
  const root = option('--root');
  const note = option('--note');
  const pr = option('--pr');
  if (!root) throw new Error('Explicit --root <target-project> is required');
  const [command, id, detail, ...extra] = args;
  if (persist && command !== 'board') throw new Error('--save is only valid for board');
  if (extra.length || args.some(value => value.startsWith('--'))) throw new Error('Unknown arguments');
  let result;
  if (command === 'doctor' && !id) result = await doctor(root);
  else if (command === 'board' && !id) result = await board(root, persist);
  else if (command === 'status' && !detail) result = await status(root, id);
  else if (command === 'resume' && !detail) result = await resume(root, id);
  else if (command === 'checkpoint' && id && detail) result = await checkpoint(root, id, detail, note);
  else if (command === 'check' && id && detail) result = await check(root, id, detail);
  else if (command === 'move' && id && detail) result = await moveTask(root, id, detail, pr === undefined ? undefined : Number(pr));
  else throw new Error('Usage: doctor | board | status [ID] | resume ID | checkpoint ID review|sanitize --note TEXT | check ID KIND | move ID STATE [--pr N]; always pass --root PATH');
  console.log(typeof result === 'string' ? result : JSON.stringify(result, null, 2));
  if (result?.passed === false) process.exitCode = 1;
} catch (error) {
  console.error(error.message);
  process.exitCode = 1;
}
