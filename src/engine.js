import path from 'node:path';
import { mkdir, writeFile } from 'node:fs/promises';
import { randomUUID } from 'node:crypto';
import { inventory, snapshot, changedFiles, copyEvaluation, verifyEvaluation, adopt, recoverAdoption, candidateDiff } from './workspace.js';
import { advisorSchema, workerSchema, advisorPrompt, workerPrompt, selection } from './prompts.js';
import { compare, validateEvaluation } from './task-registry.js';
import { defaults, settings, initializeResearch, validatePlan, reviewed } from './research-state.js';
import { reviewCandidate, finishReview } from './review.js';

export class ExplorationEngine {
  constructor({ store, adapter, tasks, root, maxTrials = defaults.maxTrials, maxMinutes = defaults.maxMinutes, directions = defaults.directions, localTrials = defaults.localTrials }) {
    Object.assign(this, { store, adapter, tasks, root, maxTrials, maxMinutes });
    this.defaults = settings({ maxTrials, maxMinutes, directions, localTrials });
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
      const config = settings(input.settings, this.defaults);
      run = { formatVersion: 3, id, sessionId: parent.id, goal: input.text, notes: [], revision: 1, cwd, root: path.join(this.root, id), status: 'preparing', stage: 'snapshot', message: '正在读取项目并建立初始快照', trials: [], invocations: [], attempts: 0, limit: config.maxTrials, elapsedMs: 0, timeLimitMs: config.maxMinutes * 60000, createdAt: new Date().toISOString(), adopted: false };
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
        if (!run.best || run.best.dir === run.baselineDir) throw new Error('尚无通过评价的改进可采用。');
        const entry = this.tasks.get(run.task);
        if (!reviewed(run, entry.task)) throw new Error('候选尚未完成当前版本的独立审查，请先检查候选。');
        const approvedFiles = await inventory(run.best.dir);
        if (entry.task.review && changedFiles(run.reviewedBest.files, approvedFiles).length) throw new Error('审查后候选文件已改变，未采用；请重新检查候选。');
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
          }, approvedFiles);
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
      const result = await this.adapter.invoke({ parent, role, cwd, prompt, schema, signal, onStarted: async childId => { invocation.childId = childId; await this.save(run); } });
      signal.throwIfAborted();
      return result;
    } finally {
      invocation.status = signal.aborted ? 'interrupted' : 'settled';
      await this.save(run);
    }
  }
  async evaluate(run, candidate, parent, signal, criteria = run.criteria, spec = run) {
    await this.adapter.authorize(parent);
    const entry = this.tasks.get(run.task);
    signal = AbortSignal.any([signal, entry.signal]);
    signal.throwIfAborted();
    const dir = path.join(run.root, 'checks', randomUUID());
    const candidateFiles = await snapshot(candidate, dir);
    const evaluationFiles = await copyEvaluation(spec.evaluationDir, dir);
    if (spec.evaluationFiles && changedFiles(spec.evaluationFiles, evaluationFiles).length) throw new Error('固定评价依据校验失败');
    const evidence = path.join(run.root, 'evaluation-output-' + randomUUID() + '.json');
    const outputs = [];
    try {
      const context = {
        cwd: dir, signal, criteria: structuredClone(criteria),
        execute: async command => {
          signal.throwIfAborted();
          if (typeof command !== 'string' || !command.trim()) throw new Error('评价命令不能为空');
          const result = await this.adapter.execute({ parent, cwd: dir, signal, command });
          outputs.push({ command, result });
          await writeFile(evidence, JSON.stringify({ outputs }, null, 2));
          return result;
        },
      };
      const parsed = validateEvaluation(await entry.task.evaluate(context));
      const supplementary = [];
      for (const check of spec.checks ?? []) {
        if (!entry.task.review) throw new Error('当前任务扩展无法执行已冻结的补充检查');
        const result = await entry.task.review.evaluate({ ...context, check: structuredClone(check) });
        if (typeof result?.passed !== 'boolean' || typeof result.summary !== 'string' || !result.summary.trim()) throw new Error('补充检查结果格式无效');
        supplementary.push({ id: check.id, passed: result.passed, summary: result.summary });
      }
      signal.throwIfAborted();
      await this.adapter.authorize(parent);
      // Evaluators run in a throwaway copy, but may not rewrite their own checks.
      await verifyEvaluation(dir, evaluationFiles);
      const after = await inventory(dir);
      if (changedFiles(candidateFiles, after).length) throw new Error('评价修改了候选源文件或已有测试，未接受结果');
      if (supplementary.length) {
        parsed.supplementaryChecks = supplementary;
        parsed.valid = parsed.valid && supplementary.every(x => x.passed);
        parsed.summary += '\n补充检查：' + supplementary.map(x => `${x.id}: ${x.passed ? '通过' : '失败'} ${x.summary}`).join('; ');
      }
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
      run.criteriaVersion++;
      run.criteria = null; run.baseline = null; run.best = null;
      run.checks = []; run.pendingReview = null; run.reviewedBest = null; run.baselineReviewed = null;
      for (const epoch of run.epochs) if (epoch.status === 'running') epoch.status = 'superseded';
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
    run.reviewSupported = !!task.review;
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
    if (run.pendingReview) await finishReview(this, run, parent, signal, task);
    if (task.review && run.baselineReviewed !== run.revision) await reviewCandidate(this, run, parent, signal, task, 'baseline');
    while (!run.reviewOnly && run.attempts < run.limit) {
      signal.throwIfAborted();
      let epoch = run.epochs.find(e => e.status === 'running' && e.revision === run.revision);
      if (!epoch) {
        run.stage = 'plan'; run.message = '正在汇总各方向证据，规划下一轮实验'; await this.save(run);
        const advisoryDir = path.join(run.root, 'advice-' + randomUUID());
        const before = await snapshot(run.best.dir, advisoryDir);
        const plan = validatePlan(await this.invoke(run, parent, 'advisor', advisoryDir, advisorPrompt(run, task), advisorSchema, signal), run);
        if (changedFiles(before, await inventory(advisoryDir)).length) throw new Error('规划阶段修改了候选，未接受计划');
        if (plan.stop) { run.stopReason = plan.reason; break; }
        epoch = { number: run.epochs.length + 1, revision: run.revision, criteriaVersion: run.criteriaVersion, status: 'running', assignments: plan.assignments.map(a => ({ ...a, trialLimit: run.settings.localTrials })) };
        for (const a of epoch.assignments) {
          let direction = run.directions.find(d => d.id === a.direction && d.revision === run.revision);
          if (!direction) {
            direction = { id: a.direction, revision: run.revision, seed: structuredClone(run.best), best: null };
            run.directions.push(direction);
          }
          direction.hypothesis = a.hypothesis;
        }
        run.epochs.push(epoch); await this.save(run);
      }
      const assignment = epoch.assignments.find(a => run.trials.filter(t => t.epoch === epoch.number && t.direction === a.direction).length < a.trialLimit);
      if (!assignment) { epoch.status = 'completed'; await this.save(run); continue; }
      const direction = run.directions.find(d => d.id === assignment.direction && d.revision === run.revision);
      await this.trial(run, parent, signal, task, epoch, assignment, direction);
      if (epoch.assignments.every(a => run.trials.filter(t => t.epoch === epoch.number && t.direction === a.direction).length >= a.trialLimit)) epoch.status = 'completed';
      await this.save(run);
      if (run.best.trial && task.complete?.(structuredClone(run.best.evaluation ?? run.best), structuredClone(run.criteria)) === true) {
        await reviewCandidate(this, run, parent, signal, task, 'candidate');
        if (run.best.trial && reviewed(run, task) && task.complete(structuredClone(run.best.evaluation ?? run.best), structuredClone(run.criteria))) break;
      }
    }
    // A failed new check can replace the winner. Review that replacement before
    // offering adoption; a bounded pass never silently accepts an unknown review.
    for (let i = 0; i < 3 && run.best.trial && !reviewed(run, task); i++) await reviewCandidate(this, run, parent, signal, task, 'candidate');
    if (run.best.trial && !reviewed(run, task)) throw new Error('审查连续发现候选问题；已保留证据，请继续探索或补充要求');
    signal.throwIfAborted();
    run.status = 'completed'; run.stage = 'result';
    run.reviewOnly = false;
    run.reviewSupported = !!task.review;
    run.message = run.stopReason || (run.best.trial ? '本轮探索结束，已保留通过检查的最佳候选。' : '本轮没有找到通过检查且更好的候选，保留原项目。');
  }
  async trial(run, parent, signal, task, epoch, assignment, direction) {
    const seed = direction.best ?? direction.seed;
    const number = ++run.attempts, dir = path.join(run.root, 'candidate-' + number);
    // Reserve identity and allowance before any side effect, including copying.
    const trial = { number, revision: run.revision, criteriaVersion: run.criteriaVersion, epoch: epoch.number, direction: direction.id, parentTrial: seed.trial, hypothesis: assignment.hypothesis, status: 'running', dir };
    run.trials.push(trial); run.stage = 'experiment'; run.message = `第 ${epoch.number} 轮 · ${direction.id} · 第 ${number} 次尝试`; await this.save(run);
    try {
      const before = await snapshot(seed.dir, dir);
      const report = await this.invoke(run, parent, 'worker', dir, workerPrompt(run, assignment, task, direction), workerSchema, signal);
      run.stage = 'evaluate'; run.message = '正在用固定依据检查候选 ' + number; await this.save(run);
      const result = await this.evaluate(run, dir, parent, signal);
      const files = await inventory(dir), changed = changedFiles(before, files);
      Object.assign(trial, { evaluation: result, valid: result.valid, ...(result.display !== undefined ? { display: result.display } : {}), ...(result.score !== undefined ? { score: result.score } : {}), evidence: result.evidence, summary: result.summary, changes: changed, report: report.summary, files });
      if (!result.valid) trial.status = 'invalid';
      else if (!changed.length) trial.status = 'no-improvement';
      else {
        const candidate = { ...result, evaluation: result, dir, trial: number, criteriaVersion: run.criteriaVersion };
        if (!direction.best || compare(task, result, direction.best.evaluation, run.criteria) === 'better') { direction.best = candidate; trial.status = 'local-kept'; }
        else trial.status = 'no-improvement';
        if (compare(task, result, run.best.evaluation ?? run.best, run.criteria) === 'better') {
          trial.status = 'kept';
          candidate.diff = await candidateDiff(run.baselineDir, dir);
          await writeFile(path.join(run.root, 'best.patch'), candidate.diff);
          run.best = candidate; run.reviewedBest = null;
        }
      }
    } catch (e) {
      trial.status = 'inconclusive'; trial.summary = String(e.message ?? e);
      if (signal.aborted) throw e;
    }
  }
  async dispose() {
    this.closing = true;
    this.lifecycle.abort(new Error('插件关闭'));
    for (const live of this.active.values()) live.controller.abort(new Error('插件关闭'));
    await Promise.allSettled([...this.actions.values()]);
    await Promise.allSettled([...this.active.values()].map(x => x.promise));
  }
}
