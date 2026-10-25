import { ExplorationRuntime } from './runtime.js';
import { CodeWorkflow } from './code-workflow.js';
import { NativeWorkflow } from './native-workflow.js';
import { selectProjectWorkflow } from './project-selector.js';

// Application composition. Runtime and kernel do not import domain workflows.
export class ExplorationEngine extends ExplorationRuntime {
  constructor(options) {
    let code;
    super({ ...options, selectWorkflow: options.selectWorkflow ?? selectProjectWorkflow,
      migrateRecord: record => {
        if (record.id && !record.formatVersion && !record.task) {
          record.task = { id: 'code-performance', version: '1.0.0', name: '代码性能' };
          record.selectionReason = '从 0.1 的性能评价记录迁移，保留原有规则。';
        }
      },
      resolveWorkflow: run => {
        if (run.workflow?.kind === 'native' || (run.task && this.tasks.entries.get(run.task.id)?.native)) return new NativeWorkflow(this, run.task);
        return code ??= new CodeWorkflow(this);
      },
    });
  }
}
