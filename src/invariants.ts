import type { Candidate, Criteria, Evaluation, FileInventory, Run, Trial } from './data.js';
import { required } from './errors.js';

export type BoundRun = Run & { task: NonNullable<Run['task']> };
export type PreparedRun = BoundRun & { criteria: Criteria; baseline: Evaluation; best: Candidate; baselineArtifactId: string };
export type CodeRun = Run & { baselineDir: string; sourceFiles: FileInventory; evaluationDir: string; evaluationFiles: FileInventory };
export type FileCandidate = Candidate & { dir: string };
export type FileTrial = Trial & { dir: string; startFiles: FileInventory };
export function assertBound(run: Run): asserts run is BoundRun { required(run.task, '工作流绑定'); }
export function assertPrepared(run: Run): asserts run is PreparedRun {
  assertBound(run);
  required(run.criteria, '评价依据'); required(run.baseline, '基线'); required(run.best, '候选'); required(run.baselineArtifactId, '基线制品');
}
export function assertCode(run: Run): asserts run is CodeRun {
  required(run.baselineDir, '原始目录'); required(run.sourceFiles, '原始文件清单');
  required(run.evaluationDir, '评价目录'); required(run.evaluationFiles, '评价文件清单');
}
export function assertFileCandidate(candidate: Candidate): asserts candidate is FileCandidate { required(candidate.dir, '文件候选目录'); }
export function assertFileTrial(trial: Trial): asserts trial is FileTrial { required(trial.dir, '尝试目录'); required(trial.startFiles, '尝试起点'); }
