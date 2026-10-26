import { ExplorationRuntime } from './runtime.js';
import { CodeWorkflow } from './code-workflow.js';
import { NativeWorkflow } from './native-workflow.js';
import { selectProjectWorkflow } from './project-selector.js';

// Application composition. Runtime and kernel do not import domain workflows.
export class ExplorationEngine extends ExplorationRuntime {
  constructor(options) {
    let code;
    super({ ...options, selectWorkflow: options.selectWorkflow ?? selectProjectWorkflow,
      resolveWorkflow: run => {
        if (run.workflow?.kind === 'native') return new NativeWorkflow(this, run.task);
        if (run.workflow?.kind === 'code') return code ??= new CodeWorkflow(this);
        throw new Error('探索尚未绑定工作流');
      },
    });
  }
}
