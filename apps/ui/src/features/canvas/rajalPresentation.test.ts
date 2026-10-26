import { describe, expect, it } from 'vitest';
import { applyEvent, initialRunState, type Evidence, type RunState } from '@simrs-flow/workflow-core';
import { rajalWorkflow } from '@simrs-flow/domain-rajal';
import {
  formatRajalClinicCounts,
  formatRajalQueueWaiting,
  rajalRecapHeight,
  rajalRecapOf,
  readRajalClinicCounts,
} from './rajalPresentation.js';
import { CARD_HEIGHT } from './phaseLayout.js';

/** Synthetic ANAK/DALAM/BEDAH result: B is in two polis, counted once in total. */
const countsEvidence: Evidence = {
  label: 'rajal.clinic-counts',
  source: 'filter_records',
  data: {
    basis: 'matched-visits',
    complete: true,
    totalClinics: 3,
    totalPatients: 3,
    clinics: [
      { clinic: 'ANAK', patientCount: 2 },
      { clinic: 'DALAM', patientCount: 2 },
      { clinic: 'BEDAH', patientCount: 0 },
    ],
  },
};

function stateWithCounts(evidence: Evidence[] = [countsEvidence]): RunState {
  const state = initialRunState(rajalWorkflow, 'synthetic-rajal-counts', 'preview');
  state.nodes.filter_records!.status = 'success';
  state.nodes.filter_records!.evidence = evidence;
  state.nodes.resolve_clinics!.evidence = [{ label: 'rajal.selected-clinics', source: 'resolve_clinics', data: ['ANAK', 'DALAM', 'BEDAH'] }];
  state.nodes.start_batch!.evidence = [{ label: 'rajal.batch-count', source: 'start_batch', data: { totalPatients: 3 } }];
  return state;
}

function waitingState(clinics: string[], queuePatients?: number): RunState {
  const state = initialRunState(rajalWorkflow, 'synthetic-rajal-waiting', 'preview');
  state.nodes.resolve_clinics!.evidence = [{ label: 'rajal.selected-clinics', source: 'resolve_clinics', data: clinics }];
  if (queuePatients !== undefined) {
    state.nodes.start_batch!.evidence = [{ label: 'rajal.batch-count', source: 'start_batch', data: { totalPatients: queuePatients } }];
  }
  return state;
}

describe('Rajal MULAI recap', () => {
  it('grows the MULAI card to fit a 30-poli recap and keeps the default otherwise', () => {
    const clinics = Array.from({ length: 30 }, (_, index) => `POLI ${index + 1}`);
    const recap = rajalRecapOf(stateWithCounts([
      {
        label: 'rajal.clinic-counts',
        source: 'filter_records',
        data: { basis: 'matched-visits', complete: true, totalClinics: 30, totalPatients: 30, clinics: clinics.map((clinic) => ({ clinic, patientCount: 1 })) },
      },
    ]));
    expect(rajalRecapHeight(recap)).toBe(200 + 20 * 33);
    expect(rajalRecapHeight(rajalRecapOf(waitingState(['ANAK'])))).toBe(CARD_HEIGHT);
  });


  it('validates the latest count evidence and rejects malformed or stale payloads', () => {
    expect(readRajalClinicCounts([countsEvidence])).toMatchObject({ totalClinics: 3, totalPatients: 3, complete: true });
    const invalid: Evidence[] = [
      { ...countsEvidence, source: 'other' },
      { ...countsEvidence, data: { ...(countsEvidence.data as object), basis: 'report-rows' } },
      { ...countsEvidence, data: { ...(countsEvidence.data as object), totalClinics: 2 } },
      { ...countsEvidence, data: { ...(countsEvidence.data as object), totalPatients: -1 } },
      { ...countsEvidence, data: { ...(countsEvidence.data as object), totalPatients: 2.5 } },
      { ...countsEvidence, data: { ...(countsEvidence.data as object), totalPatients: 9 } },
      { ...countsEvidence, data: { ...(countsEvidence.data as object), clinics: [{ clinic: 'ANAK', patientCount: 1 }, { clinic: ' anak ', patientCount: 1 }, { clinic: 'BEDAH', patientCount: 1 }] } },
      { ...countsEvidence, data: { ...(countsEvidence.data as object), clinics: [] } },
      { ...countsEvidence, data: null },
    ];
    for (const stale of invalid) {
      // A newer corrupt record must hide the valid older one, never fall back.
      expect(readRajalClinicCounts([countsEvidence, stale])).toBeUndefined();
    }
    expect(readRajalClinicCounts([])).toBeUndefined();
  });

  it('treats an all-zero evidence payload as a valid known zero', () => {
    const zero: Evidence = {
      ...countsEvidence,
      data: { basis: 'matched-visits', complete: true, totalClinics: 2, totalPatients: 0, clinics: [{ clinic: 'ANAK', patientCount: 0 }, { clinic: 'DALAM', patientCount: 0 }] },
    };
    expect(readRajalClinicCounts([zero])).toMatchObject({ totalPatients: 0, complete: true });
  });

  it('projects the ready recap with the plan wording and no patient identifiers', () => {
    const card = rajalRecapOf(stateWithCounts());
    expect(card.clinicCountsState).toBe('ready');
    const lines = formatRajalClinicCounts(card.clinicCounts, { state: 'ready' });
    expect(lines).toEqual([
      'Rekap setelah filter kunjungan',
      'Total poli: 3 Poli',
      '1. Poli ANAK: 2 pasien',
      '2. Poli DALAM: 2 pasien',
      '3. Poli BEDAH: 0 pasien',
      'Total pasien: 3 pasien',
      'Pasien lintas poli dihitung sekali pada total.',
    ]);
    expect(lines.join(' ')).not.toMatch(/\d{2}-\d{2}-\d{4}|SYN-|0-\d{2}-\d{2}-\d{2}/);
  });

  it('shows a waiting recap before filter completion and unavailable only when nothing is coming', () => {
    const waiting = rajalRecapOf(waitingState(['ANAK', 'DALAM'], 3));
    expect(waiting.clinicCountsState).toBe('waiting');
    expect(formatRajalQueueWaiting(waiting.clinics, waiting.queuePatients)).toEqual([
      'Rekap setelah filter kunjungan',
      'Total poli: 2 Poli',
      '1. Poli ANAK: Menunggu pencocokan kunjungan',
      '2. Poli DALAM: Menunggu pencocokan kunjungan',
      'Total pasien: 3 pasien dalam antrean',
    ]);

    const replayState = stateWithCounts([]);
    replayState.nodes.filter_records!.status = 'success';
    const unavailable = rajalRecapOf(replayState);
    expect(unavailable.clinicCountsState).toBe('unavailable');
    expect(formatRajalClinicCounts(undefined, { state: 'unavailable' })).toEqual(['Rekap poli belum tersedia untuk run ini']);
  });

  it('marks incomplete readable history explicitly without treating it as complete', () => {
    const partialEvidence: Evidence = { ...countsEvidence, data: { ...(countsEvidence.data as object), complete: false } };
    const lines = formatRajalClinicCounts(readRajalClinicCounts([partialEvidence]), { state: 'ready' });
    expect(lines).toContain('Total pasien terbaca: 3 pasien');
    expect(lines.at(-1)).toBe('Data parsial — sebagian riwayat belum terbaca');
  });

  it('rebuilds safe counts from node evidence in replayed run events', () => {
    const initial = initialRunState(rajalWorkflow, 'replayed-rajal-counts', 'preview');
    const replayed = applyEvent(initial, {
      schema: 'simrs.workflow.event.v1',
      eventId: 'replay-filter-evidence',
      seq: 1,
      ts: '2026-10-05T00:00:00.000Z',
      runId: 'replayed-rajal-counts',
      workflowId: rajalWorkflow.id,
      workflowVersion: rajalWorkflow.version,
      type: 'node.succeeded',
      source: 'runner',
      nodeId: 'filter_records',
      data: { evidence: [countsEvidence] },
    });
    const card = rajalRecapOf(replayed);
    expect(card.clinicCountsState).toBe('ready');
    expect(card.clinicCounts).toMatchObject({ totalClinics: 3, totalPatients: 3 });
  });
});
