import { validatePlan } from './research-state.js';
import { compare, qualify } from './task-registry.js';
import { acceptSelection } from './kernel.js';

export function initialFrontier(task, baseline, criteria) {
  baseline.eligibility = qualify(task, baseline.evaluation, criteria);
  return baseline.eligibility.deliver ? [structuredClone(baseline)] : [];
}

// Reuse the selection rules when publishing a new evaluator. The baseline is
// part of the same frontier, so a worse candidate cannot survive by omission.
export function rerank(task, criteria, baseline, entries) {
  let best = baseline, frontier = initialFrontier(task, baseline, criteria);
  const local = new Map();
  for (const { candidate, lane } of entries) {
    const eligibility = qualify(task, candidate.evaluation, criteria); candidate.eligibility = eligibility;
    if (eligibility.deliver && compare(task, candidate.evaluation, best.evaluation, criteria) === 'better') best = candidate;
    if (eligibility.retain && (!local.has(lane) || compare(task, candidate.evaluation, local.get(lane).evaluation, criteria) === 'better')) local.set(lane, candidate);
    if (eligibility.deliver) {
      const relations = frontier.map(c => compare(task, candidate.evaluation, c.evaluation, criteria));
      if (!relations.some(r => r === 'worse' || r === 'equal')) frontier = [...frontier.filter((_, i) => relations[i] !== 'better'), candidate];
    }
  }
  return { best, local, frontier };
}

// Owns search scheduling; domain operations own preparation, evaluation and delivery.
export async function explore(run, signal, task, checkpoint, operations) {
    while (!run.reviewOnly && run.attempts < run.limit) {
      signal.throwIfAborted();
      if (run.best.trial && task.complete?.(structuredClone(run.best.evaluation ?? run.best), structuredClone(run.criteria)) === true) {
        await operations.review();
        if (operations.reviewed() && task.complete(structuredClone(run.best.evaluation ?? run.best), structuredClone(run.criteria))) break;
      }
      let epoch = run.epochs.find(e => e.status === 'running' && e.revision === run.revision);
      if (!epoch) {
        const plan = validatePlan(await operations.plan(), run);
        if (plan.stop) { run.stopReason = plan.reason; break; }
        epoch = { number: run.epochs.length + 1, revision: run.revision, criteriaVersion: run.criteriaVersion, status: 'running', assignments: plan.assignments.map(a => ({ ...a, trialLimit: run.settings.localTrials })) };
        for (const a of epoch.assignments) {
          const lane = a.lane ?? a.direction;
          let direction = run.directions.find(d => d.id === lane && d.revision === run.revision);
          if (!direction) {
            direction = { id: lane, regime: a.direction, revision: run.revision, seed: structuredClone(run.best), best: null };
            run.directions.push(direction);
          }
          direction.hypothesis = a.hypothesis;
        }
        run.epochs.push(epoch); await checkpoint();
      }
      const assignment = epoch.assignments.find(a => run.trials.filter(t => t.epoch === epoch.number && t.direction === (a.lane ?? a.direction)).length < a.trialLimit);
      if (!assignment) { epoch.status = 'completed'; await checkpoint(); continue; }
      const direction = run.directions.find(d => d.id === (assignment.lane ?? assignment.direction) && d.revision === run.revision);
      await operations.trial(epoch, assignment, direction);
      if (epoch.assignments.every(a => run.trials.filter(t => t.epoch === epoch.number && t.direction === (a.lane ?? a.direction)).length >= a.trialLimit)) epoch.status = 'completed';
      await checkpoint();
      if (run.best.trial && task.complete?.(structuredClone(run.best.evaluation ?? run.best), structuredClone(run.criteria)) === true) {
        await operations.review();
        if (run.best.trial && operations.reviewed() && task.complete(structuredClone(run.best.evaluation ?? run.best), structuredClone(run.criteria))) break;
      }
    }
}

export function retain(run, task, trial, lane, candidate, changed = true) {
  const eligibility = qualify(task, candidate.evaluation, run.criteria);
  const comparisons = new Map();
  const against = reference => {
    const key = reference.observationId ?? reference;
    if (!comparisons.has(key)) comparisons.set(key, compare(task, candidate.evaluation, reference.evaluation ?? reference, run.criteria));
    return comparisons.get(key);
  };
  const local = eligibility.retain && changed && (!lane.best || against(lane.best) === 'better');
  const global = eligibility.deliver && changed && against(run.best) === 'better';
  const choice = acceptSelection(run, trial, candidate, { eligibility, local, global });
  candidate.eligibility = eligibility;
  trial.eligibility = eligibility;
  trial.assessmentStatus = 'completed';
  trial.status = !eligibility.retain ? 'invalid' : global ? 'kept' : local ? 'local-kept' : 'no-improvement';
  if (local) lane.best = candidate;
  if (global) { run.best = candidate; run.reviewedBest = null; }
  // A single display winner is retained for existing clients. Incomparable
  // admissible results remain available as a frontier, never silently dropped.
  if (eligibility.deliver && changed) {
    const frontier = run.frontier.filter(c => c.criteriaVersion === run.criteriaVersion);
    if (!frontier.some(c => ['worse', 'equal'].includes(against(c)))) {
      run.frontier = [...frontier.filter(c => against(c) !== 'better'), candidate];
    }
  }
  return choice;
}
