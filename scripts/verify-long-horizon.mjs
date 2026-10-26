// Development-only Host overlay. Drives the production SLA service with the
// configured real model; detailed logs and ZIP serialization remain DSH-owned.
import { mkdir, readFile, writeFile, cp } from 'node:fs/promises';
import { createWriteStream } from 'node:fs';
import { pipeline } from 'node:stream/promises';
import { Readable } from 'node:stream';
import { randomUUID, createHash } from 'node:crypto';
import { createRequire } from 'node:module';
import { pathToFileURL } from 'node:url';
import path from 'node:path';
import { inventory, changedFiles, verifyEvaluation } from '../dist/src/workspace.js';

export const inject = ['sla', 'agents', 'agentPresets', 'sessionQuery', 'sessionPersistence', 'sessions', 'attachments'];

export async function verifyCheckpoint(run) {
  if (changedFiles(run.sourceFiles, await inventory(run.baselineDir)).length) throw new Error('Checkpoint baseline files differ');
  const candidates = [run.best, ...(run.directions ?? []).flatMap(direction => [direction.seed, direction.best])].filter(Boolean);
  for (const candidate of candidates) {
    const expected = candidate.trial === 0 ? run.sourceFiles : run.trials.find(trial => trial.number === candidate.trial)?.files;
    if (!expected || changedFiles(expected, await inventory(candidate.dir)).length) throw new Error('Checkpoint candidate files differ: ' + candidate.trial);
  }
  await verifyEvaluation(run.evaluationDir, run.evaluationFiles);
}

export async function verifyInvocationChain(query, sessionId, invocations) {
  const logs = new Map();
  for (const call of invocations) {
    if (!call.childId) continue;
    const log = await query.readSession(call.childId);
    if (!log?.session.parentSession) throw new Error('Native invocation parent is missing: ' + call.childId);
    const owner = await query.readSession(log.session.parentSession);
    if (owner?.session.parentSession !== sessionId) throw new Error('Native invocation belongs to another root: ' + call.childId);
    logs.set(call.childId, log);
  }
  return logs;
}

export async function summarizeNativeArchive(files, sessionId, invocations, deriveTurnTokenUsage) {
  const archiveLogs = new Map();
  for (const [entry, bytes] of Object.entries(files)) {
    if (!/^(?:subagents\/[^/]+\/)?session(?:\.v\d+)?\.jsonl$/.test(entry)) continue;
    const [session, ...events] = new TextDecoder('utf-8', { fatal: true }).decode(bytes).trimEnd().split('\n').map(line => JSON.parse(line));
    if (session?.type !== 'session' || !session.id || archiveLogs.has(session.id)) throw new Error('Invalid or duplicate native archive session: ' + entry);
    archiveLogs.set(session.id, { session, events, entry, sha256: createHash('sha256').update(bytes).digest('hex') });
  }
  const root = archiveLogs.get(sessionId);
  if (!root || root.entry.startsWith('subagents/')) throw new Error('Native archive root differs');
  const logs = await verifyInvocationChain({ readSession: async id => archiveLogs.get(id) }, sessionId, invocations);
  const usage = [], observations = [];
  for (const call of invocations) {
    if (!call.childId) { usage.push({ ...call, source: 'dsh-session.zip', complete: false, exactTurns: [] }); continue; }
    const log = logs.get(call.childId);
    const turns = []; let turn;
    for (const event of log.events) {
      if (event.type === 'turn/start') { turn = []; turns.push(turn); }
      if (turn) turn.push(event);
      if (event.type === 'turn/end') turn = undefined;
    }
    const exactTurns = turns.map(events => deriveTurnTokenUsage(events) ?? null);
    observations.push({ childId: call.childId, parentSession: log.session.parentSession, source: 'dsh-session.zip',
      archiveEntry: log.entry, entrySha256: log.sha256, count: log.events.length, lastSeq: log.events.at(-1)?.seq,
      eventsSha256: createHash('sha256').update(JSON.stringify(log.events)).digest('hex') });
    usage.push({ ...call, source: 'dsh-session.zip', exactTurns, complete: exactTurns.length > 0 && exactTurns.every(Boolean) });
  }
  return { usage, observations };
}

async function exportNative(ctx, sessionId, output, invocations) {
  await verifyInvocationChain(ctx.sessionQuery, sessionId, invocations);
  const packageRoot = path.join(process.env.LOCALAPPDATA, 'npm/node_modules/@deepseek-ai/dsh/node_modules/@deepseek-ai');
  const requireDsh = createRequire(path.resolve(packageRoot, '../../package.json'));
  const native = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-session-log-export')));
  const { deriveTurnTokenUsage } = await import(pathToFileURL(requireDsh.resolve('@deepseek-ai/dsh-token-meter/client')));
  const { unzipSync } = requireDsh('fflate');
  const deps = native.sessionLogExportDeps(ctx);
  const signal = AbortSignal.timeout(120000);
  await native.flushLiveSessionLog(deps, sessionId, signal);
  const root = await native.readSessionLogText(deps.sessionPersistence, sessionId, signal);
  if (!root) throw new Error('Native root session log missing');
  await pipeline(Readable.fromWeb(native.streamSessionLogZip(deps, root, sessionId, true, 6, signal)), createWriteStream(path.join(output, 'dsh-session.zip')));
  // Cold sessionQuery reads may synthesize interrupted-turn closers. Audit the
  // exported bytes instead; never treat the recovery projection as persisted.
  const { usage, observations } = await summarizeNativeArchive(unzipSync(await readFile(path.join(output, 'dsh-session.zip'))), sessionId, invocations, deriveTurnTokenUsage);
  await writeFile(path.join(output, 'native-usage.json'), JSON.stringify(usage, null, 2));
  await writeFile(path.join(output, 'native-observations.json'), JSON.stringify(observations, null, 2));
}

async function campaign(ctx, input) {
  await ctx.sla.ready;
  await mkdir(input.output, { recursive: true });
  const engine = ctx.sla.engine;
  const parent = await ctx.agents.create({ sessionId: randomUUID(), meta: { cwd: input.cwd },
    agentOptions: { provider: 'deepseek-official', model: 'deepseek-flash', reasoningEffort: 'high', ...(input.maxTokens === undefined ? {} : { maxTokens: input.maxTokens }) },
    setup: async (scope, agent) => {
      await ctx.agentPresets.mount(scope, 'sla');
      agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
      agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
    },
  });
  const saved = engine.save.bind(engine);
  const checkpointed = new Set();
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
      const state = JSON.parse(await readFile(path.join(input.checkpoint, 'state.json'), 'utf8'));
      const expectedFiles = JSON.parse(await readFile(path.join(input.checkpoint, 'source-files.json'), 'utf8'));
      if (JSON.stringify(await inventory(input.cwd)) !== JSON.stringify(expectedFiles)) throw new Error('Checkpoint source files differ');
      for (const epoch of state.epochs ?? []) if (epoch.status === 'completed') checkpointed.add(epoch.number);
      const oldRoot = state.root;
      const id = randomUUID();
      const newRoot = path.join(engine.root, id);
      await cp(path.join(input.checkpoint, 'artifacts'), newRoot, { recursive: true, force: false, errorOnExist: true });
      const replace = value => typeof value === 'string' && value.startsWith(oldRoot) ? newRoot + value.slice(oldRoot.length)
        : Array.isArray(value) ? value.map(replace) : value && typeof value === 'object' ? Object.fromEntries(Object.entries(value).map(([k, v]) => [k, replace(v)])) : value;
      run = replace(state);
      run.id = id; run.sessionId = parent.agent.id; run.cwd = input.cwd; run.status = 'paused';
      run.continuedFrom = { sourceRun: state.id, checkpoint: input.checkpoint, attempts: state.attempts };
      run.invocations = [];
      await verifyCheckpoint(run);
      run.tranche = { attempt: run.attempts, elapsedMs: run.elapsedMs };
      run.settings = { ...run.settings, ...input.settings };
      run.limit = run.attempts + run.settings.maxTrials;
      run.timeLimitMs = run.elapsedMs + run.settings.maxMinutes * 60000;
      await engine.save(run);
      await engine.action(parent.agent, { action: 'resume' });
    } else {
      run = await engine.action(parent.agent, { action: 'start', text: input.goal, settings: input.settings });
    }
    await writeFile(path.join(input.output, 'identity.json'), JSON.stringify({ input, id: run.id, sessionId: parent.agent.id, startedAt: new Date().toISOString() }, null, 2));
    const live = engine.active.get(parent.agent.id);
    if (live) await live.promise;
    run = engine.get(parent.agent.id);
    await writeFile(path.join(input.output, 'result.json'), JSON.stringify(run, null, 2));
    await exportNative(ctx, parent.agent.id, input.output, run.invocations);
    return { status: run.status, message: run.message, attempts: run.attempts, best: run.best?.display, runId: run.id, sessionId: run.sessionId, nativeExport: 'dsh-session.zip' };
  } finally {
    engine.save = saved;
    await parent.dispose();
  }
}

export function apply(ctx) {
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let input;
      let result;
      try {
        input = JSON.parse(await readFile(process.env.SLA_CAMPAIGN_INPUT, 'utf8'));
        if (input.priorExport) {
          const prior = input.priorExport;
          const run = JSON.parse(await readFile(prior.report, 'utf8'));
          await mkdir(prior.output, { recursive: true });
          await exportNative(ctx, run.sessionId, prior.output, run.invocations);
        }
        if (input.exportSession) {
          await mkdir(input.output, { recursive: true });
          const run = JSON.parse(await readFile(input.report, 'utf8'));
          if (input.exportSession !== run.sessionId) throw new Error('Export session does not match the run report');
          await exportNative(ctx, input.exportSession, input.output, run.invocations);
          result = { sessionId: input.exportSession, nativeExport: 'dsh-session.zip', coldRead: true };
        } else result = await campaign(ctx, input);
      }
      catch (error) { result = { error: error.stack }; }
      if (input?.output) {
        await mkdir(input.output, { recursive: true });
        await writeFile(path.join(input.output, 'finished.json'), JSON.stringify(result, null, 2));
      }
      ctx.logger.info('SLA campaign finished: ' + JSON.stringify(result));
    }, 3000);
    return () => clearTimeout(timer);
  });
}
