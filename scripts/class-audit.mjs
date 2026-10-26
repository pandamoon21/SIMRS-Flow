// ponytail: throwaway audit script — class coverage + dead CSS in one shot
import { readFileSync, readdirSync } from 'node:fs';
import { join, relative } from 'node:path';

const root = 'C:/Users/naufa/Documents/Github/PKUAP/apps/ui/src';
const cssPath = join(root, 'styles/theme.css');

// 1. All class selectors defined in theme.css
const cssFiles = ['styles/theme.css', 'styles/workflow.css'];
const css = cssFiles.map((f) => readFileSync(join(root, f), 'utf8')).join('\n');
const cssClasses = new Set();
for (const m of css.matchAll(/\.([a-zA-Z][\w-]*)/g)) cssClasses.add(m[1]);

// 2. All classNames used in TSX/TS (static strings + template literals)
const used = new Map(); // class -> Set of files
function walk(dir) {
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    const p = join(dir, e.name);
    if (e.isDirectory()) walk(p);
    else if (/\.(tsx|ts)$/.test(e.name)) {
      const rel = relative(root, p).replace(/\\/g, '/');
      const src = readFileSync(p, 'utf8');
      const add = (c) => {
        if (c) {
          if (!used.has(c)) used.set(c, new Set());
          used.get(c).add(rel);
        }
      };
      // className="a b c"  className={'a b'}  className={`a ${x}`}
      for (const m of src.matchAll(/className=\{?[`'"]([^`'"]*)[`'"]/g)) {
        for (const c of m[1].split(/\s+/)) add(c);
      }
      // cls.push('x') in primitives
      for (const m of src.matchAll(/(?:cls|parts)\.push\('([\w-]+)'/g)) add(m[1]);
      // join arrays: ['badge', color ? `bg-${color}` : ''] — add known dynamic prefixes
      for (const m of src.matchAll(/`([a-z][\w-]*)-\$\{/g)) add(m[1]); // bg-, alert-, btn-, col- prefixes
    }
  }
}
walk(root);

const missing = [...used.entries()].filter(([c]) => !cssClasses.has(c));
console.log('CSS classes defined:', cssClasses.size, ' TSX classes used:', used.size);
console.log('--- USED IN TSX BUT NOT IN theme.css ---');
for (const [c, f] of missing) console.log(c.padEnd(32), [...f].join(', '));
console.log('--- DEFINED IN CSS BUT UNUSED (sample) ---');
let n = 0;
for (const c of cssClasses) {
  if (!used.has(c) && ++n <= 25) console.log(c);
}
console.log('(unused total:', [...cssClasses].filter((c) => !used.has(c)).length, ')');
