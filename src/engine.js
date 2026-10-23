import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inventory, snapshot, changedFiles, copyEvaluation, verifyEvaluation, adopt, recoverAdoption, candidateDiff } from './workspace.js';
import { advisorSchema, workerSchema, advisorPrompt, workerPrompt, selection } from './prompts.js';
import { compare, validateEvaluation } from './task-registry.js';

export class ExplorationEngine {
  constructor({ store, adapter, tasks, root, maxTrials = 3, maxMinutes = 20 }) {
    Object.assign(this, { store, adapter, tasks, root, maxTrials, maxMinutes });
    this.active = new Map();
    this.actions = new Map();
    this.closing = false;
    this.lifecycle = new AbortController();
  }
  async recover() {
    for (const [key, saved] of this.store.entries()) {
      const record = structuredClone(saved);
      if (record.id && !record.formatVersion && !record.task) {
        record.task = { id: 'code-performance', version: '1.0.0', name: '代码性能' };
        record.selectionReason = '从 0.1 的性能评价记录迁移，保留原有规则。';
      }
      if (record.id) record.formatVersion = 2;
      if (record.activeSince) {
        record.elapsedMs += Math.min(Math.max(0, Date.now() - record.activeSince), Math.max(0, record.timeLimitMs - record.elapsedMs));
        delete record.activeSince;
      }
      if (['running', 'pausing', 'stopping', 'preparing'].includes(record.status)) {
        record.status = 'paused';
        record.message = '上次运行已中断，已保存证据；点击继续从已确认结果恢复。';
        for (const trial of record.trials) if (trial.status === 'running') Object.assign(trial, { status: 'inconclusive', summary: '进程中断，未得到完整评价' });
        for (const call of record.invocations ?? []) if (call.status === 'running') call.status = 'interrupted';
      }
      if (record.root) await recoverAdoption(record);
      await this.store.put(key, record);
    }
  }
  get(id) { return structuredClone(this.store.get(id) ?? null); }
  async save(run) {
    run.updatedAt = new Date().toISOString();
    const copy = structuredClone(run);
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
      run = { formatVersion: 2, id, sessionId: parent.id, goal: input.text, notes: [], revision: 1, cwd, root: path.join(this.root, id), status: 'preparing', stage: 'snapshot', message: '正在读取项目并建立初始快照', trials: [], invocations: [], attempts: 0, limit: this.maxTrials, elapsedMs: 0, timeLimitMs: this.maxMinutes * 60000, createdAt: new Date().toISOString(), adopted: false };
      await this.save(run);
      this.launch(run, parent);
    } else {
      if (!run) throw new Error('请先输入目标开始探索。');
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
        run.rebuild = true;
        run.message = '收到补充，将重新建立依据并重测基线；旧结果保留在记录中';
        if (live) { run.status = 'pausing'; await this.save(run); live.restart = true; live.controller.abort(new Error('目标调整')); }
        else {
          if (run.attempts >= run.limit || run.elapsedMs >= run.timeLimitMs) {
            run.status = 'paused'; run.message = '已保存补充要求；本轮额度已用完，点击继续开启下一轮。';
            await this.save(run);
          } else { await this.save(run); this.launch(run, parent); }
        }
      } else if (input.action === 'resume') {
        if (live) throw new Error('当前探索尚未停止，请稍后继续。');
        if (run.adopted) throw new Error('已采用，请在新会话中探索。');
        // A deliberate continuation grants one new bounded tranche, retaining prior usage.
        if (run.attempts >= run.limit || run.status === 'completed') run.limit = run.attempts + this.maxTrials;
        if (run.elapsedMs >= run.timeLimitMs) run.timeLimitMs = run.elapsedMs + this.maxMinutes * 60000;
        this.launch(run, parent);
      } else if (input.action === 'adopt') {
        if (live) throw new Error('请先暂停探索再采用。');
        if (run.rebuild) throw new Error('目标已调整，请继续探索并完成新的评价后再采用。');
        if (run.adopted) return this.get(parent.id);
        if (!run.best || run.best.dir === run.baselineDir) throw new Error('尚无通过评价的改进可采用。');
        const entry = this.tasks.get(run.task);
        const eligible = await this.evaluate(run, run.best.dir, parent, this.lifecycle.signal);
        this.lifecycle.signal.throwIfAborted();
        run.adoptionCheck = eligible; await this.save(run);
        if (!eligible.valid) throw new Error('采用前复验未通过：' + eligible.summary);
        if (compare(entry.task, eligible, run.baseline, run.criteria) !== 'better') throw new Error('采用前复验未显示优于基线，未写回。结果已保存在证据目录。');
        run.adoptionPending = true; await this.save(run);
        try {
          entry.signal.throwIfAborted();
          run.adoptedFiles = await adopt(run, async () => {
            entry.signal.throwIfAborted(); this.lifecycle.signal.throwIfAborted();
            await this.adapter.authorize(parent);
          });
        }
        catch (error) {
          run.adoptionPending = false;
          await recoverAdoption(run);
          await this.save(run);
          throw error;
        }
        run.adopted = true;
        run.adoptionPending = false;
        run.message = '已采用并校验文件内容；原始快照保留在证据目录。';
        await this.save(run);
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
  async invoke(run, parent, role, cwd, prompt, schema, signal) {
    signal.throwIfAborted();
    const invocation = { role, revision: run.revision, startedAt: new Date().toISOString(), status: 'running' };
    run.invocations.push(invocation);
    await this.save(run);
    try {
      return await this.adapter.invoke({ parent, role, cwd, prompt, schema, signal, onStarted: async childId => { invocation.childId = childId; await this.save(run); } });
    } finally {
      invocation.status = signal.aborted ? 'interrupted' : 'settled';
      await this.save(run);
    }
  }
  async evaluate(run, candidate, parent, signal, criteria = run.criteria) {
    await this.adapter.authorize(parent);
    const entry = this.tasks.get(run.task);
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted();
    const dir = path.join(run.root, 'checks', randomUUID());
    await snapshot(candidate, dir);
    const evaluationFiles = await copyEvaluation(run.evaluationDir, dir);
    if (run.evaluationFiles && changedFiles(run.evaluationFiles, evaluationFiles).length) throw new Error('固定评价依据校验失败');
    const evidence = path.join(dir, 'evaluation-output.json');
    const outputs = [];
    try {
      const parsed = validateEvaluation(await entry.task.evaluate({
        cwd: dir, signal, criteria: structuredClone(criteria),
        execute: async command => {
          signal.throwIfAborted();
          if (typeof command !== 'string' || !command.trim()) throw new Error('评价命令不能为空');
          const result = await this.adapter.execute({ parent, cwd: dir, signal, command });
          outputs.push({ command, result });
          await writeFile(evidence, JSON.stringify({ outputs }, null, 2));
          return result;
        },
      }));
      signal.throwIfAborted();
      await this.adapter.authorize(parent);
      // Evaluators run in a throwaway copy, but may not rewrite their own checks.
      await verifyEvaluation(dir, evaluationFiles);
      await writeFile(evidence, JSON.stringify({ task: run.task, outputs, result: parsed }, null, 2));
      return { ...parsed, evidence };
    } catch (error) {
      await writeFile(evidence, JSON.stringify({ task: run.task, outputs, error: String(error.message ?? error) }, null, 2));
      throw error;
    }
  }
  async execute(run, parent, signal) {
    run.status = 'running';
    if (!run.sourceFiles) {
      run.baselineDir = path.join(run.root, 'initial-' + randomUUID());
      run.sourceFiles = await snapshot(run.cwd, run.baselineDir);
      if (!Object.keys(run.sourceFiles).length) throw new Error('项目中没有可探索的源文件。');
      await this.save(run);
    }
    if (run.rebuild) {
      run.revision++;
      run.criteria = null; run.baseline = null; run.best = null;
      run.rebuild = false;
    }
    if (!run.task) {
      const available = this.tasks.list();
      if (!available.length) throw new Error('没有已安装的 SLA 任务扩展，请在 DSH 中启用任务插件。');
      run.stage = 'select'; run.message = '正在调查项目并选择合适的任务方法'; await this.save(run);
      const selector = selection(available);
      const selectionDir = path.join(run.root, 'selection-' + randomUUID());
      await snapshot(run.baselineDir, selectionDir);
      const choice = await this.invoke(run, parent, 'selector', selectionDir, selector.prompt(run), selector.schema, signal);
      if (changedFiles(run.sourceFiles, await inventory(selectionDir)).length) throw new Error('任务选择阶段修改了项目，未接受选择结果。');
      const selected = available.find(task => task.id === choice.taskId);
      if (!selected) throw new Error('没有适用的已安装任务扩展：' + choice.reason);
      this.tasks.get(selected);
      run.task = { id: selected.id, version: selected.version, name: selected.name };
      run.selectionReason = choice.reason;
      await this.save(run);
    }
    const entry = this.tasks.get(run.task), task = entry.task;
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted();
    if (!run.criteria) {
      run.stage = 'discover'; run.message = '正在调查项目、建立正确性检查与评价依据'; await this.save(run);
      const setup = path.join(run.root, 'setup-' + randomUUID());
      await snapshot(run.baselineDir, setup);
      await mkdir(path.join(setup, '.sla'), { recursive: true });
      const criteria = await this.invoke(run, parent, 'scout', setup, task.prepare.prompt(structuredClone(run)), task.prepare.schema, signal);
      if (!criteria.ready) throw new Error('尚未建立可靠判断依据：' + criteria.reason);
      if (typeof criteria.criterion !== 'string' || !criteria.criterion.trim()) throw new Error('扩展没有说明评价依据');
      if (changedFiles(run.sourceFiles, await inventory(setup)).length) throw new Error('调查阶段修改了项目源文件，未接受该评价依据。');
      run.evaluationDir = path.join(run.root, 'criteria-' + run.revision + '-' + randomUUID());
      run.evaluationFiles = await copyEvaluation(setup, run.evaluationDir);
      run.stage = 'baseline'; run.message = '正在实际运行基线检查'; await this.save(run);
      const baseline = await this.evaluate(run, run.baselineDir, parent, signal, criteria);
      await task.validateBaseline(structuredClone(baseline), structuredClone(criteria));
      signal.throwIfAborted();
      run.criteria = criteria; run.baseline = baseline;
      run.best = { ...baseline, evaluation: baseline, dir: run.baselineDir, trial: 0 };
      await this.save(run);
    }
    while (run.attempts < run.limit) {
      signal.throwIfAborted();
      run.stage = 'plan'; run.message = '正在根据已有结果选择下一条方向'; await this.save(run);
      const advisoryDir = path.join(run.root, 'advice-' + randomUUID());
      await snapshot(run.best.dir, advisoryDir);
      const plan = await this.invoke(run, parent, 'advisor', advisoryDir, advisorPrompt(run, task), advisorSchema, signal);
      if (plan.stop) { run.message = plan.reason; break; }
      const number = ++run.attempts;
      const dir = path.join(run.root, 'candidate-' + number);
      await snapshot(run.best.dir, dir);
      const trial = { number, revision: run.revision, hypothesis: plan.hypothesis, status: 'running', dir };
      run.trials.push(trial); run.stage = 'experiment'; run.message = plan.hypothesis; await this.save(run);
      try {
        const report = await this.invoke(run, parent, 'worker', dir, workerPrompt(run, plan, task), workerSchema, signal);
        run.stage = 'evaluate'; run.message = '正在用固定依据检查候选 ' + number; await this.save(run);
        const result = await this.evaluate(run, dir, parent, signal);
        const changed = changedFiles(await inventory(run.best.dir), await inventory(dir));
        Object.assign(trial, { evaluation: result, valid: result.valid, ...(result.display !== undefined ? { display: result.display } : {}), ...(result.score !== undefined ? { score: result.score } : {}), evidence: result.evidence, summary: result.summary, changes: changed, report: report.summary });
        if (!result.valid) trial.status = 'invalid';
        else if (changed.length && compare(task, result, run.best.evaluation ?? run.best, run.criteria) === 'better') {
          trial.status = 'kept';
          const diff = await candidateDiff(run.baselineDir, dir);
          await writeFile(path.join(run.root, 'best.patch'), diff);
          run.best = { ...result, evaluation: result, dir, trial: number, diff };
        } else trial.status = 'no-improvement';
      } catch (e) {
        trial.status = 'inconclusive'; trial.summary = String(e.message ?? e);
        if (signal.aborted) throw e;
      }
      await this.save(run);
      if (run.best.trial && task.complete?.(structuredClone(run.best.evaluation ?? run.best), structuredClone(run.criteria)) === true) break;
    }
    signal.throwIfAborted();
    run.status = 'completed'; run.stage = 'result';
    run.message = run.best.trial ? '本轮探索结束，已保留通过检查的最佳候选。' : '本轮没有找到通过检查且更好的候选，保留原项目。';
  }
  async dispose() {
    this.closing = true;
    this.lifecycle.abort(new Error('插件关闭'));
    for (const live of this.active.values()) live.controller.abort(new Error('插件关闭'));
    await Promise.allSettled([...this.actions.values()]);
    await Promise.allSettled([...this.active.values()].map(x => x.promise));
  }
}
