/**
 * Edge of the flexible layout: a bezier curve, optionally running straight
 * along its row first (`through`, past the row's empty outcome slot) so a
 * converging curve never cuts across another row's outcome. Dash styling
 * lives in CSS (`.flex-edge--*`); nothing on an edge animates in a loop.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, type EdgeProps } from 'reactflow';

export interface FlowEdgeData {
  through?: number;
  wrapped?: number;
  detour?: number;
  vertical: boolean;
}

const DETOUR_OFFSET = 14;
const CORNER = 10;

/** Orthogonal path through `points` with rounded corners. */
function roundedPath(points: ReadonlyArray<[number, number]>): string {
  let path = `M${points[0]![0]},${points[0]![1]}`;
  for (let i = 1; i < points.length - 1; i += 1) {
    const [px, py] = points[i - 1]!;
    const [x, y] = points[i]!;
    const [nx, ny] = points[i + 1]!;
    const r = Math.min(CORNER, Math.hypot(x - px, y - py) / 2, Math.hypot(nx - x, ny - y) / 2);
    const inX = x - Math.sign(x - px) * r;
    const inY = y - Math.sign(y - py) * r;
    const outX = x + Math.sign(nx - x) * r;
    const outY = y + Math.sign(ny - y) * r;
    path += ` L${inX},${inY} Q${x},${y} ${outX},${outY}`;
  }
  const [lx, ly] = points[points.length - 1]!;
  return `${path} L${lx},${ly}`;
}

export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, label, data }: EdgeProps<FlowEdgeData>) {
  const through = data?.through;
  const wrapped = data?.wrapped;
  const [startX, startY] = through === undefined ? [sourceX, sourceY] : data?.vertical ? [sourceX, through] : [through, sourceY];
  // Around the steps it skips (detour), or back to the start of the next folded row (wrapped):
  // out, along the clear line, back in. React Flow's smoothstep ignored the lane when the
  // target sits behind the source and ran the line through the middle of the row.
  const lane = data?.detour ?? wrapped;
  if (lane !== undefined) {
    const o = DETOUR_OFFSET;
    const points: Array<[number, number]> = data?.vertical
      ? [[sourceX, sourceY], [sourceX, sourceY + o], [lane, sourceY + o], [lane, targetY - o], [targetX, targetY - o], [targetX, targetY]]
      : [[sourceX, sourceY], [sourceX + o, sourceY], [sourceX + o, lane], [targetX - o, lane], [targetX - o, targetY], [targetX, targetY]];
    const [lx, ly] = data?.vertical ? [lane, (sourceY + targetY) / 2] : [(sourceX + targetX) / 2, lane];
    return (
      <>
        <BaseEdge id={id} path={roundedPath(points)} style={style} markerEnd={markerEnd} />
        {label ? (
          <EdgeLabelRenderer>
            <div className="flow-edge-label" style={{ transform: `translate(-50%, -50%) translate(${lx}px, ${ly}px)` }}>{label}</div>
          </EdgeLabelRenderer>
        ) : null}
      </>
    );
  }
  const [curve, labelX, labelY] = getBezierPath({ sourceX: startX, sourceY: startY, sourcePosition, targetX, targetY, targetPosition });
  // getBezierPath starts with "M x,y"; the straight lead-in replaces that move with a line.
  const path = through === undefined ? curve : `M${sourceX},${sourceY} L${curve.slice(1)}`;
  return (
    <>
      <BaseEdge id={id} path={path} style={style} markerEnd={markerEnd} />
      {label ? (
        <EdgeLabelRenderer>
          <div className="flow-edge-label" style={{ transform: `translate(-50%, -50%) translate(${labelX}px, ${labelY}px)` }}>{label}</div>
        </EdgeLabelRenderer>
      ) : null}
    </>
  );
}
