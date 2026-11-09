import { inflateRawSync } from 'node:zlib';

export const archiveLimit = 20 * 1024 * 1024;
const expandedLimit = 50 * 1024 * 1024;

function checksum(bytes) {
  let value = 0xffffffff;
  for (const byte of bytes) {
    value ^= byte;
    for (let bit = 0; bit < 8; bit++) value = (value >>> 1) ^ (0xedb88320 & -(value & 1));
  }
  return (value ^ 0xffffffff) >>> 0;
}

function filename(bytes) {
  const name = new TextDecoder('utf-8', { fatal: true }).decode(bytes);
  const parts = name.split('/');
  if (!name || name.length > 240 || /[\\:\u0000-\u001f<>"|?*]/.test(name) || parts.some(part =>
    !part || part === '.' || part === '..' || /[. ]$/.test(part) || /^(con|prn|aux|nul|com[1-9]|lpt[1-9])(?:\.|$)/i.test(part))) {
    throw new Error(`Unsafe archive path: ${name}`);
  }
  if (parts.some(part => ['.git', 'node_modules'].includes(part.toLowerCase()))) throw new Error(`Unexpected archive path: ${name}`);
  return name;
}

export function readArchive(input) {
  const data = Buffer.from(input);
  if (data.length < 22 || data.length > archiveLimit) throw new Error('Archive size limit');
  let end = data.length - 22;
  while (end >= Math.max(0, data.length - 65557) && data.readUInt32LE(end) !== 0x06054b50) end--;
  if (end < Math.max(0, data.length - 65557) || end + 22 + data.readUInt16LE(end + 20) !== data.length) throw new Error('Invalid ZIP end');
  const count = data.readUInt16LE(end + 10);
  const start = data.readUInt32LE(end + 16);
  if (data.readUInt16LE(end + 4) || data.readUInt16LE(end + 6) || count !== data.readUInt16LE(end + 8) || !count || count > 500 || start + data.readUInt32LE(end + 12) !== end) throw new Error('Unsupported ZIP directory');
  const files = Object.create(null);
  const names = new Set();
  const regions = [];
  let position = start;
  let total = 0;
  for (let index = 0; index < count; index++) {
    if (position + 46 > end || data.readUInt32LE(position) !== 0x02014b50) throw new Error('Invalid ZIP entry');
    const flags = data.readUInt16LE(position + 8);
    const method = data.readUInt16LE(position + 10);
    const crc = data.readUInt32LE(position + 16);
    const packed = data.readUInt32LE(position + 20);
    const size = data.readUInt32LE(position + 24);
    const length = data.readUInt16LE(position + 28);
    const extra = data.readUInt16LE(position + 30);
    const comment = data.readUInt16LE(position + 32);
    const mode = (data.readUInt32LE(position + 38) >>> 16) & 0xf000;
    const offset = data.readUInt32LE(position + 42);
    const next = position + 46 + length + extra + comment;
    total += size;
    if (next > end || flags & ~0x800 || ![0, 8].includes(method) || data.readUInt16LE(position + 34) || ![0, 0x8000].includes(mode) || size > 5 * 1024 * 1024 || total > expandedLimit) throw new Error('Unsupported or oversized ZIP entry');
    const rawName = data.subarray(position + 46, position + 46 + length);
    const name = filename(rawName);
    const key = name.toLowerCase();
    if (names.has(key)) throw new Error(`Duplicate archive path: ${name}`);
    names.add(key);
    if (offset + 30 > start || data.readUInt32LE(offset) !== 0x04034b50) throw new Error('Invalid local ZIP header');
    if (data.readUInt16LE(offset + 6) !== flags || data.readUInt16LE(offset + 8) !== method || data.readUInt32LE(offset + 14) !== crc || data.readUInt32LE(offset + 18) !== packed || data.readUInt32LE(offset + 22) !== size || data.readUInt16LE(offset + 26) !== length) throw new Error('ZIP headers disagree');
    const content = offset + 30 + length + data.readUInt16LE(offset + 28);
    if (content + packed > start || !data.subarray(offset + 30, offset + 30 + length).equals(rawName)) throw new Error('Invalid ZIP data range');
    regions.push([offset, content + packed]);
    const compressed = data.subarray(content, content + packed);
    const bytes = method === 0 ? Buffer.from(compressed) : inflateRawSync(compressed, { maxOutputLength: Math.max(1, size) });
    if (bytes.length !== size || checksum(bytes) !== crc) throw new Error('ZIP integrity mismatch');
    files[name] = bytes;
    position = next;
  }
  if (position !== end) throw new Error('Invalid ZIP directory length');
  regions.sort((a, b) => a[0] - b[0]);
  for (let index = 1; index < regions.length; index++) if (regions[index][0] < regions[index - 1][1]) throw new Error('Overlapping ZIP entries');
  for (const name of names) {
    const parts = name.split('/');
    for (let length = 1; length < parts.length; length++) if (names.has(parts.slice(0, length).join('/'))) throw new Error('Archive path collision');
  }
  return files;
}
