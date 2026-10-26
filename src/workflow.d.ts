import type { Context } from '@deepseek-ai/cordis';

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
export interface WorkflowDefinition extends Pick<CodeWorkflowDefinition, 'id' | 'version' | 'name' | 'description' | 'validateBaseline' | 'compare' | 'complete' | 'qualify' | 'projectEvidence'> {
  artifacts: { verify(artifact: ArtifactInput): void | Promise<void> };
  evaluate(input: { artifact: Artifact; criteria: Criteria; signal: AbortSignal; execute(command: string): Promise<CommandResult> }): Evaluation | Promise<Evaluation>;
  run(context: WorkflowContext): void | Promise<void>;
  /** Return a durable receipt; use authorize immediately before any delivery side effect. */
  deliver?(input: { artifact: Artifact; evaluation: Evaluation; state: WorkflowState; signal: AbortSignal; authorize(): Promise<void> }): JsonValue | Promise<JsonValue>;
  /** Reconcile exact delivery side effects. Unknown remains held. */
  recoverDelivery?(state: WorkflowState): DeliveryRecovery | Promise<DeliveryRecovery>;
}
export type DeliveryRecovery = { status: 'delivered'; receipt: JsonValue } | { status: 'absent' } | { status: 'unknown'; reason: string };
export function defineWorkflow<T extends WorkflowDefinition>(definition: T): T & { kind: 'native' };
export function defineCodeWorkflow<T extends CodeWorkflowDefinition>(definition: T): T & { kind: 'code' };
export function jsonArtifact(value: JsonValue): ArtifactInput;
export function verifyJsonArtifact(artifact: ArtifactInput): void;
export const slaPlanSchema: Record<string, unknown>;

export type RegisteredWorkflow = (WorkflowDefinition & { kind: 'native' }) | (CodeWorkflowDefinition & { kind: 'code' });
export interface SlaExtensionService { registerWorkflow(workflow: RegisteredWorkflow): () => void }
declare module '@deepseek-ai/cordis' { interface Context { sla: SlaExtensionService } }
export function parseResult(result: CommandResult): unknown;

export interface Evaluation {
  valid: boolean;
  summary: string;
  display?: string;
  [key: string]: unknown;
}
export type Comparison = 'better' | 'equal' | 'worse' | 'incomparable';
export interface Criteria { ready: boolean; criterion: string; reason?: string; unit?: string; [key: string]: unknown }
export interface RunContext { goal: string; notes: string[]; [key: string]: unknown }
export interface CommandResult {
  exitCode: number | null;
  stdout: { text: string; truncated?: boolean };
  stderr: { text: string };
  aborted?: boolean;
  timedOut?: boolean;
}
export interface CodeWorkflowDefinition {
  id: string;
  version: string;
  name: string;
  description: string;
  instructions?: string;
  prepare: { schema: Record<string, unknown>; prompt(run: RunContext): string };
  evaluate(input: { cwd: string; signal: AbortSignal; criteria: Criteria; execute(command: string): Promise<CommandResult> }): Promise<Evaluation>;
  validateBaseline(result: Evaluation, criteria: Criteria): void | Promise<void>;
  compare(candidate: Evaluation, reference: Evaluation, criteria: Criteria): Comparison;
  complete?(candidate: Evaluation, criteria: Criteria): boolean;
  qualify?(candidate: Evaluation, criteria: Criteria): { retain: boolean; deliver: boolean };
  projectEvidence?(result: Evaluation): unknown;
  review?: {
    schema: Record<string, unknown>;
    prompt(run: RunContext, context: { phase: 'baseline' | 'candidate'; checkDirectory: string; originalDirectory: string; previousFailures: string[] }): string;
    evaluate(input: { cwd: string; signal: AbortSignal; criteria: Criteria; execute(command: string): Promise<CommandResult>; check: { id: string; directory: string; summary: string; title?: string; purpose?: string } }): Promise<{ passed: boolean; summary: string }>;
  };
}
