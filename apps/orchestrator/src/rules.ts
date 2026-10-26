/**
 * Operator-editable rules (Rules page) — versioned values merged into every
 * run's input as defaults.
 *
 * Only knobs the executors already read from their input live here, so a rule
 * change never touches the write path: allowlist, preconditions and
 * read-after-write verification are unchanged. Each save bumps the version,
 * rewrites `rules.json` atomically and appends the full value set to
 * `rules-history.jsonl`; every run records the version it used in `run.meta`.
 */
import { existsSync, readFileSync } from 'node:fs';
import { appendFile, mkdir, rename, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import type { WorkflowDomain } from '@simrs-flow/workflow-core';
import { BANK_DARAH_UNIT_KEYWORDS, CATHLAB_UNIT_KEYWORDS, IBS_MANUAL_REVIEW_ROOM_TOKEN } from '@simrs-flow/domain-ranap';
import {
  RAJAL_DEFAULT_PAYMENT_CONFIG,
  RAJAL_PAYMENT_TYPE_OPTIONS,
  RAJAL_SHIFT_OPTIONS,
  type RajalPaymentConfig,
  type RajalTreatmentGroup,
} from '@simrs-flow/domain-rajal';

export interface RuleValues {
  ranap: {
    /** Unit keywords whose unpaid orders block verification until settled by hand. */
    bankDarahUnits: string[];
    cathlabUnits: string[];
    /** Wards whose IBS mismatch is downgraded to a manual review. */
    ibsManualReviewRooms: string[];
  };
  rajal: {
    /** Same letter is OR, different letters are AND. */
    treatmentGroups: RajalTreatmentGroup[];
    /** Presence anywhere on the bill rejects it. */
    skipTreatments: string[];
    paymentConfig: RajalPaymentConfig;
  };
}

export interface RuleSet {
  /** 0 = built-in legacy defaults, never saved. */
  version: number;
  updatedAt?: string;
  updatedBy?: string;
  values: RuleValues;
}

export const DEFAULT_RULE_VALUES: RuleValues = {
  ranap: {
    bankDarahUnits: [...BANK_DARAH_UNIT_KEYWORDS],
    cathlabUnits: [...CATHLAB_UNIT_KEYWORDS],
    ibsManualReviewRooms: [IBS_MANUAL_REVIEW_ROOM_TOKEN],
  },
  rajal: { treatmentGroups: [], skipTreatments: [], paymentConfig: { ...RAJAL_DEFAULT_PAYMENT_CONFIG } },
};

export class RuleValidationError extends Error {
  readonly statusCode = 400;
}
export class RuleConflictError extends Error {
  readonly statusCode = 409;
}

const MAX_ITEMS = 50;

function stringList(value: unknown, field: string, maxLength = 80): string[] {
  if (!Array.isArray(value)) throw new RuleValidationError(`${field} harus berupa daftar`);
  const out: string[] = [];
  for (const item of value) {
    if (typeof item !== 'string') throw new RuleValidationError(`${field} hanya boleh berisi teks`);
    const text = item.trim();
    if (!text) continue;
    if (text.length > maxLength) throw new RuleValidationError(`${field}: "${text.slice(0, 20)}…" lebih dari ${maxLength} karakter`);
    if (!out.includes(text)) out.push(text);
  }
  if (out.length > MAX_ITEMS) throw new RuleValidationError(`${field}: maksimal ${MAX_ITEMS} entri`);
  return out;
}

function record(value: unknown, field: string): Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) throw new RuleValidationError(`${field} tidak valid`);
  return value as Record<string, unknown>;
}

/** Trust boundary: the body of `PUT /api/rules`. Returns normalized values or throws. */
export function validateRuleValues(raw: unknown): RuleValues {
  const root = record(raw, 'values');
  const ranap = record(root.ranap, 'ranap');
  const rajal = record(root.rajal, 'rajal');

  if (!Array.isArray(rajal.treatmentGroups)) throw new RuleValidationError('treatmentGroups harus berupa daftar');
  if (rajal.treatmentGroups.length > MAX_ITEMS) throw new RuleValidationError(`treatmentGroups: maksimal ${MAX_ITEMS} entri`);
  const keys = new Set<string>();
  const treatmentGroups = rajal.treatmentGroups.map((item, i) => {
    const g = record(item, `treatmentGroups[${i + 1}]`);
    const group = typeof g.group === 'string' ? g.group.trim().toUpperCase() : '';
    const key = typeof g.key === 'string' ? g.key.trim() : '';
    const name = typeof g.name === 'string' ? g.name.trim() : '';
    if (!/^[A-Z]$/.test(group)) throw new RuleValidationError(`treatmentGroups[${i + 1}]: grup harus satu huruf A–Z`);
    if (!key || key.length > 40) throw new RuleValidationError(`treatmentGroups[${i + 1}]: key wajib, maksimal 40 karakter`);
    if (!name || name.length > 120) throw new RuleValidationError(`treatmentGroups[${i + 1}]: nama tindakan wajib, maksimal 120 karakter`);
    if (keys.has(key)) throw new RuleValidationError(`treatmentGroups: key "${key}" dipakai dua kali`);
    keys.add(key);
    return { group, key, name };
  });

  const pay = record(rajal.paymentConfig, 'paymentConfig');
  const shift = String(pay.shift ?? '').trim();
  const type = String(pay.type ?? '').trim();
  const payerCode = String(pay.payerCode ?? '').trim();
  if (!RAJAL_SHIFT_OPTIONS.some((o) => o.code === shift)) throw new RuleValidationError('paymentConfig.shift tidak dikenal');
  if (!RAJAL_PAYMENT_TYPE_OPTIONS.some((o) => o.code === type)) throw new RuleValidationError('paymentConfig.type tidak dikenal');
  if (!/^\d{1,4}$/.test(payerCode)) throw new RuleValidationError('paymentConfig.payerCode harus 1–4 digit');

  return {
    ranap: {
      bankDarahUnits: stringList(ranap.bankDarahUnits, 'bankDarahUnits'),
      cathlabUnits: stringList(ranap.cathlabUnits, 'cathlabUnits'),
      ibsManualReviewRooms: stringList(ranap.ibsManualReviewRooms, 'ibsManualReviewRooms'),
    },
    rajal: {
      treatmentGroups,
      skipTreatments: stringList(rajal.skipTreatments, 'skipTreatments', 120),
      paymentConfig: { shift, type, payerCode },
    },
  };
}

/**
 * The run input with the rule values filled in as defaults. A field the
 * request sets explicitly wins, so a scripted run can still pin its own value.
 */
export function applyRules(domain: WorkflowDomain, input: unknown, values: RuleValues): unknown {
  if (!input || typeof input !== 'object' || Array.isArray(input)) return input;
  const given = Object.fromEntries(Object.entries(input).filter(([, v]) => v !== undefined));
  if (domain === 'ranap') {
    return {
      manualBlockerUnits: { bankDarah: values.ranap.bankDarahUnits, cathlab: values.ranap.cathlabUnits },
      ibsManualReviewRooms: values.ranap.ibsManualReviewRooms,
      ...given,
    };
  }
  if (domain === 'rajal') {
    return {
      treatmentGroups: values.rajal.treatmentGroups,
      skipTreatments: values.rajal.skipTreatments,
      paymentConfig: values.rajal.paymentConfig,
      ...given,
    };
  }
  return input;
}

/**
 * Current rule set; persisted under `dir` when given, memory-only otherwise.
 * ponytail: one JSON file + history JSONL, single host; move to the database
 * alongside the ledger if PostgreSQL ever lands.
 */
export class RuleStore {
  private current: RuleSet;
  private saving: Promise<unknown> = Promise.resolve();
  /** Every saved version, oldest first; mirrors rules-history.jsonl. */
  private readonly versions: RuleSet[] = [];

  constructor(private readonly dir?: string) {
    const historyFile = dir ? join(dir, 'rules-history.jsonl') : undefined;
    if (historyFile && existsSync(historyFile)) {
      // ponytail: whole file in memory; one line per save, fine for a single host's lifetime.
      for (const line of readFileSync(historyFile, 'utf8').split('\n')) {
        if (!line.trim()) continue;
        try { this.versions.push(JSON.parse(line) as RuleSet); } catch { /* a torn last line is skipped, not fatal */ }
      }
    }
    const file = dir ? join(dir, 'rules.json') : undefined;
    if (file && existsSync(file)) {
      const saved = JSON.parse(readFileSync(file, 'utf8')) as RuleSet;
      // Re-validate on load: a hand-edited file must not bypass the rules above.
      this.current = { ...saved, values: validateRuleValues(saved.values) };
    } else {
      this.current = { version: 0, values: structuredClone(DEFAULT_RULE_VALUES) };
    }
  }

  get(): RuleSet {
    return structuredClone(this.current);
  }

  /** Saved versions, newest first. */
  history(limit = 20): RuleSet[] {
    return structuredClone(this.versions.slice(-Math.max(1, limit)).reverse());
  }

  /** Save a new version. `baseVersion` must be the version the editor loaded (409 otherwise). */
  save(raw: unknown, baseVersion: unknown, operator: string, now = new Date()): Promise<RuleSet> {
    const next = this.saving.then(async () => {
      if (baseVersion !== this.current.version) {
        throw new RuleConflictError(`Rule sudah diubah ke versi ${this.current.version}; muat ulang lalu simpan lagi`);
      }
      const set: RuleSet = {
        version: this.current.version + 1,
        updatedAt: now.toISOString(),
        updatedBy: operator,
        values: validateRuleValues(raw),
      };
      if (this.dir) {
        await mkdir(this.dir, { recursive: true });
        const file = join(this.dir, 'rules.json');
        await writeFile(`${file}.tmp`, JSON.stringify(set, null, 2), 'utf8');
        await rename(`${file}.tmp`, file);
        await appendFile(join(this.dir, 'rules-history.jsonl'), JSON.stringify(set) + '\n', 'utf8');
      }
      this.current = set;
      this.versions.push(set);
      return structuredClone(set);
    });
    this.saving = next.catch(() => undefined);
    return next;
  }
}
