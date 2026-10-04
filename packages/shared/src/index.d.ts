export type WorkflowNodeType = 'http_request' | 'condition' | 'delay' | 'notify' | 'llm' | 'approval';
export type RunStatus = 'queued' | 'running' | 'waiting_for_approval' | 'succeeded' | 'failed' | 'cancelled';
export interface WorkflowNode {
    id: string;
    type: WorkflowNodeType;
    label: string;
    args?: Record<string, unknown>;
    nextNodeId?: string;
}
export interface WorkflowDefinition {
    id: string;
    name: string;
    description?: string;
    maxSteps: number;
    nodes: WorkflowNode[];
}
export interface RunStep {
    stepIndex: number;
    nodeId: string;
    status: 'pending' | 'running' | 'succeeded' | 'failed';
    startedAt?: string;
    finishedAt?: string;
    output?: Record<string, unknown>;
}
export interface WorkflowRun {
    id: string;
    workflowId: string;
    status: RunStatus;
    currentNodeId?: string;
    maxSteps: number;
    steps: RunStep[];
    startedAt: string;
    updatedAt: string;
}
export declare const DEFAULT_MAX_STEPS = 50;
