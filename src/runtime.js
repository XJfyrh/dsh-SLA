import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { defaults, settings, initializeResearch } from './research-state.js';
import { jsonValue } from './kernel.js';

export class ExplorationRuntime {
  constructor({ store, adapter, tasks, root, resolveWorkflow, selectWorkflow, migrateRecord = () => {}, maxTrials = defaults.maxTrials, maxMinutes = defaults.maxMinutes, directions = defaults.directions, localTrials = defaults.localTrials }) {
    Object.assign(this, { store, adapter, tasks, root, resolveWorkflow, selectWorkflow, migrateRecord });
    this.defaults = settings({ maxTrials, maxMinutes, directions, localTrials });
    this.active = new Map();
    this.actions = new Map();
    this.closing = false;
    this.lifecycle = new AbortController();
  }
  async recover() {
    for (const [key, saved] of this.store.entries()) {
      const record = structuredClone(saved);
      this.migrateRecord(record);
      if (record.id) initializeResearch(record, this.defaults);
      if (record.activeSince) {
        record.elapsedMs += Math.min(Math.max(0, Date.now() - record.activeSince), Math.max(0, record.timeLimitMs - record.elapsedMs));
        delete record.activeSince;
      }
      if (['running', 'pausing', 'stopping', 'preparing'].includes(record.status)) {
        record.status = 'paused';
        record.message = '上次运行已中断，已保存证据；点击继续从已确认结果恢复。';
        for (const trial of record.trials) if (trial.status === 'running') Object.assign(trial, { status: 'inconclusive', summary: '进程中断，未得到完整评价' });
        for (const call of record.invocations ?? []) if (call.status === 'running') call.status = 'interrupted';
        for (const review of record.reviews ?? []) if (review.status === 'running') { review.status = 'inconclusive'; review.error = '进程中断，未提交完整审查'; }
      }
      if (record.root) {
        try { await this.workflow(record).recover(record); }
        catch (error) { record.status = 'blocked'; record.message = String(error.message ?? error); }
      }
      await this.store.put(key, record);
    }
  }
  get(id) { return structuredClone(this.store.get(id) ?? null); }
  async save(run) {
    run.updatedAt = new Date().toISOString();
    const copy = jsonValue(run);
    await this.store.put(run.sessionId, copy);
    await mkdir(run.root, { recursive: true });
    await writeFile(path.join(run.root, 'report.json'), JSON.stringify(copy, null, 2));
  }
  action(parent, input) {
    const id = parent.id;
    const next = (this.actions.get(id) ?? Promise.resolve()).catch(() => {}).then(() => this.mutate(parent, input));
    this.actions.set(id, next);
    return next.finally(() => { if (this.actions.get(id) === next) this.actions.delete(id); });
  }
  async mutate(parent, input) {
    if (this.closing) throw new Error('插件正在关闭');
    const live = this.active.get(parent.id);
    let run = live?.run ?? this.get(parent.id);
    if (input.action === 'start') {
      if (run) throw new Error('此会话已有探索，请继续或新建会话。');
      const cwd = await this.adapter.directory(parent);
      const id = randomUUID();
      const config = settings(input.settings, this.defaults);
      run = { formatVersion: 3, id, sessionId: parent.id, goal: input.text, notes: [], revision: 1, cwd, root: path.join(this.root, id), status: 'preparing', stage: 'snapshot', message: '正在选择适合目标的探索工作流', trials: [], invocations: [], attempts: 0, limit: config.maxTrials, elapsedMs: 0, timeLimitMs: config.maxMinutes * 60000, createdAt: new Date().toISOString(), adopted: false };
      initializeResearch(run, config);
      await this.save(run);
      this.launch(run, parent);
    } else {
      if (!run) throw new Error('请先输入目标开始探索。');
      initializeResearch(run, this.defaults);
      if (run.adoptionPending) throw new Error(run.message);
      if (input.action === 'pause' || input.action === 'stop') {
        if (live) live.restart = false;
        run.status = live ? (input.action === 'pause' ? 'pausing' : 'stopping') : (input.action === 'pause' ? 'paused' : 'completed');
        run.message = live ? '正在停止当前调用，已确认结果会保留' : '已停止，证据与候选保留';
        await this.save(run);
        live?.controller.abort(new Error('用户停止'));
      } else if (input.action === 'steer') {
        if (run.adopted) throw new Error('采用后请新建会话开展下一次探索。');
        run.notes.push(input.text);
        run.reviewOnly = false; delete run.stopReason;
        run.rebuild = true;
        run.message = '收到补充，将重新建立依据并重测基线；旧结果保留在记录中';
        if (live) { run.status = 'pausing'; await this.save(run); live.restart = true; live.controller.abort(new Error('目标调整')); }
        else {
          if (run.attempts >= run.limit || run.elapsedMs >= run.timeLimitMs) {
            run.status = 'paused'; run.message = '已保存补充要求；本轮额度已用完，点击继续开启下一轮。';
            await this.save(run);
          } else { await this.save(run); this.launch(run, parent); }
        }
      } else if (input.action === 'configure') {
        if (live || run.adopted) throw new Error('请暂停探索后调整设置。');
        run.settings = settings(input.settings, run.settings);
        if (Object.hasOwn(input.settings ?? {}, 'maxTrials')) run.limit = run.tranche.attempt + run.settings.maxTrials;
        if (Object.hasOwn(input.settings ?? {}, 'maxMinutes')) run.timeLimitMs = run.tranche.elapsedMs + run.settings.maxMinutes * 60000;
        await this.save(run);
      } else if (input.action === 'resume' || input.action === 'review') {
        if (live) throw new Error('当前探索尚未停止，请稍后继续。');
        if (run.adopted) throw new Error('已采用，请在新会话中探索。');
        // A deliberate continuation grants one new bounded tranche, retaining prior usage.
        if (run.attempts >= run.limit || run.elapsedMs >= run.timeLimitMs || run.status === 'completed') {
          run.tranche = { attempt: run.attempts, elapsedMs: run.elapsedMs };
          run.limit = run.attempts + run.settings.maxTrials;
          run.timeLimitMs = run.elapsedMs + run.settings.maxMinutes * 60000;
        }
        run.reviewOnly = input.action === 'review';
        delete run.stopReason;
        if (run.reviewOnly) run.reviewedBest = null;
        this.launch(run, parent);
      } else if (input.action === 'adopt') {
        if (live) throw new Error('请先暂停探索再采用。');
        if (run.rebuild) throw new Error('目标已调整，请继续探索并完成新的评价后再采用。');
        if (run.adopted) return this.get(parent.id);
        await this.workflow(run).deliver(run, parent, this.lifecycle.signal);
      } else throw new Error('未知操作');
    }
    return this.get(parent.id);
  }
  launch(run, parent) {
    if (this.closing) throw new Error('插件正在关闭');
    if (this.active.has(run.sessionId)) throw new Error('探索已经运行');
    const controller = new AbortController();
    const live = { run, controller, restart: false };
    this.active.set(run.sessionId, live);
    const started = Date.now();
    run.activeSince = started;
    const remaining = Math.max(1, run.timeLimitMs - run.elapsedMs);
    const timer = setTimeout(() => { live.budgetExpired = true; controller.abort(new Error('时间额度已用完')); }, remaining);
    live.promise = this.execute(run, parent, controller.signal).catch(error => {
      if (controller.signal.aborted) {
        run.status = run.status === 'stopping' ? 'completed' : 'paused';
        run.message = live.budgetExpired ? '本轮时间额度已用完，已保留结果。' : run.rebuild ? '目标已调整，准备重建评价依据。' : '已暂停，已确认的结果与证据保留。';
      } else { run.status = 'blocked'; run.message = String(error.message ?? error); }
      for (const trial of run.trials) if (trial.status === 'running') Object.assign(trial, { status: 'inconclusive', summary: String(error.message ?? error) });
    }).finally(async () => {
      clearTimeout(timer);
      run.elapsedMs += Date.now() - started;
      delete run.activeSince;
      try { await this.save(run); }
      finally {
        this.active.delete(run.sessionId);
        if (live.restart && !this.closing) this.launch(run, parent);
      }
    });
    // The loop owns the error state; logging failures must remain visible.
    live.promise.catch(error => this.adapter.error(error));
  }
  async invoke(run, parent, role, cwd, prompt, schema, signal, { attempt, blueprint } = {}) {
    signal.throwIfAborted();
    const invocation = { id: randomUUID(), role, revision: run.revision, criteriaVersion: run.criteriaVersion, startedAt: new Date().toISOString(), status: 'running', ...(attempt ? { attemptId: attempt.id } : {}) };
    run.invocations.push(invocation);
    attempt?.invocationIds.push(invocation.id);
    await this.save(run);
    try {
      const result = await this.adapter.invoke({ parent, role, cwd, prompt, schema, blueprint, settings: run.settings, signal, onStarted: async childId => { invocation.childId = childId; await this.save(run); } });
      signal.throwIfAborted();
      invocation.status = 'completed';
      return result;
    } catch (error) {
      invocation.status = signal.aborted ? 'interrupted' : 'failed';
      invocation.error = String(error.message ?? error);
      invocation.quiescent = error.quiescent === true;
      throw error;
    } finally {
      invocation.finishedAt = new Date().toISOString();
      await this.save(run);
    }
  }
  workflow(run) { return this.resolveWorkflow(run); }
  async execute(run, parent, signal) {
    await this.selectWorkflow(this, run, parent, signal);
    return this.workflow(run).execute(run, parent, signal);
  }
  async evaluate(...args) { return this.workflow(args[0]).evaluate(...args); }
  async dispose() {
    this.closing = true;
    this.lifecycle.abort(new Error('插件关闭'));
    for (const live of this.active.values()) live.controller.abort(new Error('插件关闭'));
    await Promise.allSettled([...this.actions.values()]);
    await Promise.allSettled([...this.active.values()].map(x => x.promise));
  }
}
