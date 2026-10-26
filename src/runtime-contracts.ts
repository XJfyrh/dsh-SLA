import type { Agent } from '@deepseek-ai/dsh-agent';
import type { Action, Binding, Run, Settings, Trial } from './data.js';
import type { CommandResult, JsonSchema, RoleBlueprint } from './contracts.js';
import type { WorkflowRegistry } from './workflow-registry.js';
import type { ExplorationRuntime } from './runtime.js';

export interface InvokeRequest {
  parent: Agent; role: string; cwd: string; prompt: string; schema?: JsonSchema; blueprint?: RoleBlueprint;
  settings: Settings; signal: AbortSignal; onStarted(childId: string): Promise<void>;
}
export interface RuntimeAdapter {
  authorize(parent: Agent): void | Promise<void>;
  directory(parent: Agent): Promise<string>;
  invoke(request: InvokeRequest): Promise<unknown>;
  execute(request: { parent: Agent; cwd: string; signal: AbortSignal; command: string }): Promise<CommandResult>;
  error(error: unknown): void;
}
/** Storage input is untrusted until the current persisted schema has parsed it. */
export interface RunStore {
  get(id: string): unknown;
  entries(): Iterable<[string, unknown]>;
  put(id: string, run: Run): Promise<void>;
}
export interface BoundWorkflow {
  execute(run: Run, parent: Agent, signal: AbortSignal): Promise<void>;
  deliver(run: Run, parent: Agent, signal: AbortSignal): Promise<void>;
  recover(run: Run): Promise<void>;
}
export interface RuntimeOptions {
  store: RunStore; adapter: RuntimeAdapter; tasks: WorkflowRegistry; root: string;
  resolveWorkflow(run: Run): BoundWorkflow;
  selectWorkflow(engine: ExplorationRuntime, run: Run, parent: Agent, signal: AbortSignal): Promise<void>;
  maxTrials?: number; maxMinutes?: number; directions?: number; localTrials?: number;
}
export type EngineOptions = Omit<RuntimeOptions, 'resolveWorkflow' | 'selectWorkflow'> & Partial<Pick<RuntimeOptions, 'selectWorkflow'>>;
export interface LiveRun { run: Run; controller: AbortController; restart: boolean; budgetExpired?: boolean; promise?: Promise<void> }
export type InvokeOptions = { attempt?: Trial; blueprint?: RoleBlueprint };
export type { Action, Agent, Binding, Run };
