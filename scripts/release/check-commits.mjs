import { execFileSync } from 'node:child_process';
import { parseCommit } from './plugin.mjs';

const [base, head] = process.argv.slice(2);
if (![base, head].every(value => /^[a-f0-9]{40}$/.test(value || ''))) throw new Error('Two exact commit SHAs required');
const git = args => execFileSync('git', args, { encoding: 'utf8' }).trim();
const hashes = git(['rev-list', `${base}..${head}`]).split('\n').filter(Boolean);
if (!hashes.length) throw new Error('No commits to validate');
for (const hash of hashes) parseCommit({ hash, message: git(['show', '-s', '--format=%B', hash]) });
console.log(`Validated ${hashes.length} commit messages.`);
