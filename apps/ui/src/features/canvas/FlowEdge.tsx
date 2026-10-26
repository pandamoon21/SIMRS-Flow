/**
 * Edge of the flexible layout: a bezier curve, optionally running straight
 * along its row first (`through`, past the row's empty outcome slot) so a
 * converging curve never cuts across another row's outcome. Dash styling
 * lives in CSS (`.flex-edge--*`); nothing on an edge animates in a loop.
 */
import { BaseEdge, EdgeLabelRenderer, getBezierPath, getSmoothStepPath, type EdgeProps } from 'reactflow';

export interface FlowEdgeData {
  through?: number;
  wrapped?: number;
  vertical: boolean;
}

export function FlowEdge({ id, sourceX, sourceY, targetX, targetY, sourcePosition, targetPosition, style, markerEnd, label, data }: EdgeProps<FlowEdgeData>) {
  const through = data?.through;
  const wrapped = data?.wrapped;
  const [startX, startY] = through === undefined ? [sourceX, sourceY] : data?.vertical ? [sourceX, through] : [through, sourceY];
  const [curve, labelX, labelY] = wrapped !== undefined
    // Back to the start of the next folded row: a rounded detour along the gap between rows.
    ? getSmoothStepPath({ sourceX, sourceY, sourcePosition, targetX, targetY, targetPosition, borderRadius: 18, offset: 18, ...(data?.vertical ? { centerX: wrapped } : { centerY: wrapped }) })
    : getBezierPath({ sourceX: startX, sourceY: startY, sourcePosition, targetX, targetY, targetPosition });
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
