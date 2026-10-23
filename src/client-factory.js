function factory(require) {
  const React = require('react');
  const h = React.createElement;
  const decode = result => {
    if (!result.ok) throw new Error(result.error.message);
    return JSON.parse(result.value);
  };
  const dictionaries = {
    zh: { title: '持续探索', intro: '在模式菜单选择「持续探索 · SLA」，然后告诉我你希望什么变好。', allowance: '每轮最多 3 次尝试 · 20 分钟', pause: '暂停', stop: '结束探索', resume: '继续探索', adopt: '采用这个结果', adopted: '已采用', recheck: '采用前复验', details: '查看依据与实验', hide: '收起详情', steer: '补充要求', placeholder: '例如：不要增加依赖，优先降低内存占用', baseline: '初始结果', best: '当前最佳', trials: '次尝试', evidence: '证据目录', unchanged: '本次探索尚未写回', changes: '改动文件', empty: '还没有完成的实验', preparing: '准备项目', running: '探索中', paused: '已暂停', pausing: '正在暂停', stopping: '正在结束', completed: '本轮结束', blocked: '需要处理', kept: '保留', invalid: '检查未通过', inconclusive: '未完成评价', 'no-improvement': '没有改善', error: '操作失败', revision: '目标版本', method: '判断依据', pending: '正在建立判断依据…', loading: '连接探索状态…' },
    en: { title: 'Continuous exploration', intro: 'Choose SLA in the mode menu, then describe what should improve.', allowance: 'Up to 3 trials · 20 min per tranche', pause: 'Pause', stop: 'Finish', resume: 'Continue', adopt: 'Adopt result', adopted: 'Adopted', recheck: 'Adoption recheck', details: 'Evidence and experiments', hide: 'Hide details', steer: 'Add direction', placeholder: 'For example: no new dependencies; prioritize memory usage', baseline: 'Baseline', best: 'Current best', trials: 'trials', evidence: 'Evidence directory', unchanged: 'Source project unchanged', changes: 'Changed files', empty: 'No completed experiments yet', preparing: 'Preparing', running: 'Exploring', paused: 'Paused', pausing: 'Pausing', stopping: 'Stopping', completed: 'Finished', blocked: 'Needs attention', kept: 'Kept', invalid: 'Checks failed', inconclusive: 'Inconclusive', 'no-improvement': 'No improvement', error: 'Action failed', revision: 'Goal revision', method: 'Evaluation criteria', pending: 'Establishing evaluation criteria…', loading: 'Connecting…' },
  };
  const css = `
.sla-card{font:inherit;color:var(--dsw-alias-label-primary);border:1px solid var(--dsw-alias-border-l1);background:var(--dsw-alias-bg-base);border-radius:16px;padding:16px;margin:4px 0 10px;box-sizing:border-box;width:100%;font-size:13px;line-height:1.6}
.sla-card *{box-sizing:border-box}.sla-card h3{font-size:15px;margin:0;font-weight:600}.sla-top,.sla-actions,.sla-scores{display:flex;align-items:center;gap:10px;flex-wrap:wrap}.sla-top{justify-content:space-between}.sla-tag{font-size:11px;color:var(--dsw-alias-label-secondary);border:1px solid var(--dsw-alias-border-l1);padding:2px 8px;border-radius:20px}.sla-muted{color:var(--dsw-alias-label-secondary);font-size:12px}.sla-goal{margin:9px 0 4px;font-weight:500;overflow-wrap:anywhere}.sla-message{margin:3px 0 12px}.sla-scores{gap:32px;padding:8px 0 12px}.sla-value{font-size:24px;line-height:1.3;font-variant-numeric:tabular-nums}.sla-card button{font:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;background:transparent;color:inherit;padding:5px 11px;cursor:pointer}.sla-card button:hover{background:var(--dsw-alias-interactive-bg-hover)}.sla-card button:disabled{opacity:.45;cursor:default}.sla-card .sla-primary{background:var(--dsw-alias-interactive-bg-hover);font-weight:600}.sla-card button:focus-visible,.sla-card input:focus-visible{outline:2px solid var(--dsw-alias-label-primary);outline-offset:2px}.sla-card input{font:inherit;border:1px solid var(--dsw-alias-border-l1);border-radius:8px;padding:8px 10px;background:transparent;color:inherit;min-width:140px;flex:1}.sla-steer{display:flex;gap:8px;margin-top:12px}.sla-details{max-height:270px;overflow:auto;border-top:1px solid var(--dsw-alias-border-l1);margin-top:12px;padding-top:12px}.sla-trial{border-top:1px solid var(--dsw-alias-border-l1);padding:10px 0}.sla-trial p{margin:3px 0;overflow-wrap:anywhere}.sla-path{overflow-wrap:anywhere;font-size:11px;user-select:all}.sla-error{border-left:3px solid currentColor;padding-left:8px;margin:8px 0}.sla-card summary{cursor:pointer}.sla-card pre{white-space:pre-wrap;overflow-wrap:anywhere;font:inherit}@media(max-width:520px){.sla-steer{flex-direction:column}.sla-card{padding:12px}.sla-value{font-size:20px}}
`;
  return {
    inject: ['slots', 'remote', 'locale'],
    async apply(ctx) {
      ctx.effect(() => ctx.locale.register('sla', dictionaries));
      await ctx.remote.$mount(remote);
      ctx.inject(['remote.sla'], ctx => {
        function Panel({ sessionId, t }) {
          const [run, setRun] = React.useState(undefined);
          const [error, setError] = React.useState('');
          const [busy, setBusy] = React.useState(false);
          const [text, setText] = React.useState('');
          const [details, setDetails] = React.useState(false);
          React.useEffect(() => {
            let active = true, timer;
            async function refresh() {
              try {
                const value = decode(await ctx.remote.sla.get(sessionId));
                if (active) setRun(value);
              } catch (e) { if (active) setError(e.message); }
              if (active) timer = setTimeout(refresh, 2000);
            }
            setRun(undefined); setError(''); refresh();
            return () => { active = false; clearTimeout(timer); };
          }, [sessionId]);
          async function act(action) {
            setBusy(true); setError('');
            try {
              const value = decode(await ctx.remote.sla.action(sessionId, JSON.stringify({ action, ...action === 'steer' ? { text } : {} })));
              setRun(value); if (action === 'steer') setText('');
            } catch (e) { setError(e.message); }
            finally { setBusy(false); }
          }
          const moving = run && ['running', 'preparing', 'pausing', 'stopping'].includes(run.status);
          const button = (label, action, disabled = false, primary = false) => h('button', { type: 'button', disabled: busy || disabled, className: primary ? 'sla-primary' : undefined, onClick: () => act(action) }, t(label));
          const value = x => x ? String(Number(x.score.toPrecision(6))) : '—';
          if (!run && !error) return null;
          return h('section', { className: 'sla-card', 'aria-label': t('title') },
            h('style', null, css),
            h('div', { className: 'sla-top' }, h('h3', null, t('title')), h('span', { className: 'sla-tag' }, run ? t(run.adopted ? 'adopted' : run.status) : 'SLA')),
            error && h('p', { role: 'alert', className: 'sla-error' }, t('error'), '：', error),
            !run ? h('p', { className: 'sla-muted' }, run === undefined ? t('loading') : t('intro')) : h(React.Fragment, null,
              h('p', { className: 'sla-goal' }, run.goal),
              h('p', { className: 'sla-message', 'aria-live': 'polite' }, run.message),
              run.criteria && h('div', { className: 'sla-scores' },
                h('div', null, h('div', { className: 'sla-muted' }, t('baseline')), h('div', { className: 'sla-value' }, value(run.baseline))),
                h('div', null, h('div', { className: 'sla-muted' }, t('best')), h('div', { className: 'sla-value' }, value(run.best))),
                h('div', { className: 'sla-muted' }, `${run.attempts} / ${run.limit} ${t('trials')}`)),
              run.criteria && h('p', { className: 'sla-muted' }, run.criteria.unit),
              run.adopted && run.adoptionCheck && h('p', { className: 'sla-muted' }, t('recheck'), '：', run.adoptionCheck.summary),
              h('div', { className: 'sla-actions' },
                moving ? button('pause', 'pause', run.status === 'pausing' || run.status === 'stopping') : !run.adopted && !run.adoptionPending && button('resume', 'resume', false, true),
                moving && button('stop', 'stop', run.status === 'stopping'),
                !moving && !run.rebuild && !run.adoptionPending && run.best?.trial > 0 && button(run.adopted ? 'adopted' : 'adopt', 'adopt', run.adopted, true),
                h('button', { type: 'button', 'aria-expanded': details, onClick: () => setDetails(!details) }, t(details ? 'hide' : 'details'))),
              !run.adopted && !run.adoptionPending && h('form', { className: 'sla-steer', onSubmit: e => { e.preventDefault(); if (text.trim()) act('steer'); } },
                h('input', { 'aria-label': t('steer'), placeholder: t('placeholder'), value: text, onChange: e => setText(e.target.value), disabled: busy }),
                h('button', { type: 'submit', disabled: busy || !text.trim() }, t('steer'))),
              details && h('div', { className: 'sla-details' },
                h('strong', null, t('method'), ` · ${t('revision')} ${run.revision}`),
                h('p', null, run.criteria?.criterion ?? t('pending')),
                run.best?.diff && h('details', null, h('summary', null, t('best'), ' · ', t('changes')), h('pre', null, run.best.diff)),
                run.notes.map((note, i) => h('p', { key: 'note' + i }, '↳ ', note)),
                run.trials.length === 0 && h('p', { className: 'sla-muted' }, t('empty')),
                run.trials.map(trial => h('article', { key: trial.number, className: 'sla-trial' },
                  h('strong', null, `#${trial.number} · ${trial.hypothesis}`),
                  h('p', { className: 'sla-muted' }, `${t(trial.status)} · ${t('revision')} ${trial.revision}`, trial.score === undefined ? '' : ` · ${trial.score}`),
                  h('p', null, trial.summary),
                  trial.changes?.length > 0 && h('details', null, h('summary', null, t('changes')), h('pre', null, trial.changes.join('\n'))))),
                h('strong', null, t('evidence')), h('p', { className: 'sla-path' }, run.root)),
              h('p', { className: 'sla-muted', style: { marginBottom: 0 } }, run.adoptionPending ? t('blocked') : run.adopted ? t('adopted') : t('unchanged'), ' · ', t('allowance'))));
        }
        ctx.slots.inject('conversation.input.dock', () => ctx.slots.register({ name: 'conversation.input.dock', id: 'sla', order: 20, locale: 'sla', inject: sessionId => ({ sessionId }) }, Panel));
      });
    },
  };
}
