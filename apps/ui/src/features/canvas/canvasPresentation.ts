import type { EdgeStatus, NodeStatus } from '@simrs-flow/workflow-core';

/** Reference-only context: never a workflow node, execution path, or approval. */
export const REFERENCE_NOTES = {
  rajal: [
    { id: 'payment-branch', anchor: 'filter_records', label: 'Kelayakan pembayaran', detail: 'Kunjungan yang sudah dibayar dilewati; status tak terbaca perlu ditinjau sebelum bayar.' },
    { id: 'other-modality', anchor: 'validate_treatment', label: 'Tindakan lainnya', detail: 'Penunjang tak dikenal ditahan untuk tinjauan; tindakan rutin tetap dinilai oleh cek tindakan.' },
    { id: 'sep-update', anchor: 'validate_sep', label: 'Update SEP (historis)', detail: 'Ketidaksesuaian SEP menghasilkan rencana koreksi yang memerlukan persetujuan; tidak menulis langsung.' },
    { id: 'transfer-branch', anchor: 'check_verification', label: 'Transfer / verifikasi', detail: 'Order terhambat menahan pembayaran; tagihan terverifikasi namun belum dibayar tetap dapat diproses.' },
  ],
  ranap: [
    { id: 'origin-branch', anchor: 'detect_origin', label: 'Asal IGD / POLI', detail: 'Cabang IGD dan POLI dipilih dari asal per registrasi; asal tak pasti ditahan.' },
  ],
} as const;

/** Runner completes an edge only when its source completed and no branch verdict skipped it. */
export function edgeDisplayState(edge: EdgeStatus, source: NodeStatus, target: NodeStatus): 'idle' | 'active' | 'adjacent' | 'failed' | 'skipped' {
  if (edge === 'failed') return 'failed';
  if (edge === 'skipped' || source === 'skipped' || target === 'skipped') return 'skipped';
  if (edge === 'active' && target === 'running') return 'active';
  if (edge === 'completed' && !['pending', 'queued'].includes(source) && !['pending', 'queued'].includes(target)) return 'adjacent';
  return 'idle';
}
