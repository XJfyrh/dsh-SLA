import type { SlaExtensionService } from '../src/extension.js';
import { defineWorkflow, jsonArtifact, verifyJsonArtifact, type DeliveryRecovery, type RoleBlueprint } from '../src/workflow.js';
declare const service: SlaExtensionService;
const workflow = defineWorkflow({
  id: 'typed-example', version: '1.0.0', name: 'Example', description: 'Example',
  artifacts: { verify: verifyJsonArtifact },
  evaluate: async () => ({ valid: true, summary: 'measured' }),
  validateBaseline() {}, compare: () => 'equal' as const,
  async run(ctx) {
    await ctx.initialize({ criteria: { ready: true, criterion: 'example' }, artifact: jsonArtifact({ value: 1 }) });
    await ctx.search({ plan: () => ({ stop: true, reason: 'complete', assignments: [] }), produce: ({ seed }) => jsonArtifact(seed.payload) });
  },
  deliver: async ({ artifact, authorize }) => { await authorize(); return { id: artifact.id }; },
  recoverDelivery: async (): Promise<DeliveryRecovery> => ({ status: 'absent' }),
});
service.registerWorkflow(workflow);
// @ts-expect-error File tasks require their prepare contract.
service.registerTask(workflow);
// @ts-expect-error Unknown tool groups must not enter the role contract.
const invalidRole: RoleBlueprint = { instructions: '', tools: ['unknown'] };
// @ts-expect-error Recovery must distinguish missing effects from uncertainty.
const invalidRecovery: DeliveryRecovery = null;
