import { archiveLimit } from './update-archive.mjs';

export const repository = 'kArteraa/every-task';
export const manifests = { codex: '.codex-plugin/plugin.json', claude: '.claude-plugin/plugin.json', gemini: 'gemini-extension.json' };

function versionParts(value) {
  if (typeof value !== 'string' || !/^(0|[1-9]\d*)\.(0|[1-9]\d*)\.(0|[1-9]\d*)$/.test(value)) throw new Error(`Explicit stable version required: ${value}`);
  return value.split('.').map(BigInt);
}

export function compareVersions(left, right) {
  const a = versionParts(left);
  const b = versionParts(right);
  for (let index = 0; index < 3; index++) if (a[index] !== b[index]) return a[index] > b[index] ? 1 : -1;
  return 0;
}

export function selectRelease(release, host) {
  if (!Object.hasOwn(manifests, host)) throw new Error('Explicit host required: codex, claude or gemini');
  if (release.draft !== false || release.prerelease !== false || typeof release.tag_name !== 'string' || !release.tag_name.startsWith('v')) throw new Error('Published stable release required');
  const version = release.tag_name.slice(1);
  versionParts(version);
  const assets = release.assets?.filter(asset => asset.name === `etask-${version}-${host}.zip`) || [];
  if (assets.length !== 1) throw new Error('Exactly one release archive required');
  const asset = assets[0];
  if (!Number.isSafeInteger(asset.size) || asset.size < 22 || asset.size > archiveLimit || !/^sha256:[a-f0-9]{64}$/.test(asset.digest || '')) throw new Error('Release asset size/checksum missing or invalid');
  return { version, tag: release.tag_name, asset, url: `https://github.com/${repository}/releases/tag/${release.tag_name}` };
}

export function verifyPackage(files, host, version, commit) {
  const json = name => {
    if (!files[name]) throw new Error(`Missing package file: ${name}`);
    return JSON.parse(files[name].toString('utf8'));
  };
  const metadata = json('RELEASE.json');
  if (metadata.version !== version || metadata.commit !== commit) throw new Error('Package version/commit mismatch');
  const manifest = json(manifests[host]);
  if (manifest.name !== 'etask' || manifest.version !== version) throw new Error('Plugin manifest mismatch');
  for (const name of ['CHANGELOG.md', 'skills/etask/SKILL.md', 'skills/etask/tools/etask.mjs']) if (!files[name]?.length) throw new Error(`Missing package resource: ${name}`);
  if (host !== 'gemini') {
    const marketplace = json(host === 'codex' ? '.agents/plugins/marketplace.json' : '.claude-plugin/marketplace.json');
    const entry = marketplace.plugins?.[0];
    if (marketplace.name !== 'every-task' || marketplace.plugins?.length !== 1 || entry?.name !== 'etask') throw new Error('Marketplace identity mismatch');
    if (host === 'codex' ? entry.source?.source !== 'local' || entry.source?.path !== './' : entry.source !== './' || entry.version !== version) throw new Error('Marketplace must reference this local package');
  }
}

export async function releaseCommit(execute, tag) {
  let ref = JSON.parse(await execute('gh', ['api', `repos/${repository}/git/ref/tags/${tag}`])).object;
  for (let depth = 0; depth < 5; depth++) {
    if (!/^[a-f0-9]{40}$/.test(ref?.sha || '')) throw new Error('Invalid release tag SHA');
    if (ref.type === 'commit') return ref.sha;
    if (ref.type !== 'tag') break;
    ref = JSON.parse(await execute('gh', ['api', `repos/${repository}/git/tags/${ref.sha}`])).object;
  }
  throw new Error('Release tag does not resolve to a commit');
}
