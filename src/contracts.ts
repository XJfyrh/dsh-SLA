import type { Context } from '@deepseek-ai/cordis';
import type { ObjectJsonSchema } from '@deepseek-ai/dsh-tools';
import type { ShellRunResult } from '@deepseek-ai/dsh-shell';
import type { Artifact, ArtifactInput, Assignment, Candidate, Criteria, Evaluation, JsonValue, Measurement, Plan, Run, Trial } from './data.js';

export type CommandResult = ShellRunResult;
export type Comparison = 'better' | 'equal' | 'worse' | 'incomparable';
export type JsonSchema = ObjectJsonSchema;
export interface RoleBlueprint {
  instructions: string;
  tools: Array<'files' | 'search' | 'skills' | 'shell'>;
  /** Mount ordinary DSH plugins in the owned child scope. */
  mount?(ctx: Context): void | Promise<void>;
}
export interface Invocation { role: string; prompt: string; cwd?: string; schema?: JsonSchema; blueprint: RoleBlueprint }
export type RunContext = Run;
export interface WorkflowContext {
  signal: AbortSignal;
  state(): Run;
  artifact(id: string): Artifact;
  evidence(): unknown[];
  status(stage: string, message: string): Promise<void>;
  saveState(value: JsonValue): Promise<void>;
  invoke(spec: Invocation): Promise<unknown>;
  initialize(input: { criteria: Criteria; artifact: ArtifactInput }): Promise<Run>;
  observe(artifactId: string): Promise<Measurement>;
  reviseCriteria(criteria: Criteria): Promise<Run>;
  search(operations: {
    plan(input: { state: Run; evidence: unknown[] }): Plan | Promise<Plan>;
    produce(input: { assignment: Assignment; seed: Artifact; feedback: unknown; invoke(spec: Invocation): Promise<unknown>; signal: AbortSignal }): ArtifactInput | Promise<ArtifactInput>;
    afterTrial?(input: { trial: Trial; state: Run }): void | Promise<void>;
  }): Promise<Run>;
}
export interface EvaluationPolicy {
  id: string; version: string; name: string; description: string;
  validateBaseline(result: Evaluation, criteria: Criteria): void | Promise<void>;
  compare(candidate: Evaluation, reference: Evaluation, criteria: Criteria): Comparison;
  complete?(candidate: Evaluation, criteria: Criteria): boolean;
  qualify?(candidate: Evaluation, criteria: Criteria): { retain: boolean; deliver: boolean };
  projectEvidence?(result: Evaluation): unknown;
}
export interface EvaluationContext { cwd: string; signal: AbortSignal; criteria: Criteria; execute(command: string): Promise<CommandResult> }
export interface CodeWorkflowDefinition extends EvaluationPolicy {
  instructions?: string;
  prepare: { schema: JsonSchema; prompt(run: RunContext): string };
  evaluate(input: EvaluationContext): Promise<Evaluation>;
  review?: {
    schema: JsonSchema;
    prompt(run: RunContext, context: { phase: 'baseline' | 'candidate'; checkDirectory: string; originalDirectory: string; previousFailures: string[] }): string;
    evaluate(input: EvaluationContext & { check: { id: string; directory: string; summary: string; title?: string; purpose?: string } }): Promise<{ passed: boolean; summary: string }>;
  };
}
export type DeliveryRecovery = { status: 'delivered'; receipt: JsonValue } | { status: 'absent' } | { status: 'unknown'; reason: string };
export interface WorkflowDefinition extends EvaluationPolicy {
  artifacts: { verify(artifact: ArtifactInput): void | Promise<void> };
  evaluate(input: { artifact: Artifact; criteria: Criteria; signal: AbortSignal; execute(command: string): Promise<CommandResult> }): Evaluation | Promise<Evaluation>;
  run(context: WorkflowContext): void | Promise<void>;
  deliver?(input: { artifact: Artifact; evaluation: Evaluation; state: Run; signal: AbortSignal; authorize(): Promise<void> }): JsonValue | Promise<JsonValue>;
  recoverDelivery?(state: Run): DeliveryRecovery | Promise<DeliveryRecovery>;
}
export type CodeDefinition = CodeWorkflowDefinition & { kind: 'code' };
export type NativeDefinition = WorkflowDefinition & { kind: 'native' };
export type RegisteredWorkflow = CodeDefinition | NativeDefinition;
export interface SlaExtensionService { registerWorkflow(workflow: RegisteredWorkflow): () => void }
declare module '@deepseek-ai/cordis' { interface Context { sla: import('./host.js').default } }
export type { Artifact, ArtifactInput, Assignment, Candidate, Criteria, Evaluation, JsonValue, Measurement, Plan, Run as WorkflowState, Trial } from './data.js';
