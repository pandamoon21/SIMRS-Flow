import { Fragment, useMemo, useState, type ReactNode } from 'react';
import type { RuleCatalog, StepStatus, WorkflowDefinition } from '@simrs-flow/workflow-core';
import { ranapRuleCatalog, ranapWorkflow } from '@simrs-flow/domain-ranap';
import { rajalRuleCatalog, rajalWorkflow } from '@simrs-flow/domain-rajal';
import { Alert, Badge, Button, ButtonGroup, Card, CardBody, FormCheck, FormInput, type Tone } from '../../ui/primitives.js';
import { buildRuleSections, ruleRowMatches, writesWithoutReason, type RuleRow } from './ruleCatalog.js';
import { RuleEditor } from './RuleEditor.js';

const DOMAINS: Record<'ranap' | 'rajal', { label: string; workflow: WorkflowDefinition; catalog: RuleCatalog }> = {
  ranap: { label: 'Rawat inap', workflow: ranapWorkflow, catalog: ranapRuleCatalog },
  rajal: { label: 'Rawat jalan', workflow: rajalWorkflow, catalog: rajalRuleCatalog },
};

const RISK_TONE: Record<string, Tone> = { critical: 'danger', high: 'warning', medium: 'info', low: 'secondary' };

/** Marks every case-insensitive occurrence of the search text. */
function Hl({ text, query }: { text: string; query: string }): ReactNode {
  const q = query.trim();
  if (!q) return text;
  const escaped = q.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  const parts = text.split(new RegExp(`(${escaped})`, 'ig'));
  return parts.map((part, i) => (i % 2 ? <mark key={i}>{part}</mark> : <Fragment key={i}>{part}</Fragment>));
}

/** Outcomes grouped by what they mean for the run, in the order an operator cares about. */
const OUTCOME_GROUPS: ReadonlyArray<{ statuses: StepStatus[]; title: string; tone: Tone; icon: string }> = [
  { statuses: ['blocked', 'failed'], title: 'Berhenti / gagal bila', tone: 'danger', icon: '⛔' },
  { statuses: ['needs_review'], title: 'Perlu ditinjau operator bila', tone: 'warning', icon: '⚠' },
  { statuses: ['success'], title: 'Lanjut bila', tone: 'success', icon: '✓' },
  { statuses: ['skipped'], title: 'Dilewati bila', tone: 'secondary', icon: '↷' },
];

const KIND_LABEL: Record<string, string> = {
  input: 'Menyiapkan input', read: 'Membaca data SIMRS', validate: 'Memeriksa', plan: 'Menyusun rencana',
  mutate: 'Merencanakan perubahan di SIMRS', gate: 'Menunggu persetujuan operator', verify: 'Memeriksa hasil', summary: 'Merangkum',
};

/** Template text uses "…" for values filled at run time; show that plainly. */
function Plain({ text, query }: { text: string; query: string }) {
  const parts = text.split('…');
  return (
    <>
      {parts.map((part, i) => (
        <Fragment key={i}>
          <Hl text={part} query={query} />
          {i < parts.length - 1 ? <span className="rule-slot" title="Diisi dengan nilai sebenarnya saat run">…</span> : null}
        </Fragment>
      ))}
    </>
  );
}

function RuleCard({ row, catalog, query }: { row: RuleRow; catalog: RuleCatalog; query: string }) {
  const { node, entry } = row;
  const runtimeWrites = writesWithoutReason(entry);
  const hasWrites = entry.writes.length > 0;
  return (
    <Card className="surface-card rule-card">
      <CardBody>
        <header className="rule-card-head">
          <div>
            <span className="rule-card-kind">{KIND_LABEL[node.kind] ?? node.kind}</span>
            <h3><Hl text={node.label} query={query} /></h3>
          </div>
          <div className="rule-card-badges">
            {node.critical ? <Badge color="danger">Wajib lolos</Badge> : null}
            {hasWrites ? <Badge color="warning">Menulis ke SIMRS</Badge> : null}
          </div>
        </header>
        {node.ui?.description ? <p className="rule-card-desc"><Hl text={node.ui.description} query={query} /></p> : null}

        {OUTCOME_GROUPS.map((group) => {
          const items = entry.outcomes.filter((o) => group.statuses.includes(o.status));
          if (!items.length) return null;
          return (
            <section key={group.title} className="rule-outcome-group" data-tone={group.tone}>
              <h4><span aria-hidden="true">{group.icon}</span> {group.title}</h4>
              <ul className="rule-list">
                {items.map((o) => <li key={`${o.status}|${o.text}`}><Plain text={o.text} query={query} /></li>)}
              </ul>
            </section>
          );
        })}

        {entry.findings.length ? (
          <section className="rule-outcome-group">
            <h4>Alasan yang bisa muncul</h4>
            <ul className="rule-list">{entry.findings.map((f) => <li key={f}><Plain text={f} query={query} /></li>)}</ul>
          </section>
        ) : null}

        {hasWrites ? (
          <section className="rule-outcome-group" data-tone="warning">
            <h4>Yang bisa diubah di SIMRS (selalu lewat persetujuan)</h4>
            <ul className="rule-list">
              {entry.actions.map((a) => <li key={`${a.endpointId}|${a.text}`}><Plain text={a.text} query={query} /></li>)}
              {runtimeWrites.map((id) => <li key={id}>{catalog.endpoints[id]?.description ?? id} <em>— alasannya ditentukan saat run</em></li>)}
            </ul>
          </section>
        ) : null}

        <details className="rule-reads rule-tech">
          <summary>Detail teknis</summary>
          <dl className="rule-tech-list">
            <dt>ID langkah</dt><dd><code><Hl text={node.id} query={query} /></code> · {node.kind}</dd>
            {entry.issues.length ? (
              <><dt>Kode peringatan</dt><dd>{entry.issues.map((i) => <div key={`${i.code}|${i.text}`}><code><Hl text={i.code} query={query} /></code> {i.text === '…' ? '' : <Plain text={i.text} query={query} />}</div>)}</dd></>
            ) : null}
            {hasWrites ? (
              <><dt>Endpoint write</dt><dd>{entry.writes.map((id) => <div key={id}><Badge color={RISK_TONE[catalog.endpoints[id]?.riskLevel ?? 'low']}>{catalog.endpoints[id]?.riskLevel}</Badge> <code>{id}</code></div>)}</dd></>
            ) : null}
            {entry.reads.length ? (
              <><dt>Data yang dibaca</dt><dd>{entry.reads.map((id) => <div key={id}><code>{id}</code> — {catalog.endpoints[id]?.description}</div>)}</dd></>
            ) : null}
          </dl>
        </details>
      </CardBody>
    </Card>
  );
}

/**
 * Read-only catalog of what each ranap/rajal step checks, concludes and may
 * write — generated from executor source (scripts/gen-rule-catalog.ts), so it
 * always matches the code that runs.
 */
export function RuleCatalogPage({ onUnauthorized, onDirtyChange }: { onUnauthorized: () => void; onDirtyChange?: (dirty: boolean) => void }) {
  const [domain, setDomain] = useState<'ranap' | 'rajal'>('ranap');
  const [query, setQuery] = useState('');
  const [writesOnly, setWritesOnly] = useState(false);
  const { workflow, catalog } = DOMAINS[domain];
  const sections = useMemo(() => buildRuleSections(workflow, catalog), [workflow, catalog]);
  const visible = sections
    .map((s) => ({ ...s, rows: s.rows.filter((r) => ruleRowMatches(r, query, writesOnly)) }))
    .filter((s) => s.rows.length > 0);
  const shown = visible.reduce((n, s) => n + s.rows.length, 0);

  return (
    <div className="page-stack rules-page">
      <header className="page-heading">
        <div>
          <span className="page-eyebrow">Katalog dibuat dari kode · rule terpilih bisa diedit</span>
          <h1>Rule catalog</h1>
          <p>Setiap kartu menjelaskan satu langkah workflow: apa yang dicek, kapan run lanjut, kapan berhenti atau perlu ditinjau, dan apa yang bisa diubah di SIMRS. Tanda <span className="rule-slot">…</span> diisi nilai sebenarnya saat run.</p>
        </div>
        <ButtonGroup aria-label="Domain">
          {(Object.keys(DOMAINS) as Array<keyof typeof DOMAINS>).map((key) => (
            <Button key={key} color={domain === key ? 'info' : 'secondary'} variant={domain === key ? undefined : 'outline'} aria-pressed={domain === key} onClick={() => setDomain(key)}>
              {DOMAINS[key].label}
            </Button>
          ))}
        </ButtonGroup>
      </header>

      <Alert color="warning" className="rules-wip" role="note">
        <strong>Halaman ini belum selesai — masih dalam pengerjaan.</strong> Katalog dan editor rule sedang dilengkapi;
        isi dan tampilannya bisa berubah, dan belum semua rule tercakup. Gunakan sebagai referensi, bukan acuan final.
      </Alert>

      {/* One editor for both domains: switching keeps the draft (it is not remounted). */}
      <RuleEditor domain={domain} onUnauthorized={onUnauthorized} {...(onDirtyChange ? { onDirtyChange } : {})} />

      <div className="rules-toolbar">
        <div className="rules-search">
          <FormInput type="search" placeholder="Cari langkah, alasan, kode, endpoint…" value={query} onChange={(e) => setQuery(e.target.value)} aria-label="Cari rule" />
          {query ? <button type="button" className="rekap-clear" onClick={() => setQuery('')}>Hapus</button> : null}
        </div>
        <FormCheck id="rules-writes-only" label="Hanya langkah yang menulis" checked={writesOnly} onChange={setWritesOnly} />
        <span className="rules-count">{shown}/{workflow.nodes.length} langkah</span>
      </div>

      {visible.length > 1 ? (
        <nav className="rules-toc" aria-label="Fase workflow">
          {visible.map((section) => (
            <a key={section.id} href={`#rules-${domain}-${section.id}`} className="patient-filter">
              {section.label}<span className="patient-filter-count">{section.rows.length}</span>
            </a>
          ))}
        </nav>
      ) : null}

      {visible.map((section) => (
        <details key={`${domain}-${section.id}`} id={`rules-${domain}-${section.id}`} className="rules-section" open>
          <summary><h2>{section.label}</h2><span className="patient-filter-count">{section.rows.length}</span></summary>
          {section.description ? <p className="rules-section-desc">{section.description}</p> : null}
          <div className="rules-grid">
            {section.rows.map((row) => <RuleCard key={row.node.id} row={row} catalog={catalog} query={query} />)}
          </div>
        </details>
      ))}
      {shown === 0 ? (
        <p className="rules-empty">
          Tidak ada langkah yang cocok.{' '}
          <button type="button" className="rekap-clear" onClick={() => { setQuery(''); setWritesOnly(false); }}>Reset pencarian</button>
        </p>
      ) : null}
    </div>
  );
}
