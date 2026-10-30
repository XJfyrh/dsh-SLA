import assert from 'node:assert/strict';
import type { Agent } from '@deepseek-ai/dsh-agent';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ShellRunResult } from '@deepseek-ai/dsh-shell';
import type { ExplorationEngine } from '../dist/src/engine.js';
import type { Run } from '../dist/src/data.js';

function unexpectedAgentCapability(): never { throw new Error('Fixture adapter must not access live Agent capabilities'); }
export function parentAgent(id: string): Agent {
  return {
    id: SessionId(id),
    get options() { return unexpectedAgentCapability(); },
    get session() { return unexpectedAgentCapability(); },
    get inbox() { return unexpectedAgentCapability(); },
    get status() { return unexpectedAgentCapability(); },
    get ctx() { return unexpectedAgentCapability(); },
    cancel: unexpectedAgentCapability, whenIdle: unexpectedAgentCapability, runMaintenance: unexpectedAgentCapability,
    send: unexpectedAgentCapability, followup: unexpectedAgentCapability, steer: unexpectedAgentCapability, inject: unexpectedAgentCapability,
  };
}
export function getRun(engine: ExplorationEngine, id: string): Run {
  const run = engine.get(id);
  assert.ok(run, 'Expected the exploration run to exist');
  return run;
}
export async function settle(engine: ExplorationEngine) {
  while (engine.active.size) await Promise.all([...engine.active.values()].map(active => active.promise));
}
export function shellResult(stdout: string, stderr = '', overrides: Partial<ShellRunResult> = {}): ShellRunResult {
  return { exitCode: 0, signal: null, timedOut: false, aborted: false, timeoutMs: 0,
    stdout: { text: stdout, truncated: false }, stderr: { text: stderr, truncated: false }, ...overrides };
}
