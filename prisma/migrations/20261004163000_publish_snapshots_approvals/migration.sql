CREATE TYPE "WorkflowStatus" AS ENUM ('DRAFT', 'PUBLISHED');

ALTER TABLE "Workflow"
ADD COLUMN "status" "WorkflowStatus" NOT NULL DEFAULT 'PUBLISHED',
ADD COLUMN "publishedAt" TIMESTAMP(3);

UPDATE "Workflow"
SET "publishedAt" = "createdAt";

ALTER TABLE "Run"
ADD COLUMN "workflowSnapshot" JSONB;

UPDATE "Run" AS run
SET "workflowSnapshot" = jsonb_build_object(
  'id', workflow."id",
  'name', workflow."name",
  'description', workflow."description",
  'maxSteps', workflow."maxSteps",
  'nodes', workflow."nodes"
)
FROM "Workflow" AS workflow
WHERE run."workflowId" = workflow."id";

ALTER TABLE "Run"
ALTER COLUMN "workflowSnapshot" SET NOT NULL;

ALTER TABLE "RunStep"
ADD COLUMN "attempts" INTEGER NOT NULL DEFAULT 0;
