CREATE EXTENSION IF NOT EXISTS pgcrypto;

ALTER TABLE "Workflow" RENAME COLUMN "webhookSecret" TO "webhookSecretHash";

UPDATE "Workflow"
SET "webhookSecretHash" = encode(digest("webhookSecretHash", 'sha256'), 'hex')
WHERE "webhookSecretHash" IS NOT NULL;
