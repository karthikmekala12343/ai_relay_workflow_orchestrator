import crypto from 'node:crypto';
import dotenv from 'dotenv';
import OpenAI from 'openai';
import { Queue, Worker } from 'bullmq';
import { Prisma } from '@prisma/client';
import {
  assertJsonSchema,
  compareCondition,
  normalizeAllowedOrigins,
  resolveTemplate,
  validateHttpTarget,
  type ExecutionContext,
} from './engine-utils.js';
import {
  createApproval,
  createIdempotencyRecord,
  completeRunStep,
  beginRunStepAttempt,
  ensureApproval,
  getApproval,
  getIdempotencyRecord,
  getWorkflowRun,
  incrementRunStepCount,
  prisma,
  recordTrace,
  setStepStatus,
  updateRunStatus,
  upsertRunStep,
} from './db.js';

dotenv.config();

const queueName = 'relay-jobs';
const redisUrl = process.env.REDIS_URL ?? 'redis://localhost:6379';
const mockWorldUrl = process.env.MOCK_WORLD_URL ?? 'http://localhost:4101';
const llmProvider = process.env.LLM_PROVIDER ?? 'mock';
const allowedHttpOrigins = normalizeAllowedOrigins(
  (process.env.HTTP_ALLOWED_ORIGINS ?? '').split(',').map((origin) => origin.trim()).filter(Boolean),
  mockWorldUrl,
);

interface WorkflowNode {
  id: string;
  type: string;
  label: string;
  args?: Record<string, unknown>;
  nextNodeId?: string;
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function parseWorkflowNodes(value: unknown): WorkflowNode[] {
  if (!Array.isArray(value)) {
    throw new Error('Workflow nodes must be an array.');
  }

  return value.map((entry) => {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error('Workflow contains an invalid node.');
    }

    const node = entry as Record<string, unknown>;
    if (typeof node.id !== 'string' || typeof node.type !== 'string' || typeof node.label !== 'string') {
      throw new Error('Every workflow node needs a string id, type, and label.');
    }

    return {
      id: node.id,
      type: node.type,
      label: node.label,
      args: node.args && typeof node.args === 'object' && !Array.isArray(node.args)
        ? node.args as Record<string, unknown>
        : {},
      nextNodeId: typeof node.nextNodeId === 'string' ? node.nextNodeId : undefined,
    };
  });
}

function getNextNodeId(node: WorkflowNode, output: Record<string, unknown>): string | null {
  if (node.type === 'condition') {
    const route = output.condition ? node.args?.onTrueNodeId : node.args?.onFalseNodeId;
    if (typeof route === 'string') {
      return route;
    }
  }
  return node.nextNodeId ?? null;
}

async function executeLlmNode(node: WorkflowNode, context: ExecutionContext) {
  const args = resolveTemplate(node.args ?? {}, context) as Record<string, unknown>;
  const schema = args.schema && typeof args.schema === 'object' && !Array.isArray(args.schema)
    ? args.schema as Record<string, unknown>
    : undefined;

  if (llmProvider === 'mock') {
    const content = args.mockResponse ?? { text: String(args.prompt ?? node.label) };
    if (schema) {
      assertJsonSchema(content, schema, 'Mock LLM output failed JSON Schema validation');
    }
    return { output: { ok: true, model: 'mock-llm', content }, tokenCount: 0 };
  }

  if (llmProvider !== 'openai') {
    throw new Error(`Unsupported LLM_PROVIDER: ${llmProvider}`);
  }

  const apiKey = process.env.OPENAI_API_KEY;
  if (!apiKey) {
    throw new Error('OPENAI_API_KEY is required when LLM_PROVIDER=openai.');
  }

  const client = new OpenAI({
    apiKey,
    baseURL: process.env.OPENAI_BASE_URL || undefined,
    timeout: 30_000,
  });
  const model = String(args.model ?? process.env.OPENAI_MODEL ?? 'gpt-4o-mini');
  const responseFormat = schema
    ? {
        type: 'json_schema' as const,
        json_schema: {
          name: `relay_${node.id.replace(/[^a-zA-Z0-9_-]/g, '_')}`,
          strict: true,
          schema,
        },
      }
    : { type: 'json_object' as const };
  const completion = await client.chat.completions.create({
    model,
    messages: [
      { role: 'system', content: 'Return data for the current workflow step. Do not choose or alter workflow routing.' },
      { role: 'user', content: String(args.prompt ?? '') },
    ],
    response_format: responseFormat,
  });
  const text = completion.choices[0]?.message.content;
  if (!text) {
    throw new Error('LLM provider returned an empty response.');
  }

  let content: unknown;
  try {
    content = JSON.parse(text);
  } catch {
    throw new Error('LLM provider returned invalid JSON.');
  }

  if (schema) {
    assertJsonSchema(content, schema, 'LLM output failed JSON Schema validation');
  }

  return {
    output: { ok: true, model, content },
    tokenCount: completion.usage?.total_tokens ?? 0,
  };
}

async function executeHttpNode(runId: string, node: WorkflowNode, context: ExecutionContext) {
  const args = resolveTemplate(node.args ?? {}, context) as Record<string, unknown>;
  const key = crypto.createHash('sha256').update(`${runId}:${node.id}`).digest('hex');
  const saved = await getIdempotencyRecord(runId, key);

  if (saved?.response) {
    return { ok: true, idempotencyKey: key, response: saved.response };
  }

  const url = validateHttpTarget(String(args.url ?? `${mockWorldUrl}/mock/effect`), allowedHttpOrigins);
  const method = String(args.method ?? 'POST').toUpperCase();
  const body = args.body ?? {
    runId,
    nodeId: node.id,
    idempotencyKey: key,
    value: context.previous,
  };
  const headers = {
    ...(args.headers && typeof args.headers === 'object' ? args.headers as Record<string, string> : {}),
    'Idempotency-Key': key,
  };
  const response = await fetch(url, {
    method,
    headers: {
      ...headers,
      ...(body !== undefined ? { 'content-type': 'application/json' } : {}),
    },
    body: body === undefined || method === 'GET' || method === 'HEAD'
      ? undefined
      : JSON.stringify(body),
    signal: AbortSignal.timeout(Number(args.timeoutMs ?? 15000)),
    redirect: 'error',
  });
  const responseText = await response.text();
  let responseBody: unknown = responseText;
  try {
    responseBody = responseText ? JSON.parse(responseText) : null;
  } catch {
    responseBody = responseText;
  }
  const result = {
    status: response.status,
    headers: Object.fromEntries(response.headers.entries()),
    body: responseBody,
  };

  if (!response.ok) {
    throw new Error(`HTTP node failed with status ${response.status}: ${responseText.slice(0, 500)}`);
  }

  await createIdempotencyRecord(runId, key, toJson(result));
  return { ok: true, idempotencyKey: key, response: result };
}

interface NodeExecutionResult {
  output: Record<string, unknown>;
  approvalRequired?: boolean;
  tokenCount?: number;
}

async function executeNode(runId: string, node: WorkflowNode, context: ExecutionContext): Promise<NodeExecutionResult> {
  const args = resolveTemplate(node.args ?? {}, context) as Record<string, unknown>;

  switch (node.type) {
    case 'notify':
      return { output: { ok: true, message: String(args.message ?? 'Notification sent') } };
    case 'delay': {
      const ms = Number(args.ms ?? 100);
      if (!Number.isFinite(ms) || ms < 0 || ms > 30000) {
        throw new Error('Delay duration must be between 0 and 30000 milliseconds.');
      }
      await new Promise((resolve) => setTimeout(resolve, ms));
      return { output: { ok: true, delayMs: ms } };
    }
    case 'condition': {
      const left = args.left;
      const right = args.right;
      const operator = String(args.operator ?? 'eq');
      return {
        output: {
          ok: true,
          condition: compareCondition(left, operator, right),
          left,
          operator,
          right,
        },
      };
    }
    case 'llm':
      return executeLlmNode(node, context);
    case 'http_request':
      return { output: await executeHttpNode(runId, node, context) };
    case 'approval':
      await createApproval(runId, node.id, String(args.message ?? 'Awaiting approval'));
      return { approvalRequired: true, output: { approvalRequired: true } };
    default:
      throw new Error(`Unsupported workflow node type: ${node.type}`);
  }
}

async function executeRun(runId: string) {
  let run = await getWorkflowRun(runId);
  if (!run) {
    throw new Error(`Run not found: ${runId}`);
  }

  if (['SUCCEEDED', 'FAILED', 'CANCELLED', 'WAITING_FOR_APPROVAL'].includes(run.status)) {
    return { ok: true, status: run.status, runId };
  }

  const snapshot = run.workflowSnapshot as Record<string, unknown>;
  const nodes = parseWorkflowNodes(snapshot.nodes);
  const nodesById = new Map(nodes.map((node) => [node.id, node]));
  if (nodesById.size !== nodes.length) {
    throw new Error('Workflow node IDs must be unique.');
  }
  for (const node of nodes) {
    const targets = [node.nextNodeId, node.args?.onTrueNodeId, node.args?.onFalseNodeId]
      .filter((target): target is string => typeof target === 'string');
    for (const target of targets) {
      if (!nodesById.has(target)) {
        throw new Error(`Node ${node.id} routes to unknown node ${target}.`);
      }
    }
  }

  let currentNodeId: string | null = run.currentNodeId ?? nodes[0]?.id ?? null;
  if (!currentNodeId) {
    await updateRunStatus(runId, 'SUCCEEDED', null);
    return { ok: true, status: 'SUCCEEDED', runId };
  }

  await updateRunStatus(runId, 'RUNNING', currentNodeId);

  while (currentNodeId) {
    run = await getWorkflowRun(runId);
    if (!run) {
      throw new Error(`Run disappeared during execution: ${runId}`);
    }

    const node = nodesById.get(currentNodeId);
    if (!node) {
      throw new Error(`Current node does not exist in workflow: ${currentNodeId}`);
    }

    const context: ExecutionContext = {
      input: run.createdInput && typeof run.createdInput === 'object' && !Array.isArray(run.createdInput)
        ? run.createdInput as Record<string, unknown>
        : {},
      steps: Object.fromEntries(
        run.steps
          .filter((step) => step.status === 'SUCCEEDED' && step.output && typeof step.output === 'object')
          .map((step) => [step.nodeId, step.output as Record<string, unknown>]),
      ),
      previous: {},
    };
    const priorOutputs = run.steps.filter((step) => step.status === 'SUCCEEDED' && step.output);
    const prior = priorOutputs[priorOutputs.length - 1]?.output;
    if (prior && typeof prior === 'object' && !Array.isArray(prior)) {
      context.previous = prior as Record<string, unknown>;
    }

    if (node.type === 'http_request' && node.args?.requiresApproval === true) {
      const approval = await getApproval(runId, node.id);
      if (approval?.status !== 'APPROVED') {
        const args = resolveTemplate(node.args, context) as Record<string, unknown>;
        await ensureApproval(runId, node.id, String(args.approvalMessage ?? `Approval required before ${node.label}`));
        await updateRunStatus(runId, 'WAITING_FOR_APPROVAL', node.id);
        await recordTrace(runId, node.id, 'approval_required', { protectedAction: true });
        return { ok: true, status: 'WAITING_FOR_APPROVAL', runId, nodeId: node.id };
      }
    }

    const count = await incrementRunStepCount(runId);
    if (count.stepsExecuted > count.maxSteps) {
      const message = `Workflow exceeded MAX_STEPS (${count.maxSteps}).`;
      await updateRunStatus(runId, 'FAILED', currentNodeId);
      await recordTrace(runId, currentNodeId, 'step_limit_exceeded', { message, maxSteps: count.maxSteps });
      throw new Error(message);
    }

    await upsertRunStep(runId, node.id, node.label, toJson(context));
    const attempt = await beginRunStepAttempt(runId, node.id);
    const startedAt = Date.now();
    await recordTrace(runId, node.id, 'step_started', { attempt: attempt.attempts });

    try {
      const result = await executeNode(runId, node, context);
      if (result.approvalRequired) {
        await updateRunStatus(runId, 'WAITING_FOR_APPROVAL', node.id);
        await recordTrace(runId, node.id, 'approval_required', toJson(result.output));
        return { ok: true, status: 'WAITING_FOR_APPROVAL', runId, nodeId: node.id };
      }

      const output = { nodeId: node.id, nodeType: node.type, ...result.output };
      const nextNodeId = getNextNodeId(node, output);
      await completeRunStep(runId, node.id, toJson(output), nextNodeId);
      await recordTrace(runId, node.id, 'step_succeeded', { ...output, attempt: attempt.attempts }, Date.now() - startedAt, result.tokenCount);
      currentNodeId = nextNodeId;
    } catch (error) {
      const message = error instanceof Error ? error.message : 'Unknown error';
      await setStepStatus(runId, node.id, 'FAILED', toJson({ error: message }));
      await recordTrace(runId, node.id, 'step_failed', { error: message, attempt: attempt.attempts }, Date.now() - startedAt);
      throw error;
    }
  }

  return { ok: true, status: 'SUCCEEDED', runId };
}

const worker = new Worker(
  queueName,
  async (job) => {
    if (job.name === 'execute-run' || job.name === 'resume-run' || job.name === 'webhook-trigger') {
      return executeRun(job.data.runId);
    }
    if (job.name === 'workflow-created') {
      return { ok: true, workflowId: job.data.workflowId };
    }
    throw new Error(`Unsupported queue job: ${job.name}`);
  },
  {
    connection: { url: redisUrl },
    concurrency: 2,
    maxStalledCount: 5,
  },
);

worker.on('completed', (job) => {
  console.log(`Job ${job.id} completed`);
});

worker.on('failed', (job, error) => {
  console.error(`Job ${job?.id ?? 'unknown'} failed:`, error.message);
  const runId = job?.data?.runId;
  const attempts = Number(job?.opts.attempts ?? 1);
  if (runId && job && job.attemptsMade >= attempts) {
    void updateRunStatus(runId, 'FAILED').catch((statusError: unknown) => {
      console.error(`Failed to persist terminal status for run ${runId}:`, statusError);
    });
  }
});

const recoveryQueue = new Queue(queueName, { connection: { url: redisUrl } });
console.log('Relay worker is running');

void (async () => {
  const recoverableRuns = await prisma.run.findMany({
    where: { status: { in: ['QUEUED', 'RUNNING'] } },
    select: { id: true },
  });
  for (const run of recoverableRuns) {
    await recoveryQueue.add(
      'execute-run',
      { runId: run.id, recovered: true },
      {
        jobId: `run-${run.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    );
  }
})().catch((error: unknown) => {
  console.error('Failed to enqueue recoverable runs:', error);
});

async function shutdown() {
  await worker.close();
  await recoveryQueue.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
