import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import test from 'node:test';
import dotenv from 'dotenv';
import { PrismaClient } from '@prisma/client';
import { fileURLToPath } from 'node:url';

dotenv.config({ path: fileURLToPath(new URL('../../../.env', import.meta.url)) });

const enabled = process.env.RELAY_INTEGRATION_TESTS === '1';
const apiBaseUrl = process.env.RELAY_API_BASE_URL ?? 'http://localhost:4000';
const mockWorldUrl = process.env.RELAY_MOCK_WORLD_URL ?? 'http://localhost:4101';

type IntegrationRun = {
  id: string;
  status: string;
  approvals: Array<{ message: string | null }>;
  workflowSnapshot: { nodes: unknown[] };
  traces: Array<{ event: string }>;
};

type ApiBody = {
  workflow?: { status: string };
  run?: IntegrationRun;
  runId?: string;
  traces?: Array<{ response?: { runId?: string } }>;
};

type ApiResult = { status: number; body: ApiBody | null };

async function request(
  baseUrl: string,
  path: string,
  options: { method?: string; body?: unknown; headers?: Record<string, string> } = {},
): Promise<ApiResult> {
  const token = process.env.RELAY_API_TOKEN;
  const response = await fetch(`${baseUrl}${path}`, {
    method: options.method ?? 'GET',
    headers: {
      ...(options.body === undefined ? {} : { 'content-type': 'application/json' }),
      ...(token ? { authorization: `Bearer ${token}` } : {}),
      ...options.headers,
    },
    body: options.body === undefined ? undefined : JSON.stringify(options.body),
  });
  const body = response.status === 204 ? null : await response.json() as ApiBody;
  return { status: response.status, body };
}

function requireRunId(body: ApiBody | null): string {
  const runId = body?.run?.id;
  if (typeof runId !== 'string') {
    throw new Error('API response did not include a run ID.');
  }
  return runId;
}

async function waitForRun(runId: string, expected: 'SUCCEEDED' | 'FAILED'): Promise<IntegrationRun> {
  for (let attempt = 0; attempt < 120; attempt += 1) {
    const response = await request(apiBaseUrl, `/api/runs/${runId}`);
    assert.equal(response.status, 200);
    const run = response.body?.run;
    if (run?.status === expected) {
      return run;
    }
    if (run && ['SUCCEEDED', 'FAILED', 'CANCELLED'].includes(run.status)) {
      throw new Error(`Run ${runId} ended as ${run.status}; expected ${expected}.`);
    }
    await new Promise((resolve) => setTimeout(resolve, 250));
  }
  throw new Error(`Run ${runId} did not reach ${expected} in time.`);
}

test('local API and worker cover lifecycle, approvals, webhooks, schema validation and step limits', {
  skip: !enabled,
}, async () => {
  const testDatabaseUrl = new URL(
    process.env.RELAY_TEST_DATABASE_URL
      ?? process.env.DATABASE_URL
      ?? 'postgresql://relay:relay@127.0.0.1:5432/relay',
  );
  if (testDatabaseUrl.hostname === 'localhost') {
    testDatabaseUrl.hostname = '127.0.0.1';
  }
  const prisma = new PrismaClient({
    datasources: {
      db: { url: testDatabaseUrl.toString() },
    },
  });
  const suffix = crypto.randomUUID();
  const workflowIds = [
    `integration-approval-${suffix}`,
    `integration-webhook-${suffix}`,
    `integration-schema-${suffix}`,
    `integration-step-cap-${suffix}`,
  ];

  try {
    assert.equal((await request(apiBaseUrl, '/health')).status, 200, 'API must be reachable');

    const approvalNodes = [{
      id: 'protected-effect',
      type: 'http_request',
      label: 'Protected effect',
      args: { requiresApproval: true, approvalMessage: 'Approve {{input.customer}}' },
    }];
    let response = await request(apiBaseUrl, '/api/workflows', {
      method: 'POST',
      body: { id: workflowIds[0], name: 'Integration approval', nodes: approvalNodes },
    });
    assert.equal(response.status, 201);
    assert.equal(response.body?.workflow?.status, 'DRAFT');
    assert.equal((await request(apiBaseUrl, `/api/workflows/${workflowIds[0]}/run`, {
      method: 'POST',
      body: { input: { customer: 'integration-customer' } },
    })).status, 409);
    response = await request(apiBaseUrl, `/api/workflows/${workflowIds[0]}/publish`, { method: 'POST', body: {} });
    assert.equal(response.status, 200);
    assert.equal(response.body?.workflow?.status, 'PUBLISHED');
    assert.equal((await request(apiBaseUrl, `/api/workflows/${workflowIds[0]}`, {
      method: 'PUT',
      body: { name: 'Modified published workflow', nodes: approvalNodes },
    })).status, 409);
    assert.equal((await request(apiBaseUrl, `/api/workflows/${workflowIds[0]}`, { method: 'DELETE' })).status, 409);

    response = await request(apiBaseUrl, `/api/workflows/${workflowIds[0]}/run`, {
      method: 'POST',
      body: { input: { customer: 'integration-customer' } },
    });
    assert.equal(response.status, 202);
    const protectedRunId = requireRunId(response.body);
    const waitingRun = await (async () => {
      for (let attempt = 0; attempt < 120; attempt += 1) {
        const current = await request(apiBaseUrl, `/api/runs/${protectedRunId}`);
        assert.equal(current.status, 200);
        if (current.body?.run?.status === 'WAITING_FOR_APPROVAL') {
          return current.body.run;
        }
        await new Promise((resolve) => setTimeout(resolve, 250));
      }
      throw new Error(`Run ${protectedRunId} did not pause for approval.`);
    })();
    const approvalMessage = waitingRun.approvals[0]?.message;
    assert.ok(approvalMessage);
    assert.match(approvalMessage, /integration-customer/);
    const effectsBeforeApproval = await request(mockWorldUrl, '/mock/traces');
    assert.equal(effectsBeforeApproval.status, 200);
    assert.equal(
      effectsBeforeApproval.body?.traces?.filter((effect) => effect.response?.runId === protectedRunId).length,
      0,
    );
    response = await request(apiBaseUrl, `/api/runs/${protectedRunId}/approve`, {
      method: 'POST',
      body: { approved: true },
    });
    assert.equal(response.status, 200);
    const completedRun = await waitForRun(protectedRunId, 'SUCCEEDED');
    assert.deepEqual(completedRun.workflowSnapshot.nodes, approvalNodes);
    const effectsAfterApproval = await request(mockWorldUrl, '/mock/traces');
    assert.equal(
      effectsAfterApproval.body?.traces?.filter((effect) => effect.response?.runId === protectedRunId).length,
      1,
    );

    const webhookSecret = `integration-secret-${suffix}`;
    response = await request(apiBaseUrl, '/api/workflows', {
      method: 'POST',
      body: {
        id: workflowIds[1],
        name: 'Integration webhook',
        webhookSecret,
        nodes: [{ id: 'notify', type: 'notify', label: 'Webhook received' }],
      },
    });
    assert.equal(response.status, 201);
    assert.equal((await request(apiBaseUrl, `/api/webhooks/${workflowIds[1]}`, {
      method: 'POST',
      body: {},
    })).status, 409);
    assert.equal((await request(apiBaseUrl, `/api/workflows/${workflowIds[1]}/publish`, {
      method: 'POST',
      body: {},
    })).status, 200);
    assert.equal((await request(apiBaseUrl, `/api/webhooks/${workflowIds[1]}`, {
      method: 'POST',
      body: {},
    })).status, 401);
    response = await request(apiBaseUrl, `/api/webhooks/${workflowIds[1]}`, {
      method: 'POST',
      headers: { 'x-relay-webhook-secret': webhookSecret },
      body: { source: 'integration-test' },
    });
    assert.equal(response.status, 202);
    const webhookRunId = response.body?.runId;
    if (typeof webhookRunId !== 'string') {
      throw new Error('Webhook response did not include a run ID.');
    }
    await waitForRun(webhookRunId, 'SUCCEEDED');

    response = await request(apiBaseUrl, '/api/workflows', {
      method: 'POST',
      body: {
        id: workflowIds[2],
        name: 'Integration JSON Schema',
        nodes: [{
          id: 'llm',
          type: 'llm',
          label: 'Invalid mock response',
          args: { mockResponse: 7, schema: { type: 'string' } },
        }],
      },
    });
    assert.equal(response.status, 201);
    assert.equal((await request(apiBaseUrl, `/api/workflows/${workflowIds[2]}/publish`, {
      method: 'POST',
      body: {},
    })).status, 200);
    response = await request(apiBaseUrl, `/api/workflows/${workflowIds[2]}/run`, { method: 'POST', body: {} });
    assert.equal(response.status, 202);
    const invalidOutputRun = await waitForRun(requireRunId(response.body), 'FAILED');
    assert.ok(invalidOutputRun.traces.some((trace) => trace.event === 'step_failed'));

    response = await request(apiBaseUrl, '/api/workflows', {
      method: 'POST',
      body: {
        id: workflowIds[3],
        name: 'Integration step limit',
        maxSteps: 2,
        nodes: [
          {
            id: 'loop',
            type: 'condition',
            label: 'Loop',
            args: { left: true, operator: 'truthy', onTrueNodeId: 'loop', onFalseNodeId: 'finish' },
          },
          { id: 'finish', type: 'notify', label: 'Finished' },
        ],
      },
    });
    assert.equal(response.status, 201);
    assert.equal((await request(apiBaseUrl, `/api/workflows/${workflowIds[3]}/publish`, {
      method: 'POST',
      body: {},
    })).status, 200);
    response = await request(apiBaseUrl, `/api/workflows/${workflowIds[3]}/run`, { method: 'POST', body: {} });
    assert.equal(response.status, 202);
    const cappedRun = await waitForRun(requireRunId(response.body), 'FAILED');
    assert.ok(cappedRun.traces.some((trace) => trace.event === 'step_limit_exceeded'));
  } finally {
    const runs = await prisma.run.findMany({
      where: { workflowId: { in: workflowIds } },
      select: { idempotencyKeys: { select: { key: true } } },
    });
    const keys = runs.flatMap((run) => run.idempotencyKeys.map((entry) => entry.key));
    if (keys.length > 0) {
      await prisma.mockEffect.deleteMany({ where: { key: { in: keys } } });
    }
    await prisma.workflow.deleteMany({ where: { id: { in: workflowIds } } });
    await prisma.$disconnect();
  }
});
