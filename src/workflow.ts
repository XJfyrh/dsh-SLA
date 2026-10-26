export { jsonArtifact, verifyJsonArtifact } from './json-artifacts.js';
export { advisorSchema as slaPlanSchema } from './prompts.js';
export type * from './contracts.js';
import type { CodeWorkflowDefinition, WorkflowDefinition } from './contracts.js';

export function defineWorkflow<T extends WorkflowDefinition>(definition: T): T & { kind: 'native' } { return { ...definition, kind: 'native' }; }

export function defineCodeWorkflow<T extends CodeWorkflowDefinition>(definition: T): T & { kind: 'code' } { return { ...definition, kind: 'code' }; }
export { parseResult } from './evaluation.js';
