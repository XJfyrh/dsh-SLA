import type { Context } from '@deepseek-ai/cordis';

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
}
export interface SlaExtensionService { registerTask(task: TaskDefinition): () => void }
declare module '@deepseek-ai/cordis' { interface Context { sla: SlaExtensionService } }
export function parseResult(result: CommandResult): unknown;
