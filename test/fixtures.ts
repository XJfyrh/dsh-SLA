import type { ResearchSeed } from '../dist/src/research-state.js';
import { initializeResearch } from '../dist/src/research-state.js';

export function researchRun(overrides: Partial<ResearchSeed> = {}) {
  const run: ResearchSeed = { id: 'run', sessionId: 'session', root: 'root', cwd: 'workspace', goal: 'goal', notes: [], revision: 1,
    status: 'preparing', stage: 'snapshot', message: 'preparing', createdAt: new Date().toISOString(), adopted: false,
    trials: [], invocations: [], attempts: 0, limit: 8, elapsedMs: 0, timeLimitMs: 1200000, ...overrides };
  initializeResearch(run);
  return run;
}
