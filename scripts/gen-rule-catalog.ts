/**
 * Rule catalog generator — what each ranap/rajal node can conclude and touch,
 * read straight out of the executor source so the page cannot drift from code.
 *
 *   node --import tsx scripts/gen-rule-catalog.ts
 *
 * Writes `packages/domain-{ranap,rajal}/src/ruleCatalog.generated.ts`. The
 * domain `ruleCatalog.test.ts` regenerates in memory and fails when the
 * committed file is stale.
 *
 * Per executor it walks the executor body plus, transitively, every function
 * or constant it references inside the same domain package, and collects:
 *   - outcomes: `ok/fail/blocked/skipped/review/planResult('…')` calls and
 *     `{ status: '…', summary: '…' }` literals
 *   - issues:   `warning('code', '…')` calls and `{ code: '…', message: '…' }` literals
 *   - actions:  `{ endpointId: '…', reason: '…' }` mutation plans
 *   - reads/writes: any string literal that is an EvoMedis endpoint id
 * ponytail: static extraction — a summary built from a variable is invisible
 * (only literal/template texts are listed); upgrade to runtime capture if the
 * gaps start to matter.
 */
import { fileURLToPath, pathToFileURL } from 'node:url';
import { dirname, join, resolve, sep } from 'node:path';
import { writeFileSync } from 'node:fs';
import ts from 'typescript';
import { ENDPOINTS } from '../packages/evomedis-client/src/endpoints.js';
import type { RuleCatalog, RuleCatalogEndpoint, RuleCatalogEntry, StepStatus, WorkflowDefinition } from '../packages/workflow-core/src/types.js';
import { ranapWorkflow } from '../packages/domain-ranap/src/workflow.js';
import { rajalWorkflow } from '../packages/domain-rajal/src/workflow.js';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');

const OUTCOME_HELPERS: Record<string, StepStatus> = {
  ok: 'success',
  fail: 'failed',
  blocked: 'blocked',
  skipped: 'skipped',
  review: 'needs_review',
  planResult: 'needs_review',
};
const STATUSES = new Set<string>(['success', 'failed', 'skipped', 'blocked', 'needs_review']);
/** List names the executors collect detail reasons into before joining them into a summary. */
const FINDING_LISTS = /^(issues|hard|soft|review|refusals|unbalanced|problems|blocking|blockers|notLanded|failed|ambiguous|notRajal|unreadable)$/;
const ENDPOINT_IDS = ENDPOINTS as Record<string, RuleCatalogEndpoint & { kind: 'read' | 'mutate' | 'auth' }>;

export const DOMAINS = {
  ranap: { workflow: ranapWorkflow, file: 'packages/domain-ranap/src/executors.ts', out: 'packages/domain-ranap/src/ruleCatalog.generated.ts', name: 'ranapRuleCatalog' },
  rajal: { workflow: rajalWorkflow, file: 'packages/domain-rajal/src/executors.ts', out: 'packages/domain-rajal/src/ruleCatalog.generated.ts', name: 'rajalRuleCatalog' },
} as const;

/** Literal text of a string/template expression; `${…}` spans become `…`. */
function textOf(node: ts.Node | undefined): string | undefined {
  if (!node) return undefined;
  if (ts.isStringLiteral(node) || ts.isNoSubstitutionTemplateLiteral(node)) return node.text.replace(/\s+/g, ' ').trim();
  if (ts.isBinaryExpression(node) && node.operatorToken.kind === ts.SyntaxKind.PlusToken) {
    const left = textOf(node.left) ?? '…';
    const right = textOf(node.right) ?? '…';
    return left === '…' && right === '…' ? undefined : `${left}${right}`.replace(/\s+/g, ' ').trim();
  }
  if (ts.isParenthesizedExpression(node)) return textOf(node.expression);
  if (ts.isTemplateExpression(node)) {
    const text = node.head.text + node.templateSpans.map((s) => `…${s.literal.text}`).join('');
    return text.replace(/\s+/g, ' ').trim();
  }
  return undefined;
}

/** `textOf`, also following a local `const x = '…'` the call passes by name. */
function argText(node: ts.Node | undefined, checker: ts.TypeChecker): string | undefined {
  const direct = textOf(node);
  if (direct !== undefined || !node || !ts.isIdentifier(node)) return direct;
  const decl = checker.getSymbolAtLocation(node)?.valueDeclaration;
  return decl && ts.isVariableDeclaration(decl) ? textOf(decl.initializer) : undefined;
}

/** A table's object literal, looking through `as const` / `satisfies`. */
function objectOf(node: ts.Expression | undefined): ts.ObjectLiteralExpression | undefined {
  while (node && (ts.isAsExpression(node) || ts.isSatisfiesExpression(node) || ts.isParenthesizedExpression(node))) node = node.expression;
  return node && ts.isObjectLiteralExpression(node) ? node : undefined;
}

function propText(obj: ts.ObjectLiteralExpression, key: string): string | undefined {
  for (const p of obj.properties) {
    if (ts.isPropertyAssignment(p) && p.name.getText() === key) return textOf(p.initializer);
  }
  return undefined;
}

export function buildCatalog(workflow: WorkflowDefinition, executorsFile: string): RuleCatalog {
  const abs = join(ROOT, executorsFile);
  const pkgSrc = dirname(abs) + sep;
  const program = ts.createProgram([abs], { target: ts.ScriptTarget.ES2022, module: ts.ModuleKind.ESNext, moduleResolution: ts.ModuleResolutionKind.Bundler, noEmit: true });
  const checker = program.getTypeChecker();
  const source = program.getSourceFile(abs)!;
  const inPackage = (sf: ts.SourceFile) => resolve(sf.fileName).startsWith(pkgSrc) && !sf.fileName.endsWith('.test.ts');

  // Executor registry: properties named like "ranap.xxx" in an object literal.
  const executors = new Map<string, ts.Node>();
  const findRegistry = (node: ts.Node): void => {
    if (ts.isPropertyAssignment(node) && ts.isStringLiteral(node.name) && /^[a-z]+\.[A-Za-z]+$/.test(node.name.text)) {
      executors.set(node.name.text, node.initializer);
    }
    ts.forEachChild(node, findRegistry);
  };
  findRegistry(source);

  /** Declarations an identifier resolves to, limited to this domain package. */
  const declarationsOf = (id: ts.Identifier): ts.Node[] => {
    let symbol = checker.getSymbolAtLocation(id);
    if (symbol && symbol.flags & ts.SymbolFlags.Alias) symbol = checker.getAliasedSymbol(symbol);
    return (symbol?.declarations ?? []).filter((d) => {
      if (!inPackage(d.getSourceFile())) return false;
      // Only module-level functions/constants: locals are already inside the walked body.
      return ts.isFunctionDeclaration(d) || (ts.isVariableDeclaration(d) && ts.isSourceFile(d.parent.parent.parent));
    });
  };

  /** `endpointId` of a plan literal: a string, or `TABLE.member` on a module-level table. */
  const endpointOf = (obj: ts.ObjectLiteralExpression): string | undefined => {
    const p = obj.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText() === 'endpointId');
    if (!p) return undefined;
    const direct = textOf(p.initializer);
    if (direct) return direct;
    if (ts.isPropertyAccessExpression(p.initializer) && ts.isIdentifier(p.initializer.expression)) {
      const member = p.initializer.name.text;
      for (const d of declarationsOf(p.initializer.expression)) {
        const table = ts.isVariableDeclaration(d) ? objectOf(d.initializer) : undefined;
        if (!table) continue;
        const prop = table.properties.find((q): q is ts.PropertyAssignment => ts.isPropertyAssignment(q) && q.name.getText() === member);
        const text = textOf(prop?.initializer);
        if (text) return text;
      }
    }
    return undefined;
  };

  const entries: RuleCatalogEntry[] = [];
  const used = new Set<string>();
  for (const node of workflow.nodes) {
    const root = executors.get(node.executorRef);
    const outcomes = new Map<string, { status: StepStatus; text: string }>();
    const issues = new Map<string, { code: string; text: string }>();
    const findings = new Set<string>();
    const actions = new Map<string, { endpointId: string; text: string }>();
    const reads = new Set<string>();
    const writes = new Set<string>();
    const seen = new Set<ts.Node>();
    const walk = (n: ts.Node): void => {
      if (seen.has(n)) return;
      seen.add(n);
      if (ts.isCallExpression(n) && ts.isIdentifier(n.expression)) {
        const status = OUTCOME_HELPERS[n.expression.text];
        const text = argText(n.arguments[0], checker);
        if (status && text) outcomes.set(`${status}|${text}`, { status, text });
        if (n.expression.text === 'warning') {
          const code = textOf(n.arguments[0]);
          if (code) issues.set(code + '|' + (textOf(n.arguments[1]) ?? ''), { code, text: textOf(n.arguments[1]) ?? '…' });
        }
      }
      if (
        ts.isCallExpression(n) && ts.isPropertyAccessExpression(n.expression) && n.expression.name.text === 'push' &&
        ts.isIdentifier(n.expression.expression) && FINDING_LISTS.test(n.expression.expression.text)
      ) {
        const text = textOf(n.arguments[0]);
        if (text && /[A-Za-z]{3,}/.test(text)) findings.add(text);
      }
      if (ts.isObjectLiteralExpression(n)) {
        const status = propText(n, 'status');
        const summary = propText(n, 'summary');
        if (status && STATUSES.has(status) && summary) outcomes.set(`${status}|${summary}`, { status: status as StepStatus, text: summary });
        const reason = propText(n, 'reason');
        const endpointId = endpointOf(n);
        if (reason && endpointId && ENDPOINT_IDS[endpointId]?.kind === 'mutate') actions.set(`${endpointId}|${reason}`, { endpointId, text: reason });
        // A decision reason with no endpoint (a planner's "leave alone" / "add" verdict).
        else if (reason && !endpointId && /[A-Za-z]{3,}/.test(reason)) findings.add(reason);
        const code = propText(n, 'code');
        const message = propText(n, 'message');
        if (code && /^[a-z][a-z0-9_]*$/.test(code) && message !== undefined) issues.set(`${code}|${message}`, { code, text: message });
      }
      if ((ts.isStringLiteral(n) || ts.isNoSubstitutionTemplateLiteral(n)) && ENDPOINT_IDS[n.text]) {
        (ENDPOINT_IDS[n.text]!.kind === 'mutate' ? writes : reads).add(n.text);
      }
      // `TABLE.member` on a module-level object literal: walk only that member,
      // not every entry of a shared table like PRECONDITION.
      if (ts.isPropertyAccessExpression(n) && ts.isIdentifier(n.expression)) {
        const member = n.name.text;
        const tables = declarationsOf(n.expression)
          .map((d) => (ts.isVariableDeclaration(d) ? objectOf(d.initializer) : undefined))
          .filter((o): o is ts.ObjectLiteralExpression => !!o);
        if (tables.length > 0) {
          for (const t of tables) {
            const prop = t.properties.find((p) => p.name?.getText() === member);
            if (prop) walk(prop);
          }
          return;
        }
      }
      if (ts.isIdentifier(n) && !(ts.isPropertyAccessExpression(n.parent) && n.parent.name === n)) {
        for (const d of declarationsOf(n)) walk(d);
      }
      ts.forEachChild(n, walk);
    };
    if (root) walk(root);
    for (const id of [...reads, ...writes]) used.add(id);
    entries.push({
      nodeId: node.id,
      executorRef: node.executorRef,
      outcomes: [...outcomes.values()],
      issues: [...issues.values()],
      findings: [...findings],
      actions: [...actions.values()],
      reads: [...reads].sort(),
      writes: [...writes].sort(),
    });
  }

  const endpoints: Record<string, RuleCatalogEndpoint> = {};
  for (const id of [...used].sort()) {
    const def = ENDPOINT_IDS[id]!;
    endpoints[id] = { id, kind: def.kind, riskLevel: def.riskLevel, description: def.description };
  }
  return { workflowId: workflow.id, entries, endpoints };
}

export function renderCatalog(name: string, catalog: RuleCatalog): string {
  return [
    '// GENERATED by scripts/gen-rule-catalog.ts — do not edit; rerun the script.',
    "import type { RuleCatalog } from '@simrs-flow/workflow-core';",
    '',
    `export const ${name}: RuleCatalog = ${JSON.stringify(catalog, null, 2)};`,
    '',
  ].join('\n');
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  for (const d of Object.values(DOMAINS)) {
    const catalog = buildCatalog(d.workflow, d.file);
    writeFileSync(join(ROOT, d.out), renderCatalog(d.name, catalog));
    const outcomes = catalog.entries.reduce((a, e) => a + e.outcomes.length, 0);
    console.log(`${d.out}: ${catalog.entries.length} nodes, ${outcomes} outcomes, ${Object.keys(catalog.endpoints).length} endpoints`);
  }
}
