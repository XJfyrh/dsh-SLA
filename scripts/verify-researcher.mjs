// Load through a temporary dsh --patch overlay. Uses the real Host, spawn,
// tool and sandbox services, with scripted model output and no API calls.
import assert from 'node:assert/strict';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { randomUUID } from 'node:crypto';
import path from 'node:path';
import os from 'node:os';
import { LlmAdapter } from '@deepseek-ai/dsh-llm';

export const inject = ['sla', 'agents', 'agentPresets', 'tools', 'llm'];
const root = fileURLToPath(new URL('../artifacts/private-researcher/', import.meta.url));
const shellName = process.platform === 'win32' ? 'pwsh' : 'bash';
const requiredTools = ['read', 'write', 'edit', 'glob', 'grep', shellName];

function tool(name, args) {
  const block = { type: 'tool-call', id: randomUUID(), name, arguments: JSON.stringify(args) };
  return [
    { type: 'block-start', index: 0, blockType: 'tool-call' },
    { type: 'tool-call-delta', index: 0, id: block.id, name, argumentsDelta: block.arguments },
    { type: 'block-end', index: 0, block },
    { type: 'finish', reason: { kind: 'tool-calls' } },
  ];
}
const done = [
  { type: 'block-start', index: 0, blockType: 'text' },
  { type: 'text-delta', index: 0, text: 'done' },
  { type: 'block-end', index: 0, block: { type: 'text', text: 'done' } },
  { type: 'finish', reason: { kind: 'stop' } },
];

class ScriptedAdapter extends LlmAdapter {
  queue = [];
  requests = 0;
  async resolveModel(provider, model) { return { provider, id: model, name: model }; }
  async *stream(options) {
    const names = options.tools.map(tool => tool.name);
    for (const name of requiredTools) assert.ok(names.includes(name), `first request missing ${name}`);
    assert.ok(!names.includes('sla_control'), 'child inherited the controller');
    this.requests++;
    const response = this.queue.shift();
    assert.ok(response, 'unexpected model request');
    yield* typeof response === 'function' ? response(options) : response;
  }
}

async function verify(ctx) {
  await ctx.sla.ready;
  const cwd = path.join(os.homedir(), '.dsh', 'sla-artifacts', 'private-researcher-smoke', randomUUID());
  await mkdir(cwd, { recursive: true });
  const roster = await ctx.agentPresets.list();
  assert.deepEqual(roster.filter(item => item.id.startsWith('sla')).map(item => item.id), ['sla']);
  const adapter = new ScriptedAdapter();
  const unregister = ctx.llm.registerAdapter(['sla-test'], adapter);
  const children = [];
  const results = [];
  const unlisten = ctx.on('tools/result', (exec, result) => {
    if (children.some(child => child === exec.agent)) results.push({ name: exec.name, isError: !!result.isError, content: result.content });
  });
  const parent = await ctx.agents.create({
    sessionId: randomUUID(), meta: { cwd, origin: 'subagent' }, agentOptions: { provider: 'sla-test', model: 'scripted' },
    setup: async (agentCtx, agent) => {
      await ctx.agentPresets.mount(agentCtx, 'sla');
      agent.session.append('sandbox/mode', { mode: 'workspace-write', source: 'delegation' });
      agent.session.append('approval/policy', { policy: 'never', source: 'delegation' });
    },
  });
  const mainTools = () => ctx.tools.schemas(parent.agent).map(tool => tool.name).sort();
  const before = mainTools();
  assert.ok(before.includes('sla_control'));
  assert.ok(!before.includes('write'));
  const onStarted = async id => {
    const child = ctx.agents.get(id);
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
      const result = await ctx.sla.invoke({ parent: parent.agent, role: 'worker', cwd, prompt: 'Run the scripted private child check.', signal: AbortSignal.timeout(60000), onStarted });
      assert.equal(result.summary, 'done');
      assert.equal(await readFile(path.join(cwd, filename), 'utf8'), `private-child-${index}`);
      assert.equal(ctx.agents.get(children.at(-1).id), undefined);
      assert.equal(ctx.tools.get('write', children.at(-1)), undefined);
    }
    adapter.queue.push(options => {
      const submit = options.tools.find(item => !requiredTools.includes(item.name) && item.parameters?.properties?.ok);
      assert.ok(submit, 'structured completion tool missing');
      return tool(submit.name, { ok: true });
    });
    const result = await ctx.sla.invoke({ parent: parent.agent, role: 'scout', cwd, prompt: 'Submit the scripted structured result.', schema: { type: 'object', properties: { ok: { type: 'boolean' } }, required: ['ok'], additionalProperties: false }, signal: AbortSignal.timeout(60000), onStarted });
    assert.deepEqual(result, { ok: true });
    assert.equal(results.length, 5);
    assert.ok(results.every(result => !result.isError), JSON.stringify(results));
    for (let index = 1; index <= 2; index++) assert.ok(results[index * 2 - 1].content.some(block => block.text?.includes(`private-child-${index}`)));
    assert.equal(ctx.sla.researchOwners.size, 0);
    assert.equal(ctx.sla.calls.size, 0);
    assert.deepEqual(mainTools(), before);
    return { passed: true, model: 'scripted; no external API', requests: adapter.requests, children: children.map(child => child.id), tools: results, publicSlaPresets: ['sla'], privateToolsDisposed: children.every(child => ctx.tools.get('write', child) === undefined), cwd };
  } finally {
    unlisten();
    unregister();
    await parent.dispose();
  }
}

export function apply(ctx) {
  // Let the Web profile finish mounting its factory and sandbox providers.
  ctx.effect(() => {
    const timer = setTimeout(async () => {
      let report;
      try { report = await verify(ctx); }
      catch (error) { report = { passed: false, error: error.stack }; }
      await mkdir(root, { recursive: true });
      await writeFile(path.join(root, 'verification.json'), JSON.stringify(report, null, 2));
      ctx.logger.info(JSON.stringify(report));
    }, 3000);
    return () => clearTimeout(timer);
  });
}
