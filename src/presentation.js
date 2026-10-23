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
  return preview?.runId === run.id && preview.trial === run.best?.trial && preview.criteriaVersion === (run.criteriaVersion ?? run.revision);
}
