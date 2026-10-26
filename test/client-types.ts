import { apply, inject, type SlaRemote } from 'dsh-sla/client';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
declare const ctx: Context;
declare const session: SessionId;
const endpoints: SlaRemote = ctx.remote.sla;
await apply(ctx);
inject.map(name => name.toUpperCase());
const result = await endpoints.action(session, JSON.stringify({ action: 'pause' }));
if (result.ok) result.value.toUpperCase();
// @ts-expect-error The wire action takes a SessionId, not an arbitrary object.
endpoints.action({}, '{}');
// @ts-expect-error The remote result must be checked before accessing its value.
result.value;
