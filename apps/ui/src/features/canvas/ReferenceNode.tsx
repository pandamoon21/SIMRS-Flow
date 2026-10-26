import { Handle, Position, type NodeProps } from 'reactflow';

export interface ReferenceNodeData {
  label: string;
  detail: string;
}

export function ReferenceNode({ data }: NodeProps<ReferenceNodeData>) {
  return (
    <div className="workflow-reference" aria-label={`Alur referensi: ${data.label}. ${data.detail}`}>
      <Handle type="target" position={Position.Top} isConnectable={false} />
      <span className="workflow-reference-kind">Alur referensi</span>
      <strong>{data.label}</strong>
      <span>{data.detail}</span>
    </div>
  );
}
