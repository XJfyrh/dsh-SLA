export { jsonArtifact, verifyJsonArtifact } from './json-artifacts.js';
export { advisorSchema as slaPlanSchema } from './prompts.js';

// Identity helper for JS authors; registration performs runtime validation.
export function defineWorkflow(definition) { return definition; }
