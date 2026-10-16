import Ajv from 'ajv';

export class SchemaCompileError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'SchemaCompileError';
  }
}

const ajv = new Ajv({ strict: false, allErrors: true });

/** Compiles a seller-supplied JSON Schema. Throws SchemaCompileError if invalid (M-01, P-10). */
export function compileSchema(schema: unknown) {
  if (typeof schema !== 'object' || schema === null) throw new SchemaCompileError('schema must be an object');
  try {
    return ajv.compile(schema as object);
  } catch (e) {
    throw new SchemaCompileError((e as Error).message);
  }
}
