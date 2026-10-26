/**
 * Step reasoning: the checklist behind a step's verdict, for the operator.
 *
 * Executors attach it as ordinary evidence (label {@link REASONING_LABEL}), so
 * it flows through the event stream, ledger and replay with no new event type.
 * Each item is one thing the step checked; `ok` is `true` (met), `false` (not
 * met) or `null` (informational). An item the step resolves by planning a write
 * names that plan, so the UI can show it turning from ✗ into ✓ once the write
 * is verified — e.g. "Visite DPJP tgl 19 ✗ → tambah visite (plan) → ✓".
 */
import type { Evidence } from './types.js';

export const REASONING_LABEL = 'reasoning';

export interface ReasoningItem {
  label: string;
  ok: boolean | null;
  detail?: string;
  /** The MutationPlan id that fixes this item, when the step planned one. */
  planId?: string;
  /** Who the item is about in a batch run — the patient's No. RM — so the UI can trail one patient across steps. */
  subject?: string;
}

export interface Reasoning {
  /** One line naming what was checked, e.g. "Total 3 hari (17–19 Okt)". */
  title?: string;
  items: ReasoningItem[];
}

export function reasoningEvidence(reasoning: Reasoning): Evidence {
  return { label: REASONING_LABEL, data: reasoning };
}

/** The step's reasoning, if it attached one; malformed data is ignored, never thrown. */
export function reasoningOf(evidence: readonly Evidence[] | undefined): Reasoning | undefined {
  const found = evidence?.find((item) => item.label === REASONING_LABEL)?.data as Partial<Reasoning> | undefined;
  if (!found || !Array.isArray(found.items)) return undefined;
  const items = found.items.filter((item): item is ReasoningItem =>
    Boolean(item) && typeof item.label === 'string' && (item.ok === true || item.ok === false || item.ok === null));
  return { ...(typeof found.title === 'string' ? { title: found.title } : {}), items };
}
