import { Ajv } from 'ajv';

const ajv = new Ajv({ allErrors: true, strict: false });

export type ExecutionContext = {
  input: Record<string, unknown>;
  steps: Record<string, Record<string, unknown>>;
  previous: Record<string, unknown>;
};

export function assertJsonSchema(value: unknown, schema: Record<string, unknown>, label: string): void {
  const validate = ajv.compile(schema);
  if (!validate(value)) {
    throw new Error(`${label}: ${ajv.errorsText(validate.errors)}`);
  }
}

export function normalizeAllowedOrigins(values: string[], fallbackUrl: string): string[] {
  const candidates = values.length > 0 ? values : [fallbackUrl];
  return [...new Set(candidates.map((value) => {
    let url: URL;
    try {
      url = new URL(value);
    } catch {
      throw new Error(`Invalid HTTP_ALLOWED_ORIGINS entry: ${value}`);
    }
    if (!['http:', 'https:'].includes(url.protocol) || url.username || url.password
      || url.pathname !== '/' || url.search || url.hash) {
      throw new Error(`HTTP_ALLOWED_ORIGINS entries must be HTTP(S) origins without credentials or paths: ${value}`);
    }
    return url.origin;
  }))];
}

export function validateHttpTarget(value: string, allowedOrigins: string[]): URL {
  let target: URL;
  try {
    target = new URL(value);
  } catch {
    throw new Error('HTTP node URL must be an absolute URL.');
  }
  if (!['http:', 'https:'].includes(target.protocol) || target.username || target.password) {
    throw new Error('HTTP node URL must use HTTP(S) and cannot include credentials.');
  }
  if (!allowedOrigins.includes(target.origin)) {
    throw new Error(`HTTP node target origin is not allowed: ${target.origin}`);
  }
  return target;
}

function readPath(value: unknown, path: string): unknown {
  return path.split('.').filter(Boolean).reduce<unknown>((current, key) => {
    if (!current || typeof current !== 'object') {
      return undefined;
    }
    return (current as Record<string, unknown>)[key];
  }, value);
}

export function resolveTemplate(value: unknown, context: ExecutionContext): unknown {
  if (typeof value === 'string') {
    const exact = value.match(/^\{\{\s*(input|steps|previous)(?:\.([^{}]+))?\s*\}\}$/);
    if (exact) {
      return exact[1] === 'input'
        ? readPath(context.input, exact[2] ?? '')
        : exact[1] === 'previous'
          ? readPath(context.previous, exact[2] ?? '')
          : readPath(context.steps, exact[2] ?? '');
    }

    return value.replace(/\{\{\s*(input|steps|previous)\.([^{}]+)\s*\}\}/g, (_match, root: string, path: string) => {
      const source = root === 'input' ? context.input : root === 'previous' ? context.previous : context.steps;
      const resolved = readPath(source, path);
      return resolved === undefined ? '' : String(resolved);
    });
  }

  if (Array.isArray(value)) {
    return value.map((entry) => resolveTemplate(entry, context));
  }

  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value).map(([key, entry]) => [key, resolveTemplate(entry, context)]),
    );
  }

  return value;
}

export function compareCondition(left: unknown, operator: string, right: unknown): boolean {
  switch (operator) {
    case 'eq':
      return left === right;
    case 'neq':
      return left !== right;
    case 'gt':
      return Number(left) > Number(right);
    case 'gte':
      return Number(left) >= Number(right);
    case 'lt':
      return Number(left) < Number(right);
    case 'lte':
      return Number(left) <= Number(right);
    case 'contains':
      return Array.isArray(left)
        ? left.includes(right)
        : typeof left === 'string' && left.includes(String(right));
    case 'truthy':
      return Boolean(left);
    default:
      throw new Error(`Unsupported condition operator: ${operator}`);
  }
}
