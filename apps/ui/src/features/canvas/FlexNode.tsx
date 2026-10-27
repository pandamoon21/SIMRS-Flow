/**
 * The small nodes of the flexible layout: one check (or rule) of a step, the
 * "+N more" fold, a decision diamond at a real fork, the join where a step's
 * rows converge, and the outcome a ✗ leads to. Every edge leaves right and
 * enters left (bottom/top when vertical), so each node mounts only those two
 * handles: a React Flow handle is costly and a tree holds over a hundred nodes.
 */
import { memo } from 'react';
import { Handle, Position, type NodeProps } from 'reactflow';
import { chipDetail, type FlexMark, type OutcomeTone } from './flexLayout.js';
import { TRAIL_MARK } from './WorkflowNode.js';

export type FlexNodeData = { vertical: boolean } & (
  | { kind: 'check'; mark: FlexMark; text: string; detail?: string; onOpen?: () => void }
  | { kind: 'more'; count: number; rules: boolean; onOpen?: () => void }
  | { kind: 'branch'; text: string }
  | { kind: 'join' }
  | { kind: 'outcome'; tone: OutcomeTone; text: string });

export function FlowHandles({ vertical, side }: { vertical: boolean; side?: 'in' | 'out' }) {
  return vertical ? (
    <>
      <Handle id="in-top" type="target" position={Position.Top} isConnectable={false} />
      <Handle id="out-bottom" type="source" position={Position.Bottom} isConnectable={false} />
      {/* The vertical list's ✗ → outcome edge steps right. */}
      {side === 'out' ? <Handle id="out-right" type="source" position={Position.Right} isConnectable={false} /> : null}
      {side === 'in' ? <Handle id="in-left" type="target" position={Position.Left} isConnectable={false} /> : null}
    </>
  ) : (
    <>
      <Handle id="in-left" type="target" position={Position.Left} isConnectable={false} />
      <Handle id="out-right" type="source" position={Position.Right} isConnectable={false} />
    </>
  );
}

function FlexNodeView({ data }: NodeProps<FlexNodeData>) {
  const side = data.kind === 'check' ? 'out' : data.kind === 'outcome' ? 'in' : undefined;
  const handles = <FlowHandles vertical={data.vertical} {...(side ? { side } : {})} />;
  if (data.kind === 'join') {
    return (
      <div className="flex-join" aria-hidden="true">
        {handles}
      </div>
    );
  }
  if (data.kind === 'branch') {
    return (
      <div className="flex-node flex-branch" title={data.text}>
        {handles}
        <span className="flex-branch-text">{data.text}</span>
      </div>
    );
  }
  if (data.kind === 'outcome') {
    return (
      <div className="flex-node flex-outcome" data-tone={data.tone} title={data.tone === 'plan' ? `${data.text} — menunggu persetujuan operator` : data.text}>
        {handles}
        <span className="flex-text">{data.text}</span>
      </div>
    );
  }
  if (data.kind === 'more') {
    return (
      <button type="button" className="flex-node flex-more nodrag" onClick={data.onOpen} title="Buka inspector untuk semua cek">
        {handles}
        +{data.count} {data.rules ? 'aturan' : 'cek'} lagi
      </button>
    );
  }
  const mark = data.mark === 'rule' ? '◇' : TRAIL_MARK[data.mark];
  const shown = chipDetail(data.mark, data.detail);
  return (
    <div className="flex-node flex-check" data-mark={data.mark} title={data.detail ? `${data.text} — ${data.detail}` : data.text} onClick={data.onOpen}>
      {handles}
      <span className="wf-mark" aria-hidden="true">{mark}</span>
      <span className="flex-body">
        <span className="flex-text">{data.text}</span>
        {shown ? <span className="flex-detail">{shown}</span> : null}
      </span>
    </div>
  );
}

/**
 * React Flow re-renders a node whenever it moves (it passes the position as a
 * prop); the content only depends on `data`, so a tween frame skips it.
 */
export const FlexNode = memo(FlexNodeView, (a, b) => a.data === b.data);
