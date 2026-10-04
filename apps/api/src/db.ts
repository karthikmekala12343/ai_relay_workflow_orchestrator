import crypto from 'node:crypto';
import { PrismaClient } from '@prisma/client';

export const prisma = new PrismaClient();

export function hashIdempotencyKey(runId: string, nodeId: string) {
  return crypto.createHash('sha256').update(`${runId}:${nodeId}`).digest('hex');
}

export async function upsertStep(runId: string, nodeId: string, label: string, input: Record<string, unknown> | null = null) {
  return prisma.runStep.upsert({
    where: {
      runId_nodeId: { runId, nodeId },
    },
    create: {
      runId,
      nodeId,
      label,
      status: 'PENDING',
      input: input as any,
    },
    update: {
      label,
      input: input as any,
    },
  });
}

export async function setStepStatus(runId: string, nodeId: string, status: 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED', output?: Record<string, unknown>) {
  const now = new Date();

  return prisma.runStep.update({
    where: {
      runId_nodeId: { runId, nodeId },
    },
    data: {
      status,
      output: output as any,
      startedAt: status === 'RUNNING' ? now : undefined,
      finishedAt: status === 'SUCCEEDED' || status === 'FAILED' ? now : undefined,
    },
  });
}

export async function recordTrace(runId: string, nodeId: string, event: string, payload: Record<string, unknown> = {}, latencyMs?: number, tokenCount?: number) {
  return prisma.trace.create({
    data: {
      runId,
      nodeId,
      event,
      payload: payload as any,
      latencyMs,
      tokenCount,
    },
  });
}

export async function recordIdempotencyCall(runId: string, key: string, response: Record<string, unknown>) {
  return prisma.idempotencyKey.upsert({
    where: {
      runId_key: { runId, key },
    },
    create: {
      runId,
      key,
      response: response as any,
    },
    update: {
      response: response as any,
    },
  });
}
