# Relay: AI Workflow Orchestrator

Relay is a durable AI workflow orchestrator that keeps execution state in a database, dispatches background jobs through Redis, and employs workflow graphs to control AI-powered and deterministic actions safely.

## Project documentation

- [Project overview, BRD alignment, HLD, LLD, use cases, and test cases](docs/PROJECT_OVERVIEW.md)
- [Sequence and ER diagrams](docs/SEQUENCE_AND_ER_DIAGRAMS.md)
- [Presentation notes, feature demo scripts, and evidence checklist](docs/PRESENTATION_AND_DEMO_GUIDE.md)
- [Local Postman collection](postman/Relay_Local.postman_collection.json)
- [OpenAPI specification for Redocly](openapi.yaml) and [Redocly config](redocly.yaml)
- [MIT License](LICENSE)

Preview the API reference locally with Redocly CLI:

```bash
npx @redocly/cli preview-docs openapi.yaml
```

## Stack

- Runtime: Node.js + TypeScript
- API: Express
- Queue: Redis + BullMQ
- Database: PostgreSQL + Prisma
- Async worker: BullMQ consumer
- Mock external system: Express mock world service
- AI node: OpenAI-compatible chat completions adapter or local mock provider
- AI output validation: Ajv JSON Schema validation
- Shared contracts: TypeScript package for workflow/run types

## Included implementation

- PostgreSQL schema for workflows, runs, steps, traces, approvals, and idempotency
- Draft/published workflow lifecycle with graph validation at publication
- Immutable workflow snapshots on every run, including webhook-triggered runs
- API endpoints for workflow management, run creation, approval handling, and webhooks
- Queue-driven worker loop for durable execution logic
- Bounded graph execution with branch routing, retries, and startup recovery
- Approval gates that pause before protected HTTP actions and resume only after approval
- Templated values from trigger input and earlier node outputs
- Configurable mock/OpenAI LLM node with JSON Schema validation
- Mock world API with idempotency-aware side effects and trace collection
- Configurable HTTP origin allowlist; HTTP redirects are rejected
- Browser console dashboard at `/console`

## Structure

- `apps/api`: REST API, console assets, and workflow trigger endpoints
- `apps/worker`: background execution engine for runs and approvals
- `apps/mock-world`: test-side-effect service for idempotent external calls
- `packages/shared`: workflow node and run definitions
- `prisma/schema.prisma`: durable persistence schema
- `docker-compose.yml`: local Postgres and Redis services

## Setup

1. Install dependencies:
   ```bash
   npm install
   ```
2. Copy the environment template:
   ```bash
   copy .env.example .env
   ```
3. Start the complete local stack (Postgres, Redis, migrations, API, worker, and mock world):
   ```bash
   docker compose up --build -d
   ```
4. Seed the demo workflow:
   ```bash
   npm run db:seed
   ```
5. Open the console at `http://localhost:4000/console`.

For development without app containers, run the services in separate terminals:
   ```bash
   npm run db:generate
   npm run db:migrate
   npm run dev:mock-world
   npm run dev:api
   npm run dev:worker
   ```

Set `LLM_PROVIDER=openai` and `OPENAI_API_KEY` to enable the OpenAI provider. The default `mock` provider needs no API key. Both providers validate configured `args.schema` JSON Schemas before returning output to the workflow.

## API authentication

The local Compose setup defaults to development mode and permits API requests without a token. Before running the API with `NODE_ENV=production`, set `RELAY_API_TOKEN` to a randomly generated value of at least 32 characters; production startup fails if it is missing. The API and console use this bearer token for workflow, run, and approval endpoints. The console asks for the token when needed and keeps it in the current browser tab's session storage. Webhook requests remain separately authenticated with each workflow's `x-relay-webhook-secret`.

## API surface

- `GET /health`
- `GET /console`
- `GET /api/workflows`
- `GET /api/workflows/:workflowId`
- `POST /api/workflows`
- `PUT /api/workflows/:workflowId`
- `POST /api/workflows/:workflowId/publish`
- `DELETE /api/workflows/:workflowId` (drafts only, and only when no run history exists)
- `POST /api/workflows/:workflowId/run`
- `GET /api/runs` and `GET /api/runs/:runId`
- `POST /api/runs/:runId/approve`
- `POST /api/webhooks/:workflowId` (requires `x-relay-webhook-secret`)

## Workflow lifecycle and approvals

New workflows start as `DRAFT`. Drafts can be edited or deleted (provided they have
no runs), but cannot be run or triggered by webhook. Publish with
`POST /api/workflows/:workflowId/publish`; publishing checks node IDs, graph
targets, and protected-action configuration. Published workflows cannot be edited
or deleted. Existing workflows are migrated as published to avoid breaking
previously runnable workflows.

Each run stores the full workflow definition it started with. The worker uses that
snapshot rather than the current workflow row, so retries and recovery keep the
same graph and configuration.

For an `http_request` node that can perform a sensitive action, set
`args.requiresApproval: true` and optionally provide `args.approvalMessage`.
Relay persists a pending approval and pauses before making the HTTP request.
`POST /api/runs/:runId/approve` with `{"approved":true}` resumes that same node;
rejecting it cancels the run. Existing `approval` nodes continue to pause and
resume at their configured next node.

## Behavioral guarantees

- Workflow graph controls execution safety and routing
- `maxSteps` is enforced across graph transitions, including cycles
- HTTP nodes send stable run/node idempotency keys and store successful responses
  for retries. External services must honor the `Idempotency-Key` header to avoid
  duplicate side effects if a process dies after the remote action but before
  Relay records its response.
- HTTP requests must target an origin allowed by `HTTP_ALLOWED_ORIGINS`; when
  unset, only the configured `MOCK_WORLD_URL` origin is permitted. Specify
  comma-separated HTTP(S) origins (scheme, host, and optional port; no path) in
  each environment. Redirects are not followed.
- Approval-required HTTP actions are not sent until approved
- Step-level status and traces are persisted; interrupted BullMQ jobs can be retried or re-enqueued at worker startup
- AI responses are data only: routing remains controlled by workflow node configuration

## Build

```bash
npm run build
npm test
```

The default test suite runs worker unit tests for template resolution, condition
operators, JSON Schema validation, and HTTP origin validation; the API integration
test is skipped unless explicitly enabled. To run integration coverage against a
local Compose stack, start it with `docker compose up --build -d`, then set
`RELAY_INTEGRATION_TESTS=1` and run `npm test`. The integration test creates and
removes its own workflows and mock side effects. It checks draft/publish behavior,
approval gates, webhook authentication, schema rejection, and the step cap. The
worker crash/restart scenario is also verified manually against the local stack.

## Notes

For locally authored workflows, condition node `args` supports `left`, `operator`, `right`, `onTrueNodeId`, and `onFalseNodeId`. Supported operators are `eq`, `neq`, `gt`, `gte`, `lt`, `lte`, `contains`, and `truthy`. Templates use `{{input.path}}`, `{{steps.nodeId.output.path}}`, and `{{previous.path}}`.

Configure a workflow `webhookSecret` with at least 16 characters when creating it. Relay stores only its SHA-256 hash and never returns the secret; webhook callers must send it in the `x-relay-webhook-secret` header.

The Compose credentials and local-only port bindings are for development. Before internet-facing deployment, replace the database credentials, keep Postgres and Redis private, provision `RELAY_API_TOKEN` and any OpenAI key through a secret manager, and put the service behind HTTPS. The shared API token is intended for a single operator; multi-user deployments should use an identity provider with per-user authorization. Real OpenAI mode and cloud deployment require credentials and infrastructure not included in the local environment.
