// One subscription per session, shared by the header, transcript and sidebar.
export function createRunStore(read, mutate, pollMs = 2000) {
  const sessions = new Map();
  let disposed = false;
  function forSession(sessionId) {
    if (sessions.has(sessionId)) return sessions.get(sessionId);
    let snapshot = { run: undefined, error: '', loadError: '', busy: false };
    let timer, generation = 0;
    const listeners = new Set();
    const publish = patch => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    };
    function schedule() {
      clearTimeout(timer);
      if (!disposed && listeners.size) timer = setTimeout(refresh, pollMs);
    }
    async function refresh() {
      if (disposed || !listeners.size) return;
      if (snapshot.busy) return schedule();
      const current = ++generation;
      try {
        const run = await read(sessionId);
        if (!disposed && current === generation) publish({ run, loadError: '' });
      } catch (error) {
        if (!disposed && current === generation) publish({ loadError: error.message });
      } finally { if (current === generation) schedule(); }
    }
    const entry = {
      getSnapshot: () => snapshot,
      subscribe(listener) {
        listeners.add(listener);
        if (listeners.size === 1) void refresh();
        return () => {
          listeners.delete(listener);
          if (!listeners.size) { clearTimeout(timer); generation++; }
        };
      },
      async action(action) {
        if (disposed || snapshot.busy) return;
        generation++; clearTimeout(timer);
        publish({ busy: true, error: '', loadError: '' });
        try {
          const run = await mutate(sessionId, action);
          if (disposed) return;
          publish({ run });
          return run;
        } catch (error) {
          if (!disposed) publish({ error: error.message });
        } finally {
          if (!disposed) publish({ busy: false });
          schedule();
        }
      },
      dispose() { generation++; clearTimeout(timer); listeners.clear(); },
    };
    sessions.set(sessionId, entry);
    return entry;
  }
  return { forSession, dispose() { disposed = true; for (const entry of sessions.values()) entry.dispose(); sessions.clear(); } };
}

// Attach the live result to the conversation turn that started this exploration.
export function ownsRun(turn, run) {
  const started = Date.parse(run?.createdAt);
  return Number.isFinite(started) && turn?.status === 'closed'
    && typeof turn.start?.time === 'number' && typeof turn.end?.time === 'number'
    && turn.start.time <= started && started <= turn.end.time;
}

export function collapseAdoptedPanel(sidebar, sessionId, tabId) {
  if (sidebar.mounted.getSnapshot() === sessionId && sidebar.active()?.id === tabId && sidebar.isExpanded()) sidebar.toggleExpanded();
}
