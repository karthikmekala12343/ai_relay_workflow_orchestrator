import crypto from 'node:crypto';
import express, { type NextFunction, type Request, type RequestHandler, type Response } from 'express';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { Queue } from 'bullmq';
import { Prisma } from '@prisma/client';
import { z } from 'zod';
import { DEFAULT_MAX_STEPS, type WorkflowDefinition } from '@relay/shared';
import { config } from './config.js';
import { prisma } from './db.js';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

const app = express();
app.use(express.json());
app.use('/console', express.static(path.join(__dirname, '../public')));

const queue = new Queue('relay-jobs', {
  connection: { url: config.redisUrl },
});

const workflowNodeSchema = z.object({
  id: z.string().min(1),
  type: z.enum(['http_request', 'condition', 'delay', 'notify', 'llm', 'approval']),
  label: z.string().min(1),
  args: z.record(z.unknown()).optional(),
  nextNodeId: z.string().optional(),
});
type ParsedWorkflowNode = z.infer<typeof workflowNodeSchema>;

const workflowSchema = z.object({
  id: z.string().min(1).optional(),
  name: z.string().min(1),
  description: z.string().optional(),
  webhookSecret: z.string().min(16).optional(),
  maxSteps: z.number().int().positive().max(config.maxSteps).default(Math.min(DEFAULT_MAX_STEPS, config.maxSteps)),
  nodes: z.array(workflowNodeSchema).min(1),
});

const runRequestSchema = z.object({
  trigger: z.string().optional(),
  input: z.record(z.unknown()).optional(),
});

const approvalSchema = z.object({
  approved: z.boolean(),
  message: z.string().optional(),
});

function asyncRoute(handler: (req: Request, res: Response) => Promise<void>): RequestHandler {
  return (req, res, next: NextFunction) => {
    void handler(req, res).catch(next);
  };
}

function normalizeWorkflowRecord(record: { nodes: unknown; webhookSecretHash?: string | null } | null) {
  if (!record) {
    return null;
  }

  const { webhookSecretHash: _webhookSecretHash, ...safeRecord } = record;
  const nodes = Array.isArray(record.nodes) ? record.nodes : [];
  return {
    ...safeRecord,
    nodes,
  };
}

function toJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function matchesSecret(expected: string, provided: string): boolean {
  const expectedBytes = Buffer.from(expected, 'utf8');
  const providedBytes = Buffer.from(provided, 'utf8');
  return expectedBytes.length === providedBytes.length && crypto.timingSafeEqual(expectedBytes, providedBytes);
}

function authenticateApi(req: Request, res: Response, next: NextFunction): void {
  const isWebhook = req.method === 'POST' && /^\/webhooks\/[^/]+$/.test(req.path);
  if (isWebhook || !config.apiToken) {
    next();
    return;
  }

  const authorization = req.header('authorization');
  const providedToken = authorization?.match(/^Bearer (.+)$/i)?.[1];
  if (!providedToken || !matchesSecret(config.apiToken, providedToken)) {
    res.status(401).json({ ok: false, error: 'A valid Relay API bearer token is required.' });
    return;
  }

  next();
}

function hashSecret(secret: string): string {
  return crypto.createHash('sha256').update(secret, 'utf8').digest('hex');
}

function validateWorkflowGraph(nodes: ParsedWorkflowNode[]): string | null {
  const nodeIds = new Set(nodes.map((node) => node.id));
  if (nodeIds.size !== nodes.length) {
    return 'Workflow node IDs must be unique.';
  }

  for (const node of nodes) {
    if (
      node.args?.requiresApproval !== undefined
      && (typeof node.args.requiresApproval !== 'boolean' || (node.args.requiresApproval && node.type !== 'http_request'))
    ) {
      return `Node "${node.id}" may set requiresApproval only to true or false on an http_request node.`;
    }
    const targets = [
      node.nextNodeId,
      node.args?.onTrueNodeId,
      node.args?.onFalseNodeId,
    ].filter((target): target is string => typeof target === 'string');
    const missingTarget = targets.find((target) => !nodeIds.has(target));
    if (missingTarget) {
      return `Node "${node.id}" routes to unknown node "${missingTarget}".`;
    }
  }

  return null;
}

app.get('/health', (_req, res) => {
  res.json({
    ok: true,
    service: 'relay-api',
    environment: config.nodeEnv,
  });
});

app.get('/console', (_req, res) => {
  res.sendFile(path.join(__dirname, '../public/console.html'));
});

app.use('/api', authenticateApi);

app.get('/api/workflows', asyncRoute(async (_req, res) => {
  const workflows = await prisma.workflow.findMany({
    orderBy: { createdAt: 'desc' },
  });

  res.json({
    ok: true,
    workflows: workflows.map((workflow) => normalizeWorkflowRecord(workflow)),
  });
}));

app.get('/api/workflows/:workflowId', asyncRoute(async (req, res) => {
  const workflow = await prisma.workflow.findUnique({
    where: { id: req.params.workflowId },
  });

  if (!workflow) {
    res.status(404).json({ ok: false, error: 'Workflow not found.' });
    return;
  }

  res.json({ ok: true, workflow: normalizeWorkflowRecord(workflow) });
}));

app.post('/api/workflows/:workflowId/publish', asyncRoute(async (req, res) => {
  const workflow = await prisma.workflow.findUnique({
    where: { id: req.params.workflowId },
  });

  if (!workflow) {
    res.status(404).json({ ok: false, error: 'Workflow not found.' });
    return;
  }
  if (workflow.status === 'PUBLISHED') {
    res.status(409).json({ ok: false, error: 'Workflow is already published and immutable.' });
    return;
  }

  const parsedNodes = z.array(workflowNodeSchema).safeParse(workflow.nodes);
  if (!parsedNodes.success) {
    res.status(400).json({ ok: false, errors: parsedNodes.error.flatten() });
    return;
  }
  const nodes = parsedNodes.data;
  const graphError = validateWorkflowGraph(nodes);
  if (graphError) {
    res.status(400).json({ ok: false, error: graphError });
    return;
  }

  const publication = await prisma.workflow.updateMany({
    where: { id: workflow.id, status: 'DRAFT', updatedAt: workflow.updatedAt },
    data: { status: 'PUBLISHED', publishedAt: new Date() },
  });
  if (publication.count !== 1) {
    res.status(409).json({ ok: false, error: 'Workflow changed while it was being published.' });
    return;
  }

  const published = await prisma.workflow.findUnique({ where: { id: workflow.id } });
  res.json({ ok: true, workflow: normalizeWorkflowRecord(published) });
}));

app.post('/api/workflows', asyncRoute(async (req, res) => {
  const parsed = workflowSchema.safeParse(req.body);

  if (!parsed.success) {
    res.status(400).json({
      ok: false,
      errors: parsed.error.flatten(),
    });
    return;
  }

  const graphError = validateWorkflowGraph(parsed.data.nodes);
  if (graphError) {
    res.status(400).json({ ok: false, error: graphError });
    return;
  }

  const workflow: WorkflowDefinition = {
    ...parsed.data,
    id: parsed.data.id ?? crypto.randomUUID(),
  };

  const record = await prisma.workflow.create({
    data: {
      id: workflow.id,
      name: workflow.name,
      description: workflow.description,
      webhookSecretHash: parsed.data.webhookSecret ? hashSecret(parsed.data.webhookSecret) : undefined,
      maxSteps: workflow.maxSteps,
      nodes: toJson(workflow.nodes),
    },
  });

  await queue.add('workflow-created', {
    workflowId: record.id,
    createdAt: new Date().toISOString(),
  });

  res.status(201).json({
    ok: true,
    workflow: normalizeWorkflowRecord(record),
  });
}));

app.put('/api/workflows/:workflowId', asyncRoute(async (req, res) => {
  const parsed = workflowSchema.safeParse(req.body);
  if (!parsed.success) {
    res.status(400).json({ ok: false, errors: parsed.error.flatten() });
    return;
  }

  if (parsed.data.id && parsed.data.id !== req.params.workflowId) {
    res.status(400).json({ ok: false, error: 'Workflow ID cannot be changed.' });
    return;
  }

  const graphError = validateWorkflowGraph(parsed.data.nodes);
  if (graphError) {
    res.status(400).json({ ok: false, error: graphError });
    return;
  }

  const existing = await prisma.workflow.findUnique({
    where: { id: req.params.workflowId },
  });
  if (!existing) {
    res.status(404).json({ ok: false, error: 'Workflow not found.' });
    return;
  }
  if (existing.status !== 'DRAFT') {
    res.status(409).json({ ok: false, error: 'Published workflows are immutable. Create a new draft to make changes.' });
    return;
  }

  const record = await prisma.workflow.updateMany({
    where: { id: existing.id, status: 'DRAFT', updatedAt: existing.updatedAt },
    data: {
      name: parsed.data.name,
      description: parsed.data.description,
      maxSteps: parsed.data.maxSteps,
      nodes: toJson(parsed.data.nodes),
      webhookSecretHash: parsed.data.webhookSecret
        ? hashSecret(parsed.data.webhookSecret)
        : existing.webhookSecretHash,
    },
  });
  if (record.count !== 1) {
    res.status(409).json({ ok: false, error: 'Workflow changed or was published while applying the update.' });
    return;
  }
  const updatedWorkflow = await prisma.workflow.findUnique({ where: { id: existing.id } });
  res.json({ ok: true, workflow: normalizeWorkflowRecord(updatedWorkflow) });
}));

app.delete('/api/workflows/:workflowId', asyncRoute(async (req, res) => {
  const workflow = await prisma.workflow.findUnique({
    where: { id: req.params.workflowId },
  });
  if (!workflow) {
    res.status(404).json({ ok: false, error: 'Workflow not found.' });
    return;
  }
  if (workflow.status === 'PUBLISHED') {
    res.status(409).json({ ok: false, error: 'Published workflows cannot be deleted.' });
    return;
  }
  const runCount = await prisma.run.count({ where: { workflowId: workflow.id } });
  if (runCount > 0) {
    res.status(409).json({ ok: false, error: 'Workflows with run history cannot be deleted.' });
    return;
  }

  await prisma.workflow.delete({ where: { id: workflow.id } });
  res.status(204).end();
}));

app.post('/api/workflows/:workflowId/run', asyncRoute(async (req, res) => {
  const workflow = await prisma.workflow.findUnique({
    where: { id: req.params.workflowId },
  });

  if (!workflow) {
    res.status(404).json({ ok: false, error: 'Workflow not found.' });
    return;
  }
  if (workflow.status !== 'PUBLISHED') {
    res.status(409).json({ ok: false, error: 'Only published workflows can be run.' });
    return;
  }

  const parsed = runRequestSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ ok: false, errors: parsed.error.flatten() });
    return;
  }

  const parsedNodes = z.array(workflowNodeSchema).safeParse(workflow.nodes);
  if (!parsedNodes.success) {
    res.status(409).json({ ok: false, error: 'Published workflow contains invalid node data.' });
    return;
  }
  const nodes = parsedNodes.data;
  const graphError = validateWorkflowGraph(nodes);
  if (graphError) {
    res.status(409).json({ ok: false, error: graphError });
    return;
  }
  const firstNode = nodes[0];
  const workflowSnapshot = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    maxSteps: workflow.maxSteps,
    nodes,
  };
  const run = await prisma.run.create({
    data: {
      workflowId: workflow.id,
      status: 'QUEUED',
      currentNodeId: firstNode ? String(firstNode.id) : null,
      maxSteps: workflow.maxSteps,
      createdInput: toJson(parsed.data.input ?? {}),
      workflowSnapshot: toJson(workflowSnapshot),
      steps: {
        create: nodes.map((node) => ({
          nodeId: node.id,
          label: node.label,
          status: 'PENDING',
        })),
      },
    },
    include: {
      steps: true,
    },
  });

  await queue.add(
    'execute-run',
    {
      runId: run.id,
      workflowId: workflow.id,
      trigger: parsed.data.trigger ?? 'manual',
      createdAt: new Date().toISOString(),
    },
    {
      jobId: `run-${run.id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
    },
  );

  res.status(202).json({ ok: true, run });
}));

app.get('/api/runs', asyncRoute(async (_req, res) => {
  const runs = await prisma.run.findMany({
    include: {
      workflow: true,
      steps: true,
    },
    orderBy: { startedAt: 'desc' },
  });

  res.json({
    ok: true,
    runs: runs.map(({ workflow, ...run }) => ({
      ...run,
      workflow: normalizeWorkflowRecord(workflow),
    })),
  });
}));

app.get('/api/runs/:runId', asyncRoute(async (req, res) => {
  const run = await prisma.run.findUnique({
    where: { id: req.params.runId },
    include: {
      workflow: true,
      steps: true,
      traces: true,
      approvals: true,
    },
  });

  if (!run) {
    res.status(404).json({ ok: false, error: 'Run not found.' });
    return;
  }

  const { workflow, ...safeRun } = run;
  res.json({
    ok: true,
    run: {
      ...safeRun,
      workflow: normalizeWorkflowRecord(workflow),
    },
  });
}));

app.post('/api/runs/:runId/approve', asyncRoute(async (req, res) => {
  const parsed = approvalSchema.safeParse(req.body ?? {});

  if (!parsed.success) {
    res.status(400).json({ ok: false, errors: parsed.error.flatten() });
    return;
  }

  const run = await prisma.run.findUnique({
    where: { id: req.params.runId },
    include: { workflow: true },
  });

  if (!run) {
    res.status(404).json({ ok: false, error: 'Run not found.' });
    return;
  }

  if (run.status !== 'WAITING_FOR_APPROVAL' || !run.currentNodeId) {
    res.status(409).json({ ok: false, error: 'Run is not waiting for approval.' });
    return;
  }

  const snapshotNodes = run.workflowSnapshot && typeof run.workflowSnapshot === 'object'
    ? (run.workflowSnapshot as Record<string, unknown>).nodes
    : run.workflow.nodes;
  const nodes = Array.isArray(snapshotNodes) ? snapshotNodes as Array<Record<string, unknown>> : [];
  const currentNode = nodes.find((node) => node.id === run.currentNodeId);

  const isApprovalNode = currentNode?.type === 'approval';
  const isProtectedHttpNode = currentNode?.type === 'http_request'
    && (currentNode.args as Record<string, unknown> | undefined)?.requiresApproval === true;
  if (!currentNode || (!isApprovalNode && !isProtectedHttpNode)) {
    res.status(409).json({ ok: false, error: 'Current node is not configured to require human approval.' });
    return;
  }

  const approvalStatus = parsed.data.approved ? 'APPROVED' : 'REJECTED';
  const approval = await prisma.$transaction(async (transaction) => {
    const decision = await transaction.approval.updateMany({
      where: {
        runId: run.id,
        nodeId: run.currentNodeId!,
        status: 'PENDING',
      },
      data: {
        status: approvalStatus,
        decision: parsed.data.message ?? (parsed.data.approved ? 'approve' : 'reject'),
        resolvedAt: new Date(),
      },
    });

    if (decision.count !== 1) {
      return null;
    }

    const nextNodeId = parsed.data.approved && isApprovalNode
      ? (typeof currentNode.nextNodeId === 'string' ? currentNode.nextNodeId : null)
      : parsed.data.approved ? run.currentNodeId : null;
    const updatedRun = await transaction.run.updateMany({
      where: {
        id: run.id,
        status: 'WAITING_FOR_APPROVAL',
        currentNodeId: run.currentNodeId,
      },
      data: {
        status: parsed.data.approved ? (nextNodeId ? 'RUNNING' : 'SUCCEEDED') : 'CANCELLED',
        currentNodeId: nextNodeId,
        completedAt: parsed.data.approved && nextNodeId ? null : new Date(),
      },
    });

    if (updatedRun.count !== 1) {
      throw new Error('Approval run state changed while applying the decision.');
    }

    if (isApprovalNode) {
      await transaction.runStep.update({
        where: {
          runId_nodeId: {
            runId: run.id,
            nodeId: run.currentNodeId!,
          },
        },
        data: {
          status: parsed.data.approved ? 'SUCCEEDED' : 'FAILED',
          output: {
            approved: parsed.data.approved,
            message: parsed.data.message ?? null,
          },
          finishedAt: new Date(),
        },
      });
    }

    return transaction.approval.findUnique({
      where: {
        runId_nodeId: {
          runId: run.id,
          nodeId: run.currentNodeId!,
        },
      },
    });
  });

  if (!approval) {
    res.status(409).json({ ok: false, error: 'Approval has already been resolved.' });
    return;
  }

  const updatedRun = await prisma.run.findUnique({ where: { id: run.id } });

  if (parsed.data.approved && updatedRun?.status === 'RUNNING') {
    await queue.add(
      'resume-run',
      { runId: run.id },
      {
        jobId: `run-${run.id}`,
        attempts: 5,
        backoff: { type: 'exponential', delay: 1000 },
        removeOnComplete: true,
      },
    );
  }

  res.json({ ok: true, approval, run: updatedRun });
}));

app.post('/api/webhooks/:workflowId', asyncRoute(async (req, res) => {
  const workflow = await prisma.workflow.findUnique({
    where: { id: req.params.workflowId },
  });

  if (!workflow) {
    res.status(404).json({ ok: false, error: 'Workflow not found.' });
    return;
  }
  if (workflow.status !== 'PUBLISHED') {
    res.status(409).json({ ok: false, error: 'Only published workflows can receive webhooks.' });
    return;
  }

  const providedSecret = req.header('x-relay-webhook-secret');
  if (!workflow.webhookSecretHash || !providedSecret || !matchesSecret(workflow.webhookSecretHash, hashSecret(providedSecret))) {
    res.status(401).json({ ok: false, error: 'Webhook authentication failed.' });
    return;
  }

  const parsedNodes = z.array(workflowNodeSchema).safeParse(workflow.nodes);
  if (!parsedNodes.success) {
    res.status(409).json({ ok: false, error: 'Published workflow contains invalid node data.' });
    return;
  }
  const workflowNodes = parsedNodes.data;
  const graphError = validateWorkflowGraph(workflowNodes);
  if (graphError) {
    res.status(409).json({ ok: false, error: graphError });
    return;
  }
  const firstWebhookNode = workflowNodes[0];
  const workflowSnapshot = {
    id: workflow.id,
    name: workflow.name,
    description: workflow.description,
    maxSteps: workflow.maxSteps,
    nodes: workflowNodes,
  };

  const run = await prisma.run.create({
    data: {
      workflowId: workflow.id,
      status: 'QUEUED',
      currentNodeId: firstWebhookNode ? String(firstWebhookNode.id) : null,
      maxSteps: workflow.maxSteps,
      createdInput: toJson(req.body ?? {}),
      workflowSnapshot: toJson(workflowSnapshot),
      steps: {
        create: workflowNodes.map((node) => ({
          nodeId: node.id,
          label: node.label,
          status: 'PENDING',
        })),
      },
    },
    include: { steps: true },
  });

  await queue.add(
    'execute-run',
    {
      workflowId: workflow.id,
      runId: run.id,
      trigger: 'webhook',
      payload: req.body,
      receivedAt: new Date().toISOString(),
    },
    {
      jobId: `run-${run.id}`,
      attempts: 5,
      backoff: { type: 'exponential', delay: 1000 },
      removeOnComplete: true,
    },
  );

  res.status(202).json({
    ok: true,
    workflowId: workflow.id,
    runId: run.id,
    message: 'Webhook accepted for processing.',
  });
}));

app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
  console.error('Relay API request failed:', error);
  res.status(500).json({ ok: false, error: 'Internal server error.' });
});

const port = config.port;

app.listen(port, () => {
  console.log(`Relay API listening on http://localhost:${port}`);
});

process.on('SIGINT', async () => {
  await queue.close();
  await prisma.$disconnect();
  process.exit(0);
});
