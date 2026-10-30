import type {} from '@deepseek-ai/dsh-client-ui-session/client';
import type {} from '@deepseek-ai/dsh-client-ui-renderer/client';
import * as React from 'react';
import { MarkdownText, DiffBlock } from '@deepseek-ai/dsh-client-ui-primitives';
import type { Context } from '@deepseek-ai/cordis';
import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { PropsRuntime, PropsLocale, Translate } from '@deepseek-ai/dsh-client-ui-slots';
import type {} from '@deepseek-ai/dsh-api-remotes/client';
import type {} from '@deepseek-ai/dsh-client-locale/client';
import type {} from '@deepseek-ai/dsh-client-ui-conversation/client';
import type {} from '@deepseek-ai/dsh-client-ui-chat/client';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import { remote } from './remote.js';
import { decode, previewSchema } from './wire.js';
import type { ChangePreview } from './wire.js';
import { runSchema, settingsSchema, settingKeys } from './data.js';
import type { Run, Evaluation as EvaluationResult, Settings as RunSettings } from './data.js';
import { createRunStore, collapseAdoptedPanel, latestRunTurn, ownsRun } from './client-state.js';
import type { RunEntry, RunAction } from './client-state.js';
import { currentEvaluation, evaluationView, matchesPreview, checkPresentation, decisionView } from './presentation.js';
import { isRecord, message } from './errors.js';
export type { SlaRemote } from './wire.js';
declare module '@deepseek-ai/dsh-client-ui-slots' { interface LocaleNamespaceMap { sla: string } }
type HeaderProps = PropsRuntime<'conversation.session.header.actions'> & PropsLocale<'sla'>;
type ResultProps = PropsRuntime<'conversation.chat.turnTail'> & PropsLocale<'sla'>;
type PanelProps = PropsRuntime<'sidebar.right.pane.tab'> & PropsLocale<'sla'>;
function factory() {
  const h = React.createElement;
  const dictionaries: { zh: Record<string, string>; en: Record<string, string> } = {
    zh: { review: '检查候选', directions: '探索方向', epochs: '轮次', localBest: '方向内最佳', noLocal: '尚无有效局部候选', reviews: '独立审查', parent: '起点', reassessment: '复验', 'local-kept': '方向内保留', 'no-checks': '未提出新检查', accepted: '检查已纳入', 'confirmed-regression': '发现回归', checking: '正在复验', title: '持续探索', short: '探索', intro: '在主对话中告诉我，你希望项目的什么变好。', pause: '暂停', stop: '结束探索', resume: '继续探索', adopt: '采用这个结果', adopted: '已采用', details: '查看探索', steerHint: '补充要求：在主对话发送。', baseline: '初始结果', trials: '次尝试', experiments: '实验记录', evidence: '本地证据', unchanged: '本次探索尚未写回', changes: '查看改动', empty: '还没有完成的实验', preparing: '准备项目', running: '探索中', paused: '已暂停', pausing: '正在暂停', stopping: '正在结束', completed: '本轮结束', blocked: '需要处理', kept: '保留', invalid: '检查未通过', inconclusive: '未完成评价', 'no-improvement': '没有改善', error: '操作失败', revision: '版本', method: '判断依据', pending: '正在建立判断依据…', loading: '正在读取探索状态…', result: '探索结果', notes: '补充要求', adoptedSummary: '已写回项目。', noResult: '尚无通过检查的改进结果。' },
    en: { review: 'Review candidate', directions: 'Directions', epochs: 'Epoch', localBest: 'Local best', noLocal: 'No valid local candidate', reviews: 'Independent reviews', parent: 'Parent', reassessment: 'Reassessment', 'local-kept': 'Locally retained', 'no-checks': 'No new check proposed', accepted: 'Check accepted', 'confirmed-regression': 'Regression found', checking: 'Rechecking', title: 'Continuous exploration', short: 'Explore', intro: 'Describe what should improve in the main conversation.', pause: 'Pause', stop: 'Finish', resume: 'Continue', adopt: 'Adopt result', adopted: 'Adopted', details: 'View exploration', steerHint: 'Add requirements in the main conversation.', baseline: 'Baseline', trials: 'trials', experiments: 'Experiments', evidence: 'Local evidence', unchanged: 'Source project unchanged', changes: 'View changes', empty: 'No completed experiments yet', preparing: 'Preparing', running: 'Exploring', paused: 'Paused', pausing: 'Pausing', stopping: 'Stopping', completed: 'Finished', blocked: 'Needs attention', kept: 'Kept', invalid: 'Checks failed', inconclusive: 'Inconclusive', 'no-improvement': 'No improvement', error: 'Action failed', revision: 'Revision', method: 'Evaluation criteria', pending: 'Establishing evaluation criteria…', loading: 'Loading exploration…', result: 'Exploration result', notes: 'Additional requirements', adoptedSummary: 'Applied to the project.', noResult: 'No verified improvement yet.' },
  };
  Object.assign(dictionaries.zh, { copy: '复制', copied: '已复制', code: '代码', wrap: '自动换行', unwrap: '不换行', footnotes: '注释',
    raw: '查看原始记录', rawPatch: '查看原始补丁', idea: '尝试思路', fullCriteria: '检查内容与方法', measurement: '衡量方式', checkGroup: '补充检查',
    passed: '通过', failed: '未通过', unknown: '未完成', verified: '当前版本的检查已通过', failedCheck: '当前版本的检查未通过', unknownCheck: '尚无完整检查结果',
    groups: '组', checkResults: '补充检查结果', loadingChanges: '正在读取文件改动…', previewChanged: '候选已更新，请重试以读取当前改动。', retry: '重试', noChanges: '没有文件改动',
    files: '个文件', added: '新增', deleted: '删除', modified: '修改', binary: '二进制或非 UTF-8 文件，请在证据目录查看。', large: '文件较大，请在证据目录查看完整内容。',
    changesHint: '初始项目 → 当前候选', methodChoice: '为什么选择这个方法', historical: '历史评价，未按当前依据复验', previous: '查看历史评价', expandDiff: '展开其余行', collapseDiff: '收起代码', resultValue: '实测结果' });
  Object.assign(dictionaries.en, { copy: 'Copy', copied: 'Copied', code: 'Code', wrap: 'Wrap lines', unwrap: 'Unwrap lines', footnotes: 'Footnotes',
    raw: 'Original record', rawPatch: 'Original patch', idea: 'Approach', fullCriteria: 'Checks and method', measurement: 'Measurement', checkGroup: 'Additional check',
    passed: 'Passed', failed: 'Failed', unknown: 'Incomplete', verified: 'Current checks passed', failedCheck: 'Current checks failed', unknownCheck: 'No complete result yet',
    groups: 'groups', checkResults: 'Additional check results', loadingChanges: 'Loading file changes…', previewChanged: 'The candidate changed. Retry to load its current changes.', retry: 'Retry', noChanges: 'No file changes',
    files: 'files', added: 'Added', deleted: 'Deleted', modified: 'Modified', binary: 'Binary or non-UTF-8 file. See the evidence directory.', large: 'Large file. See the evidence directory for its full content.',
    changesHint: 'Initial project → current candidate', methodChoice: 'Why this method', historical: 'Historical result; not checked against current criteria', previous: 'Historical evaluation', expandDiff: 'Expand remaining lines', collapseDiff: 'Collapse code', resultValue: 'Measured result' });
  Object.assign(dictionaries.zh, { live: '探索最新状态', updated: '更新于', syncFailed: '状态同步失败，以下保留上次记录。', goal: '本次目标', changed: '改了什么', authorReport: '执行者的改动说明', workerRecord: '查看执行记录', candidate: '候选', initialProject: '初始项目', criterionVersion: '评价版本', excluded: '当前检查未通过，已排除', reviewRequired: '需完成候选审查后才能采用。', unverified: '尚未验证 · 执行者说明', ready: '采用会复验并写回项目；若项目已变化会停止。', pendingReview: '新增检查尚在复验，候选排序尚未更新。', currentCheck: '本次复验结果', checkOrigin: '检查来源 · 历史审查记录', originHint: '以下是提出检查时的发现，不代表当前候选的结果。', unknownOrigin: '未保存审查来源', introduced: '纳入评价版本', next: '接下来', adoptedValue: '采用时复验', selectedValue: '候选实测', selectedTrial: '当前保留', changeFiles: '改动文件', checkCurrentHint: '当前结果以本次复验为准。' });
  Object.assign(dictionaries.en, { live: 'Latest exploration state', updated: 'Updated', syncFailed: 'Sync failed. Showing the last known state.', goal: 'Goal', changed: 'What changed', authorReport: 'Worker change description', workerRecord: 'Worker report', candidate: 'Candidate', initialProject: 'Initial project', criterionVersion: 'Criteria version', excluded: 'Excluded by current checks', reviewRequired: 'Candidate review is required before adoption.', unverified: 'Unverified · worker statement', ready: 'Adoption rechecks and applies changes. It stops if the project has changed.', pendingReview: 'Additional checks are being evaluated; ranking has not yet been updated.', currentCheck: 'This recheck result', checkOrigin: 'Check origin · historical review', originHint: 'These findings describe when the check was proposed, not the current candidate.', unknownOrigin: 'Review origin was not recorded', introduced: 'Added in criteria version', next: 'Next', adoptedValue: 'Adoption recheck', selectedValue: 'Candidate measurement', selectedTrial: 'Currently retained', changeFiles: 'Changed files', checkCurrentHint: 'Use this recheck for the current outcome.' });
  const css = `
.sla-panel,.sla-result{font:inherit;color:var(--dsw-alias-label-primary);font-size:13px;line-height:1.65;box-sizing:border-box}
.sla-panel *,.sla-result *{box-sizing:border-box}.sla-panel{height:100%;overflow:auto;padding:22px 22px 32px}.sla-panel h2{font-size:19px;line-height:1.5;margin:0 0 10px;font-weight:600}.sla-panel h3{font-size:13px;margin:0;font-weight:600}.sla-panel p{margin:8px 0;overflow-wrap:anywhere}.sla-eyebrow{font-size:12px;color:var(--dsw-alias-label-secondary);margin-bottom:12px}.sla-top,.sla-actions{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.sla-top{justify-content:space-between}.sla-tag{font-size:12px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);padding:2px 8px;border-radius:20px;white-space:nowrap}.sla-muted{color:var(--dsw-alias-label-secondary);font-size:13px}.sla-panel button,.sla-result button,.sla-header{font:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;padding:6px 11px;cursor:pointer}.sla-panel button:hover,.sla-result button:hover,.sla-header:hover{background:var(--dsw-alias-interactive-bg-hover)}.sla-panel button:disabled{opacity:.5;cursor:default}.sla-panel .sla-primary{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}.sla-panel button:focus-visible,.sla-result button:focus-visible,.sla-header:focus-visible,.sla-panel summary:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px}.sla-header{display:inline-flex;align-items:center;gap:6px;padding:3px 8px;font-size:12px;white-space:nowrap;max-width:210px;overflow:hidden;text-overflow:ellipsis;color:var(--dsw-alias-label-secondary)}.sla-section{border-top:1px solid var(--dsw-alias-border-l1);margin-top:22px;padding-top:17px}.sla-panel summary{cursor:pointer;overflow-wrap:anywhere}.sla-panel summary:hover{color:var(--dsw-alias-label-primary)}.sla-trial{padding:12px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.sla-trial:last-child{border-bottom:0}.sla-panel pre{white-space:pre-wrap;overflow-wrap:anywhere;font:12px/1.6 monospace;background:var(--dsw-alias-interactive-bg-hover);padding:12px;border-radius:8px;max-height:360px;overflow:auto}.sla-path{overflow-wrap:anywhere;font-size:13px;user-select:all}.sla-error{border-left:3px solid currentColor;padding-left:10px;margin:12px 0}.sla-result{margin:14px 0 4px;border:1px solid var(--dsw-alias-border-l1);border-radius:12px;padding:13px 15px}.sla-result p{margin:6px 0 0;overflow-wrap:anywhere}.sla-result button{padding:3px 8px;font-size:12px}.sla-result strong{font-weight:600}.sla-hint{padding-top:10px}@media(max-width:520px){.sla-panel{padding:18px 16px}.sla-header{max-width:150px}}
`;
  Object.assign(dictionaries.zh, { settings: '探索设置', runAllowance: '整轮额度', maxTrials: '最多尝试次数', maxMinutes: '最长时间（分钟）',
    callAllowance: '高级设置 · 单次工作与方向', maxStepsPerCall: '单次工作步数', maxMinutesPerCall: '单次时间（分钟）', directionsLimit: '每次规划方向数', localTrials: '每方向尝试次数',
    saveSettings: '保存设置', settingsSaved: '已保存；点击继续探索时使用。', pauseToConfigure: '暂停后调整',
    settingsHint: '调整额度会保留已用次数和时间，不会重新开始探索。', callHint: '每次调用另有 1 步用于提交结果；仍受整轮剩余时间限制。方向设置用于下一次规划。', });
  Object.assign(dictionaries.en, { settings: 'Exploration settings', runAllowance: 'Run allowance', maxTrials: 'Maximum trials', maxMinutes: 'Time limit (minutes)',
    callAllowance: 'Advanced · calls and directions', maxStepsPerCall: 'Work steps per call', maxMinutesPerCall: 'Minutes per call', directionsLimit: 'Directions per epoch', localTrials: 'Trials per direction',
    saveSettings: 'Save settings', settingsSaved: 'Saved. Continue exploration to use them.', pauseToConfigure: 'Pause to edit',
    settingsHint: 'Changing the allowance retains consumed trials and time; it does not restart exploration.', callHint: 'Each call has one extra submission step and stays within the remaining run time. Direction settings apply to the next plan.', });
  const settingsCss = `.sla-settings fieldset{border:0;padding:0;margin:12px 0;min-width:0}.sla-settings legend{font-size:13px;font-weight:600}.sla-settings-grid{display:grid;grid-template-columns:repeat(2,minmax(0,1fr));gap:12px;margin-top:10px}.sla-settings label{font-size:12px;display:flex;flex-direction:column;gap:5px}.sla-settings input{font:inherit;color:inherit;background:transparent;border:1px solid var(--dsw-alias-border-l1);border-radius:7px;padding:7px 9px;width:100%;min-width:0}.sla-settings input:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.sla-settings fieldset:disabled{opacity:.6}.sla-settings summary{font-weight:500}@container(max-width:280px){.sla-settings-grid{grid-template-columns:1fr}}`;
  const evidenceCss = `
.sla-panel{font-size:14px;line-height:1.7;container-type:inline-size}.sla-panel .sla-prose{min-width:0;overflow-wrap:anywhere}.sla-prose>div{font-size:inherit;line-height:inherit}.sla-prose h1,.sla-prose h2,.sla-prose h3{font-size:14px;line-height:1.6;margin:16px 0 7px;font-weight:600}.sla-prose p{margin:8px 0}.sla-prose ul,.sla-prose ol{padding-left:22px}.sla-prose li+li{margin-top:6px}.sla-prose table{display:block;max-width:100%;overflow-x:auto}.sla-prose pre{white-space:pre;overflow-wrap:normal;max-height:none;background:transparent;padding:0;border-radius:0;font:inherit}.sla-prose [data-code-block]{max-width:100%}.sla-section>summary{font-weight:600;padding-bottom:4px}.sla-details{margin:12px 0}.sla-details>summary{font-size:12px;color:var(--dsw-alias-label-secondary)}.sla-check-result{padding:10px 0}.sla-check-result>strong{font-size:14px}.sla-facts{margin:10px 0;display:grid;grid-template-columns:auto 1fr;gap:6px 16px;font-size:13px}.sla-facts dt{color:var(--dsw-alias-label-secondary)}.sla-facts dd{margin:0;text-align:right;font-variant-numeric:tabular-nums;overflow-wrap:anywhere}.sla-check-list{list-style:none;padding:0;margin:12px 0}.sla-check-list>li{border-top:1px solid var(--dsw-alias-border-l1);padding:8px 0}.sla-check-list details>summary{display:flex;gap:8px;justify-content:space-between;align-items:baseline;font-size:13px}.sla-check-list details>summary::before{content:'›';color:var(--dsw-alias-label-secondary)}.sla-check-list details[open]>summary::before{transform:rotate(90deg)}.sla-check-list details>summary>span:first-child{flex:1}.sla-status{font-size:12px;font-weight:500;white-space:nowrap}.sla-status-passed{color:color-mix(in srgb,var(--dsw-alias-state-success-primary) 50%,var(--dsw-alias-label-primary))}.sla-status-failed{color:var(--dsw-alias-state-error-primary)}.sla-status-unknown{color:var(--dsw-alias-label-secondary)}.sla-file{margin:12px 0;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;min-width:0;overflow:hidden}.sla-file>summary{padding:10px 12px;overflow-wrap:anywhere;font-weight:500}.sla-file-body{min-width:0}.sla-file-body pre{white-space:pre;overflow-wrap:normal;max-height:none;background:transparent;padding:0;border-radius:0;font:inherit}.sla-file-body>div{max-width:100%}.sla-file-body>p{padding:0 12px}.sla-file-kind{font-size:11px;color:var(--dsw-alias-label-secondary);margin-left:10px}.sla-method-title{font-weight:500}.sla-subsection{margin-top:16px}.sla-raw{white-space:pre-wrap!important;max-height:360px!important;overflow:auto!important;font:12px/1.6 monospace!important;padding:12px!important;background:var(--dsw-alias-interactive-bg-hover)!important}.sla-measurement{font-size:13px;color:var(--dsw-alias-label-secondary);margin-top:10px}.sla-measurement strong{display:block;color:var(--dsw-alias-label-primary);font-weight:500}.sla-file-count{font-size:12px;font-weight:400;color:var(--dsw-alias-label-secondary)}
.sla-decision{padding:14px 0}.sla-decision h3{margin-top:14px}.sla-decision h3:first-child{margin-top:0}.sla-origin{border-left:2px solid var(--dsw-alias-border-l1);padding:2px 0 2px 12px;margin:12px 0}.sla-next{padding:12px;border-radius:8px;background:var(--dsw-alias-interactive-bg-hover)}.sla-check-list .sla-origin summary{display:list-item}.sla-check-list .sla-origin summary::before{content:none}.sla-result time{font-size:12px;color:var(--dsw-alias-label-secondary)}.sla-result:focus-visible,.sla-result summary:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:3px}
`;
  const moving = (run: Run | null | undefined) => run && ['running', 'preparing', 'pausing', 'stopping'].includes(run.status);
  Object.assign(dictionaries.zh, { settingRange: '整数范围', settingInvalid: '请输入整数', settingsErrors: '请修正标出的设置后再保存。', settingsDirty: '有未保存的修改', resetSettings: '撤销修改', savingSettings: '正在保存设置…', adopting: '正在复验并采用…', reviewing: '正在检查候选…', resuming: '正在继续探索…', actionPending: '正在处理…', attempted: '已尝试' });
  Object.assign(dictionaries.en, { settingRange: 'Whole numbers', settingInvalid: 'Enter a whole number', settingsErrors: 'Correct the highlighted settings before saving.', settingsDirty: 'Unsaved changes', resetSettings: 'Discard changes', savingSettings: 'Saving settings…', adopting: 'Rechecking and adopting…', reviewing: 'Reviewing candidate…', resuming: 'Continuing exploration…', actionPending: 'Working…', attempted: 'Attempted' });
  Object.assign(dictionaries.zh, { resultPath: '结果文件', copyPath: '复制路径', pathCopied: '路径已复制', copyPathFailed: '未能复制，请选中上方路径手动复制。' });
  Object.assign(dictionaries.en, { resultPath: 'Result file', copyPath: 'Copy path', pathCopied: 'Path copied', copyPathFailed: 'Could not copy. Select the path above and copy it manually.' });
  const uxCss = `.sla-comparison{margin:12px 0;font-size:13px}.sla-comparison>div{display:grid;grid-template-columns:76px minmax(0,1fr);gap:10px;padding:8px 0;border-bottom:1px solid var(--dsw-alias-border-l1)}.sla-comparison dt{color:var(--dsw-alias-label-secondary)}.sla-comparison dd{margin:0;overflow-wrap:anywhere;font-variant-numeric:tabular-nums}.sla-comparison>div:last-child dd{font-weight:600}.sla-field-help{font-size:13px;color:var(--dsw-alias-label-secondary)}.sla-field-error{font-size:13px;color:var(--dsw-alias-state-error-primary)}.sla-settings input[aria-invalid=true]{border-color:var(--dsw-alias-state-error-primary)}.sla-settings input{min-height:40px}.sla-settings .sla-actions{margin-top:14px}.sla-panel .sla-next{margin-top:18px}.sla-settings-state{font-size:12px;font-weight:400;margin-left:8px;color:var(--dsw-alias-label-secondary)}@container(max-width:280px){.sla-comparison>div{grid-template-columns:1fr;gap:2px}}`;
  Object.assign(dictionaries.zh, { artifactChanges: '查看候选内容', artifactCount: '项', artifactHint: '初始制品 → 当前候选', artifactUnchanged: '候选尚未交付', artifactReady: '采用前会重新评价候选，再交付结果。', artifactDelivered: '结果已交付。', artifactEmpty: '候选内容没有变化', artifactUnsupported: '此类制品暂不支持内容预览，可在证据中查看。', delivery: '交付记录', frontier: '保留的候选', frontierHint: '这些候选未被其他结果明确优于；不可比结果共同保留。' });
  Object.assign(dictionaries.en, { artifactChanges: 'View candidate content', artifactCount: 'items', artifactHint: 'Initial artifact → current candidate', artifactUnchanged: 'Candidate not delivered', artifactReady: 'Adoption reevaluates the candidate before delivery.', artifactDelivered: 'Result delivered.', artifactEmpty: 'Candidate content is unchanged', artifactUnsupported: 'Preview is unavailable for this artifact kind. See the evidence.', delivery: 'Delivery receipt', frontier: 'Retained candidates', frontierHint: 'No other retained result is strictly better; incomparable results remain available.' });
  const state = (run: Run) => run.adopted ? 'adopted' : run.status;
  const value = (x: EvaluationResult | null | undefined) => x?.display ?? (typeof x?.score === 'number' && Number.isFinite(x.score) ? String(Number(x.score.toPrecision(6))) : '—');
  return {
    inject: ['slots', 'remote', 'locale', 'sidebarRight', 'sidebarRightTabs'],
    async apply(ctx: Context) {
      ctx.effect(() => ctx.locale.register('sla', dictionaries));
      await ctx.remote.$mount(remote);
      ctx.inject(['remote.sla'], ctx => {
        const runs = createRunStore(
          async id => runSchema.nullable().parse(decode(await ctx.remote.sla.get(id))),
          async (id, action) => runSchema.nullable().parse(decode(await ctx.remote.sla.action(id, JSON.stringify(typeof action === 'string' ? { action } : action)))),
        );
        ctx.effect(() => () => runs.dispose());
        const tabKind = 'dsh-sla';
        const t = ctx.locale.bind('sla');
        const artifactLabels: Record<string, string> = { adoptedSummary: 'artifactDelivered', ready: 'artifactReady', unchanged: 'artifactUnchanged', changes: 'artifactChanges', changesHint: 'artifactHint', files: 'artifactCount', noChanges: 'artifactEmpty' };
        const resultLabel = (run: Run, key: string) => t(run.workflow?.kind === 'native' ? (artifactLabels[key] ?? key) : key);
        const actionLabel = (name: RunAction | null) => t(name === 'configure' ? 'savingSettings' : name === 'adopt' ? 'adopting' : name === 'review' ? 'reviewing' : name === 'resume' ? 'resuming' : name === 'pause' ? 'pausing' : name === 'stop' ? 'stopping' : 'actionPending');
        const toolbarLabels = () => ({ codeLabel: t('code'), wrapLabel: t('wrap'), unwrapLabel: t('unwrap') });
        function Prose({ text }: { text?: unknown }) {
          if (!text) return null;
          return h('div', { className: 'sla-prose' }, h(MarkdownText, { text: String(text), labels: {
            code: { copyLabel: t('copy'), copiedLabel: t('copied'), toolbarLabels: toolbarLabels() }, footnotes: t('footnotes'),
          } }));
        }
        function Original({ text, label = 'raw', title, code = false }: { text?: string; label?: string; title?: string; code?: boolean }) {
          if (!text) return null;
          return h('details', { className: 'sla-details' }, h('summary', null, title ?? t(label)), code ? h('pre', { className: 'sla-raw' }, text) : h(Prose, { text }));
        }
        function Delivery({ receipt }: { receipt: Run['delivery'] }) {
          const path = isRecord(receipt) && typeof receipt.path === 'string' ? receipt.path : '';
          const [copyState, setCopyState] = React.useState<'idle' | 'copied' | 'failed'>('idle');
          React.useEffect(() => { setCopyState('idle'); }, [path]);
          async function copy() {
            try { await navigator.clipboard.writeText(path); setCopyState('copied'); }
            catch { setCopyState('failed'); }
          }
          if (!path) return h(Original, { text: JSON.stringify(receipt, null, 2), label: 'delivery', code: true });
          return h('details', { className: 'sla-details' }, h('summary', null, t('delivery')),
            h('h3', null, t('resultPath')), h('p', { className: 'sla-path' }, path),
            h('button', { type: 'button', onClick: copy }, t('copyPath')),
            copyState !== 'idle' && h('p', { role: 'status', className: 'sla-muted' }, t(copyState === 'copied' ? 'pathCopied' : 'copyPathFailed')),
            h(Original, { text: JSON.stringify(receipt, null, 2), code: true }));
        }
        function CheckOrigin({ run, check, index }: { run: Run; check: { id?: string }; index: number }) {
          const view = checkPresentation(run, check, index);
          return h('div', { className: 'sla-origin' },
            view.purpose && h(Prose, { text: view.purpose }),
            h('details', { className: 'sla-details' }, h('summary', null, t('checkOrigin')),
              h('p', { className: 'sla-muted' }, t('originHint')),
              h('p', null, view.origin ? `${view.origin.trial ? t('candidate') + ' #' + view.origin.trial : t('initialProject')} · ${t('criterionVersion')} ${view.origin.version}` : t('unknownOrigin')),
              view.origin?.publishedVersion && h('p', { className: 'sla-muted' }, `${t('introduced')} ${view.origin.publishedVersion}`),
              h(Prose, { text: view.original })));
        }
        function Evaluation({ result, run }: { result?: EvaluationResult | null; run: Run }) {
          const view = evaluationView(result);
          return h('div', { className: 'sla-check-result' },
            h('strong', { className: `sla-status-${view.status}` }, t(view.status === 'passed' ? 'verified' : view.status === 'failed' ? 'failedCheck' : 'unknownCheck')),
            h('dl', { className: 'sla-facts' },
              (result?.display !== undefined || Number.isFinite(result?.score)) && h(React.Fragment, null, h('dt', null, t('resultValue')), h('dd', null, value(result), Number.isFinite(result?.score) && run.criteria?.unit ? ' ' + run.criteria.unit.split(/[，,；;]/)[0] : '')),
              view.total > 0 && h(React.Fragment, null, h('dt', null, t('checkResults')), h('dd', null, `${view.passed} / ${view.total} ${t('groups')} ${t('passed')}`))),
            view.total > 0 && h('ul', { className: 'sla-check-list' }, ...view.checks.map((check, i) => h('li', { key: check.id ?? i },
              h('details', null, h('summary', null, h('span', null, checkPresentation(run, check, i).title ?? `${t('checkGroup')} ${i + 1}`), h('span', { className: `sla-status sla-status-${check.passed === true ? 'passed' : check.passed === false ? 'failed' : 'unknown'}` }, t(check.passed === true ? 'passed' : check.passed === false ? 'failed' : 'unknown'))),
                h('p', { className: 'sla-muted' }, t('currentCheck')), h(Prose, { text: check.summary }), h(CheckOrigin, { run, check, index: i }))))),
            h(Original, { text: result?.summary }));
        }
        function Decision({ run, compact = false }: { run: Run; compact?: boolean }) {
          const view = decisionView(run);
          if (!view.trial) return h('p', null, run.rebuild ? t('pending') : t('noResult'));
          const measurements: [string, EvaluationResult | null | undefined][] = [[t('baseline'), run.baseline], [t(run.adopted && run.adoptionCheck ? 'adoptedValue' : 'selectedValue'), view.evaluation]];
          const changedFiles = run.workflow?.kind !== 'native' && (view.trial.changes?.length ?? 0) > 0;
          const hasDescription = view.brief.change || changedFiles || view.trial.report || view.excluded.length || run.pendingReview || view.brief.unverified;
          return h(React.Fragment, null,
            h('dl', { className: 'sla-comparison' }, ...measurements.map(([label, result]) => h('div', { key: label }, h('dt', null, label), h('dd', null, value(result), Number.isFinite(result?.score) && run.criteria?.unit ? ' ' + run.criteria.unit.split(/[，,；;]/)[0] : '')))),
            compact ? h('p', { className: 'sla-muted' }, run.pendingReview ? t('pendingReview') : resultLabel(run, run.adopted ? 'adoptedSummary' : 'unchanged')) : hasDescription ? h('div', { className: 'sla-decision' },
              (view.brief.change || changedFiles) && h('h3', null, t('changed')),
              view.brief.change && h('p', { className: 'sla-muted' }, t('authorReport')),
              view.brief.change ? h(Prose, { text: view.brief.change }) : changedFiles ? h('p', null, `${t('changeFiles')}：${view.trial.changes?.join('、')}`) : null,
              h(Original, { text: view.trial.report, label: 'workerRecord' }),
              view.excluded.length > 0 && h('p', { className: 'sla-muted' }, `${t('excluded')}：${view.excluded.map(n => '#' + n).join('、')}`),
              run.pendingReview && h('p', null, t('pendingReview')),
              view.brief.unverified && h(React.Fragment, null, h('h3', null, t('unverified')), h(Prose, { text: view.brief.unverified }))) : null,
          );
        }
        function Changes({ run, sessionId }: { run: Run; sessionId: SessionId }) {
          const [expanded, setExpanded] = React.useState(false);
          const [attempt, setAttempt] = React.useState(0);
          const [preview, setPreview] = React.useState<ChangePreview | null>(null);
          const [failure, setFailure] = React.useState('');
          const identity = `${run.id}:${run.best?.trial}:${run.criteriaVersion ?? run.revision}`;
          React.useEffect(() => {
            if (!expanded) return;
            let active = true;
            setPreview(null); setFailure('');
            ctx.remote.sla.changes(sessionId).then(result => previewSchema.parse(decode(result))).then(data => { if (!active) return; if (!matchesPreview(data, run)) throw new Error(t('previewChanged')); setPreview(data); })
              .catch(error => { if (active) setFailure(message(error)); });
            return () => { active = false; };
          }, [expanded, identity, sessionId, attempt]);
          const data = matchesPreview(preview, run) ? preview : null;
          const labels = { ...toolbarLabels(), copy: t('copy'), copied: t('copied'), collapseAria: t('collapseDiff'), collapse: t('collapseDiff'), expandAria: (n: number) => `${t('expandDiff')} (${n})`, expand: (n: number) => `${t('expandDiff')} (${n})` };
          return h('details', { className: 'sla-section', onToggle: (e: React.SyntheticEvent<HTMLDetailsElement>) => { if (e.target === e.currentTarget) setExpanded(e.currentTarget.open); } },
            h('summary', null, resultLabel(run, 'changes'), data && h('span', { className: 'sla-file-count' }, ` · ${data.files.length} ${resultLabel(run, 'files')}`)),
            expanded && h(React.Fragment, null,
              h('p', { className: 'sla-muted' }, resultLabel(run, 'changesHint')),
              failure ? h('div', { role: 'alert' }, h('p', null, failure), h('button', { type: 'button', onClick: () => setAttempt(attempt + 1) }, t('retry'))) : !data ? h('p', { role: 'status' }, t('loadingChanges')) : data.files.length ? data.files.map(file => h('details', { className: 'sla-file', key: file.path, open: data.files.length === 1 },
                h('summary', null, file.path, h('span', { className: 'sla-file-kind' }, t(file.kind))),
                h('div', { className: 'sla-file-body' }, file.omitted ? h('p', null, t(file.omitted)) : h(DiffBlock, { diffs: [{ path: file.path, oldText: file.oldText ?? '', newText: file.newText ?? '' }], labels, maxLines: 18 })))) : h('p', null, data.unsupported ? t('artifactUnsupported') : resultLabel(run, 'noChanges')),
              h(Original, { text: run.best?.diff, label: 'rawPatch', code: true })));
        }
        ctx.effect(() => ctx.sidebarRightTabs.register({ id: tabKind, kind: tabKind, title: () => t('title') }));
        function useRun(sessionId: SessionId) {
          const entry = runs.forSession(sessionId);
          const snapshot = React.useSyncExternalStore(entry.subscribe, entry.getSnapshot);
          return { ...snapshot, error: snapshot.error || snapshot.loadError, act: entry.action };
        }
        function open(sessionId: SessionId) {
          if (ctx.sidebarRight.mounted.getSnapshot() === sessionId) ctx.sidebarRight.openTab(tabKind);
        }
        function Header({ sessionId, t }: HeaderProps) {
          const { run, error } = useRun(sessionId);
          if (!run && !error) return null;
          return h(React.Fragment, null, h('style', null, css), h('button', {
            type: 'button', className: 'sla-header', title: t('details'), 'aria-label': `${t('title')} · ${run ? t(state(run)) : t('error')}`,
            onClick: () => open(sessionId),
          }, t('short'), ' · ', run ? t(state(run)) : t('error'), run && moving(run) && run.attempts > 0 ? ` · ${run.attempts}/${run.limit}` : ''));
        }
        function Result({ sessionId, turn, t, useChat }: ResultProps) {
          const { run, error, loadError, pendingAction } = useRun(sessionId);
          const latestTurn = useChat(snapshot => latestRunTurn(snapshot.timeline, run?.createdAt));
          if (!run || !ownsRun(turn, run, latestTurn)) return null;
          return h('section', { className: 'sla-result', 'aria-label': t('live') }, h('style', null, css + evidenceCss + uxCss),
            h('div', { className: 'sla-top' }, h('strong', { role: 'status' }, t('live'), ' · ', t(state(run))), h('button', { type: 'button', onClick: () => open(sessionId) }, t('details'))),
            error && h('p', { role: 'alert' }, loadError ? t('syncFailed') : `${t('error')}：${error}`),
            pendingAction && h('p', { role: 'status' }, actionLabel(pendingAction)),
            moving(run) || run.status === 'blocked' ? h(Prose, { text: run.message }) : null,
            h(Decision, { run, compact: true }),
            run.updatedAt && h('time', { dateTime: run.updatedAt }, t('updated'), ' ', new Date(run.updatedAt).toLocaleString()));
        }
        function Settings({ run, busy, pendingAction, error, act }: { run: Run; busy: boolean; pendingAction: RunAction | null; error: string; act: RunEntry['action'] }) {
          const current = run.settings;
          const signature = JSON.stringify(current);
          const [draft, setDraft] = React.useState<Record<keyof RunSettings, number | string>>(current);
          const [saved, setSaved] = React.useState<string | false>(false);
          const [saveFailed, setSaveFailed] = React.useState(false);
          const [touched, setTouched] = React.useState<Partial<Record<keyof RunSettings, boolean>>>({});
          const [submitted, setSubmitted] = React.useState(false);
          const [advancedOpen, setAdvancedOpen] = React.useState(false);
          const inputs = React.useRef<Partial<Record<keyof RunSettings, HTMLInputElement | null>>>({});
          const focusAfterRender = React.useRef<keyof RunSettings | null>(null);
          const id = React.useId();
          React.useEffect(() => { setDraft(run.settings); setTouched({}); setSubmitted(false); }, [run.id, signature]);
          React.useLayoutEffect(() => {
            if (focusAfterRender.current) { inputs.current[focusAfterRender.current]?.focus(); focusAfterRender.current = null; }
          });
          const invalid = (name: keyof RunSettings) => String(draft[name]).trim() === '' || !settingsSchema.shape[name].safeParse(Number(draft[name])).success;
          const dirty = settingKeys.some(key => String(draft[key]).trim() === '' || Number(draft[key]) !== current[key]);
          const field = (name: keyof RunSettings, label: string = name) => {
            const schema = settingsSchema.shape[name], range = `${schema.minValue}–${schema.maxValue}`;
            const error = (submitted || touched[name]) && invalid(name);
            const descriptionId = `${id}-${name}-help`;
            return h('div', { key: name }, h('label', { htmlFor: `${id}-${name}` }, t(label)), h('input', {
              id: `${id}-${name}`, type: 'number', name, min: schema.minValue, max: schema.maxValue, step: 1, required: true,
              ref: (input: HTMLInputElement | null) => { inputs.current[name] = input; },
              'aria-invalid': !!error, 'aria-describedby': descriptionId, value: draft[name] ?? '',
              onBlur: () => setTouched(previous => ({ ...previous, [name]: true })),
              onChange: (event: React.ChangeEvent<HTMLInputElement>) => { setSaved(false); setSaveFailed(false); setDraft(previous => ({ ...previous, [name]: event.target.value })); },
            }), h('span', { id: descriptionId, className: error ? 'sla-field-error' : 'sla-field-help' }, `${t(error ? 'settingInvalid' : 'settingRange')}：${range}`));
          };
          async function save(event: React.FormEvent<HTMLFormElement>) {
            event.preventDefault();
            if (busy || moving(run)) return;
            const fieldOrder: (keyof RunSettings)[] = ['maxTrials', 'maxMinutes', 'maxStepsPerCall', 'maxMinutesPerCall', 'directions', 'localTrials'];
            const invalidKeys = fieldOrder.filter(invalid);
            if (invalidKeys.length) {
              setSubmitted(true); setTouched({});
              if (invalidKeys.some(key => key !== 'maxTrials' && key !== 'maxMinutes')) setAdvancedOpen(true);
              focusAfterRender.current = invalidKeys[0];
              return;
            }
            const changed = Object.fromEntries(settingKeys.filter(key => Number(draft[key]) !== current[key]).map(key => [key, Number(draft[key])]));
            if (!Object.keys(changed).length) return;
            setSaved(false); setSaveFailed(false);
            const result = await act({ action: 'configure', settings: changed });
            if (result) setSaved(JSON.stringify(result.settings));
            else setSaveFailed(true);
          }
          return h('details', { className: 'sla-section sla-settings' }, h('summary', null, t('settings'), dirty && h('span', { className: 'sla-settings-state' }, t('settingsDirty'))),
            h('p', { className: 'sla-muted' }, t('settingsHint')),
            moving(run) && h('button', { type: 'button', disabled: busy || ['pausing', 'stopping'].includes(run.status), onClick: () => act('pause') }, t('pauseToConfigure')),
            h('form', { onSubmit: save, noValidate: true }, h('fieldset', { disabled: busy || moving(run) },
              h('legend', null, t('runAllowance')), h('div', { className: 'sla-settings-grid' }, field('maxTrials'), field('maxMinutes')),
              h('details', { className: 'sla-details', open: advancedOpen, onToggle: (event: React.SyntheticEvent<HTMLDetailsElement>) => { if (event.target === event.currentTarget) setAdvancedOpen(event.currentTarget.open); } }, h('summary', null, t('callAllowance')),
                h('div', { className: 'sla-settings-grid' }, field('maxStepsPerCall'), field('maxMinutesPerCall'), field('directions', 'directionsLimit'), field('localTrials')),
                h('p', { className: 'sla-muted' }, t('callHint'))),
              submitted && settingKeys.some(invalid) && h('p', { role: 'alert', className: 'sla-field-error' }, t('settingsErrors')),
              h('div', { className: 'sla-actions' }, h('button', { type: 'submit', disabled: !dirty }, pendingAction === 'configure' ? t('savingSettings') : t('saveSettings')),
                dirty && h('button', { type: 'button', onClick: () => { setDraft(current); setTouched({}); setSubmitted(false); setSaved(false); setSaveFailed(false); } }, t('resetSettings'))))),
            saveFailed && error && h('p', { role: 'alert', className: 'sla-field-error' }, error),
            !moving(run) && saved === JSON.stringify(run.settings) && h('p', { role: 'status' }, t('settingsSaved')));
        }
        function Panel({ sessionId, t, useTabInfo }: PanelProps) {
          const { run, error, loadError, busy, pendingAction, act } = useRun(sessionId);
          const view = run ? decisionView(run) : undefined;
          const info = useTabInfo();
          async function action(name: RunAction) {
            const result = await act(name);
            if (name === 'adopt' && result?.adopted) collapseAdoptedPanel(ctx.sidebarRight, sessionId, info.tab.id);
          }
          const button = (label: string, name: RunAction, disabled = false, primary = false) => h('button', { type: 'button', disabled: busy || disabled, className: primary ? 'sla-primary' : undefined, onClick: () => action(name) }, pendingAction === name ? actionLabel(name) : t(label));
          return h('section', { className: 'sla-panel', 'aria-label': t('title') }, h('style', null, css + evidenceCss + settingsCss + uxCss),
            h('div', { className: 'sla-top sla-eyebrow' }, t('title'), run && h('span', { className: 'sla-tag' }, t(state(run)))),
            error && h('p', { role: 'alert', className: 'sla-error' }, loadError ? t('syncFailed') : t('error'), '：', error),
            !run || !view ? h('p', null, run === undefined ? t('loading') : t('intro')) : h(React.Fragment, null,
              h('h2', null, view.trial ? `${t('result')} · ${t('candidate')} #${view.trial.number}` : t('title')),
              h(Original, { text: run.goal, label: 'goal' }),
              !run.adopted && h('div', { 'aria-live': 'polite' }, h(Prose, { text: run.message })),
              !run.adopted && h('p', { className: 'sla-muted' }, `${t('attempted')} ${run.attempts} / ${run.limit} · ${resultLabel(run, 'unchanged')}`),
              run.adopted && h('p', null, resultLabel(run, 'adoptedSummary')),
              run.delivery !== undefined && h(Delivery, { receipt: run.delivery }),
              h(Decision, { run }),
              view.trial && h(Changes, { key: `changes:${run.id}`, run, sessionId }),
              view.evaluation && h('details', { className: 'sla-section' }, h('summary', null, t(view.checks.status === 'passed' ? 'verified' : view.checks.status === 'failed' ? 'failedCheck' : 'unknownCheck'), view.checks.total > 0 ? ` · ${view.checks.passed}/${view.checks.total} ${t('groups')}` : ''), h(Evaluation, { result: view.evaluation, run })),
              !run.adopted && h(React.Fragment, null,
                !moving(run) && (view.ready || view.trial && !view.approved) && h('p', { className: 'sla-next' }, view.ready ? resultLabel(run, 'ready') : t('reviewRequired')),
                pendingAction && h('p', { role: 'status' }, actionLabel(pendingAction)),
                h('div', { className: 'sla-actions' },
                  moving(run) ? button('pause', 'pause', run.status === 'pausing' || run.status === 'stopping') : !run.adoptionPending && button('resume', 'resume', false, !view.trial),
                  moving(run) && button('stop', 'stop', run.status === 'stopping'),
                  !moving(run) && !run.adoptionPending && view.trial && (view.ready ? button('adopt', 'adopt', false, true) : !view.approved && button('review', 'review', false, true))),
                h('p', { className: 'sla-muted sla-hint' }, t('steerHint'))),
              !run.adopted && run.settings && h(Settings, { key: `settings:${run.id}`, run, busy, pendingAction, error, act }),
              run.frontier?.length > 1 && h('details', { className: 'sla-section' }, h('summary', null, t('frontier')), h('p', { className: 'sla-muted' }, t('frontierHint')), ...run.frontier.map(candidate => h('p', { key: candidate.artifactId }, `#${candidate.trial} · ${value(candidate)}`))),
              h('details', { className: 'sla-section' }, h('summary', null, t('method'), ` · ${t('revision')} ${run.criteriaVersion ?? run.revision}`),
                h('div', { className: 'sla-method-title' }, h(Prose, { text: run.criteria?.title ?? t('pending') })),
                run.criteria?.unit && h('div', { className: 'sla-measurement' }, h('strong', null, t('measurement')), h(Prose, { text: run.criteria.unit })),
                h(Original, { text: run.criteria?.criterion, label: 'fullCriteria' }),
                run.task && h('p', { className: 'sla-muted' }, `${run.task.name} · ${run.task.version}`),
                h(Original, { text: run.selectionReason, label: 'methodChoice' }),
                ...(run.checks ?? []).map((check, i) => h('details', { key: check.id, className: 'sla-details' }, h('summary', null, check.title ?? `${t('checkGroup')} ${i + 1}`), h(CheckOrigin, { run, check, index: i }))),
                run.notes.length > 0 && h('div', { className: 'sla-subsection' }, h('h3', null, t('notes')), ...run.notes.map((note, i) => h(Prose, { key: i, text: note })))),
              run.directions?.length > 0 && h('div', { className: 'sla-section' }, h('div', { className: 'sla-top' }, h('h3', null, t('directions')), h('span', { className: 'sla-muted' }, `${t('epochs')} ${run.epochs?.length ?? 0}`)),
                ...run.directions.filter(d => d.revision === run.revision).map(d => h('details', { key: d.id, className: 'sla-trial' }, h('summary', null, d.id, ' · ', value(d.best)), h(Prose, { text: d.hypothesis }), h('p', { className: 'sla-muted' }, d.best ? `#${d.best.trial} · ${t('localBest')}` : t('noLocal'))))),
              run.reviews?.length > 0 && h('details', { className: 'sla-section' }, h('summary', null, t('reviews')),
                ...run.reviews.map(r => h('details', { key: r.id, className: 'sla-trial' }, h('summary', null, `#${r.targetTrial} · ${t(r.status)}`), r.error && h(Prose, { text: r.error }), h(Prose, { text: r.summary })))),
              h('div', { className: 'sla-section' }, h('div', { className: 'sla-top' }, h('h3', null, t('experiments')), h('span', { className: 'sla-muted' }, `${run.attempts} / ${run.limit} ${t('trials')}`)),
                run.trials.length === 0 && h('p', { className: 'sla-muted' }, t('empty')),
                ...run.trials.map(trial => {
                  const { assessment, evaluation: shown, historical } = currentEvaluation(run, trial);
                  const label = historical ? t('historical') : assessment ? `${t('reassessment')}${shown?.valid ? '' : ' · ' + t('invalid')}` : t(trial.status);
                  return h('details', { key: trial.number, className: 'sla-trial' },
                  h('summary', null, `#${trial.number} · ${label}`, shown?.display !== undefined || shown?.score !== undefined ? ` · ${value(shown)}` : '', ` · ${t('revision')} ${assessment?.criteriaVersion ?? trial.criteriaVersion ?? trial.revision}`),
                  trial.direction && h('p', { className: 'sla-muted' }, `${t('epochs')} ${trial.epoch} · ${trial.direction} · ${t('parent')} #${trial.parentTrial}`),
                  !historical && h(Evaluation, { result: shown, run }),
                  h(Original, { label: 'idea', text: trial.hypothesis }),
                  historical && h(Prose, { text: trial.summary }),
                  assessment && h(Original, { label: 'previous', text: `**${t('revision')} ${trial.criteriaVersion ?? trial.revision} · ${t(trial.status)}**\n\n${trial.summary ?? ''}` }),
                  ...(run.assessments ?? []).filter(a => a.trial === trial.number && a !== assessment).map(a => h(Original, { key: a.criteriaVersion, label: 'previous', text: `**${t('revision')} ${a.criteriaVersion}**\n\n${a.evaluation?.summary ?? ''}` })),
                  (trial.changes?.length ?? 0) > 0 && h('p', { className: 'sla-muted' }, trial.changes?.join('、'))); })),
              h('details', { className: 'sla-section' }, h('summary', null, t('evidence')), h('p', { className: 'sla-path' }, run.root))));
        }
        ctx.slots.inject('conversation.session.header.actions', () => ctx.slots.register({ name: 'conversation.session.header.actions', id: 'sla', order: 30, locale: 'sla' }, Header));
        ctx.slots.inject('sidebar.right.pane.tab', () => ctx.slots.register({ name: 'sidebar.right.pane.tab', key: tabKind, locale: 'sla' }, Panel));
        ctx.slots.inject('conversation.chat.turnTail', () => ctx.slots.register({ name: 'conversation.chat.turnTail', id: 'sla-result', order: 30, locale: 'sla' }, Result));
      });
    },
  };
}

export const { inject, apply } = factory();
