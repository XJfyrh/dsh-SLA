import type { SlaExtensionService } from 'dsh-sla/workflow';
import { defineWorkflow, jsonArtifact, verifyJsonArtifact, type DeliveryRecovery, type RoleBlueprint } from 'dsh-sla/workflow';
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
// @ts-expect-error Registration requires an explicit workflow kind.
service.registerWorkflow({ ...workflow, kind: 'unknown' });
// @ts-expect-error Unknown tool groups must not enter the role contract.
const invalidRole: RoleBlueprint = { instructions: '', tools: ['unknown'] };
// @ts-expect-error Recovery must distinguish missing effects from uncertainty.
const invalidRecovery: DeliveryRecovery = null;
