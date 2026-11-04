import { readFile } from 'node:fs/promises';
import Ajv from 'ajv';

const schema = JSON.parse(await readFile(new URL('../skills/etask/assets/config.schema.json', import.meta.url), 'utf8'));
const validate = new Ajv({ allErrors: true, strict: true }).compile(schema);

export function validateConfig(config) {
  if (validate(config)) return [];
  return validate.errors.map(error => `${error.instancePath || '/'} ${error.message}`);
}
