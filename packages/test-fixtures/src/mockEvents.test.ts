import { describe, expect, it } from 'vitest';
import { rajalWorkflow } from '@simrs-flow/domain-rajal';
import { ranapWorkflow } from '@simrs-flow/domain-ranap';
import { mockEventStream } from './mockEvents.js';

describe('mockEventStream clinic counts', () => {
  it('leaves the default stream untouched', () => {
    const stream = mockEventStream(rajalWorkflow, { runId: 'no-counts' });
    const withEvidence = stream.filter((event) => {
      const data = event.data as { evidence?: unknown[] } | undefined;
      return Array.isArray(data?.evidence);
    });
    expect(withEvidence).toHaveLength(0);
  });

  it('attaches rajal.clinic-counts only to the Rajal filter success event', () => {
    const stream = mockEventStream(rajalWorkflow, {
      runId: 'with-counts',
      clinicCounts: {
        complete: true,
        totalClinics: 3,
        totalPatients: 3,
        clinics: [
          { clinic: 'ANAK', patientCount: 2 },
          { clinic: 'DALAM', patientCount: 2 },
          { clinic: 'BEDAH', patientCount: 0 },
        ],
      },
    });
    const carrying = stream.filter((event) => {
      const data = event.data as { evidence?: Array<{ label: string }> } | undefined;
      return data?.evidence?.some((item) => item.label === 'rajal.clinic-counts');
    });
    expect(carrying).toHaveLength(1);
    expect(carrying[0]).toMatchObject({ nodeId: 'filter_records', type: 'node.succeeded' });
  });

  it('does not attach counts to a non-Rajal workflow even when requested', () => {
    const stream = mockEventStream(ranapWorkflow, {
      runId: 'ranap-counts',
      clinicCounts: { complete: true, totalClinics: 1, totalPatients: 1, clinics: [{ clinic: 'ANAK', patientCount: 1 }] },
    });
    const carrying = stream.filter((event) => {
      const data = event.data as { evidence?: unknown[] } | undefined;
      return Array.isArray(data?.evidence);
    });
    expect(carrying).toHaveLength(0);
  });
});

describe('mockEventStream branch verdicts', () => {
  it('marks an explicit skipped edge without changing default replay', () => {
    const edgeId = 'detect_origin__process_igd';
    const defaultEdge = mockEventStream(ranapWorkflow).filter((event) => event.edgeId === edgeId).at(-1);
    const skippedEdge = mockEventStream(ranapWorkflow, { branches: { [edgeId]: 'skip' } })
      .filter((event) => event.edgeId === edgeId).at(-1);
    expect(defaultEdge?.type).toBe('edge.completed');
    expect(skippedEdge?.type).toBe('edge.skipped');
  });
});
