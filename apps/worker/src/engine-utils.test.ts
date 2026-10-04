import assert from 'node:assert/strict';
import test from 'node:test';
import {
  assertJsonSchema,
  compareCondition,
  normalizeAllowedOrigins,
  resolveTemplate,
  validateHttpTarget,
  type ExecutionContext,
} from './engine-utils.js';

const context: ExecutionContext = {
  input: { customer: { tier: 'gold' }, count: 3 },
  steps: { lookup: { output: { active: true } } },
  previous: { message: 'ready' },
};

test('resolves exact and interpolated workflow templates', () => {
  assert.equal(resolveTemplate('{{input.customer.tier}}', context), 'gold');
  assert.equal(resolveTemplate('tier={{input.customer.tier}}', context), 'tier=gold');
  assert.equal(resolveTemplate('{{steps.lookup.output.active}}', context), true);
  assert.deepEqual(resolveTemplate({ message: '{{previous.message}}' }, context), { message: 'ready' });
});

test('evaluates supported condition operators', () => {
  assert.equal(compareCondition(4, 'gt', 3), true);
  assert.equal(compareCondition('gold', 'eq', 'gold'), true);
  assert.equal(compareCondition(['a', 'b'], 'contains', 'b'), true);
  assert.equal(compareCondition('relay', 'contains', 'lay'), true);
  assert.equal(compareCondition(false, 'truthy', true), false);
});

test('rejects unknown condition operators', () => {
  assert.throws(() => compareCondition(1, 'approx', 1), /Unsupported condition operator/);
});

test('validates LLM output against JSON Schema', () => {
  const schema = { type: 'object', required: ['approved'], properties: { approved: { type: 'boolean' } } };
  assert.doesNotThrow(() => assertJsonSchema({ approved: true }, schema, 'Invalid output'));
  assert.throws(() => assertJsonSchema({ approved: 'yes' }, schema, 'Invalid output'), /Invalid output/);
});

test('limits HTTP nodes to explicitly allowed origins', () => {
  const origins = normalizeAllowedOrigins(['https://mock.example:8443'], 'http://localhost:4101');
  assert.equal(validateHttpTarget('https://mock.example:8443/effect', origins).pathname, '/effect');
  assert.throws(() => validateHttpTarget('http://127.0.0.1:8080/admin', origins), /not allowed/);
  assert.throws(() => validateHttpTarget('file:///etc/passwd', origins), /HTTP\(S\)/);
  assert.throws(() => validateHttpTarget('https://user:pass@mock.example:8443/path', origins), /credentials/);
});

test('rejects HTTP allowlist entries that are not bare origins', () => {
  assert.throws(
    () => normalizeAllowedOrigins(['https://example.com/private'], 'http://localhost:4101'),
    /without credentials or paths/,
  );
});
