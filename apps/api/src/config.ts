import dotenv from 'dotenv';

dotenv.config();

const maxSteps = Number(process.env.MAX_STEPS ?? 50);
if (!Number.isSafeInteger(maxSteps) || maxSteps < 1 || maxSteps > 1000) {
  throw new Error('MAX_STEPS must be an integer between 1 and 1000.');
}

const apiToken = process.env.RELAY_API_TOKEN ?? '';
if (apiToken.length > 0 && (apiToken.trim().length === 0 || apiToken.length < 32)) {
  throw new Error('RELAY_API_TOKEN must be non-empty and contain at least 32 characters.');
}
if (process.env.NODE_ENV === 'production' && apiToken.trim().length === 0) {
  throw new Error('RELAY_API_TOKEN is required when NODE_ENV=production.');
}

export const config = {
  port: Number(process.env.PORT ?? 4000),
  redisUrl: process.env.REDIS_URL ?? 'redis://localhost:6379',
  postgresUrl: process.env.POSTGRES_URL ?? 'postgresql://relay:relay@localhost:5432/relay',
  maxSteps,
  nodeEnv: process.env.NODE_ENV ?? 'development',
  apiToken,
};
