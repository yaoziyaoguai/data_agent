import { Ajv2020 } from 'ajv/dist/2020.js';
import schema from './schema.json' with { type: 'json' };

const ajv = new Ajv2020({ strict: false, allErrors: true });
const validators = new Map(Object.keys(schema.$defs).map(name => [name, ajv.compile({
  ...schema, $id: undefined, properties: undefined, required: undefined,
  type: undefined, additionalProperties: undefined, $ref: '#/$defs/' + name,
})]));

export function validateContract(name: string, value: unknown): void {
  const validator = validators.get(name);
  if (!validator || !validator(value)) throw new Error('invalid_input: ' + name);
}
export function decodeContract<T>(name:string,value:unknown):T {validateContract(name,value);return value as T;}
