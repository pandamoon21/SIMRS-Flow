/**
 * Run-wide log stream and node-status summary from the shared projection.
 *
 * The log is what the operator actually watches while a run executes, so three
 * things matter more than anything else here:
 *  - the aligned `label : value` blocks the executors emit must stay aligned,
 *    which means nothing may be prepended to a message line;
 *  - it must be obvious which step each block came from, hence the per-step
 *    header carrying the timestamp, the step name and its status;
 *  - scrolling up to read something must not be yanked back down by the next
 *    event. Auto-follow therefore only applies while the view is already at the
 *    bottom, and a "Jump to latest" pill appears once it is not.
 */

import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { useRunStore } from '../../store/runStore.js';
import { classifyLogLine, groupLogs, logTime, statusCounts } from './logView.js';
import { durationLabel as formatDuration, RUN_STATUS_LABEL, runOutcomeOf } from '../run/runStatus.js';
import { Badge, Button, Card, CardBody, CardHeader, FormCheck } from '../../ui/primitives.js';

export interface RunConsoleProps {
  onHide?: () => void;
}

/** Distance from the bottom, in px, still treated as "following the tail". */
const FOLLOW_THRESHOLD_PX = 48;

export function RunConsole({ onHide }: RunConsoleProps) {
  const [debugMode, setDebugMode] = useState(false);
  const [problemsOnly, setProblemsOnly] = useState(false);
  const [following, setFollowing] = useState(true);
  const state = useRunStore((store) => store.state);
  const definition = useRunStore((store) => store.definition);
  const consoleClearedThroughSeq = useRunStore((store) => store.consoleClearedThroughSeq);
  const clearConsole = useRunStore((store) => store.clearConsole);
  const logBoxRef = useRef<HTMLDivElement>(null);

  const logs = state?.logs ?? [];
  const visibleLogs = useMemo(
    () =>
      logs.filter(
        (log) =>
          log.seq > consoleClearedThroughSeq &&
          (debugMode || log.severity !== 'debug') &&
          (!problemsOnly || log.severity === 'warn' || log.severity === 'error'),
      ),
    [consoleClearedThroughSeq, debugMode, problemsOnly, logs],
  );
  const groups = useMemo(() => groupLogs(visibleLogs, definition, state?.nodes), [definition, state?.nodes, visibleLogs]);
  const counts = statusCounts(state?.nodes);
  const outcome = runOutcomeOf(state);
  const progress = { done: outcome.done, total: outcome.total };
  const problemCount = outcome.problems;
  const totalMs = outcome.durationMs;
  const durationLabel = formatDuration(totalMs);

  const scrollToLatest = useCallback(() => {
    const logBox = logBoxRef.current;
    if (!logBox) return;
    logBox.scrollTop = logBox.scrollHeight;
    setFollowing(true);
  }, []);

  const onScroll = useCallback(() => {
    const logBox = logBoxRef.current;
    if (!logBox) return;
    const distance = logBox.scrollHeight - logBox.scrollTop - logBox.clientHeight;
    setFollowing(distance <= FOLLOW_THRESHOLD_PX);
  }, []);

  useEffect(() => {
    if (!following) return;
    const logBox = logBoxRef.current;
    if (logBox) logBox.scrollTop = logBox.scrollHeight;
  }, [following, state?.status, visibleLogs.length]);

  return (
    <Card className="panel-card run-console-panel">
      <CardHeader className="card-header-actions">
        <span className="console-title">
          Run console
          {state ? <span className="console-title-status" data-status={state.status}>{RUN_STATUS_LABEL[state.status]}</span> : null}
        </span>
        <div className="panel-actions">
          <Button color="secondary" variant="outline" size="sm" onClick={clearConsole} disabled={visibleLogs.length === 0}>
            Clear log
          </Button>
          <FormCheck
            id="console-problems"
            label="Problems only"
            title="Hanya peringatan dan error"
            checked={problemsOnly}
            onChange={(c) => setProblemsOnly(c)}
          />
          <FormCheck
            id="console-debug"
            label="Debug"
            title="Tampilkan juga baris debug: no reg, no trx, sumber SEP, preflight gizi"
            checked={debugMode}
            onChange={(c) => setDebugMode(c)}
          />
          {onHide ? (
            <button type="button" className="panel-close" aria-label="Tutup console" title="Tutup console" onClick={onHide}>×</button>
          ) : null}
        </div>
      </CardHeader>
      <CardBody className="console-body">
        <div className="console-summary">
          {progress.total > 0 ? (
            <span className="console-progress" title="Langkah yang sudah selesai">
              <strong>{progress.done}</strong>/{progress.total} steps
            </span>
          ) : null}
          {totalMs > 0 ? (
            <span className="console-duration" title="Total waktu langkah">◷ {durationLabel}</span>
          ) : null}
          {counts.map(({ status, count }) => (
            <span className="console-stat" data-status={status} key={status}>
              {status.replace('_', ' ')}
              <b>{count}</b>
            </span>
          ))}
          {problemCount > 0 ? (
            <Badge color="warning" className="console-problem-badge">
              {problemCount} to review
            </Badge>
          ) : null}
        </div>
        <div className="run-log-shell">
          <div className="log-box run-log-box" ref={logBoxRef} onScroll={onScroll} aria-live="polite" aria-label="Run log">
            {groups.length === 0 ? (
              <div className="empty">
                {problemsOnly && logs.length > 0
                  ? 'Belum ada peringatan atau error.'
                  : 'No logs yet. Start a run or wait for the next event.'}
              </div>
            ) : (
              groups.map((group) => (
                <section className="log-group" data-severity={group.severity} key={group.key}>
                  <header className="log-group-head">
                    <time className="log-group-time">{group.time}</time>
                    <span className="log-group-name">{group.label}</span>
                    {group.section ? <span className="log-group-section">{group.section}</span> : null}
                    {group.status ? (
                      <span className="log-group-status" data-status={group.status}>
                        {group.status.replace('_', ' ')}
                      </span>
                    ) : null}
                  </header>
                  {group.entries.map((entry) => (
                    <div
                      className="log-line"
                      data-shape={classifyLogLine(entry.message)}
                      data-severity={entry.severity}
                      title={`${logTime(entry.ts)} · ${entry.severity}`}
                      key={entry.seq}
                    >
                      {entry.severity === 'warn' || entry.severity === 'error' ? (
                        <span className="visually-hidden">{entry.severity}: </span>
                      ) : null}
                      {entry.message}
                    </div>
                  ))}
                </section>
              ))
            )}
          </div>
          {!following && groups.length > 0 ? (
            <Button className="log-follow-pill" color="info" size="sm" onClick={scrollToLatest}>
              Jump to latest
            </Button>
          ) : null}
        </div>
      </CardBody>
    </Card>
  );
}
