import type { Context } from '@deepseek-ai/cordis';
import type { Agent } from '@deepseek-ai/dsh-agent';
import type { } from '@deepseek-ai/dsh-agent-preset-registry';
import type { GenerateOptions, StreamChunk, ToolCallBlock } from '@deepseek-ai/dsh-llm';
import { ToolCallId } from '@deepseek-ai/dsh-llm';
import type { } from '@deepseek-ai/dsh-sandbox-policy';
import { SessionId } from '@deepseek-ai/dsh-session/types';
import type { } from '@deepseek-ai/dsh-skill';
import type { ObjectJsonSchema, ToolResult } from '@deepseek-ai/dsh-tools';
import type { Epoch, JsonValue } from '../dist/src/data.js';
import { isRecord, message } from '../dist/src/errors.js';
import type { } from '../dist/src/host.js';
import { settings } from '../dist/src/research-state.js';
import { candidateFixture, object, present, runFixture } from '../test/state-fixtures.ts';
// Load through a temporary dsh --patch overlay. Uses the real Host, spawn,
// tool and sandbox services, with scripted model output and no API calls.
import { LlmAdapter } from '@deepseek-ai/dsh-llm';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { access, mkdir, readFile, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { performanceWorkflow } from '../dist/extensions/performance.js';
import { fileArtifact } from '../dist/src/file-artifacts.js';
import { candidateFrom, observe, reserveAttempt } from '../dist/src/kernel.js';
import { initializeResearch } from '../dist/src/research-state.js';
import { inventory, snapshot } from '../dist/src/workspace.js';

export const inject = ['sla', 'agents', 'agentPresets', 'tools', 'llm', 'skills'];
const root = fileURLToPath(new URL('../artifacts/epoch/researcher/', import.meta.url));
const shellName = process.platform === 'win32' ? 'pwsh' : 'bash';
const requiredTools = ['read', 'write', 'edit', 'glob', 'grep', shellName, 'skill'];

function tool(name: string, args: Record<string, JsonValue>): StreamChunk[] {
  const block: ToolCallBlock = { type: 'tool-call', id: ToolCallId(randomUUID()), name, arguments: JSON.stringify(args) };
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}
const done: StreamChunk[] = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'done' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
  { type: 'finish', reason: { kind: 'stop' } },
];

type Response = StreamChunk[] | ((options: GenerateOptions) => StreamChunk[]);
type QueuedResponse = Response | { finalTools: string[]; response: Response };
class ScriptedAdapter extends LlmAdapter {
  queue: QueuedResponse[] = [];
  requests = 0;
  async resolveModel(provider: string, model: string) { return { provider, id: model, name: model }; }
  async *stream(options: GenerateOptions): AsyncGenerator<StreamChunk> {
    assert.equal(options.maxTokens, 32768, 'child did not inherit the native model output setting');
    const names = (options.tools ?? []).map(tool => tool.name);
    const queued = this.queue.shift();
    assert.ok(queued, 'unexpected model request');
    if ('finalTools' in queued) {
      assert.deepEqual(names, queued.finalTools, 'final step exposes working tools');
      assert.ok(JSON.stringify(options).includes('只剩结果提交步'), 'final submission guidance missing');
    } else for (const name of requiredTools) assert.ok(names.includes(name), `request missing ${name}`);
    assert.ok(!names.includes('sla_control'), 'child inherited the controller');
    this.requests++;
    const response = 'finalTools' in queued ? queued.response : queued;
    yield* typeof response === 'function' ? response(options) : response;
  }
}

async function verify(ctx: Context) {
  await ctx.sla.ready;
  const cwd = path.join(os.homedir(), '.dsh', 'sla-artifacts', 'private-researcher-smoke', randomUUID());
  await mkdir(cwd, { recursive: true });
  const projectSkillDir = path.join(cwd, '.agents', 'skills', 'sla-local-probe');
  await mkdir(projectSkillDir, { recursive: true });
  await writeFile(path.join(projectSkillDir, 'SKILL.md'), '---\nname: sla-local-probe\ndescription: Verify project skill discovery.\n---\nSLA_LOCAL_SKILL_PROBE: load from the current snapshot.\n');
  const roster = await ctx.agentPresets.list();
  assert.deepEqual(roster.filter(item => item.id.startsWith('sla')).map(item => item.id), ['sla']);
  const adapter = new ScriptedAdapter();
  const unregister = ctx.llm.registerAdapter(['sla-test'], adapter);
  const removeSkill = ctx.skills.register({ name: 'sla-probe', source: 'runtime', description: 'SLA skill loading verification', content: 'SLA_SKILL_PROBE: inspect project tests before editing.' });
  const children: Agent[] = [];
  const results: Array<{ name: string; isError: boolean; content: ToolResult['content'] }> = [];
  const unlisten = ctx.on('tools/result', (exec, result) => {
    if (children.some(child => child === exec.agent)) results.push({ name: exec.name, isError: !!result.isError, content: result.content });
  });
  const parent = await ctx.agents.create({
    sessionId: SessionId(randomUUID()), meta: { cwd, origin: 'subagent' }, agentOptions: { provider: 'sla-test', model: 'scripted', maxTokens: 32768 },
    setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, 'sla');
      agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
      agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
    },
  });
  const mainTools = () => ctx.tools.schemas(parent.agent).map(tool => tool.name).sort();
  let before = mainTools();
  assert.ok(before.includes('sla_control'));
  assert.ok(!before.includes('write'));
  const onStarted = async (id: string) => {
    const child = ctx.agents.get(SessionId(id));
    assert.ok(child);
    children.push(child);
    for (const name of requiredTools) assert.ok(ctx.tools.get(name, child), `child missing ${name}`);
    assert.equal(ctx.tools.get('sla_control', child), undefined);
    assert.equal(child.session.header.agentPreset, undefined);
    assert.equal(child.session.header.cwd, cwd);
    assert.deepEqual(mainTools(), before);
    assert.ok(!(await ctx.agentPresets.list()).some(item => item.id === 'sla-researcher'));
  };
  try {
    // Repeated invocations exercise plugin reuse and scope disposal.
    for (let index = 1; index <= 2; index++) {
      const filename = `probe-${index}.txt`;
      adapter.queue.push(tool('write', { file_path: filename, content: `private-child-${index}` }));
      adapter.queue.push(tool(shellName, { command: process.platform === 'win32' ? `Get-Content -LiteralPath '${filename}'` : `cat '${filename}'`, description: 'Read the private child test file' }));
      adapter.queue.push(done);
      const result = await ctx.sla.invoke({ settings: settings(), parent: parent.agent, role: 'worker', cwd, prompt: 'Run the scripted private child check.', signal: AbortSignal.timeout(60000), onStarted });
      assert.equal(object(result).summary, 'done');
      assert.equal(await readFile(path.join(cwd, filename), 'utf8'), `private-child-${index}`);
      assert.equal(ctx.agents.get(present(children.at(-1)).id), undefined);
      assert.equal(ctx.tools.get('write', present(children.at(-1))), undefined);
    }
    adapter.queue.push(tool('skill', { name: 'sla-probe' }), done);
    await ctx.sla.invoke({ settings: settings(), parent: parent.agent, role: 'worker', cwd, prompt: 'Load sla-probe.', signal: AbortSignal.timeout(60000), onStarted });
    assert.ok(present(results.at(-1)).content.some(block => (block.type === 'text' && block.text.includes('SLA_SKILL_PROBE'))), JSON.stringify(results.at(-1)));
    adapter.queue.push(tool('skill', { name: 'sla-local-probe' }), done);
    await ctx.sla.invoke({ settings: settings(), parent: parent.agent, role: 'worker', cwd, prompt: 'Load the project skill sla-local-probe.', signal: AbortSignal.timeout(60000), onStarted });
    assert.ok(present(results.at(-1)).content.some(block => (block.type === 'text' && block.text.includes('SLA_LOCAL_SKILL_PROBE'))), JSON.stringify(results.at(-1)));
    adapter.queue.push(options => {
      assert.ok(JSON.stringify(options).includes('缺陷复现成功就是本阶段成功'), 'scout role boundary missing from model request');
      const submit = present(options.tools).find(item => !requiredTools.includes(item.name) && isRecord(item.parameters.properties) && item.parameters.properties.ok);
      assert.ok(submit, 'structured completion tool missing');
      return tool(submit.name, { ok: true });
    });
    const result = await ctx.sla.invoke({ settings: settings(), parent: parent.agent, role: 'scout', cwd, prompt: 'Submit the scripted structured result.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, signal: AbortSignal.timeout(60000), onStarted });
    assert.deepEqual(result, { ok: true });
    assert.equal(results.length, 7);
    assert.ok(results.every(result => !result.isError), JSON.stringify(results));
    for (const role of ['advisor', 'reviewer']) {
      adapter.queue.push(options => {
        assert.ok(JSON.stringify(options).includes(role === 'advisor' ? '只读规划下一轮' : '只独立审查评价遗漏'), `${role} boundary missing`);
        const submit = present(options.tools).find(item => isRecord(item.parameters.properties) && item.parameters.properties.ok);
        assert.ok(submit);
        return tool(submit.name, { ok: true });
      });
      const value = await ctx.sla.invoke({ settings: settings(), parent: parent.agent, role, cwd, prompt: 'Submit the scripted role result.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, signal: AbortSignal.timeout(60000), onStarted });
      assert.deepEqual(value, { ok: true });
    }
    for (let index = 1; index <= 2; index++) assert.ok(results[index * 2 - 1].content.some(block => (block.type === 'text' && block.text.includes(`private-child-${index}`))));
    assert.equal(ctx.sla.researchOwners.size, 0);
    assert.equal(ctx.sla.calls.size, 0);
    assert.deepEqual(mainTools(), before);
    const fillWork = (last = tool('read', { file_path: 'probe-1.txt' })) => {
      adapter.queue.push(...Array.from({ length: 23 }, (_, index) => (options: GenerateOptions) => {
        if (index >= 20) assert.ok(JSON.stringify(options).includes('本次 SLA 调用已进入收尾阶段'), 'step budget feedback missing');
        return tool('read', { file_path: 'probe-1.txt' });
      }), last);
    };
    const schema: ObjectJsonSchema = { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false };
    const invoke = (role: string, signal = AbortSignal.timeout(60000)) => ctx.sla.invoke({ settings: settings(), parent: parent.agent, role, cwd, prompt: 'Exercise the final submission step.', ...(role === 'worker' ? {} : { schema }), signal, onStarted });
    fillWork(tool('write', { file_path: '.sla/last-work.txt', content: 'written in step 24' }));
    adapter.queue.push({ finalTools: ['structured_output'], response: tool('structured_output', { ok: true }) });
    assert.deepEqual(await invoke('scout'), { ok: true });
    assert.equal(await readFile(path.join(cwd, '.sla/last-work.txt'), 'utf8'), 'written in step 24');
    fillWork(); adapter.queue.push({ finalTools: [], response: done });
    assert.equal(object(await invoke('worker')).summary, 'done');
    for (const role of ['worker', 'scout']) {
      fillWork();
      adapter.queue.push({ finalTools: role === 'worker' ? [] : ['structured_output'], response: tool('write', { file_path: `forbidden-${role}.txt`, content: 'must never be written' }) });
      await assert.rejects(invoke(role), /24 个工作步和 1 个结果提交步上限/);
      await assert.rejects(access(path.join(cwd, `forbidden-${role}.txt`)), { code: 'ENOENT' });
      assert.equal(present(results.at(-1)).isError, true);
    }
    fillWork();
    adapter.queue.push({ finalTools: ['structured_output'], response: tool('structured_output', { ok: 'invalid type' }) });
    await assert.rejects(invoke('scout'), /24 个工作步和 1 个结果提交步上限/);
    fillWork(); adapter.queue.push({ finalTools: ['structured_output'], response: done });
    await assert.rejects(invoke('scout'), /未完成|未提交/);
    const cancellation = new AbortController();
    fillWork();
    adapter.queue.push({ finalTools: ['structured_output'], response: () => { cancellation.abort(new Error('cancel final submission')); return done; } });
    await assert.rejects(invoke('scout', cancellation.signal), /cancel final submission/);
    const nativeParentTools = before;
    const restorePresentation = parent.agent.ctx.tools.presentAs('ptc');
    before = mainTools();
    try {
      assert.ok(before.includes('run_code'), 'parent did not switch to PTC presentation');
      fillWork(); adapter.queue.push({ finalTools: ['structured_output'], response: tool('structured_output', { ok: true }) });
      assert.deepEqual(await invoke('scout'), { ok: true });
      assert.deepEqual(mainTools(), before);
    } finally { restorePresentation(); before = nativeParentTools; }
    adapter.queue.push(tool('structured_output', { ok: true }));
    assert.deepEqual(await invoke('scout'), { ok: true });
    adapter.queue.push(...Array.from({ length: 4 }, () => tool('read', { file_path: 'probe-1.txt' })));
    adapter.queue.push({ finalTools: ['structured_output'], response: tool('structured_output', { ok: true }) });
    assert.deepEqual(await ctx.sla.invoke({ parent: parent.agent, role: 'scout', cwd, prompt: 'Use the configured four work steps and submission step.', schema,
      settings: settings({ maxStepsPerCall: 4, maxMinutesPerCall: 1 }), signal: AbortSignal.timeout(60000), onStarted }), { ok: true });
    assert.equal(adapter.queue.length, 0);
    assert.equal(ctx.sla.calls.size, 0);
    assert.equal(ctx.sla.researchOwners.size, 0);
    assert.deepEqual(ctx.sla.tasks.list().map(task => task.id).sort(), ['code-bugfix', 'code-performance', 'retrieval-parameters']);
    const { review: _review, ...unreviewedPerformance } = performanceWorkflow;
    const external = { ...unreviewedPerformance, id: 'host-extension-probe', name: 'Host extension probe' };
    const plugin = { name: 'sla-extension-probe', inject: ['sla'], apply(scope: Context) { scope.effect(() => scope.sla.registerWorkflow(external)); } };
    const fiber = ctx.plugin(plugin); await fiber;
    const entry = ctx.sla.tasks.get(external);
    await fiber.dispose();
    assert.equal(entry.signal.aborted, true);
    assert.throws(() => ctx.sla.tasks.get(external), /未安装/);
    const upgraded = ctx.plugin({ name: 'sla-extension-upgrade-probe', inject: ['sla'], apply(scope: Context) { scope.effect(() => scope.sla.registerWorkflow({ ...external, version: '2.0.0' })); } }); await upgraded;
    assert.throws(() => ctx.sla.tasks.get(external), /版本不一致/);
    await upgraded.dispose();
    let nativeEvaluations = 0;
    const nativeTask = { ...external, id: 'native-readonly-probe', async evaluate() { nativeEvaluations++; return { valid: true, score: 1, summary: 'native check' }; } };
    const nativePlugin = ctx.plugin({ name: 'sla-native-readonly-probe', inject: ['sla'], apply(scope: Context) { scope.effect(() => scope.sla.registerWorkflow(nativeTask)); } }); await nativePlugin;
    try {
      const project = path.join(cwd, 'readonly-source'), evidenceRoot = path.join(cwd, 'readonly-evidence');
      await mkdir(project); await writeFile(path.join(project, 'value.txt'), 'original');
      const initial = path.join(evidenceRoot, 'initial'), best = path.join(evidenceRoot, 'best');
      await snapshot(project, initial); await snapshot(project, best); await writeFile(path.join(best, 'value.txt'), 'candidate');
      const run = runFixture({ id: randomUUID(), sessionId: parent.agent.id, goal: 'readonly verification', cwd: project, root: evidenceRoot, status: 'completed', revision: 1, notes: [], trials: [], attempts: 1, limit: 3, elapsedMs: 0, timeLimitMs: 1200000, sourceFiles: await inventory(project), baselineDir: initial, baseline: { valid: true, score: 2, summary: 'baseline' }, best: candidateFixture({ valid: true, score: 1, summary: 'candidate', dir: best, trial: 1 }), task: { id: nativeTask.id, version: nativeTask.version, name: nativeTask.name }, criteria: { ready: true, criterion: 'native check' }, adopted: false });
      initializeResearch(run);
      Object.assign(run, { stage: 'completed', message: 'Read-only adoption fixture', createdAt: new Date().toISOString(), attempts: 0, evaluationDir: initial, evaluationFiles: await inventory(initial) });
      const baselineArtifact = await fileArtifact(run, initial);
      const baselineObservation = observe(run, baselineArtifact.id, present(run.baseline));
      run.baselineArtifactId = baselineArtifact.id; run.baselineObservationId = baselineObservation.id;
      const seed = candidateFrom({ evaluation: present(run.baseline), artifactId: baselineArtifact.id, observationId: baselineObservation.id }, { trial: 0, criteriaVersion: run.criteriaVersion, dir: initial });
      const lane = { id: 'readonly', revision: 1, seed, best: null };
      const assignment = { direction: 'readonly', hypothesis: 'verify permission before evaluation', instructions: '', evidenceTrials: [] };
      const epoch: Epoch = { number: 1, revision: 1, criteriaVersion: 1, status: 'completed', assignments: [{ ...assignment, trialLimit: 1 }] };
      run.directions.push(lane); run.epochs.push(epoch);
      const trial = reserveAttempt(run, epoch, assignment, lane);
      const artifact = await fileArtifact(run, best, trial.number, baselineArtifact.id);
      const evaluation = { valid: true, score: 1, summary: 'candidate' };
      const observation = observe(run, artifact.id, evaluation);
      run.best = candidateFrom({ evaluation, artifactId: artifact.id, observationId: observation.id }, { trial: trial.number, criteriaVersion: 1, dir: best });
      Object.assign(trial, { status: 'kept', assessmentStatus: 'completed', artifactId: artifact.id, observationId: observation.id, evaluation });
      run.invocations = [];
      run.workflow = { kind: 'code', id: nativeTask.id, version: nativeTask.version };
      await ctx.sla.engine.save(run);
      parent.agent.session.append('sandbox/mode', { mode: 'read-only', source: 'delegation' });
      await assert.rejects(ctx.sla.action(parent.agent, JSON.stringify({ action: 'adopt' })), /只读模式/);
      assert.equal(await readFile(path.join(project, 'value.txt'), 'utf8'), 'original');
      assert.equal(nativeEvaluations, 0);
    } finally { await nativePlugin.dispose(); }
    assert.deepEqual(mainTools(), before);
    return { passed: true, model: 'scripted; no external API', requests: adapter.requests, children: children.map(child => child.id), tools: results, tasks: ctx.sla.tasks.list(), stepLimitReported: true, finalSubmissionVerified: true, finalStepWritesDenied: true, finalStepCancellationVerified: true, ptcParentVerified: true, nativeReadonlyAdoptionBlocked: true, pluginLifecycleVerified: true, skillLoaded: true, projectSkillLoaded: true, publicSlaPresets: ['sla'], privateToolsDisposed: children.every(child => ctx.tools.get('write', child) === undefined), cwd };
  } finally {
    unlisten();
    unregister();
    removeSkill();
    await parent.dispose();
  }
}

export function apply(ctx: Context) {
  // Let the Web profile finish mounting its factory and sandbox providers.
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let report;
      try { report = await verify(ctx); }
      catch (error) { report = { passed: false, error: error instanceof Error ? error.stack : message(error) }; }
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
      ctx.logger.info(JSON.stringify(report));
    }, 3000);
    return () => clearTimeout(timer);
  });
}
