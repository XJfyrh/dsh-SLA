import type { Context } from '@deepseek-ai/cordis';
import type { WorkflowDefinition } from './workflow.js';

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
export interface TaskDefinition {
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
export interface SlaExtensionService {
  /** Use the default file/code workflow with a domain evaluator. */
  registerTask(task: TaskDefinition): () => void;
  /** Supply workflow composition, artifact validation and delivery. */
  registerWorkflow(workflow: WorkflowDefinition): () => void;
}
declare module '@deepseek-ai/cordis' { interface Context { sla: SlaExtensionService } }
export function parseResult(result: CommandResult): unknown;
