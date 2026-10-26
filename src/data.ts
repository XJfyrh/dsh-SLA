import { z } from 'zod';
import { isRecord } from './errors.js';

export type JsonValue = null | boolean | number | string | JsonValue[] | { [key: string]: JsonValue };
function isJsonValue(value: unknown, ancestors = new Set<object>()): value is JsonValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return true;
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'object' || ancestors.has(value)) return false;
  if (!Array.isArray(value) && Object.getPrototypeOf(value) !== Object.prototype && Object.getPrototypeOf(value) !== null) return false;
  ancestors.add(value);
  const valid = (Array.isArray(value) ? Array.from(value) : Object.values(value)).every(item => isJsonValue(item, ancestors));
  ancestors.delete(value);
  return valid;
}
// Zod 4.4.3's JSON clone drops own __proto__ keys, changing sealed artifact digests.
export const jsonSchema = z.custom<JsonValue>(value => isJsonValue(value));
export type FileInventory = Record<string, string>;
export const filesSchema = z.custom<FileInventory>(value => isRecord(value) && isJsonValue(value) && Object.values(value).every(hash => typeof hash === 'string'));
export function fileHash(files: FileInventory, name: string): string | undefined { return Object.hasOwn(files, name) ? files[name] : undefined; }
export const settingsSchema = z.object({
  maxTrials: z.number().int().min(1).max(100), maxMinutes: z.number().int().min(1).max(240),
  directions: z.number().int().min(1).max(4), localTrials: z.number().int().min(1).max(5),
  maxStepsPerCall: z.number().int().min(4).max(200), maxMinutesPerCall: z.number().int().min(1).max(60),
}).strict();
export type Settings = z.infer<typeof settingsSchema>;
export const settingKeys = settingsSchema.keyof().options;
export const actionSchema = z.object({
  action: z.enum(['start', 'pause', 'resume', 'steer', 'stop', 'adopt', 'configure', 'review']),
  text: z.string().trim().max(12000).optional(), settings: settingsSchema.partial().optional(),
}).strict();
export type Action = z.infer<typeof actionSchema>;
export const bindingSchema = z.object({ id: z.string(), version: z.string(), name: z.string().optional() });
export type Binding = z.infer<typeof bindingSchema>;
const criteriaShape = z.object({ ready: z.boolean(), criterion: z.string(), reason: z.string().optional(), unit: z.string().optional(), title: z.string().optional() }).catchall(z.unknown());
export type Criteria = z.infer<typeof criteriaShape>;
export const criteriaSchema = z.custom<Criteria>(value => criteriaShape.safeParse(value).success);
const evaluationShape = z.object({
  valid: z.boolean(), summary: z.string(), display: z.string().optional(),
}).catchall(z.unknown());
export type Evaluation = z.infer<typeof evaluationShape>;
export const evaluationSchema = z.custom<Evaluation>(value => evaluationShape.safeParse(value).success);
export function supplementaryChecks(result: Evaluation | null | undefined) {
  if (!Array.isArray(result?.supplementaryChecks)) return [];
  // Keep every reported check, including malformed entries. One bad entry must
  // never erase a valid failure elsewhere in the list or become a passed check.
  return result.supplementaryChecks.map((item: unknown) => {
    const check = isRecord(item) ? item : {};
    return { id: typeof check.id === 'string' ? check.id : undefined,
      passed: typeof check.passed === 'boolean' ? check.passed : undefined, summary: check.summary };
  });
}
export const artifactInputSchema = z.object({ kind: z.string(), digest: z.string(), payload: jsonSchema });
export type ArtifactInput = z.infer<typeof artifactInputSchema>;
export const artifactSchema = artifactInputSchema.extend({ id: z.string(), parentId: z.string().nullable(), trial: z.number(), revision: z.number(), sealedAt: z.string() });
export type Artifact = z.infer<typeof artifactSchema>;
export const measurementSchema = z.object({ evaluation: evaluationSchema, artifactId: z.string(), observationId: z.string() });
export type Measurement = z.infer<typeof measurementSchema>;
export const eligibilitySchema = z.object({ retain: z.boolean(), deliver: z.boolean() });
export type Eligibility = z.infer<typeof eligibilitySchema>;
const candidateShape = evaluationShape.extend({
  evaluation: evaluationSchema, artifactId: z.string(), observationId: z.string(), trial: z.number(),
  criteriaVersion: z.number(), eligibility: eligibilitySchema.optional(), dir: z.string().optional(), diff: z.string().optional(),
});
export type Candidate = z.infer<typeof candidateShape>;
export const candidateSchema = z.custom<Candidate>(value => candidateShape.safeParse(value).success);
export const assignmentSchema = z.object({ direction: z.string(), lane: z.string().optional(), hypothesis: z.string(), instructions: z.string(), evidenceTrials: z.array(z.number()) });
export type Assignment = z.infer<typeof assignmentSchema>;
export const planSchema = z.object({ stop: z.boolean(), reason: z.string(), assignments: z.array(assignmentSchema) });
export type Plan = z.infer<typeof planSchema>;
export const trialSchema = z.object({
  id: z.string(), number: z.number(), revision: z.number(), criteriaVersion: z.number(), epoch: z.number(),
  direction: z.string(), regime: z.string(), parentTrial: z.number(), parentArtifactId: z.string(), hypothesis: z.string(),
  status: z.enum(['running', 'inconclusive', 'invalid', 'kept', 'local-kept', 'no-improvement', 'rechecked-valid', 'not-rechecked']),
  invocationIds: z.array(z.string()), assessmentStatus: z.enum(['pending', 'completed', 'superseded']), selection: z.string().nullable(),
  artifactId: z.string().optional(), observationId: z.string().optional(), dir: z.string().optional(),
  evaluation: evaluationSchema.optional(), valid: z.boolean().optional(), summary: z.string().optional(), display: z.string().optional(), score: z.unknown().optional(), evidence: z.unknown().optional(),
  eligibility: eligibilitySchema.optional(), pendingEvaluation: z.boolean().optional(),
  startFiles: filesSchema.optional(), files: filesSchema.optional(), changes: z.array(z.string()).optional(),
  failurePhase: z.string().optional(), assessmentError: z.string().optional(), report: z.string().optional(),
  historicalStatus: z.string().optional(), changeInspectionError: z.string().optional(),
  executionFailure: z.object({ message: z.string(), quiescent: z.literal(true) }).optional(),
  failures: z.array(z.object({ phase: z.string().optional(), message: z.string(), evidence: z.string().optional() })).optional(),
});
export type Trial = z.infer<typeof trialSchema>;
export const epochSchema = z.object({ number: z.number(), revision: z.number(), criteriaVersion: z.number(), status: z.enum(['running', 'completed', 'superseded']), assignments: z.array(assignmentSchema.extend({ trialLimit: z.number() })) });
export type Epoch = z.infer<typeof epochSchema>;
export const directionSchema = z.object({ id: z.string(), regime: z.string().optional(), revision: z.number(), seed: candidateSchema, best: candidateSchema.nullable(), hypothesis: z.string().optional() });
export type Direction = z.infer<typeof directionSchema>;
export const checkSchema = z.object({ id: z.string(), directory: z.string(), summary: z.string(), title: z.string().optional(), purpose: z.string().optional() });
export type Check = z.infer<typeof checkSchema>;
const reviewCandidateSchema = z.object({ trial: z.number(), dir: z.string(), files: filesSchema.optional(), direction: z.string().optional(), artifactId: z.string().optional() });
export const codePendingSchema = z.object({ kind: z.undefined().optional(), id: z.string(), revision: z.number(), criteriaVersion: z.number(), evaluationDir: z.string(), evaluationFiles: filesSchema, checks: z.array(checkSchema), candidates: z.array(reviewCandidateSchema), results: z.array(reviewCandidateSchema.merge(measurementSchema)) });
export const nativePendingSchema = z.object({ id: z.string(), kind: z.literal('workflow'), revision: z.number(), criteriaVersion: z.number(), criteria: criteriaSchema, candidates: z.array(z.string()), results: z.array(measurementSchema) });
export const pendingSchema = z.union([nativePendingSchema, codePendingSchema]);
export type PendingReview = z.infer<typeof pendingSchema>;
export type CodePendingReview = z.infer<typeof codePendingSchema>;
export type NativePendingReview = z.infer<typeof nativePendingSchema>;
export const reviewSchema = z.object({
  id: z.string(), phase: z.enum(['baseline', 'candidate']), revision: z.number(), criteriaVersion: z.number(), targetTrial: z.number(), targetFiles: filesSchema,
  status: z.enum(['running', 'inconclusive', 'no-checks', 'checking', 'confirmed-regression', 'accepted']),
  summary: z.string().optional(), error: z.string().optional(), title: z.string().optional(), purpose: z.string().optional(), publishedVersion: z.number().optional(), failedProposal: codePendingSchema.optional(),
});
export type Review = z.infer<typeof reviewSchema>;
const reviewedSchema = z.object({ trial: z.number(), criteriaVersion: z.number(), revision: z.number(), task: bindingSchema, files: filesSchema });
export const invocationSchema = z.object({ id: z.string(), role: z.string(), revision: z.number(), criteriaVersion: z.number(), startedAt: z.string(), status: z.enum(['running', 'interrupted', 'completed', 'failed']), attemptId: z.string().optional(), childId: z.string().optional(), error: z.string().optional(), quiescent: z.boolean().optional(), finishedAt: z.string().optional() });
export type InvocationRecord = z.infer<typeof invocationSchema>;
export const observationSchema = z.object({ id: z.string(), artifactId: z.string(), artifactDigest: z.string(), revision: z.number(), criteriaVersion: z.number(), evaluator: bindingSchema, result: evaluationSchema, conditions: jsonSchema, status: z.literal('completed'), observedAt: z.string() });
export type Observation = z.infer<typeof observationSchema>;
export const selectionSchema = z.object({ local: z.boolean(), global: z.boolean(), eligibility: eligibilitySchema });
export type Selection = z.infer<typeof selectionSchema>;
export const decisionSchema = selectionSchema.extend({ id: z.string(), trial: z.number(), artifactId: z.string(), observationId: z.string(), revision: z.number(), criteriaVersion: z.number() });
export type Decision = z.infer<typeof decisionSchema>;
export const runSchema = z.object({
  formatVersion: z.literal(1), id: z.string(), sessionId: z.string(), root: z.string(), cwd: z.string(), goal: z.string(), notes: z.array(z.string()),
  revision: z.number().int().positive(), criteriaVersion: z.number().int(),
  status: z.enum(['preparing', 'running', 'pausing', 'paused', 'stopping', 'completed', 'blocked']), stage: z.string(), message: z.string(),
  createdAt: z.string(), updatedAt: z.string().optional(), adopted: z.boolean(), adoptionPending: z.boolean().optional(), adoptedFiles: z.array(z.string()).optional(),
  attempts: z.number().int().nonnegative(), limit: z.number(), elapsedMs: z.number(), timeLimitMs: z.number(), activeSince: z.number().optional(),
  settings: settingsSchema, tranche: z.object({ attempt: z.number(), elapsedMs: z.number() }),
  task: bindingSchema.optional(), workflow: bindingSchema.extend({ kind: z.enum(['code', 'native']) }).optional(), selectionReason: z.string().optional(),
  trials: z.array(trialSchema), artifacts: z.array(artifactSchema), observations: z.array(observationSchema), decisions: z.array(decisionSchema), frontier: z.array(candidateSchema),
  directions: z.array(directionSchema), epochs: z.array(epochSchema), invocations: z.array(invocationSchema),
  assessments: z.array(z.object({ trial: z.number(), revision: z.number(), criteriaVersion: z.number(), evaluation: evaluationSchema.nullable(), artifactId: z.string().optional(), observationId: z.string().optional() })),
  reviews: z.array(reviewSchema), checks: z.array(checkSchema),
  criteria: criteriaSchema.nullish(), baseline: evaluationSchema.nullish(), best: candidateSchema.nullish(),
  baselineArtifactId: z.string().nullish(), baselineObservationId: z.string().optional(),
  sourceFiles: filesSchema.optional(), baselineDir: z.string().optional(), evaluationDir: z.string().optional(), evaluationFiles: filesSchema.optional(),
  pendingReview: pendingSchema.nullish(), reviewedBest: reviewedSchema.nullish(), baselineReviewed: z.number().nullish(),
  reviewSupported: z.boolean().optional(), rebuild: z.boolean().optional(), reviewOnly: z.boolean().optional(), stopReason: z.string().optional(),
  workflowState: jsonSchema.optional(), adoptionCheck: evaluationSchema.optional(), delivery: jsonSchema.optional(), deliveryError: z.string().optional(),
});
export type Run = z.infer<typeof runSchema>;
export type WorkflowState = Run;
