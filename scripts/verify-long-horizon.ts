import type { Context } from '@deepseek-ai/cordis';
import type { } from '@deepseek-ai/dsh-agent-preset-registry';
import { ReasoningEffortId } from '@deepseek-ai/dsh-llm';
import type { } from '@deepseek-ai/dsh-sandbox-policy';
import { sessionFormatCatalog } from '@deepseek-ai/dsh-session-format-catalog';
import * as native from '@deepseek-ai/dsh-session-log-export';
import type { SessionEvent, SessionHeader } from '@deepseek-ai/dsh-session/types';
import { SESSION_FORMAT_VERSION, SessionId } from '@deepseek-ai/dsh-session/types';
import type { } from '@deepseek-ai/dsh-token-meter';
import { deriveTurnTokenUsage } from '@deepseek-ai/dsh-token-meter/client';
import { unzipSync } from 'fflate';
import assert from 'node:assert/strict';
import { z } from 'zod';
import type { InvocationRecord, Run } from '../dist/src/data.js';
import { filesSchema, runSchema, settingsSchema } from '../dist/src/data.js';
import { message, required } from '../dist/src/errors.js';
import type { } from '../dist/src/host.js';
import { settings } from '../dist/src/research-state.js';
import { parseJson, readJson } from './json.ts';

const priorExportSchema = z.object({ report: z.string().min(1), output: z.string().min(1) });
const commonInput = { output: z.string().min(1), priorExport: priorExportSchema.optional() };
const campaignSchema = z.strictObject({ ...commonInput, cwd: z.string().min(1), goal: z.string().min(1),
  settings: settingsSchema.partial(), maxTokens: z.number().int().positive().optional(), checkpoint: z.string().min(1).optional() });
export const campaignInputSchema = z.union([
  z.strictObject({ ...commonInput, exportSession: z.string().min(1), report: z.string().min(1) }), campaignSchema,
]);
type CampaignInput = z.infer<typeof campaignSchema>;
type InvocationLink = Pick<InvocationRecord, 'childId'>;
type SessionParent = { session: { parentSession?: SessionHeader['parentSession'] } };
const archiveHeaderSchema = z.looseObject({ type: z.literal('session'), id: z.string().min(1),
  version: z.literal(SESSION_FORMAT_VERSION), parentSession: z.string().transform(SessionId).optional() });

function assertArchiveEvents(header: unknown, events: unknown[]): asserts events is SessionEvent[] {
  const restore = sessionFormatCatalog.createRestore(header, { recovery: 'strict', validation: 'current' });
  for (const event of events) restore.decodeRow(event);
  assert.deepEqual(restore.finish().events, events, 'Native archive validation changed persisted events');
}
// Development-only Host overlay. Drives the production SLA service with the
// configured real model; detailed logs and ZIP serialization remain DSH-owned.
import { createHash, randomUUID } from 'node:crypto';
import { createWriteStream } from 'node:fs';
import { cp, mkdir, readFile, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { pipeline } from 'node:stream/promises';
import { changedFiles, inventory, verifyEvaluation } from '../dist/src/workspace.js';

export const inject = ['sla', 'agents', 'agentPresets', 'sessionQuery', 'sessionPersistence', 'sessions', 'attachments'];

export async function verifyCheckpoint(run: Run) {
  const baselineDir = required(run.baselineDir, 'checkpoint baseline directory');
  const sourceFiles = required(run.sourceFiles, 'checkpoint source files');
  if (changedFiles(sourceFiles, await inventory(baselineDir)).length) throw new Error('Checkpoint baseline files differ');
  const candidates = [run.best, ...(run.directions ?? []).flatMap(direction => [direction.seed, direction.best])].filter(candidate => candidate != null);
  for (const candidate of candidates) {
    const expected = candidate.trial === 0 ? run.sourceFiles : run.trials.find(trial => trial.number === candidate.trial)?.files;
    if (!expected || changedFiles(expected, await inventory(required(candidate.dir, 'checkpoint candidate directory'))).length) throw new Error('Checkpoint candidate files differ: ' + candidate.trial);
  }
  await verifyEvaluation(required(run.evaluationDir, 'checkpoint evaluation directory'), required(run.evaluationFiles, 'checkpoint evaluation files'));
}

export async function verifyInvocationChain<Log extends SessionParent>(query: { readSession(id: SessionId): Promise<Log | undefined> }, sessionId: string, invocations: readonly InvocationLink[]) {
  const logs = new Map<string, Log>();
  for (const call of invocations) {
    if (!call.childId) continue;
    const log = await query.readSession(SessionId(call.childId));
    if (!log?.session.parentSession) throw new Error('Native invocation parent is missing: ' + call.childId);
    const owner = await query.readSession(log.session.parentSession);
    if (owner?.session.parentSession !== sessionId) throw new Error('Native invocation belongs to another root: ' + call.childId);
    logs.set(call.childId, log);
  }
  return logs;
}

export async function summarizeNativeArchive<Usage>(files: Record<string, Uint8Array>, sessionId: string, invocations: readonly InvocationLink[], deriveUsage: (events: readonly SessionEvent[]) => Usage | undefined) {
  const archiveLogs = new Map<string, { session: z.infer<typeof archiveHeaderSchema>; events: SessionEvent[]; entry: string; sha256: string }>();
  for (const [entry, bytes] of Object.entries(files)) {
    if (!/^(?:subagents\/[^/]+\/)?session(?:\.v\d+)?\.jsonl$/.test(entry)) continue;
    const [header, ...events] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n').map(parseJson);
    const session = archiveHeaderSchema.parse(header);
    assertArchiveEvents(header, events);
    if (session?.type !== 'session' || !session.id || archiveLogs.has(session.id)) throw new Error('Invalid or duplicate native archive session: ' + entry);
    archiveLogs.set(session.id, { session, events, entry, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const root = archiveLogs.get(sessionId);
  if (!root || root.entry.startsWith('subagents/')) throw new Error('Native archive root differs');
  const logs = await verifyInvocationChain({ readSession: async id => archiveLogs.get(id) }, sessionId, invocations);
  const usage = [], observations = [];
  for (const call of invocations) {
    if (!call.childId) { usage.push({ ...call, source: 'dsh-session.zip', complete: false, exactTurns: [] }); continue; }
    const log = required(logs.get(call.childId), 'native invocation archive');
    const turns: SessionEvent[][] = []; let turn: SessionEvent[] | undefined;
    for (const event of log.events) {
      if (event.type === 'turn/start') { turn = []; turns.push(turn); }
      if (turn) turn.push(event);
      if (event.type === 'turn/end') turn = undefined;
    }
    const exactTurns = turns.map(events => deriveUsage(events) ?? null);
    observations.push({ childId: call.childId, parentSession: log.session.parentSession, source: 'dsh-session.zip',
      archiveEntry: log.entry, entrySha256: log.sha256, count: log.events.length, lastSeq: log.events.at(-1)?.seq,
      eventsSha256: createHash('sha256').update(JSON.stringify(log.events)).digest('hex') });
    usage.push({ ...call, source: 'dsh-session.zip', exactTurns, complete: exactTurns.length > 0 && exactTurns.every(Boolean) });
  }
  return { usage, observations };
}

async function* archiveBytes(stream: ReadableStream<Uint8Array>) {
  const reader = stream.getReader();
  try {
    while (true) {
      const chunk = await reader.read();
      if (chunk.done) return;
      yield chunk.value;
    }
  } finally { await reader.cancel(); reader.releaseLock(); }
}

async function exportNative(ctx: Context, sessionId: string, output: string, invocations: readonly InvocationLink[]) {
  await verifyInvocationChain(ctx.sessionQuery, sessionId, invocations);
  const deps = native.sessionLogExportDeps(ctx);
  const ready = { ...deps, sessionQuery: required(deps.sessionQuery, 'session query'), sessionPersistence: required(deps.sessionPersistence, 'session persistence'), attachments: required(deps.attachments, 'attachments') };
  const signal = AbortSignal.timeout(120000);
  await native.flushLiveSessionLog(deps, SessionId(sessionId), signal);
  const root = await native.readSessionLogText(required(deps.sessionPersistence, 'session persistence'), SessionId(sessionId), signal);
  if (!root) throw new Error('Native root session log missing');
  await pipeline(archiveBytes(native.streamSessionLogZip(ready, root, SessionId(sessionId), true, 6, signal)), createWriteStream(path.join(output, 'dsh-session.zip')));
  // Cold sessionQuery reads may synthesize interrupted-turn closers. Audit the
  // exported bytes instead; never treat the recovery projection as persisted.
  const { usage, observations } = await summarizeNativeArchive(unzipSync(await readFile(path.join(output, 'dsh-session.zip'))), sessionId, invocations, deriveTurnTokenUsage);
  await writeFile(path.join(output, 'native-usage.json'), JSON.stringify(usage, null, 2));
  await writeFile(path.join(output, 'native-observations.json'), JSON.stringify(observations, null, 2));
}

async function campaign(ctx: Context, input: CampaignInput) {
  await ctx.sla.ready;
  await mkdir(input.output, { recursive: true });
  const engine = ctx.sla.engine;
  const parent = await ctx.agents.create({ sessionId: SessionId(randomUUID()), meta: { cwd: input.cwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: ReasoningEffortId('high'), ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }) },
    setup: async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'sla');
      agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
      agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
    },
  });
  const saved = engine.save.bind(engine);
  const checkpointed = new Set<number>();
  engine.save = async run => {
    await saved(run);
    if (run.sessionId !== parent.agent.id) return;
    await writeFile(path.join(input.output, 'progress.json'), JSON.stringify({ id: run.id, sessionId: run.sessionId, status: run.status, stage: run.stage, message: run.message, attempts: run.attempts, best: run.best?.display, epochs: run.epochs?.length, calls: run.invocations?.length }, null, 2));
    const epoch = run.epochs?.at(-1);
    if (epoch?.status === 'completed' && !checkpointed.has(epoch.number)) {
      checkpointed.add(epoch.number);
      const target = path.join(input.output, 'checkpoint-' + epoch.number);
      await mkdir(target, { recursive: true });
      // This is an acceptance checkpoint, not a second session log/export.
      await cp(run.root, path.join(target, 'artifacts'), { recursive: true, errorOnExist: true, force: false });
      const state = structuredClone(run);
      state.elapsedMs += state.activeSince ? Date.now() - state.activeSince : 0;
      delete state.activeSince;
      state.status = 'paused';
      await writeFile(path.join(target, 'state.json'), JSON.stringify(state, null, 2));
      await writeFile(path.join(target, 'source-files.json'), JSON.stringify(await inventory(run.cwd), null, 2));
    }
  };
  let run;
  try {
    if (input.checkpoint) {
      const state = runSchema.parse(await readJson(path.join(input.checkpoint, 'state.json')));
      const expectedFiles = filesSchema.parse(await readJson(path.join(input.checkpoint, 'source-files.json')));
      if (JSON.stringify(await inventory(input.cwd)) !== JSON.stringify(expectedFiles)) throw new Error('Checkpoint source files differ');
      for (const epoch of state.epochs ?? []) if (epoch.status === 'completed') checkpointed.add(epoch.number);
      const oldRoot = state.root;
      const id = randomUUID();
      const newRoot = path.join(engine.root, id);
      await cp(path.join(input.checkpoint, 'artifacts'), newRoot, { recursive: true, force: false, errorOnExist: true });
      const replace = (value: unknown): unknown => typeof value === 'string' && value.startsWith(oldRoot) ? newRoot + value.slice(oldRoot.length)
        : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)])) : value;
      run = runSchema.parse(replace(state));
      run.id = id; run.sessionId = parent.agent.id; run.cwd = input.cwd; run.status = 'paused';
      Object.assign(run, { continuedFrom: { sourceRun: state.id, checkpoint: input.checkpoint, attempts: state.attempts } });
      run.invocations = [];
      await verifyCheckpoint(run);
      run.tranche = { attempt: run.attempts, elapsedMs: run.elapsedMs };
      run.settings = settings(input.settings, run.settings);
      run.limit = run.attempts + run.settings.maxTrials;
      run.timeLimitMs = run.elapsedMs + run.settings.maxMinutes * 60000;
      await engine.save(run);
      await engine.action(parent.agent, { action: 'resume' });
    } else {
      run = required(await engine.action(parent.agent, { action: 'start', text: input.goal, settings: input.settings }), 'new exploration');
    }
    await writeFile(path.join(input.output, 'identity.json'), JSON.stringify({ input, id: run.id, sessionId: parent.agent.id, startedAt: new Date().toISOString() }, null, 2));
    const live = engine.active.get(parent.agent.id);
    if (live) await live.promise;
    run = required(engine.get(parent.agent.id), 'completed exploration');
    await writeFile(path.join(input.output, 'result.json'), JSON.stringify(run, null, 2));
    await exportNative(ctx, parent.agent.id, input.output, run.invocations);
    return { status: run.status, message: run.message, attempts: run.attempts, best: run.best?.display, runId: run.id, sessionId: run.sessionId, nativeExport: 'dsh-session.zip' };
  } finally {
    engine.save = saved;
    await parent.dispose();
  }
}

export function apply(ctx: Context) {
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let output: string | undefined;
      let result;
      try {
        const raw = await readJson(required(process.env.SLA_CAMPAIGN_INPUT, 'SLA_CAMPAIGN_INPUT'));
        output = z.object({ output: commonInput.output }).parse(raw).output;
        const input = campaignInputSchema.parse(raw);
        if (input.priorExport) {
          const prior = input.priorExport;
          const run = runSchema.parse(await readJson(prior.report));
          await mkdir(prior.output, { recursive: true });
          await exportNative(ctx, run.sessionId, prior.output, run.invocations);
        }
        if ('exportSession' in input) {
          await mkdir(input.output, { recursive: true });
          const run = runSchema.parse(await readJson(input.report));
          if (input.exportSession !== run.sessionId) throw new Error('Export session does not match the run report');
          await exportNative(ctx, input.exportSession, input.output, run.invocations);
          result = { sessionId: input.exportSession, nativeExport: 'dsh-session.zip', coldRead: true };
        } else result = await campaign(ctx, input);
      }
      catch (error) { result = { error: error instanceof Error ? error.stack : message(error) }; }
      if (output) {
        await mkdir(output, { recursive: true });
        await writeFile(path.join(output, 'finished.json'), JSON.stringify(result, null, 2));
      }
      ctx.logger.info('SLA campaign finished: ' + JSON.stringify(result));
    }, 3000);
    return () => clearTimeout(timer);
  });
}
