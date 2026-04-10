import type { CollectionDefinition, CollectionSchema } from './types.js';

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function materializeDefaults<T>(schema: CollectionSchema<T>): Partial<T> | undefined {
  if (!schema.defaults) {
    return undefined;
  }

  return typeof schema.defaults === 'function'
    ? schema.defaults()
    : schema.defaults;
}

function applyDefaults<T>(value: unknown, defaults: Partial<T> | undefined): unknown {
  if (!defaults) {
    return value;
  }

  if (value === undefined) {
    return defaults;
  }

  if (isRecord(value) && isRecord(defaults)) {
    return {
      ...defaults,
      ...value,
    };
  }

  return value;
}

export function getCollectionSchema<T>(definition: CollectionDefinition<T>): CollectionSchema<T> | null {
  return definition.schema ?? null;
}

export function getSchemaVersion<T>(definition: CollectionDefinition<T>): number {
  return definition.schema?.version ?? definition.schemaVersion ?? 1;
}

export function normalizeCollectionItem<T>(
  definition: CollectionDefinition<T>,
  value: unknown,
  options: { fromVersion?: number } = {},
): T {
  const schema = getCollectionSchema(definition);
  if (!schema) {
    return value as T;
  }

  const fromVersion = options.fromVersion ?? schema.version;
  let next = value;

  if (fromVersion !== schema.version) {
    if (!schema.migrate) {
      throw new Error(`Collection schema migration required: ${fromVersion} -> ${schema.version}`);
    }
    next = schema.migrate(value, fromVersion);
  }

  next = applyDefaults(next, materializeDefaults(schema));

  if (schema.normalize) {
    next = schema.normalize(next as T);
  }

  if (schema.validate) {
    schema.validate(next as T);
  }

  return next as T;
}
