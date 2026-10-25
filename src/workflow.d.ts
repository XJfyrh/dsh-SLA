import type { Context } from '@deepseek-ai/cordis';
import type { Criteria, Evaluation, CommandResult, TaskDefinition } from './extension.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
export interface ArtifactInput { kind: string; digest: string; payload: JsonValue }
export interface Artifact extends ArtifactInput { id: string; parentId: string | null; trial: number; revision: number; sealedAt: string }
export interface Measurement { evaluation: Evaluation; artifactId: string; observationId: string }
export interface Candidate extends Measurement { trial: number; criteriaVersion: number; eligibility?: { retain: boolean; deliver: boolean } }
export interface Assignment { direction: string; lane?: string; hypothesis: string; instructions: string; evidenceTrials: number[] }
export interface Plan { stop: boolean; reason: string; assignments: Assignment[] }
export interface RoleBlueprint {
  instructions: string;
  tools: Array<'files' | 'search' | 'skills' | 'shell'>;
  /** Mount ordinary DSH plugins in the owned child scope. Disposal follows that scope. */
  mount?(ctx: Context): void | Promise<void>;
}
export interface Invocation { role: string; prompt: string; cwd?: string; schema?: Record<string, unknown>; blueprint: RoleBlueprint }
export interface WorkflowState {
  id: string; root: string; cwd: string; goal: string; notes: string[];
  revision: number; criteriaVersion: number; criteria?: Criteria; best?: Candidate;
  artifacts: Artifact[]; workflowState?: JsonValue;
  settings: { directions: number; localTrials: number; maxTrials: number; maxMinutes: number; maxStepsPerCall: number; maxMinutesPerCall: number };
  [key: string]: unknown;
}
/** Every returned state/artifact is a snapshot. Use commands to change authoritative state. */
export interface WorkflowContext {
  signal: AbortSignal;
  state(): WorkflowState;
  artifact(id: string): Artifact;
  evidence(): unknown[];
  status(stage: string, message: string): Promise<void>;
  saveState(value: JsonValue): Promise<void>;
  invoke(spec: Invocation): Promise<unknown>;
  initialize(input: { criteria: Criteria; artifact: ArtifactInput }): Promise<WorkflowState>;
  observe(artifactId: string): Promise<Measurement>;
  reviseCriteria(criteria: Criteria): Promise<WorkflowState>;
  search(operations: {
    plan(input: { state: WorkflowState; evidence: unknown[] }): Plan | Promise<Plan>;
    produce(input: { assignment: Assignment; seed: Artifact; feedback: unknown; invoke(spec: Invocation): Promise<unknown>; signal: AbortSignal }): ArtifactInput | Promise<ArtifactInput>;
    afterTrial?(input: { trial: Record<string, unknown>; state: WorkflowState }): void | Promise<void>;
  }): Promise<WorkflowState>;
}
export interface WorkflowDefinition extends Pick<TaskDefinition, 'id' | 'version' | 'name' | 'description' | 'validateBaseline' | 'compare' | 'complete' | 'qualify' | 'projectEvidence'> {
  artifacts: { verify(artifact: ArtifactInput): void | Promise<void> };
  evaluate(input: { artifact: Artifact; criteria: Criteria; signal: AbortSignal; execute(command: string): Promise<CommandResult> }): Evaluation | Promise<Evaluation>;
  run(context: WorkflowContext): void | Promise<void>;
  /** Return a durable receipt; use authorize immediately before any delivery side effect. */
  deliver?(input: { artifact: Artifact; evaluation: Evaluation; state: WorkflowState; signal: AbortSignal; authorize(): Promise<void> }): JsonValue | Promise<JsonValue>;
  /** Reconcile exact delivery side effects. Unknown remains held. */
  recoverDelivery?(state: WorkflowState): DeliveryRecovery | Promise<DeliveryRecovery>;
}
export type DeliveryRecovery = { status: 'delivered'; receipt: JsonValue } | { status: 'absent' } | { status: 'unknown'; reason: string };
export function defineWorkflow<T extends WorkflowDefinition>(definition: T): T;
export function jsonArtifact(value: JsonValue): ArtifactInput;
export function verifyJsonArtifact(artifact: ArtifactInput): void;
export const slaPlanSchema: Record<string, unknown>;
