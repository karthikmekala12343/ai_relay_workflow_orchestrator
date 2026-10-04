import dotenv from 'dotenv';
import express from 'express';
import { Prisma, PrismaClient } from '@prisma/client';

dotenv.config();

const app = express();
const prisma = new PrismaClient();
app.use(express.json());

app.get('/health', async (_req, res) => {
  const calls = await prisma.mockEffect.count();
  res.json({
    ok: true,
    service: 'relay-mock-world',
    calls,
  });
});

app.post('/mock/effect', async (req, res) => {
  const body = req.body as {
    runId?: string;
    nodeId?: string;
    idempotencyKey?: string;
    value?: unknown;
  } | undefined;
  const headerKey = req.header('Idempotency-Key');
  const key = body?.idempotencyKey ?? headerKey ?? `${body?.runId ?? 'unknown'}:${body?.nodeId ?? 'node'}`;

  if (!body || typeof body !== 'object') {
    res.status(400).json({ ok: false, error: 'A JSON request body is required.' });
    return;
  }

  const response = {
    ok: true,
    runId: body.runId ?? 'unknown',
    nodeId: body.nodeId ?? 'unknown',
    result: body.value ?? 'completed',
    receivedAt: new Date().toISOString(),
  };

  let stored;
  let duplicate = false;
  try {
    stored = await prisma.mockEffect.create({
      data: { key, response },
    });
  } catch (error) {
    if (!(error instanceof Prisma.PrismaClientKnownRequestError) || error.code !== 'P2002') {
      throw error;
    }
    stored = await prisma.mockEffect.findUnique({ where: { key } });
    if (!stored) {
      throw new Error('Idempotency record disappeared after a unique-key conflict.');
    }
    duplicate = true;
  }

  res.json({
    ok: true,
    duplicate,
    idempotencyKey: key,
    response: stored.response,
  });
});

app.get('/mock/traces', async (_req, res) => {
  const traces = await prisma.mockEffect.findMany({
    orderBy: { createdAt: 'asc' },
  });
  res.json({ ok: true, traces });
});

const port = Number(process.env.MOCK_WORLD_PORT ?? 4101);
const server = app.listen(port, () => {
  console.log(`Relay mock world listening on http://localhost:${port}`);
});

async function shutdown() {
  server.close();
  await prisma.$disconnect();
  process.exit(0);
}

process.on('SIGINT', () => void shutdown());
process.on('SIGTERM', () => void shutdown());
