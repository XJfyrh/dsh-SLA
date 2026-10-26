import type { Context } from '@deepseek-ai/cordis';
import { defineWorkflow, jsonArtifact, verifyJsonArtifact, type Evaluation } from 'dsh-sla/workflow';
import { z } from 'zod';

const payload = z.object({ count: z.number().int().nonnegative() });
function score(result: Evaluation): number {
  if (typeof result.score !== 'number') throw new Error('Counter evaluator did not return a numeric score');
  return result.score;
}
export const counter = defineWorkflow({
  id: 'example-counter', version: '1.0.0', name: 'Counter', description: 'A deterministic JSON workflow for extension development',
  artifacts: { verify: verifyJsonArtifact },
  evaluate: ({ artifact }) => ({ valid: true, score: payload.parse(artifact.payload).count, summary: 'Count checked against the payload schema' }),
  validateBaseline(result) { if (!result.valid) throw new Error('Invalid baseline'); },
  compare(candidate, reference) { return score(candidate) < score(reference) ? 'better' : score(candidate) === score(reference) ? 'equal' : 'worse'; },
  complete: result => score(result) === 0,
  async run(ctx) {
    await ctx.initialize({ criteria: { ready: true, criterion: 'Reduce count to zero' }, artifact: jsonArtifact({ count: 2 }) });
    await ctx.search({
      plan: () => ({ stop: false, reason: '', assignments: [{ direction: 'decrement', lane: 'one', hypothesis: 'A smaller count meets the criterion', instructions: 'Decrease by one', evidenceTrials: [] }] }),
      produce: ({ seed }) => jsonArtifact({ count: Math.max(0, payload.parse(seed.payload).count - 1) }),
    });
  },
  // File or remote delivery should implement authorize + recoverDelivery together;
  // this example has no external effect and returns its sealed content as a receipt.
  deliver: ({ artifact }) => artifact.payload,
  recoverDelivery: () => ({ status: 'absent' }),
});
export const inject = ['sla'];
export function apply(ctx: Context) { ctx.effect(() => ctx.sla.registerWorkflow(counter)); }
