import type { SessionId } from '@deepseek-ai/dsh-session/types';
import type { ConversationTimelineSnapshot, TurnLocation } from '@deepseek-ai/dsh-client-ui-conversation/client';
import type { Context } from '@deepseek-ai/cordis';
import type {} from '@deepseek-ai/dsh-client-ui-sidebar-right/client';
import type { Action, Run } from './data.js';
import { message } from './errors.js';
export type RunAction = Action | Action['action'];
export interface RunSnapshot { run?: Run | null; error: string; loadError: string; busy: boolean }
export interface RunEntry {
  getSnapshot(): RunSnapshot;
  subscribe(listener: () => void): () => void;
  action(action: RunAction): Promise<Run | null | undefined>;
  dispose(): void;
}
// One subscription per session, shared by the header, transcript and sidebar.
export function createRunStore(read: (id: SessionId) => Promise<Run | null>, mutate: (id: SessionId, action: RunAction) => Promise<Run | null>, pollMs = 2000) {
  const sessions = new Map<SessionId, RunEntry>();
  let disposed = false;
  function forSession(sessionId: SessionId): RunEntry {
    const existing = sessions.get(sessionId);
    if (existing) return existing;
    let snapshot: RunSnapshot = { run: undefined, error: '', loadError: '', busy: false };
    let timer: ReturnType<typeof setTimeout> | undefined, generation = 0;
    const listeners = new Set<() => void>();
    const publish = (patch: Partial<RunSnapshot>) => {
      snapshot = { ...snapshot, ...patch };
      for (const listener of listeners) listener();
    };
    function schedule() {
      clearTimeout(timer);
      if (!disposed && listeners.size) timer = setTimeout(refresh, pollMs);
    }
    async function refresh(): Promise<void> {
      if (disposed || !listeners.size) return;
      if (snapshot.busy) return schedule();
      const current = ++generation;
      try {
        const run = await read(sessionId);
        if (!disposed && current === generation) publish({ run, loadError: '' });
      } catch (error) {
        if (!disposed && current === generation) publish({ loadError: message(error) });
      } finally { if (current === generation) schedule(); }
    }
    const entry: RunEntry = {
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
          if (!disposed) publish({ error: message(error) });
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

// The latest completed native turn hosts the live projection; older messages stay intact.
export function latestRunTurn(timeline: ConversationTimelineSnapshot | undefined, createdAt?: string) {
  const started = Date.parse(createdAt ?? '');
  if (!Number.isFinite(started)) return undefined;
  return timeline?.turnOrder.findLast(number => {
    const turn = timeline.turns.get(number);
    return turn?.status === 'closed' && typeof turn.end?.time === 'number' && turn.end.time >= started;
  });
}

export function ownsRun(turn: TurnLocation | undefined, run: Run | null | undefined, latestTurn: number | undefined) {
  const started = Date.parse(run?.createdAt ?? '');
  return Number.isFinite(started) && turn?.status === 'closed'
    && typeof turn.end?.time === 'number' && turn.end.time >= started
    && latestTurn !== undefined && turn.turn === latestTurn;
}

export function collapseAdoptedPanel(sidebar: Context['sidebarRight'], sessionId: SessionId, tabId: string) {
  if (sidebar.mounted.getSnapshot() === sessionId && sidebar.active()?.id === tabId && sidebar.isExpanded()) sidebar.toggleExpanded();
}
