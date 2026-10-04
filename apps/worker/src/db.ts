import { Prisma, PrismaClient, type RunStatus, type StepStatus } from '@prisma/client';

export const prisma = new PrismaClient();

export async function getWorkflowRun(runId: string) {
  return prisma.run.findUnique({
    where: { id: runId },
    include: {
      workflow: true,
      steps: { orderBy: { updatedAt: 'asc' } },
      approvals: true,
      traces: true,
    },
  });
}

export async function updateRunStatus(runId: string, status: RunStatus, currentNodeId?: string | null) {
  return prisma.run.update({
    where: { id: runId },
    data: {
      status,
      currentNodeId,
      completedAt: status === 'SUCCEEDED' || status === 'FAILED' || status === 'CANCELLED' ? new Date() : undefined,
    },
  });
}

export async function upsertRunStep(runId: string, nodeId: string, label: string, input: Prisma.InputJsonValue = {}) {
  return prisma.runStep.upsert({
    where: { runId_nodeId: { runId, nodeId } },
    create: {
      runId,
      nodeId,
      label,
      input,
      status: 'PENDING',
    },
    update: {
      label,
      input,
    },
  });
}

export async function setStepStatus(runId: string, nodeId: string, status: StepStatus, output?: Prisma.InputJsonValue) {
  return prisma.runStep.update({
    where: { runId_nodeId: { runId, nodeId } },
    data: {
      status,
      output,
      startedAt: status === 'RUNNING' ? new Date() : undefined,
      finishedAt: status === 'SUCCEEDED' || status === 'FAILED' ? new Date() : undefined,
    },
  });
}

export async function beginRunStepAttempt(runId: string, nodeId: string) {
  return prisma.runStep.update({
    where: { runId_nodeId: { runId, nodeId } },
    data: {
      status: 'RUNNING',
      attempts: { increment: 1 },
      startedAt: new Date(),
      finishedAt: null,
    },
  });
}

export async function recordTrace(
  runId: string,
  nodeId: string,
  event: string,
  payload: Prisma.InputJsonValue = {},
  latencyMs?: number,
  tokenCount?: number,
) {
  return prisma.trace.create({
    data: {
      runId,
      nodeId,
      event,
      payload,
      latencyMs,
      tokenCount,
    },
  });
}

export async function createApproval(runId: string, nodeId: string, message: string) {
  return prisma.approval.upsert({
    where: { runId_nodeId: { runId, nodeId } },
    create: {
      runId,
      nodeId,
      message,
      status: 'PENDING',
    },
    update: {
      message,
      status: 'PENDING',
      decision: null,
      resolvedAt: null,
    },
  });
}

export async function ensureApproval(runId: string, nodeId: string, message: string) {
  return prisma.approval.upsert({
    where: { runId_nodeId: { runId, nodeId } },
    create: {
      runId,
      nodeId,
      message,
      status: 'PENDING',
    },
    update: {},
  });
}

export async function getApproval(runId: string, nodeId: string) {
  return prisma.approval.findUnique({
    where: { runId_nodeId: { runId, nodeId } },
  });
}

export async function resolveApproval(runId: string, nodeId: string, approved: boolean, reason: string) {
  const approval = await prisma.approval.findFirst({
    where: { runId, nodeId, status: 'PENDING' },
  });

  if (!approval) {
    return null;
  }

  return prisma.approval.update({
    where: { id: approval.id },
    data: {
      status: approved ? 'APPROVED' : 'REJECTED',
      resolvedAt: new Date(),
      decision: reason,
    },
  });
}

export async function getIdempotencyRecord(runId: string, key: string) {
  return prisma.idempotencyKey.findUnique({
    where: { runId_key: { runId, key } },
  });
}

export async function createIdempotencyRecord(runId: string, key: string, response: Prisma.InputJsonValue) {
  return prisma.idempotencyKey.upsert({
    where: { runId_key: { runId, key } },
    create: {
      runId,
      key,
      response,
    },
    update: {
      response,
    },
  });
}

export async function incrementRunStepCount(runId: string) {
  return prisma.run.update({
    where: { id: runId },
    data: { stepsExecuted: { increment: 1 } },
    select: { stepsExecuted: true, maxSteps: true },
  });
}

export async function completeRunStep(
  runId: string,
  nodeId: string,
  output: Prisma.InputJsonValue,
  nextNodeId: string | null,
) {
  await prisma.$transaction([
    prisma.runStep.update({
      where: { runId_nodeId: { runId, nodeId } },
      data: {
        status: 'SUCCEEDED',
        output,
        finishedAt: new Date(),
      },
    }),
    prisma.run.update({
      where: { id: runId },
      data: {
        currentNodeId: nextNodeId,
        status: nextNodeId ? 'RUNNING' : 'SUCCEEDED',
        completedAt: nextNodeId ? null : new Date(),
      },
    }),
  ]);
}
