# Relay Sequence and ER Diagrams

These diagrams describe the current implementation: Express API, PostgreSQL via
Prisma, Redis/BullMQ, Relay worker, and Mock World. Mermaid diagrams render in
GitHub and compatible Markdown viewers.

## Workflow run and approval sequence

The main path below starts with an already published workflow. The optional
webhook trigger uses the same run creation, snapshot, and queue path after secret
validation.

```mermaid
sequenceDiagram
    autonumber
    actor Operator
    participant API as Relay API
    participant DB as PostgreSQL
    participant Queue as Redis / BullMQ
    participant Worker as Relay Worker
    participant World as Mock World / HTTP target

    Operator->>API: POST /api/workflows/:id/run (input)
    API->>DB: Load workflow and verify PUBLISHED
    API->>DB: Create QUEUED Run + workflowSnapshot + PENDING RunSteps
    API->>Queue: Enqueue execute-run (retry policy)
    API-->>Operator: 202 Accepted + runId

    Queue-->>Worker: Deliver execute-run
    Worker->>DB: Load Run, snapshot, prior steps
    Worker->>DB: Set Run RUNNING, then load context for current node

    alt Current node is protected HTTP (requiresApproval=true)
        Worker->>DB: Ensure PENDING Approval for run/node
        Worker->>DB: Set WAITING_FOR_APPROVAL and persist approval_required trace
        Worker-->>Queue: Yield job without making HTTP request
        Operator->>API: GET /api/runs/:runId (poll)
        API->>DB: Read run, steps, traces, approvals
        API-->>Operator: WAITING_FOR_APPROVAL + approval details
        Operator->>API: POST /api/runs/:runId/approve (approved=true)
        API->>DB: Transactionally resolve Approval and set Run RUNNING
        API->>Queue: Enqueue resume-run at the same current node
        API-->>Operator: 200 Approval decision
        Queue-->>Worker: Deliver resume-run
        Worker->>DB: Reload same immutable snapshot and APPROVED decision
        Worker->>DB: Increment step count and persist HTTP attempt and step_started trace
        Worker->>World: HTTP request + stable Idempotency-Key
        World->>DB: Insert MockEffect once by unique key
        World-->>Worker: Response (or previously stored response)
        Worker->>DB: Cache successful response in IdempotencyKey
        Worker->>DB: Mark step SUCCEEDED and persist step_succeeded trace
    else Current node is regular approval
        Worker->>DB: Increment step count and persist attempt and step_started trace
        Worker->>DB: Create PENDING Approval and WAITING_FOR_APPROVAL state
        Worker-->>Queue: Yield job
        Operator->>API: POST /api/runs/:runId/approve (approved=true)
        API->>DB: Resolve Approval and mark approval step SUCCEEDED
        API->>DB: Advance currentNodeId to configured next node
        API->>Queue: Enqueue resume-run
        Queue-->>Worker: Continue graph at next node
    else Ordinary deterministic or AI node
        Worker->>DB: Increment step count and persist attempt and step_started trace
        Worker->>Worker: Resolve templates and execute node
        opt HTTP node
            Worker->>World: Allowlisted request + stable Idempotency-Key
            World-->>Worker: Response
        end
        opt LLM node
            Worker->>Worker: Call mock or configured OpenAI-compatible provider
            Worker->>Worker: Validate output against configured JSON Schema
        end
        Worker->>DB: Persist output, next node, and trace
    end

    alt Node execution succeeds and graph has another node
        Worker->>DB: Advance currentNodeId and continue from snapshot
    else Graph completes normally
        Worker->>DB: Mark Run SUCCEEDED
        Worker-->>Queue: Complete job
        Operator->>API: GET /api/runs/:runId
        API->>DB: Read run, steps, traces, approvals
        API-->>Operator: Terminal run and execution evidence
    else Approval rejected
        Operator->>API: POST /api/runs/:runId/approve (approved=false)
        API->>DB: Resolve Approval and set Run CANCELLED
        API-->>Operator: 200 Rejection decision
    else Node fails or exceeds maxSteps
        Worker->>DB: Persist step_failed or step_limit_exceeded trace
        Worker-->>Queue: Fail job for BullMQ retry policy
        Queue-->>Worker: Retry if attempts remain
        Worker->>DB: Resume using same persisted run snapshot
    end
```

### Recovery sequence

```mermaid
sequenceDiagram
    autonumber
    participant WorkerA as Worker before restart
    participant DB as PostgreSQL
    participant World as Idempotent downstream
    participant Queue as Redis / BullMQ
    participant WorkerB as Worker after restart

    WorkerA->>DB: Persist completed node and cached response
    WorkerA->>World: Perform HTTP effect with run/node key
    World->>World: Store effect once under unique key
    Note over WorkerA: Process stops during a later node
    WorkerB->>DB: Find QUEUED/RUNNING runs at startup
    WorkerB->>Queue: Re-enqueue recoverable run
    Queue-->>WorkerB: Deliver execution job
    WorkerB->>DB: Reload currentNodeId, snapshot, and completed outputs
    WorkerB->>DB: Resume from durable current node
    opt Previously completed HTTP node is retried
        WorkerB->>DB: Look up cached IdempotencyKey response
        WorkerB->>World: Retry with same Idempotency-Key if response not cached
        World-->>WorkerB: Return existing effect rather than duplicate it
    end
    WorkerB->>DB: Persist remaining steps and terminal status
```

The idempotency guarantee depends on the downstream honoring the key. Relay
cannot guarantee exactly-once side effects with a remote service that ignores
idempotency keys, particularly if the remote effect happens before Relay stores
its response.

## Entity-relationship diagram

```mermaid
erDiagram
    WORKFLOW {
        string id PK
        string name
        string description
        string webhookSecretHash
        WorkflowStatus status
        datetime publishedAt
        int maxSteps
        json nodes
        datetime createdAt
        datetime updatedAt
    }

    RUN {
        string id PK
        string workflowId FK
        RunStatus status
        string currentNodeId
        int maxSteps
        int stepsExecuted
        json createdInput
        json workflowSnapshot
        datetime startedAt
        datetime completedAt
        datetime updatedAt
    }

    RUN_STEP {
        string id PK
        string runId FK
        string nodeId
        string label
        StepStatus status
        int attempts
        json input
        json output
        datetime startedAt
        datetime finishedAt
        datetime createdAt
        datetime updatedAt
    }

    APPROVAL {
        string id PK
        string runId FK
        string nodeId
        string message
        string status
        string decision
        datetime createdAt
        datetime resolvedAt
    }

    TRACE {
        string id PK
        string runId FK
        string nodeId
        string event
        json payload
        int latencyMs
        int tokenCount
        datetime createdAt
    }

    IDEMPOTENCY_KEY {
        string id PK
        string runId FK
        string key
        json response
        datetime createdAt
    }

    MOCK_EFFECT {
        string id PK
        string key UK
        json response
        datetime createdAt
    }

    WORKFLOW ||--o{ RUN : "has execution history"
    RUN ||--o{ RUN_STEP : "contains"
    RUN ||--o{ APPROVAL : "requires decisions"
    RUN ||--o{ TRACE : "records events"
    RUN ||--o{ IDEMPOTENCY_KEY : "caches external calls"
```

### Relationship and key notes

- Deleting a workflow cascades to its runs; deleting a run cascades to its steps,
  approvals, traces, and idempotency records.
- `RUN_STEP` is unique on `(runId, nodeId)`.
- `APPROVAL` is unique on `(runId, nodeId)`.
- `IDEMPOTENCY_KEY` is unique on `(runId, key)`.
- `MOCK_EFFECT.key` is globally unique in Mock World. It has no database foreign
  key to `RUN` or `IDEMPOTENCY_KEY`; it represents the downstream system's
  idempotency store.
- Workflow node edges and `RUN.currentNodeId`/node IDs are stored in JSON/scalar
  fields and are not relational foreign keys.
