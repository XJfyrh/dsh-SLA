import { supplementaryChecks } from './data.js';
import type { Evaluation, Run, Trial } from './data.js';
import type { ChangePreview } from './wire.js';
export function evaluationView(result: Evaluation | null | undefined) {
  const checks = supplementaryChecks(result);
  const failed = checks.filter(c => c.passed === false).length;
  const passed = checks.filter(c => c.passed === true).length;
  return { status: result?.valid === false || failed ? 'failed' : result?.valid === true && passed === checks.length ? 'passed' : 'unknown',
    passed, failed, total: checks.length, checks };
}

export function currentEvaluation(run: Run, trial: Trial) {
  const assessment = (run.assessments ?? []).filter(a => a.trial === trial.number && a.revision === run.revision && a.criteriaVersion === run.criteriaVersion).at(-1);
  return { assessment, evaluation: assessment?.evaluation ?? trial.evaluation,
    historical: trial.revision !== run.revision || (!assessment && trial.criteriaVersion !== run.criteriaVersion) };
}

export function matchesPreview(preview: ChangePreview | null | undefined, run: Run): preview is ChangePreview {
  return !!run.best?.artifactId && preview?.runId === run.id && preview.trial === run.best.trial && preview.criteriaVersion === run.criteriaVersion
    && preview.artifactId === run.best.artifactId;
}

// Only explicitly authored sections are promoted. Historical prose is never guessed or rewritten.
export function candidateBrief(report = ''): { change?: string; unverified?: string } {
  const sections: Record<string, string> = {};
  let key: string | undefined, fence: string | null | undefined;
  for (const line of String(report).split(/\r?\n/)) {
    const marker = line.match(/^\s*(`{3,}|~{3,})/);
    if (marker) {
      if (!fence) fence = marker[1];
      else if (marker[1][0] === fence[0] && marker[1].length >= fence.length) fence = null;
      if (key) sections[key] = (sections[key] ?? '') + line + '\n';
      continue;
    }
    if (fence) { if (key) sections[key] = (sections[key] ?? '') + line + '\n'; continue; }
    const heading = line.match(/^#{1,6}\s+(.+?)\s*$/);
    if (heading) { key = heading[1] === '改动说明' ? 'change' : heading[1] === '尚未验证' ? 'unverified' : undefined; continue; }
    if (key) sections[key] = (sections[key] ?? '') + line + '\n';
  }
  return Object.fromEntries(Object.entries(sections).map(([key, text]) => [key, text.trim()]).filter(([, text]) => text && text.length <= 500));
}

export function checkPresentation(run: Run, check: { id?: string }, index: number) {
  const definition = run.checks?.find(c => c.id === check.id);
  const review = run.reviews?.find(r => r.id === check.id);
  return { title: definition?.title || null, purpose: definition?.purpose || null, index: index + 1,
    origin: review ? { trial: review.targetTrial, version: review.criteriaVersion, publishedVersion: review.publishedVersion, status: review.status } : null,
    original: definition?.summary, named: !!definition?.title };
}

export function decisionView(run: Run) {
  const trial = run.trials?.find(t => t.number === run.best?.trial);
  const current = trial && currentEvaluation(run, trial);
  const hasCandidate = !run.rebuild && (run.best?.trial ?? 0) > 0 && current && !current.historical;
  const evaluation = hasCandidate ? (run.adopted && run.adoptionCheck ? run.adoptionCheck : current.evaluation) : null;
  const checks = evaluationView(evaluation);
  const approved = !run.reviewSupported || (run.reviewedBest?.trial === run.best?.trial
    && run.reviewedBest?.revision === run.revision && run.reviewedBest?.criteriaVersion === run.criteriaVersion && !run.pendingReview);
  const moving = ['running', 'preparing', 'pausing', 'stopping'].includes(run.status);
  return { trial: hasCandidate ? trial : null, evaluation, checks, approved,
    ready: !!hasCandidate && run.best?.eligibility?.deliver !== false && checks.status === 'passed' && approved && !run.pendingReview && !moving && !run.adoptionPending && !run.adopted,
    brief: hasCandidate ? candidateBrief(trial.report) : {},
    excluded: (run.trials ?? []).filter(t => t.number !== trial?.number && t.revision === run.revision && (() => {
      const result = currentEvaluation(run, t);
      return !result.historical && evaluationView(result.evaluation).status === 'failed';
    })()).map(t => t.number),
  };
}
