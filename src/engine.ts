import type { EngineOptions } from './runtime-contracts.js';
import { required } from './errors.js';
import { ExplorationRuntime } from './runtime.js';
import { CodeWorkflow } from './code-workflow.js';
import { NativeWorkflow } from './native-workflow.js';
import { selectProjectWorkflow } from './project-selector.js';

// Application composition. Runtime and kernel do not import domain workflows.
export class ExplorationEngine extends ExplorationRuntime {
  constructor(options: EngineOptions) {
    let code: CodeWorkflow | undefined;
    super({ ...options, selectWorkflow: options.selectWorkflow ?? selectProjectWorkflow,
      resolveWorkflow: run => {
        if (run.workflow?.kind === 'native') return new NativeWorkflow(this, required(run.task, '工作流'));
        if (run.workflow?.kind === 'code') return code ??= new CodeWorkflow(this);
        throw new Error('探索尚未绑定工作流');
      },
    });
  }
}
