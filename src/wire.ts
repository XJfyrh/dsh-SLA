import { z } from 'zod';
import type { RemoteResult } from '@deepseek-ai/dsh-typert-protocol';
import type { SessionId } from '@deepseek-ai/dsh-session/types';

export const previewSchema = z.object({
  runId: z.string().optional(), trial: z.number().optional(), criteriaVersion: z.number().optional(), artifactId: z.string().optional(),
  kind: z.literal('artifact').optional(), unsupported: z.boolean().optional(),
  files: z.array(z.object({ path: z.string(), kind: z.enum(['added', 'deleted', 'modified']), omitted: z.enum(['large', 'binary']).optional(), oldText: z.string().nullable().optional(), newText: z.string().optional() })),
});
export type ChangePreview = z.infer<typeof previewSchema>;
export function decode(result: RemoteResult<string>): unknown {
  if (!result.ok) throw new Error(result.error.message);
  const value: unknown = JSON.parse(result.value);
  return value;
}
// The DSH lookup substitutes an Agent for action's wire SessionId on the Host.
export interface SlaEndpoints<AgentLookup> {
  get(sessionId: string): Promise<string>;
  changes(sessionId: string): Promise<string>;
  action(agent: AgentLookup, input: string): Promise<string>;
}
type RemoteMethod<Method extends (...args: never[]) => unknown> = (...args: Parameters<Method>) => Promise<RemoteResult<Awaited<ReturnType<Method>>>>;
export type SlaRemote = { [K in keyof SlaEndpoints<SessionId>]: RemoteMethod<SlaEndpoints<SessionId>[K]> };
declare module '@deepseek-ai/dsh-typert-protocol' {
  interface TypertRemoteNamespaceMap { sla: SlaRemote }
}
