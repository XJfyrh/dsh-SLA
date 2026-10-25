import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { inventory, snapshot, changedFiles } from './workspace.js';
import { selection } from './prompts.js';

// DSH project entry point, separate from search and from the selected workflow.
export async function selectProjectWorkflow(engine, run, parent, signal) {
  if (run.task) return;
  const available = engine.tasks.list();
  if (!available.length) throw new Error('没有已安装的 SLA 任务扩展，请在 DSH 中启用任务插件。');
  run.stage = 'select'; run.message = '正在调查目标并选择合适的工作流'; await engine.save(run);
  const selector = selection(available);
  const dir = path.join(run.root, 'selection-' + randomUUID());
  const files = await snapshot(run.cwd, dir);
  const choice = await engine.invoke(run, parent, 'selector', dir, selector.prompt(run), selector.schema, signal);
  if (changedFiles(files, await inventory(dir)).length) throw new Error('任务选择阶段修改了项目，未接受选择结果。');
  const selected = available.find(task => task.id === choice.taskId);
  if (!selected) throw new Error('没有适用的已安装任务扩展：' + choice.reason);
  engine.tasks.get(selected);
  run.task = { id: selected.id, version: selected.version, name: selected.name };
  run.selectionReason = choice.reason;
  await engine.save(run);
}
