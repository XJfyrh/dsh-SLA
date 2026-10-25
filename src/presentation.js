// Old runs contain prose paragraphs; only add layout, never infer new results.
export function criteriaMarkdown(text = '') {
  text = String(text).replace(/^criterion\s*[:：]\s*/i, '');
  if (text.includes('\n')) return text;
  return text.split(/(`+[^`]*`+)/g).map((part, i) => i % 2 ? part : part
    .replace(/([。；;])\s*(?=\(\d+\)|（\d+）)/g, '$1\n\n')
    .replace(/([。；;])\s*(正确性|性能|复现条件|回归范围)[:：]/g, '$1\n\n### $2\n\n')
    .replace(/(^|[:：])\s*[（(](\d+)[）)]\s*/g, '$1\n\n$2. ')
    .replace(/\n\n[（(](\d+)[）)]\s*/g, '\n\n$1. ')).join('');
}

export function evaluationView(result) {
  const checks = Array.isArray(result?.supplementaryChecks) ? result.supplementaryChecks : [];
  const failed = checks.filter(c => c.passed === false).length;
  const passed = checks.filter(c => c.passed === true).length;
  return { status: result?.valid === false || failed ? 'failed' : result?.valid === true && passed === checks.length ? 'passed' : 'unknown',
    passed, failed, total: checks.length, checks };
}

export function currentEvaluation(run, trial) {
  const assessment = (run.assessments ?? []).filter(a => a.trial === trial.number && a.revision === run.revision && a.criteriaVersion === run.criteriaVersion).at(-1);
  return { assessment, evaluation: assessment?.evaluation ?? trial.evaluation ?? trial,
    historical: trial.revision !== run.revision || (!assessment && (trial.criteriaVersion ?? trial.revision) !== (run.criteriaVersion ?? run.revision)) };
}

export function matchesPreview(preview, run) {
  return preview?.runId === run.id && preview.trial === run.best?.trial && preview.criteriaVersion === (run.criteriaVersion ?? run.revision)
    && (!run.best?.artifactId || preview.artifactId === run.best.artifactId);
}

// Only explicitly authored sections are promoted. Historical prose is never guessed or rewritten.
export function candidateBrief(report = '') {
  const sections = {};
  let key, fence;
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
    if (heading) { key = ({ '改动说明': 'change', '尚未验证': 'unverified' })[heading[1]]; continue; }
    if (key) sections[key] = (sections[key] ?? '') + line + '\n';
  }
  return Object.fromEntries(Object.entries(sections).map(([key, text]) => [key, text.trim()]).filter(([, text]) => text && text.length <= 500));
}

export function checkPresentation(run, check, index) {
  const definition = run.checks?.find(c => c.id === check.id);
  const review = run.reviews?.find(r => r.id === check.id);
  return { title: definition?.title || null, purpose: definition?.purpose || null, index: index + 1,
    origin: review ? { trial: review.targetTrial, version: review.criteriaVersion, publishedVersion: review.publishedVersion, status: review.status } : null,
    original: definition?.summary, named: !!definition?.title };
}

export function decisionView(run) {
  const trial = run.trials?.find(t => t.number === run.best?.trial);
  const current = trial && currentEvaluation(run, trial);
  const hasCandidate = !run.rebuild && run.best?.trial > 0 && current && !current.historical;
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
