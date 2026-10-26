import { useEffect, useLayoutEffect, useRef, useState, type CSSProperties, type KeyboardEvent, type PointerEvent as ReactPointerEvent } from 'react';
import { ReactFlowProvider } from 'reactflow';
import type { ExecutionMode, RunState, WorkflowDefinition } from '@simrs-flow/workflow-core';
import { RunInputForm, type RunInputResult } from '../forms/RunInputForm.js';
import { RunSpinner, RunTrack, glyphStateOf, trackProgressOf, variantOf } from './RunStatusGlyph.js';
import { WorkflowCanvas } from '../canvas/WorkflowCanvas.js';
import { NodeInspector } from '../panels/NodeInspector.js';
import { RunConsole } from '../panels/RunConsole.js';
import { berkasProgressOf, cancelButtonLabel, currentNodeOf, attentionOf, PREVIEW_GATE_LABEL, previewGateStopOf, RUN_STATUS_LABEL, TERMINAL_RUN_STATUSES } from './runStatus.js';
import { RunSummary } from './RunSummary.js';
import { RunLogView } from './RunLogView.js';
import { useRunStore } from '../../store/runStore.js';
import { toast } from '../../ui/toast.js';
import { motionMs } from '../../ui/motion.js';
import { pageZoom } from '../../ui/fitZoom.js';
import { RESIZE_CURSOR, RESIZE_DIRS, resizeRectWithin, type ResizeDir } from './panelResize.js';
import { clampSummaryRect, placeSummary, summaryBottomReserve, summaryResizeBounds, SUMMARY_MIN_SIZE, type SummaryRect } from './summaryPlacement.js';
import type { Source } from '../../app/App.js';
import type { PlaybackMode } from '../../store/runStore.js';
import { Alert, Badge, Button, ButtonGroup, FormCheck } from '../../ui/primitives.js';
import { clampPanelLayout, defaultPanelLayout, PANEL_LAYOUT_KEY, PANEL_MIN, parsePanelLayout, type PanelLayout, type PanelName, type PanelViewport } from './panelLayout.js';

const viewportOf = (element: HTMLElement | null, bar?: HTMLElement | null): PanelViewport => ({
  width: element?.clientWidth ?? 800, height: element?.clientHeight ?? 600,
  // Flush with the command bar, like the other three edges are flush with the canvas.
  top: element && bar ? Math.max(0, Math.ceil((bar.getBoundingClientRect().bottom - element.getBoundingClientRect().top) / pageZoom())) : 0,
});

/**
 * Eight resize handles for one floating panel: four edges and four corners.
 * Only the bottom-right handle is tabbable — eight tab stops per panel would
 * swamp the keyboard path through the run page; the other seven are pointer-only.
 * `nodrag nopan` keeps a handle drag from panning the React Flow canvas, exactly
 * like the header drag strips.
 */
function PanelGrip({ label, onResize }: { label: string; onResize: (dir: ResizeDir, dx: number, dy: number) => void }) {
  const start = (event: ReactPointerEvent<HTMLButtonElement>) => {
    event.stopPropagation();
    event.preventDefault();
    event.currentTarget.setPointerCapture(event.pointerId);
    event.currentTarget.dataset.lastX = String(event.clientX);
    event.currentTarget.dataset.lastY = String(event.clientY);
  };
  return (
    <>
      {RESIZE_DIRS.map((dir) => (
        <button
          key={dir}
          type="button"
          className={`run-panel-grip run-panel-grip-${dir} nodrag nopan`}
          data-dir={dir}
          tabIndex={dir === 'se' ? 0 : -1}
          style={{ cursor: RESIZE_CURSOR[dir] }}
          aria-label={`Resize ${label} from ${dir}; arrow keys resize`}
          title={`Resize ${label} (${dir})`}
          onPointerDown={start}
          onPointerMove={(event) => {
            if (!event.currentTarget.hasPointerCapture(event.pointerId)) return;
            // Pointer deltas are CSS px; divide by the root fit-zoom so the panel
            // tracks the cursor 1:1 on a scaled (<1920px) screen.
            const zoom = pageZoom();
            const dx = (event.clientX - Number(event.currentTarget.dataset.lastX)) / zoom;
            const dy = (event.clientY - Number(event.currentTarget.dataset.lastY)) / zoom;
            onResize(dir, dx, dy);
            event.currentTarget.dataset.lastX = String(event.clientX);
            event.currentTarget.dataset.lastY = String(event.clientY);
          }}
          onKeyDown={(event) => {
            const arrows: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
            const delta = arrows[event.key];
            if (delta) { event.preventDefault(); onResize(dir, ...delta); }
          }}
        />
      ))}
    </>
  );
}

const LOCKED_TITLE = 'Hentikan atau selesaikan run ini dulu';
const SUMMARY_RECT_KEY = 'simrs-flow.run.summary-rect.v2';
const ZOOM_KEY = 'simrs-flow.run.panel-zoom.v1';
const SUMMARY_KEY = 'simrs-flow.run.summary.v1';
/** Kanvas or Log: the setup default and the command-bar toggle share one value per browser. */
const VIEW_KEY = 'simrs-flow.run.view.v1';
export type RunView = 'canvas' | 'log';
const ZOOM_STEPS = [0.85, 0.92, 1, 1.1, 1.2, 1.35] as const;

function readJson<T>(key: string, fallback: T): T {
  try {
    const raw = localStorage.getItem(key);
    if (!raw) return fallback;
    const parsed: unknown = JSON.parse(raw);
    // Objects merge over the fallback so a newly added panel still gets a default.
    if (typeof fallback === 'object' && fallback !== null) return { ...fallback, ...(parsed as object) } as T;
    return typeof parsed === typeof fallback ? (parsed as T) : fallback;
  } catch { return fallback; }
}
function writeJson(key: string, value: unknown): void {
  try { localStorage.setItem(key, JSON.stringify(value)); } catch { /* Storage may be disabled. */ }
}

/** A− / A+ for one panel's text; the panel window keeps its size. */
function FontScale({ name, label, value, onChange }: { name: PanelName; label: string; value: number; onChange: (name: PanelName, value: number) => void }) {
  const index = Math.max(0, ZOOM_STEPS.findIndex((step) => step >= value - 0.001));
  const step = (delta: number) => onChange(name, ZOOM_STEPS[Math.min(ZOOM_STEPS.length - 1, Math.max(0, index + delta))]!);
  return (
    <span className="font-scale" role="group" aria-label={`Ukuran teks ${label}`} onPointerDown={(event) => event.stopPropagation()}>
      <button type="button" aria-label={`Perkecil teks ${label}`} disabled={index === 0} onClick={() => step(-1)}>A−</button>
      <button type="button" className="font-scale-value" title="Kembalikan ke 100%" onClick={() => onChange(name, 1)}>{Math.round(value * 100)}%</button>
      <button type="button" aria-label={`Perbesar teks ${label}`} disabled={index === ZOOM_STEPS.length - 1} onClick={() => step(1)}>A+</button>
    </span>
  );
}
const RUN_STATUS_TONE = { completed: 'success', failed: 'danger', running: 'info', paused: 'warning', cancelled: 'warning', created: 'secondary' } as const;

/** Run configuration and live canvas share a surface with independently movable panels. */
export interface RunPageProps {
  // config
  workflows: readonly WorkflowDefinition[];
  workflowId: string;
  mode: ExecutionMode;
  source: Source;
  runInput: RunInputResult;
  startBlocker?: string;
  onWorkflowChange: (workflowId: string) => void;
  onModeChange: (mode: ExecutionMode) => void;
  onSourceChange: (source: Source) => void;
  onInputChange: (result: RunInputResult) => void;
  onStart: () => void;
  /** Write-mode only: skip the human gate/plan confirmation for this run. */
  autoApprove: boolean;
  onAutoApproveChange: (value: boolean) => void;
  // live
  hasRunContext: boolean;
  runId?: string;
  /** Changes on every Start, even when a fixture replay keeps its run id. */
  runNonce?: number;
  state?: RunState;
  liveError?: string;
  historical: boolean;
  playback: PlaybackMode;
  cursor: number;
  eventCount: number;
  /** Start pressed and the run id has not come back yet. */
  starting?: boolean;
  onOpenHistory: () => void;
  onDismissError: () => void;
  onCancel: () => void;
  /** Pause before the next step / continue a paused run (a fixture replay pauses its timer). */
  onPause: () => void;
  onResume: () => void;
  onApproveGate: (nodeId: string) => void | Promise<void>;
  onRejectGate: (nodeId: string) => void | Promise<void>;
  onApproveMutation: (planId: string) => void | Promise<void>;
  onSeek: (cursor: number) => void;
  replayPlaying: boolean;
  onPlayReplay: () => void;
  onPauseReplay: () => void;
}

export function RunPage(props: RunPageProps) {
  const {
    workflows, workflowId, mode, source, runInput, startBlocker,
    onWorkflowChange, onModeChange, onSourceChange, onInputChange, onStart,
    autoApprove, onAutoApproveChange,
    hasRunContext, runId, runNonce = 0, state, liveError, historical,
    playback, cursor, eventCount,
    onCancel, onPause, onResume, onApproveGate, onRejectGate, onApproveMutation, onSeek,
    replayPlaying, onPlayReplay, onPauseReplay,
    starting = false, onOpenHistory, onDismissError,
  } = props;
  const selectNode = useRunStore((store) => store.selectNode);

  const workflow = workflows.find((item) => item.id === workflowId) ?? workflows[0]!;
  const domain = workflow.domain === 'rajal' ? 'rajal' : 'ranap';

  const surface = useRef<HTMLDivElement>(null);
  const commandBar = useRef<HTMLDivElement>(null);
  const inspectorRef = useRef<HTMLElement>(null);
  const dragCleanup = useRef<(() => void) | null>(null);
  const persistLayout = useRef(false);
  useEffect(() => () => dragCleanup.current?.(), []);
  const [inspectorAutoOpen, setInspectorAutoOpen] = useState(false);
  // Per-panel text size, independent of the panel's window size; kept per browser.
  const [zoom, setZoom] = useState<Record<PanelName, number>>(() => readJson(ZOOM_KEY, { setup: 1, inspector: 1, console: 1 }));
  const setZoomOf = (name: PanelName, value: number) => setZoom((previous) => {
    const next = { ...previous, [name]: value };
    writeJson(ZOOM_KEY, next);
    return next;
  });
  const [summaryEnabled, setSummaryEnabled] = useState<boolean>(() => readJson(SUMMARY_KEY, true));
  // The summary is absolutely positioned inside `.canvas-wrap`, so its rect is
  // kept in that box's own CSS px — not the panel viewport (which adds the
  // command-bar offset a second time and pushed the bottom handles off screen).
  const canvasWrap = useRef<HTMLDivElement>(null);
  const summaryRef = useRef<HTMLElement>(null);
  const [summaryRect, setSummaryRect] = useState<SummaryRect | undefined>(() => readJson<SummaryRect | undefined>(SUMMARY_RECT_KEY, undefined));
  const [canvasBox, setCanvasBox] = useState<{ width: number; height: number }>({ width: 0, height: 0 });
  const [contentHeight, setContentHeight] = useState(0);
  // Measured height of the replay bar; the summary must never cover it.
  const [replayBarHeight, setReplayBarHeight] = useState<number | undefined>(undefined);
  const setSummary = (next: SummaryRect) => { writeJson(SUMMARY_RECT_KEY, next); setSummaryRect(next); };
  // The first drag starts from the DERIVED default box: it is placed on render but
  // only becomes `summaryRect` once the operator resizes it.
  const resizeSummary = (dir: ResizeDir, dx: number, dy: number) => {
    const el = canvasWrap.current;
    if (!el) return;
    const box = { width: el.clientWidth, height: el.clientHeight };
    const reserve = summaryBottomReserve(replayBarHeight);
    const base = summaryRect ?? (canvasBox.width ? placeSummary(box, contentHeight, SUMMARY_MIN_SIZE, reserve) : undefined);
    if (!base) return;
    const grown = resizeRectWithin(base, dir, dx, dy, SUMMARY_MIN_SIZE, summaryResizeBounds(box, reserve));
    setSummary(clampSummaryRect(grown, box, SUMMARY_MIN_SIZE, reserve));
  };
  const resetSummary = () => { writeJson(SUMMARY_RECT_KEY, undefined); setSummaryRect(undefined); };
  const toggleSummary = () => setSummaryEnabled((previous) => { writeJson(SUMMARY_KEY, !previous); return !previous; });
  const [view, setViewState] = useState<RunView>(() => (readJson<string>(VIEW_KEY, 'canvas') === 'log' ? 'log' : 'canvas'));
  const setView = (next: RunView) => { writeJson(VIEW_KEY, next); setViewState(next); };
  const viewToggle = (className: string) => (
    <div className={className} role="group" aria-label="Tampilan hasil">
      <button type="button" className={`run-toggle${view === 'canvas' ? ' is-on' : ''}`} aria-pressed={view === 'canvas'} title="Hasil sebagai kanvas node" onClick={() => setView('canvas')}>Kanvas</button>
      <button type="button" className={`run-toggle${view === 'log' ? ' is-on' : ''}`} aria-pressed={view === 'log'} title="Hasil sebagai log terminal, atas ke bawah" onClick={() => setView('log')}>Log</button>
    </div>
  );
  // "Run baru": the finished graph stays on the canvas until the next Start; this only brings Setup forward.
  const bringSetupForward = () => { if (!layout.panels.setup.open) toggle('setup'); else raise('setup'); };
  const [layout, setLayout] = useState<PanelLayout>(() => {
    const zoom = pageZoom();
    const viewport = { width: typeof window === 'undefined' ? 800 : window.innerWidth / zoom, height: typeof window === 'undefined' ? 600 : window.innerHeight / zoom - 120 };
    // Before any run, Setup always opens (saved position and size kept) so the first run starts from it.
    // With a run on screen the operator's own choice stands: returning from another page must not reopen it.
    try {
      const saved = parsePanelLayout(localStorage.getItem(PANEL_LAYOUT_KEY), viewport);
      if (!saved) return defaultPanelLayout(viewport);
      return hasRunContext ? saved : { ...saved, panels: { ...saved.panels, setup: { ...saved.panels.setup, open: true } } };
    }
    catch { return defaultPanelLayout(viewport); }
  });
  useEffect(() => {
    if (!persistLayout.current) return;
    persistLayout.current = false;
    try { localStorage.setItem(PANEL_LAYOUT_KEY, JSON.stringify(layout)); } catch { /* Storage may be disabled. */ }
  }, [layout]);
  useLayoutEffect(() => {
    const element = surface.current;
    const bar = commandBar.current;
    if (!element || !bar) return;
    const measure = () => {
      const viewport = viewportOf(element, bar);
      setLayout((previous) => {
        const next = clampPanelLayout(previous, viewport);
        return JSON.stringify(next.panels) === JSON.stringify(previous.panels) ? previous : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(element);
    observer.observe(bar);
    return () => observer.disconnect();
  }, []);
  const updatePanel = (name: PanelName, change: Partial<PanelLayout['panels'][PanelName]>) => {
    persistLayout.current = true;
    setLayout((previous) => clampPanelLayout({ ...previous, panels: { ...previous.panels, [name]: { ...previous.panels[name], ...change, open: name === 'inspector' && inspectorAutoOpen ? true : previous.panels[name].open } } }, viewportOf(surface.current, commandBar.current)));
    if (name === 'inspector') setInspectorAutoOpen(false);
  };
  const raise = (name: PanelName) => setLayout((previous) => previous.order.at(-1) === name ? previous : { ...previous, order: [...previous.order.filter((item) => item !== name), name] });
  const toggle = (name: PanelName) => {
    persistLayout.current = true;
    setLayout((previous) => clampPanelLayout({ ...previous,
      panels: { ...previous.panels, [name]: { ...previous.panels[name], open: !(previous.panels[name].open || (name === 'inspector' && inspectorAutoOpen)) } },
      order: [...previous.order.filter((item) => item !== name), name],
    }, viewportOf(surface.current, commandBar.current)));
    if (name === 'inspector') setInspectorAutoOpen(false);
  };
  // ponytail: selection only affects this session; explicit panel actions remain the persistence boundary.
  const openInspector = () => {
    if (!layout.panels.inspector.open) setInspectorAutoOpen(true);
    // Stacked (≤900px) layout puts the inspector below the graph; bring it into view.
    requestAnimationFrame(() => { if (window.matchMedia('(max-width: 900px)').matches) inspectorRef.current?.scrollIntoView({ block: 'start', behavior: motionMs(1) ? 'smooth' : 'auto' }); });
  };
  // The summary's containing block is `.canvas-wrap`; measure that box itself and
  // re-clamp a saved rect whenever the canvas changes (window resize, log view).
  useEffect(() => {
    const el = canvasWrap.current;
    if (!el) return;
    const measure = () => {
      const box = { width: el.clientWidth, height: el.clientHeight };
      const bar = el.querySelector('.replay-bar');
      const barH = bar ? bar.getBoundingClientRect().height / pageZoom() : undefined;
      setReplayBarHeight((previous) => (previous !== undefined && barH !== undefined && Math.abs(previous - barH) < 0.5 ? previous : barH));
      setCanvasBox((previous) => (previous.width === box.width && previous.height === box.height ? previous : box));
      setSummaryRect((previous) => {
        if (!previous) return previous;
        const next = clampSummaryRect(previous, box);
        return JSON.stringify(next) === JSON.stringify(previous) ? previous : next;
      });
    };
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [hasRunContext, view, summaryEnabled]);
  // Content height feeds the default box (bottom-centre, content-sized).
  useEffect(() => {
    const el = summaryRef.current;
    if (!el) return;
    const measure = () => setContentHeight((previous) => (Math.abs(previous - el.offsetHeight) < 1 ? previous : el.offsetHeight));
    measure();
    const observer = new ResizeObserver(measure);
    observer.observe(el);
    return () => observer.disconnect();
  }, [runId, state?.status, summaryEnabled]);
  const bottomReserve = summaryBottomReserve(replayBarHeight);
  const effectiveSummaryRect = summaryRect
    ? clampSummaryRect(summaryRect, canvasBox.width ? canvasBox : { width: 1, height: 1 }, SUMMARY_MIN_SIZE, bottomReserve)
    : placeSummary(canvasBox.width ? canvasBox : { width: 1, height: 1 }, contentHeight, SUMMARY_MIN_SIZE, bottomReserve);
  const summaryStyle: CSSProperties = {
    position: 'absolute',
    left: effectiveSummaryRect.x,
    top: effectiveSummaryRect.y,
    width: effectiveSummaryRect.width,
    height: effectiveSummaryRect.height,
    // Override the stylesheet's bottom-centre placement; with both `top` and
    // `bottom` set CSS stretches the box to the canvas edge.
    bottom: 'auto',
    transform: 'none',
    right: 'auto',
    maxWidth: '100%',
    maxHeight: '100%',
  };
  const resizePanel = (name: PanelName, dir: ResizeDir, dx: number, dy: number) => {
    persistLayout.current = true;
    const viewport = viewportOf(surface.current, commandBar.current);
    setLayout((previous) => {
      const panel = previous.panels[name];
      // West/north handles move the origin; the opposite edge stays where it is.
      // Bounds are the panel viewport itself, so a resize cannot push an edge
      // under the command bar or past the canvas.
      const next = resizeRectWithin(panel, dir, dx, dy, { width: PANEL_MIN.width, height: PANEL_MIN.height },
        { x: 0, y: viewport.top ?? 0, width: viewport.width, height: Math.max(1, viewport.height - (viewport.top ?? 0)) });
      return clampPanelLayout({ ...previous, panels: {
        ...previous.panels, [name]: { ...panel, ...next, open: name === 'inspector' && inspectorAutoOpen ? true : panel.open },
      } }, viewport);
    });
    if (name === 'inspector') setInspectorAutoOpen(false);
  };
  const dragHeader = (name: PanelName, event: ReactPointerEvent<HTMLElement>) => {
    if (event.button !== 0 || (event.target as HTMLElement).closest('button, input, select, a, label')) return;
    event.preventDefault();
    event.stopPropagation();
    dragCleanup.current?.();
    raise(name);
    const startX = event.clientX; const startY = event.clientY;
    const start = layout.panels[name];
    const pointerId = event.pointerId;
    const zoom = pageZoom();
    const move = (e: PointerEvent) => { if (e.pointerId === pointerId) updatePanel(name, { x: start.x + (e.clientX - startX) / zoom, y: start.y + (e.clientY - startY) / zoom }); };
    const end = (e: PointerEvent) => { if (e.pointerId === pointerId) cleanup(); };
    const cleanup = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', end);
      window.removeEventListener('pointercancel', end);
      dragCleanup.current = null;
    };
    dragCleanup.current = cleanup;
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', end);
    window.addEventListener('pointercancel', end);
  };
  const moveByKey = (name: PanelName, event: KeyboardEvent<HTMLElement>) => {
    const delta: Record<string, [number, number]> = { ArrowLeft: [-16, 0], ArrowRight: [16, 0], ArrowUp: [0, -16], ArrowDown: [0, 16] };
    const step = delta[event.key];
    if (step) {
      event.preventDefault();
      updatePanel(name, { x: layout.panels[name].x + step[0], y: layout.panels[name].y + step[1] });
    }
  };
  const panelStyle = (name: PanelName): CSSProperties => {
    const { x, y, width, height } = layout.panels[name];
    return { left: x, top: y, width, height, zIndex: 10 + layout.order.indexOf(name), '--panel-zoom': zoom[name] } as CSSProperties;
  };
  const inspectorOpen = layout.panels.inspector.open || inspectorAutoOpen;

  const [cancelArmed, setCancelArmed] = useState(false);
  // Cancel confirmed, run.cancelled not yet received.
  const [stopping, setStopping] = useState(false);
  useEffect(() => { setCancelArmed(false); setStopping(false); }, [runId]);

  // A run can be stopped only while it is genuinely in flight (not historical,
  // not already finished); the command bar holds the single stop control.
  const runStoppable =
    hasRunContext && Boolean(runId) && !historical && Boolean(state) &&
    // A freshly loaded definition is also "created"; only a run that has produced events is live.
    (['running', 'paused'].includes(state!.status) || (state!.status === 'created' && eventCount > 0));
  useEffect(() => { if (!runStoppable) { setCancelArmed(false); setStopping(false); } }, [runStoppable]);
  // An armed Stop falls back to "Stop run" after 4s, so no extra "keep running"
  // button appears beside it and shifts the controls the operator is aiming at.
  useEffect(() => {
    if (!cancelArmed) return;
    const timer = window.setTimeout(() => setCancelArmed(false), 4000);
    return () => window.clearTimeout(timer);
  }, [cancelArmed]);
  const pressStop = () => {
    if (!runStoppable || stopping) return;
    if (!cancelArmed) return setCancelArmed(true);
    setCancelArmed(false);
    setStopping(true);
    onCancel();
  };
  const stopButton = (size: 'sm' | 'lg', className = '') => (
    <Button className={`run-cancel-btn ${className}`} color="danger" variant={cancelArmed || stopping ? undefined : 'outline'} size={size} disabled={!runStoppable || stopping}
      title={historical ? 'Historical replays cannot be cancelled' : runStoppable ? 'Hentikan run ini — tidak bisa dilanjutkan. Klik dua kali untuk konfirmasi.' : 'Run sudah selesai'}
      aria-live="polite" onBlur={() => setCancelArmed(false)} onKeyDown={(event) => { if (event.key === 'Escape') setCancelArmed(false); }}
      onClick={pressStop}>
      {stopping ? 'Menghentikan…' : cancelButtonLabel(cancelArmed)}
    </Button>
  );

  // A fixture replay never reaches 'paused' in state; its timer is the pause.
  const runPaused = runId?.startsWith('offline-') ? !replayPlaying : state?.status === 'paused';
  const pauseButton = (size: 'sm' | 'lg') => (
    <Button color="secondary" variant={runPaused ? undefined : 'outline'} size={size} type="button" disabled={!runStoppable || stopping}
      title={runPaused ? 'Lanjutkan dari step berikutnya' : 'Jeda sebelum step berikutnya — step yang sedang berjalan diselesaikan dulu; bisa dilanjutkan'}
      onClick={runPaused ? onResume : onPause}>
      {runPaused ? 'Lanjutkan' : 'Jeda'}
    </Button>
  );

  const actualStatus = state?.status;
  const currentNode = currentNodeOf(state);
  const labelOf = (id: string) => workflow.nodes.find((node) => node.id === id)?.label ?? id;
  const focusNode = (id: string) => { selectNode(id); openInspector(); };

  // A waiting gate or a failure must reach the operator even with the inspector
  // closed: select the node, open the inspector, and say so once per node.
  const announced = useRef<string>();
  const attentionNodeId = currentNode && (currentNode.status === 'gate_waiting' || ((currentNode.status === 'failed' || currentNode.status === 'blocked') && actualStatus === 'failed'))
    ? currentNode.id : undefined;
  useEffect(() => {
    if (!attentionNodeId || historical || announced.current === `${runId}:${attentionNodeId}`) return;
    announced.current = `${runId}:${attentionNodeId}`;
    focusNode(attentionNodeId);
    // Preview holds every gate itself; nobody is being asked to approve anything.
    if (currentNode?.status === 'gate_waiting' && mode !== 'preview') toast('warning', `Gate menunggu persetujuan · ${labelOf(attentionNodeId)}`);
    // focusNode/labelOf are stable in effect: keyed by run + node id only.
  }, [attentionNodeId, historical, runId]);
  const terminal = Boolean(actualStatus && TERMINAL_RUN_STATUSES.includes(actualStatus));
  // A new spinner and traveller per run: re-rolled on every Start and on a run opened from History.
  const [variantSeed, setVariantSeed] = useState(() => Math.random());
  useEffect(() => setVariantSeed(Math.random()), [runId, runNonce]);
  const variant = variantOf(variantSeed);
  const previewHeld = Boolean(previewGateStopOf(state));
  const glyph = previewHeld ? 'done' : glyphStateOf(runId, state?.status);
  // Changing workflow/source/mode mid-run would silently reset the live graph.
  const setupLocked = runStoppable || starting;
  // A finished run is still on the canvas; switching workflow or mode reloads a
  // pristine definition and drops it, so ask once instead of making it vanish.
  const [pendingSwitch, setPendingSwitch] = useState<{ kind: 'workflow'; value: string } | { kind: 'mode'; value: ExecutionMode }>();
  useEffect(() => setPendingSwitch(undefined), [runId]);
  const keepsFinishedRun = hasRunContext && Boolean(runId) && !setupLocked;
  const requestWorkflow = (id: string) => {
    if (id === workflowId) return;
    if (keepsFinishedRun) setPendingSwitch({ kind: 'workflow', value: id });
    else onWorkflowChange(id);
  };
  const requestMode = (next: ExecutionMode) => {
    if (next === mode) return;
    if (keepsFinishedRun) setPendingSwitch({ kind: 'mode', value: next });
    else onModeChange(next);
  };
  const confirmSwitch = () => {
    if (!pendingSwitch) return;
    if (pendingSwitch.kind === 'workflow') onWorkflowChange(pendingSwitch.value);
    else onModeChange(pendingSwitch.value);
    setPendingSwitch(undefined);
  };
  const switchTarget = pendingSwitch?.kind === 'workflow'
    ? workflows.find((item) => item.id === pendingSwitch.value)?.label ?? pendingSwitch.value
    : pendingSwitch?.value === 'write' ? 'Confirmed write' : 'Preview';
  const switchConfirm = (kind: 'workflow' | 'mode') => pendingSwitch?.kind === kind ? (
    <div className="switch-confirm" role="alertdialog" aria-label="Konfirmasi ganti" aria-live="assertive">
      <p>
        <strong>Ganti ke {switchTarget}?</strong>
        Hasil run <span className="mono">{runId}</span> akan ditutup dari kanvas{view === 'canvas' ? ' & console' : ''}.
        {runId?.startsWith('offline-') ? ' Replay fixture tidak disimpan.' : ' Run tetap tersimpan dan bisa dibuka lagi dari History.'}
      </p>
      <div className="switch-confirm-actions">
        <Button color="warning" size="sm" type="button" onClick={confirmSwitch} autoFocus>Ya, ganti</Button>
        <Button color="secondary" variant="outline" size="sm" type="button" onClick={() => setPendingSwitch(undefined)}>Batal</Button>
      </div>
    </div>
  ) : null;
  const berkasProgress = berkasProgressOf(state);
  const attention = attentionOf(state, (id) => workflow.nodes.find((node) => node.id === id)?.label ?? id);
  const provenanceLabel = historical ? 'Historical ledger replay' : playback === 'replay' ? 'Fixture replay' : 'In-memory run detail';

  return (
    <div className="run-split" ref={surface}>
      {/* ── Setup panel ─────────────────────────────────────────────── */}
      <aside className="run-setup-rail run-floating-panel" aria-label="Run setup" hidden={!layout.panels.setup.open} style={panelStyle('setup')} onPointerDown={() => raise('setup')}>
        <div className="run-setup-head run-drag-header nodrag nopan" role="button" tabIndex={0} aria-label="Move setup panel; arrow keys move" onPointerDown={(event) => dragHeader('setup', event)} onKeyDown={(event) => moveByKey('setup', event)}>
          <span className="page-eyebrow">Configure</span>
          <h1>Run setup</h1>
          <FontScale name="setup" label="Run setup" value={zoom.setup} onChange={setZoomOf} />
          <button type="button" className="run-panel-close" aria-label="Tutup run setup" onClick={() => toggle('setup')}>×</button>
        </div>
        <div className="run-setup-scroll">
        <div className="run-setup-body">
          <div className="control-cluster">
            <span className="control-label">Workflow</span>
            <ButtonGroup role="group" aria-label="Workflow">
              {workflows.map((item) => (
                <Button color={workflowId === item.id ? 'info' : 'secondary'} variant={workflowId === item.id ? undefined : 'outline'} key={item.id} type="button" aria-pressed={workflowId === item.id} disabled={setupLocked} title={setupLocked ? LOCKED_TITLE : undefined} onClick={() => requestWorkflow(item.id)}>
                  {item.label}
                </Button>
              ))}
            </ButtonGroup>
            {switchConfirm('workflow')}
          </div>
          <div className="control-cluster">
            <span className="control-label">Data source</span>
            <ButtonGroup role="group" aria-label="Run source">
              <Button color={source === 'offline' ? 'info' : 'secondary'} variant={source === 'offline' ? undefined : 'outline'} aria-pressed={source === 'offline'} title="Replay canned fixture data — never touches SIMRS" disabled={setupLocked} onClick={() => onSourceChange('offline')}>Fixture replay</Button>
              <Button color={source === 'live' ? 'info' : 'secondary'} variant={source === 'live' ? undefined : 'outline'} aria-pressed={source === 'live'} title="Read from the live SIMRS instance with your operator session" disabled={setupLocked} onClick={() => onSourceChange('live')}>Live SIMRS</Button>
            </ButtonGroup>
          </div>
          <RunInputForm domain={domain} source={source} onInputChange={onInputChange} viewingRunId={runId} />
          <div className="control-cluster">
            <span className="control-label">Tampilan hasil</span>
            {/* Not locked by a running run: switching view never touches the run. */}
            <ButtonGroup role="group" aria-label="Tampilan hasil default">
              <Button color={view === 'canvas' ? 'info' : 'secondary'} variant={view === 'canvas' ? undefined : 'outline'} aria-pressed={view === 'canvas'} title="Hasil sebagai kanvas node" onClick={() => setView('canvas')}>Kanvas</Button>
              <Button color={view === 'log' ? 'info' : 'secondary'} variant={view === 'log' ? undefined : 'outline'} aria-pressed={view === 'log'} title="Hasil sebagai log terminal" onClick={() => setView('log')}>Log</Button>
            </ButtonGroup>
          </div>
          <div className="control-cluster">
            <span className="control-label">Execution mode</span>
            <ButtonGroup role="group" aria-label="Execution mode">
              <Button color={mode === 'preview' ? 'info' : 'secondary'} variant={mode === 'preview' ? undefined : 'outline'} aria-pressed={mode === 'preview'} title="Dry run — mutations are surfaced as plans, nothing is written" disabled={setupLocked} onClick={() => requestMode('preview')}>Preview</Button>
              <Button color={mode === 'write' ? 'write' : 'secondary'} variant={mode === 'write' ? undefined : 'outline'} aria-pressed={mode === 'write'} title="Writes require an allowlist, per-call approval, and verification" disabled={setupLocked} onClick={() => requestMode('write')}>Confirmed write</Button>
            </ButtonGroup>
            {switchConfirm('mode')}
          </div>
        </div>
        <div className="run-setup-confirm">
          <dl className="summary-list">
            <dt>Workflow</dt><dd>{workflow.label}</dd>
            <dt>Source</dt><dd>{source === 'live' ? 'Live SIMRS' : 'Fixture replay'}</dd>
            <dt>Mode</dt><dd>{mode}</dd>
            <dt>Input</dt><dd>{runInput.error ?? runInput.summary}</dd>
          </dl>
          {mode === 'write' ? <Alert color="warning" className="mb-0">Write mode still requires allowlists, approvals, locks, and verification.</Alert> : null}
          {/* Verifikasi off also drops the final gate, the only hold point: the run would end before any correction plan could be approved. */}
          {mode === 'write' && runInput.enabled?.final_gate === false ? (
            <Alert color="danger" className="mb-0">
              Verifikasi mati: run write ini akan selesai tanpa jeda, jadi rencana koreksi <strong>tidak bisa disetujui</strong>. Untuk menerapkan koreksi saja, nyalakan Verifikasi, setujui rencana koreksi saat Gerbang Akhir menunggu, lalu <strong>tolak</strong> Gerbang Akhir.
            </Alert>
          ) : null}
          {mode === 'write' ? (
            <div className="toggle-group write-auto-approve" role="group" aria-label="Auto approve write run">
              <FormCheck
                id="run-auto-approve"
                label="Auto-approve gate & mutasi"
                title="Lewati konfirmasi manusia: gate dan rencana mutasi disetujui otomatis atas nama operator ini. Allowlist, precondition, verifikasi read-after-write, dan audit ledger tetap berlaku."
                checked={autoApprove}
                onChange={onAutoApproveChange}
              />
              {autoApprove ? (
                <Alert color="danger" className="mb-0">
                  Auto-approve aktif: gate dan mutasi critical akan dieksekusi tanpa konfirmasi manusia. Pastikan satu pasien/episode dan scope sudah benar.
                </Alert>
              ) : null}
            </div>
          ) : null}
          {startBlocker ? <div className="form-hint text-warning">Start blocked: {startBlocker}</div> : null}
          {runStoppable ? <div className="run-setup-stop-row">{pauseButton('lg')}{stopButton('lg', 'run-setup-stop')}</div> : (
            <Button color={mode === 'write' ? 'write' : 'info'} size="lg" type="button" disabled={Boolean(startBlocker) || setupLocked} title={setupLocked ? LOCKED_TITLE : undefined} onClick={onStart}>
              {starting ? 'Memulai…' : mode === 'write' ? 'Start confirmed write' : 'Start preview'}
            </Button>
          )}
        </div>
        </div>
        <PanelGrip label="run setup panel" onResize={(dir, dx, dy) => resizePanel('setup', dir, dx, dy)} />
      </aside>


      {/* ── Live workspace ────────────────────────────────────────── */}
      <section className="run-live">
        <div className="run-command-bar" ref={commandBar}>
          <div className="run-command-lead">
            <RunSpinner state={glyph} kind={variant.spinner} />
            <div className="run-command-title">
              <span className="page-eyebrow">{provenanceLabel}</span>
              <strong title={runId}>{runId ?? 'No run yet'}</strong>
              {/* Stage and attention change every few seconds; they live under the run id so
                  the controls on the right never move while the operator aims at Stop. */}
              {/* Always rendered (fixed height) so the bar never grows or shrinks under the cursor. */}
              <div className="run-command-meta" aria-live="polite">
                {currentNode && runStoppable ? <span className="run-meta-chip" data-tone={currentNode.status === 'running' ? 'info' : 'warning'}>Tahap: {labelOf(currentNode.id)}</span> : null}
                {berkasProgress ? (
                  <span className="run-meta-chip run-meta-progress" data-tone="info" title={`Kelengkapan berkas: ${berkasProgress.label}`}>
                    <span className="run-meta-label">Berkas: {berkasProgress.label}</span>
                    <span className="run-meta-bar" role="progressbar" aria-label="Progres cek berkas" aria-valuemin={0} aria-valuemax={100} {...(berkasProgress.percent !== undefined ? { 'aria-valuenow': berkasProgress.percent } : {})}>
                      <i style={berkasProgress.percent !== undefined ? { width: `${berkasProgress.percent}%` } : undefined} data-indeterminate={berkasProgress.percent === undefined ? '' : undefined} />
                    </span>
                  </span>
                ) : null}
                {attention ? <span className="run-meta-chip" data-tone="warning">{attention}</span> : null}
              </div>
            </div>
            <RunTrack state={glyph} progress={trackProgressOf(state)} traveller={variant.traveller} />
          </div>
          <div className="run-command-status">
            <Badge color={mode === 'write' ? 'write' : 'info'}>{mode}</Badge>
            <Badge className="run-status-badge" color={previewHeld ? 'success' : actualStatus ? RUN_STATUS_TONE[actualStatus] : 'secondary'}>{stopping ? 'Menghentikan…' : previewHeld ? PREVIEW_GATE_LABEL : actualStatus ? RUN_STATUS_LABEL[actualStatus] : 'Belum mulai'}</Badge>
            {hasRunContext ? viewToggle('run-view-toggle') : null}
            <div className="run-panel-toggles" role="group" aria-label="Panel visibility">
              <span className="run-toggles-label" aria-hidden="true">Panels</span>
              <button type="button" className={`run-toggle${layout.panels.setup.open ? ' is-on' : ''}`} aria-pressed={layout.panels.setup.open} title={layout.panels.setup.open ? 'Hide run setup' : 'Show run setup'} onClick={() => toggle('setup')}>Setup</button>
              {hasRunContext ? (
                <>
                  <button type="button" className={`run-toggle${inspectorOpen ? ' is-on' : ''}`} aria-pressed={inspectorOpen} title={inspectorOpen ? 'Hide inspector' : 'Show inspector'} onClick={() => toggle('inspector')}>Inspector</button>
                  {view === 'canvas' ? <button type="button" className={`run-toggle${layout.panels.console.open ? ' is-on' : ''}`} aria-pressed={layout.panels.console.open} title={layout.panels.console.open ? 'Hide console' : 'Show console'} onClick={() => toggle('console')}>Console</button> : null}
                  <button type="button" className={`run-toggle${summaryEnabled ? ' is-on' : ''}`} aria-pressed={summaryEnabled} title={summaryEnabled ? 'Jangan tampilkan ringkasan saat run selesai' : 'Tampilkan ringkasan saat run selesai'} onClick={toggleSummary}>Ringkasan</button>
                </>
              ) : null}
              <button type="button" className="run-toggle run-reset-toggle" title="Reset panel positions, sizes and visibility" onClick={() => { persistLayout.current = true; setInspectorAutoOpen(false); setLayout(defaultPanelLayout(viewportOf(surface.current, commandBar.current))); resetSummary(); }}>Reset tata letak</button>
            </div>
          </div>
          {hasRunContext ? <div className="run-command-stop">{runStoppable ? pauseButton('sm') : null}{stopButton('sm')}</div> : null}
        </div>
        {liveError ? (
          <Alert color="danger" className="run-error-alert">
            <span>{liveError}</span>
            <button type="button" className="run-error-close" aria-label="Tutup pesan error" onClick={onDismissError}>×</button>
          </Alert>
        ) : null}

        {hasRunContext ? (
          <div className="run-live-body">
            <div ref={canvasWrap} className={view === 'log' ? 'canvas-wrap is-log' : 'canvas-wrap'}>
              {view === 'log' ? (
                <RunLogView onApproveGate={onApproveGate} onRejectGate={onRejectGate} onApproveMutation={onApproveMutation} onOpenNode={focusNode} />
              ) : (
                <ReactFlowProvider>
                  <WorkflowCanvas onReviewNode={openInspector} onSelectExecutableNode={openInspector} />
                </ReactFlowProvider>
              )}
              {summaryEnabled && terminal && state && runId ? (
                <RunSummary state={state} runId={runId} labelOf={labelOf} onFocusNode={focusNode} onOpenHistory={onOpenHistory}
                  onNewRun={bringSetupForward} style={summaryStyle} sectionRef={summaryRef}
                  grips={<div className="run-summary-grips"><PanelGrip label="Ringkasan" onResize={resizeSummary} /></div>} />
              ) : null}
              {playback === 'replay' && eventCount > 0 ? (
                <div className="replay-bar">
                  <button type="button" className="replay-play"
                    aria-label={replayPlaying ? 'Pause replay' : cursor >= eventCount ? 'Replay from start' : 'Continue replay'}
                    title={replayPlaying ? 'Pause' : cursor >= eventCount ? 'Replay from start' : 'Continue'}
                    onClick={() => (replayPlaying ? onPauseReplay() : onPlayReplay())}>
                    {replayPlaying ? '❚❚' : cursor >= eventCount ? '↻' : '►'}
                  </button>
                  <label htmlFor="run-replay-range" className="visually-hidden">Replay position</label>
                  <input id="run-replay-range" type="range" min={0} max={eventCount} value={cursor}
                    aria-valuetext={`Event ${cursor} of ${eventCount}`} aria-describedby="run-replay-range-description"
                    onChange={(event) => { onPauseReplay(); onSeek(Number(event.target.value)); }} />
                  <span id="run-replay-range-description">Event {cursor} of {eventCount}</span>
                </div>
              ) : null}
            </div>
          </div>
        ) : (
          <div className="run-live-empty">
            <div className="run-live-empty-inner">
              <span className="page-eyebrow">Ready</span>
              <h2>Configure a run to begin</h2>
              <p>Set the workflow, scope, and execution mode in the setup panel, then start a preview. The live graph, inspector, and console appear here.</p>
            </div>
          </div>
        )}
      </section>
            {inspectorOpen ? (
              <aside ref={inspectorRef} className="run-inspector run-floating-panel" style={inspectorAutoOpen && !layout.panels.inspector.open ? { ...panelStyle('inspector'), zIndex: 13 } : panelStyle('inspector')} onPointerDown={() => { if (inspectorAutoOpen) return; raise('inspector'); }}>
                <div className="run-panel-drag-zone nodrag nopan" role="button" tabIndex={0} aria-label="Move inspector panel; arrow keys move" onPointerDown={(event) => dragHeader('inspector', event)} onKeyDown={(event) => moveByKey('inspector', event)} />
                <div className="run-panel-tools nodrag nopan"><FontScale name="inspector" label="Inspector" value={zoom.inspector} onChange={setZoomOf} /></div>
                <NodeInspector onApproveGate={onApproveGate} onRejectGate={onRejectGate} onApproveMutation={onApproveMutation} onHide={() => toggle('inspector')} />
                <PanelGrip label="inspector panel" onResize={(dir, dx, dy) => resizePanel('inspector', dir, dx, dy)} />
              </aside>
            ) : null}
            {/* In log view the log is the main area; the console panel would only repeat it. */}
            {layout.panels.console.open && view === 'canvas' ? (
              <div className="run-console-dock run-floating-panel" style={panelStyle('console')} onPointerDown={() => raise('console')}>
                <div className="run-panel-drag-zone nodrag nopan" role="button" tabIndex={0} aria-label="Move console panel; arrow keys move" onPointerDown={(event) => dragHeader('console', event)} onKeyDown={(event) => moveByKey('console', event)} />
                <div className="run-panel-tools nodrag nopan"><FontScale name="console" label="Console" value={zoom.console} onChange={setZoomOf} /></div>
                <RunConsole onHide={() => toggle('console')} />
                <PanelGrip label="console panel" onResize={(dir, dx, dy) => resizePanel('console', dir, dx, dy)} />
              </div>
            ) : null}
    </div>
  );
}
