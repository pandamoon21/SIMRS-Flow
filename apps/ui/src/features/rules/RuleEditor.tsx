import { useCallback, useEffect, useState } from 'react';
import { BANK_DARAH_UNIT_KEYWORDS, CATHLAB_UNIT_KEYWORDS, IBS_MANUAL_REVIEW_ROOM_TOKEN } from '@simrs-flow/domain-ranap';
import { RAJAL_DEFAULT_PAYMENT_CONFIG, RAJAL_PAYMENT_TYPE_OPTIONS, RAJAL_SHIFT_OPTIONS } from '@simrs-flow/domain-rajal';
import { api, UnauthorizedError, type RuleSet, type RuleValues } from '../../api/client.js';
import { Alert, Badge, Button, Card, CardBody, FormInput, FormLabel, FormSelect, FormTextarea, Spinner } from '../../ui/primitives.js';
import { toast } from '../../ui/toast.js';
import { diffRules, parseLines, RULE_FIELD_DOMAIN, RULE_FIELD_LABEL, ruleDraftErrors, type RuleField } from './ruleCatalog.js';

/** Same values the orchestrator starts from (version 0). */
const DEFAULTS: RuleValues = {
  ranap: { bankDarahUnits: [...BANK_DARAH_UNIT_KEYWORDS], cathlabUnits: [...CATHLAB_UNIT_KEYWORDS], ibsManualReviewRooms: [IBS_MANUAL_REVIEW_ROOM_TOKEN] },
  rajal: { treatmentGroups: [], skipTreatments: [], paymentConfig: { ...RAJAL_DEFAULT_PAYMENT_CONFIG } },
};

/** Textareas hold one entry per line; groups and payment are edited in place. */
interface Draft {
  bankDarahUnits: string;
  cathlabUnits: string;
  ibsManualReviewRooms: string;
  skipTreatments: string;
  treatmentGroups: RuleValues['rajal']['treatmentGroups'];
  paymentConfig: RuleValues['rajal']['paymentConfig'];
}

const toDraft = (v: RuleValues): Draft => ({
  bankDarahUnits: v.ranap.bankDarahUnits.join('\n'),
  cathlabUnits: v.ranap.cathlabUnits.join('\n'),
  ibsManualReviewRooms: v.ranap.ibsManualReviewRooms.join('\n'),
  skipTreatments: v.rajal.skipTreatments.join('\n'),
  treatmentGroups: v.rajal.treatmentGroups.map((g) => ({ ...g })),
  paymentConfig: { ...v.rajal.paymentConfig },
});

const fromDraft = (d: Draft): RuleValues => ({
  ranap: { bankDarahUnits: parseLines(d.bankDarahUnits), cathlabUnits: parseLines(d.cathlabUnits), ibsManualReviewRooms: parseLines(d.ibsManualReviewRooms) },
  rajal: { treatmentGroups: d.treatmentGroups, skipTreatments: parseLines(d.skipTreatments), paymentConfig: d.paymentConfig },
});

/** Reset only the visible domain's fields to the built-in values. */
const DEFAULT_PATCH: Record<'ranap' | 'rajal', Partial<Draft>> = {
  ranap: { bankDarahUnits: DEFAULTS.ranap.bankDarahUnits.join('\n'), cathlabUnits: DEFAULTS.ranap.cathlabUnits.join('\n'), ibsManualReviewRooms: DEFAULTS.ranap.ibsManualReviewRooms.join('\n') },
  rajal: { skipTreatments: '', treatmentGroups: [], paymentConfig: { ...DEFAULTS.rajal.paymentConfig } },
};

function FieldMark({ changed, error }: { changed: boolean; error?: string }) {
  return (
    <>
      {changed ? <span className="rule-changed">diubah</span> : null}
      {error ? <span className="rule-field-error" role="alert">{error}</span> : null}
    </>
  );
}

function ListField({ id, label, hint, value, changed, onChange }: { id: string; label: string; hint: string; value: string; changed: boolean; onChange: (v: string) => void }) {
  return (
    <div className={`rule-field${changed ? ' is-changed' : ''}`}>
      <FormLabel htmlFor={id}>{label}<FieldMark changed={changed} /></FormLabel>
      <FormTextarea id={id} rows={3} value={value} onChange={(e) => onChange(e.target.value)} />
      <small>{hint}</small>
    </div>
  );
}

const isConflict = (message?: string) => Boolean(message && /→ 409/.test(message));
const DOMAIN_LABEL = { ranap: 'Rawat inap', rajal: 'Rawat jalan' } as const;

/**
 * Edits the Rules-page values. Saving stores a new version on the orchestrator;
 * runs started afterwards use it and record its number. The draft spans both
 * domains, so switching ranap/rajal never drops an edit.
 */
export function RuleEditor({ domain, onUnauthorized, onDirtyChange }: { domain: 'ranap' | 'rajal'; onUnauthorized: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [rules, setRules] = useState<RuleSet>();
  const [draft, setDraft] = useState<Draft>();
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string>();
  const [history, setHistory] = useState<RuleSet[]>();

  const fail = useCallback((err: unknown) => {
    if (err instanceof UnauthorizedError) onUnauthorized();
    else setError(err instanceof Error ? err.message : String(err));
  }, [onUnauthorized]);

  const load = useCallback(async () => {
    setError(undefined);
    try {
      const set = await api.getRules();
      setRules(set);
      setDraft(toDraft(set.values));
    } catch (err) {
      fail(err);
    }
  }, [fail]);

  useEffect(() => { void load(); }, [load]);

  const values = draft ? fromDraft(draft) : undefined;
  const changes = rules && values ? diffRules(rules.values, values) : [];
  const dirty = changes.length > 0;

  useEffect(() => { onDirtyChange?.(dirty); }, [dirty, onDirtyChange]);
  useEffect(() => {
    if (!dirty) return;
    const warn = (event: BeforeUnloadEvent) => { event.preventDefault(); };
    window.addEventListener('beforeunload', warn);
    return () => window.removeEventListener('beforeunload', warn);
  }, [dirty]);

  if (!draft || !rules || !values) {
    return error ? (
      <Alert color="danger">
        Rule tidak dapat dimuat: {error} <Button size="sm" color="secondary" variant="outline" onClick={() => void load()}>Coba lagi</Button>
      </Alert>
    ) : <div className="page-loading" role="status"><Spinner size="sm" /> Memuat rule…</div>;
  }

  const set = (patch: Partial<Draft>) => { setDraft({ ...draft, ...patch }); if (!isConflict(error)) setError(undefined); };
  const errors = ruleDraftErrors(values);
  const blocked = Object.keys(errors).length > 0;
  const changed = (field: RuleField) => changes.includes(field);
  const otherDomainChanges = changes.filter((field) => RULE_FIELD_DOMAIN[field] !== domain).length;
  const atDefaults = diffRules(DEFAULTS, values).every((field) => RULE_FIELD_DOMAIN[field] !== domain);

  const save = async () => {
    setBusy(true);
    setError(undefined);
    try {
      const saved = await api.saveRules(rules.version, values);
      setRules(saved);
      setDraft(toDraft(saved.values));
      setHistory(undefined);
      toast('success', `Tersimpan sebagai versi ${saved.version}. Run berikutnya memakai rule ini.`);
    } catch (err) {
      fail(err);
    } finally {
      setBusy(false);
    }
  };

  // Conflict: adopt the newer server version as the baseline but keep the draft, so a re-save is one click.
  const reloadBaseline = async () => {
    try {
      setRules(await api.getRules());
      setError(undefined);
      setHistory(undefined);
    } catch (err) {
      fail(err);
    }
  };

  const loadHistory = async () => {
    if (history) return;
    try {
      setHistory((await api.getRuleHistory(20)).versions);
    } catch (err) {
      fail(err);
    }
  };

  const groups = draft.treatmentGroups;
  const setGroup = (i: number, patch: Partial<Draft['treatmentGroups'][number]>) =>
    set({ treatmentGroups: groups.map((g, j) => (j === i ? { ...g, ...patch } : g)) });
  const removeGroup = (i: number) => {
    const before = groups;
    set({ treatmentGroups: groups.filter((_, j) => j !== i) });
    toast('info', `Grup ${i + 1} dihapus`, { label: 'Urungkan', run: () => setDraft((current) => (current ? { ...current, treatmentGroups: before } : current)) });
  };

  return (
    <Card className="surface-card rule-editor">
      <CardBody>
        <div className="rule-editor-head">
          <strong>Rule yang bisa diedit</strong>
          <span className="history-run-id">
            {rules.version === 0 ? 'versi 0 · bawaan' : `versi ${rules.version} · ${rules.updatedBy ?? '-'} · ${rules.updatedAt ? new Date(rules.updatedAt).toLocaleString() : ''}`}
          </span>
          {dirty ? (
            <Badge color="warning">
              {changes.length} perubahan belum disimpan{otherDomainChanges ? ` · ${otherDomainChanges} di ${DOMAIN_LABEL[domain === 'ranap' ? 'rajal' : 'ranap']}` : ''}
            </Badge>
          ) : null}
        </div>
        {domain === 'ranap' ? (
          <div className="rule-fields">
            <ListField id="rule-bank-darah" label={RULE_FIELD_LABEL.bankDarahUnits} hint="Order unit yang namanya memuat teks ini dan belum dibayar akan memblok verifikasi. Kosongkan untuk mematikan." value={draft.bankDarahUnits} changed={changed('bankDarahUnits')} onChange={(v) => set({ bankDarahUnits: v })} />
            <ListField id="rule-cathlab" label={RULE_FIELD_LABEL.cathlabUnits} hint="Sama seperti di atas, untuk Cathlab." value={draft.cathlabUnits} changed={changed('cathlabUnits')} onChange={(v) => set({ cathlabUnits: v })} />
            <ListField id="rule-ibs-rooms" label={RULE_FIELD_LABEL.ibsManualReviewRooms} hint="Selisih IBS di ruang ini jadi peringatan (tetap perlu review), bukan error." value={draft.ibsManualReviewRooms} changed={changed('ibsManualReviewRooms')} onChange={(v) => set({ ibsManualReviewRooms: v })} />
          </div>
        ) : (
          <div className="rule-fields">
            <ListField id="rule-skip" label={RULE_FIELD_LABEL.skipTreatments} hint="Tagihan yang memuat salah satu tindakan ini ditolak dari batch." value={draft.skipTreatments} changed={changed('skipTreatments')} onChange={(v) => set({ skipTreatments: v })} />
            <div className={`rule-field rule-field-wide${changed('treatmentGroups') ? ' is-changed' : ''}`}>
              <FormLabel>{RULE_FIELD_LABEL.treatmentGroups}<FieldMark changed={changed('treatmentGroups')} error={errors.treatmentGroups} /></FormLabel>
              <small>Huruf sama = cukup salah satu (OR); huruf berbeda = semua grup wajib ada (AND). Nama dicocokkan persis (huruf besar/kecil berpengaruh).</small>
              {groups.length ? (
                <div className="rule-groups">
                  {groups.map((g, i) => (
                    <div key={i} className="rule-group-row">
                      <FormInput aria-label={`Grup ${i + 1}`} value={g.group} maxLength={1} onChange={(e) => setGroup(i, { group: e.target.value.toUpperCase() })} />
                      <FormInput aria-label={`Key ${i + 1}`} placeholder="key" value={g.key} onChange={(e) => setGroup(i, { key: e.target.value })} />
                      <FormInput aria-label={`Nama tindakan ${i + 1}`} placeholder="nama tindakan" value={g.name} onChange={(e) => setGroup(i, { name: e.target.value })} />
                      <Button color="danger" variant="ghost" size="sm" aria-label={`Hapus grup ${i + 1}`} onClick={() => removeGroup(i)}>Hapus</Button>
                    </div>
                  ))}
                </div>
              ) : <p className="rule-empty">Belum ada grup — semua tagihan lolos cek grup.</p>}
              <Button size="sm" color="secondary" variant="outline" onClick={() => set({ treatmentGroups: [...groups, { group: 'A', key: '', name: '' }] })}>+ Tambah grup</Button>
            </div>
            <div className={`rule-field rule-field-wide${changed('paymentConfig') ? ' is-changed' : ''}`}>
              <FormLabel htmlFor="rule-shift">{RULE_FIELD_LABEL.paymentConfig}<FieldMark changed={changed('paymentConfig')} error={errors.paymentConfig} /></FormLabel>
              <div className="rule-payment">
                <FormSelect id="rule-shift" aria-label="Shift" value={draft.paymentConfig.shift} onChange={(e) => set({ paymentConfig: { ...draft.paymentConfig, shift: e.target.value } })}>
                  {RAJAL_SHIFT_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                </FormSelect>
                <FormSelect aria-label="Jenis pembayaran" value={draft.paymentConfig.type} onChange={(e) => set({ paymentConfig: { ...draft.paymentConfig, type: e.target.value } })}>
                  {RAJAL_PAYMENT_TYPE_OPTIONS.map((o) => <option key={o.code} value={o.code}>{o.label}</option>)}
                </FormSelect>
                <FormInput aria-label="Kode penjamin" inputMode="numeric" aria-invalid={Boolean(errors.paymentConfig)} value={draft.paymentConfig.payerCode} onChange={(e) => set({ paymentConfig: { ...draft.paymentConfig, payerCode: e.target.value } })} />
              </div>
              <small>Shift, jenis pembayaran, dan kode penjamin (kd_penjamin) untuk tampung bayar rajal.</small>
            </div>
          </div>
        )}

        {error ? (
          <Alert color="danger">
            {isConflict(error) ? 'Rule sudah diubah operator lain sejak halaman ini dibuka. Draft Anda tetap ada.' : error}
            {isConflict(error) ? <> <Button size="sm" color="secondary" variant="outline" onClick={() => void reloadBaseline()}>Muat versi terbaru</Button></> : null}
          </Alert>
        ) : null}
        <div className="rule-editor-actions">
          <Button color="primary" disabled={!dirty || busy || blocked} title={blocked ? 'Perbaiki isian yang ditandai dulu' : undefined} onClick={() => void save()}>{busy ? 'Menyimpan…' : 'Simpan versi baru'}</Button>
          <Button color="secondary" variant="outline" disabled={busy || !dirty} onClick={() => { setDraft(toDraft(rules.values)); setError(undefined); }}>Batalkan perubahan</Button>
          <Button color="secondary" variant="ghost" disabled={busy || atDefaults} title={atDefaults ? 'Sudah sama dengan nilai bawaan' : 'Isi draft dengan nilai bawaan (belum disimpan)'} onClick={() => set(DEFAULT_PATCH[domain])}>Isi nilai bawaan</Button>
        </div>
        <details className="rule-history" onToggle={(event) => { if ((event.target as HTMLDetailsElement).open) void loadHistory(); }}>
          <summary>Riwayat versi</summary>
          {!history ? <div className="page-loading" role="status"><Spinner size="sm" /> Memuat…</div> : history.length === 0 ? (
            <p className="rule-empty">Belum ada versi tersimpan — rule masih nilai bawaan.</p>
          ) : (
            <ol className="rule-history-list">
              {history.map((version, i) => {
                const previous = history[i + 1]?.values ?? DEFAULTS;
                const fields = diffRules(previous, version.values);
                return (
                  <li key={version.version}>
                    <span className="mono">v{version.version}</span>
                    <span>{version.updatedBy ?? '-'} · {version.updatedAt ? new Date(version.updatedAt).toLocaleString() : ''}</span>
                    <span className="rule-history-fields">{fields.length ? fields.map((field) => RULE_FIELD_LABEL[field]).join(', ') : 'tanpa perubahan nilai'}</span>
                    {version.version !== rules.version ? (
                      <Button size="sm" color="secondary" variant="outline" onClick={() => { setDraft(toDraft(version.values)); toast('info', `Draft diisi dari versi ${version.version} — belum disimpan`); }}>Pakai sebagai draft</Button>
                    ) : <Badge color="info">aktif</Badge>}
                  </li>
                );
              })}
            </ol>
          )}
        </details>
        <small className="rule-editor-foot">Perubahan tidak menyentuh jalur write: allowlist, precondition, dan verifikasi tetap sama. Setiap versi tercatat, dan setiap run mencatat versi rule yang dipakai.</small>
      </CardBody>
    </Card>
  );
}
