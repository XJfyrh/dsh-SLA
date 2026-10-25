// Registration belongs to the DSH plugin that calls it. Its disposer withdraws
// the capability and cancels calls still using that exact registration.
export class TaskRegistry {
  entries = new Map();
  register(task) { return this.registerDefinition(task, false); }
  registerWorkflow(workflow) { return this.registerDefinition(workflow, true); }
  registerDefinition(task, native) {
    if (!/^[a-z][a-z0-9-]{0,63}$/.test(task.id ?? '') || !/^\d+\.\d+\.\d+$/.test(task.version ?? '')) throw new Error('任务扩展需要稳定 id 和语义版本');
    for (const key of ['name', 'description']) if (typeof task[key] !== 'string' || !task[key].trim()) throw new Error('任务扩展缺少 ' + key);
    for (const key of ['evaluate', 'validateBaseline', 'compare']) if (typeof task[key] !== 'function') throw new Error('任务扩展缺少 ' + key);
    if (native) {
      if (typeof task.run !== 'function' || typeof task.artifacts?.verify !== 'function') throw new Error('工作流缺少 run 或制品校验能力');
      for (const key of ['deliver', 'recoverDelivery']) if (task[key] !== undefined && typeof task[key] !== 'function') throw new Error(key + ' 必须是函数');
    } else if (!task.prepare?.schema || typeof task.prepare.prompt !== 'function') throw new Error('任务扩展缺少 prepare');
    if (task.complete !== undefined && typeof task.complete !== 'function') throw new Error('complete 必须是函数');
    for (const key of ['qualify', 'projectEvidence']) if (task[key] !== undefined && typeof task[key] !== 'function') throw new Error(key + ' 必须是函数');
    if (task.review !== undefined && (!task.review.schema || typeof task.review.prompt !== 'function' || typeof task.review.evaluate !== 'function')) throw new Error('review 需要 schema、prompt 和 evaluate');
    if (this.entries.has(task.id)) throw new Error('任务扩展重复注册：' + task.id);
    const controller = new AbortController();
    const definition = Object.freeze({ ...task,
      ...(task.prepare ? { prepare: Object.freeze({ ...task.prepare, schema: structuredClone(task.prepare.schema) }) } : {}),
      ...(task.artifacts ? { artifacts: Object.freeze({ ...task.artifacts }) } : {}),
      ...(task.review ? { review: Object.freeze({ ...task.review, schema: structuredClone(task.review.schema) }) } : {}) });
    const entry = { task: definition, native, signal: controller.signal };
    this.entries.set(task.id, entry);
    return () => {
      if (this.entries.get(task.id) !== entry) return;
      this.entries.delete(task.id);
      controller.abort(new Error(`任务扩展已卸载：${task.id}@${task.version}；请恢复该版本后继续。`));
    };
  }
  list() { return [...this.entries.values()].map(({ task: { id, version, name, description } }) => ({ id, version, name, description })); }
  get(binding) {
    const entry = this.entries.get(binding.id);
    if (!entry || entry.task.version !== binding.version) throw new Error(`需要任务扩展 ${binding.id}@${binding.version}；当前未安装或版本不一致，未替换评价规则。`);
    return entry;
  }
}

export function validateEvaluation(value) {
  if (!value || typeof value.valid !== 'boolean' || typeof value.summary !== 'string' || !value.summary.trim() || (value.display !== undefined && typeof value.display !== 'string')) throw new Error('评价结果格式无效');
  const json = JSON.stringify(value, (_key, item) => {
    if (typeof item === 'number' && !Number.isFinite(item)) throw new Error('评价结果包含无效数字');
    if (['function', 'symbol', 'bigint'].includes(typeof item)) throw new Error('评价结果必须可保存为 JSON');
    return item;
  });
  if (json.length > 128 * 1024) throw new Error('评价结果过大');
  return JSON.parse(json);
}

export function compare(task, candidate, reference, criteria) {
  const result = task.compare(structuredClone(candidate), structuredClone(reference), structuredClone(criteria));
  if (!['better', 'equal', 'worse', 'incomparable'].includes(result)) throw new Error('扩展比较结果必须为 better/equal/worse/incomparable');
  return result;
}

export function qualify(task, result, criteria) {
  const value = task.qualify?.(structuredClone(result), structuredClone(criteria)) ?? { retain: result.valid, deliver: result.valid };
  if (!value || typeof value.retain !== 'boolean' || typeof value.deliver !== 'boolean' || (value.deliver && !result.valid)) throw new Error('候选资格格式无效，未通过检查不能交付');
  return { retain: value.retain, deliver: value.deliver };
}
