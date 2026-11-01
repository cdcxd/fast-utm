// Usage: bun scripts/inline.ts [--check]
//
// Expands `// @inline name(args); key = value; ... // @end` regions from the `// @kernel` function `name` in the same
// file, or in a file before it in FILES (whose closure must then bind the non-numeric names the kernel reads). Engines
// optimize a loop with the kernel written out in it much better than one calling a kernel that returns through
// closure variables (Node and Chromium up to 2×), so the batch loops hold copies and the point methods call the
// kernel. Options rename identifiers in the copy, parameters included (`rx = out[i]`); `return = ...` replaces a bare
// `return;` (default `continue;`); `scope = open` leaves out the enclosing block, so code after the region can read
// the copy's locals. A kernel's own regions are expanded before it is copied. --check fails if a region is stale.
//
// `// @locals name` ... `// @end` before a loop declares the closure constants kernel `name` reads as locals (`kAL =
// kA`), and an @inline region with the option `locals` reads them: JavaScriptCore reloads a closure variable at every
// use in a loop (Bun 7-10% on the TM rows), V8 doesn't.
//
// Copies also take the kernel's file's module-level numeric constants (`const KS1 = P.KS1;`, `const D2R = Math.PI /
// 180;`) as literals, a bare `Math.LOG2E` as written: V8 reloads a module const from its context on every use in on-stack-replacement code, which is how a batch
// loop called a few hundred times runs (up to 1.9x slower in Node; JavaScriptCore folds them either way).
import { execFileSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

const src = join(dirname(fileURLToPath(import.meta.url)), '../src');
const FILES = ['tmerc.ts', 'gcj02.ts', 'gcj02-fused.ts', 'webmerc.ts', 'bd09.ts'];

type Kernel = { params: string[]; body: string[]; consts: Map<string, string>; mutable: Set<string> };

// The modules the kernels' files bind constants from, under their import names.
const MODULES = { P: await import(join(src, 'poly.ts')), K: await import(join(src, 'gcj02-constants.ts')) };

// Module-level `const NAME = expr;` lines whose value is a number, each as its shortest round-trip literal.
function constants(lines: string[]): Map<string, string> {
  const vals = new Map<string, number>();
  const bare = new Map<string, string>();
  for (const l of lines) {
    const m = /^const (\w+) = ([^;]+);$/.exec(l);
    if (!m || /\bnew\b|=>|\(\)/.test(m[2]!)) continue;
    let v: unknown;
    try {
      v = Function(
        ...Object.keys(MODULES),
        ...vals.keys(),
        `return (${m[2]});`,
      )(...Object.values(MODULES), ...vals.values());
    } catch {
      continue;
    }
    if (typeof v === 'number' && Number.isFinite(v)) {
      vals.set(m[1]!, v);
      if (/^Math\.\w+$/.test(m[2]!)) bare.set(m[1]!, m[2]!);
    }
  }
  return new Map([...vals].map(([k, v]) => [k, bare.get(k) ?? String(v)]));
}

// Names the file declares with let or var, or assigns other than in a const declaration (a parameter, say): a
// @locals copy of one could go stale.
function mutableNames(lines: string[]): Set<string> {
  const out = new Set<string>();
  let inConst = false;
  for (const raw of lines) {
    const l = raw.replace(/\/\/.*$/, '');
    for (const m of l.matchAll(/\b(?:let|var)\s+([^=;]+?)\s*(?:=|;)/g))
      for (const n of m[1]!.split(',')) out.add(n.split(':')[0]!.trim());
    const decl = inConst || /^\s*const\b/.test(l);
    // In a const declaration only `name =` at the start of the line or after `const`/a comma declares.
    const body = decl ? l.replace(/^\s*(?:const\s+)?\w+\s*=(?!=)/, '').replace(/,\s*\w+\s*=(?!=)/g, ',') : l;
    const assign = /(?<![.\w$])([A-Za-z_$][\w$]*)\s*(?:(?:\*\*|<<|>>>?|&&|\|\||\?\?|[-+*/%&|^])?=(?!=)|\+\+|--)/g;
    for (const m of body.matchAll(assign)) out.add(m[1]!);
    // Destructuring assignments: `[a, b] = ...`, `({ a, b } = ...)`.
    for (const m of body.matchAll(/(?<!\b(?:const|let|var)\s*)[[{]([^\]}=]*)[\]}]\s*=(?!=)/g))
      for (const n of m[1]!.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*/g)) out.add(n[0]);
    for (const m of body.matchAll(/(?:\+\+|--)([A-Za-z_$][\w$]*)/g)) out.add(m[1]!);
    if (decl) inConst = !/;\s*$/.test(l);
  }
  return out;
}

const MARKER = /\/\/\s*@(kernel|inline|locals|end)\b/;

// Every marker-like comment must be one the script reads: a typo would otherwise leave a region unexpanded.
function checkMarkers(lines: string[]): void {
  lines.forEach((l, i) => {
    if (MARKER.test(l) && !/^\s*\/\/ @(kernel|end)$/.test(l) && !REGION.test(l) && !LOCALS.test(l))
      throw new Error(`malformed marker at line ${i + 1}: ${l.trim()}`);
  });
}

function kernels(lines: string[]): Map<string, Kernel> {
  const found = new Map<string, Kernel>();
  const consts = constants(lines);
  const mutable = mutableNames(lines);
  for (let i = 0; i < lines.length; i++) {
    if (lines[i]!.trim() !== '// @kernel') continue;
    // A lint directive may sit between the marker and the header: a kernel only ever copied in is never called.
    const h = /^\s*\/\/ oxlint-disable-next-line /.test(lines[i + 1]!) ? i + 2 : i + 1;
    const m = /^(\s*)function (\w+)\(([^)]*)\)(?:: \w+)? \{$/.exec(lines[h]!);
    if (!m) throw new Error(`@kernel at line ${i + 1} is not followed by a one-line function header`);
    const end = lines.indexOf(`${m[1]}}`, h + 1);
    const params = m[3]!.split(',').map((p) => p.split(':')[0]!.trim());
    found.set(m[2]!, { params, body: lines.slice(h + 1, end), consts, mutable });
  }
  return found;
}

// Splits on commas outside brackets.
function splitArgs(s: string): string[] {
  const out: string[] = [];
  let depth = 0;
  let cur = '';
  for (const ch of s) {
    if ('([{'.includes(ch)) depth++;
    if (')]}'.includes(ch)) depth--;
    if (ch === ',' && depth === 0) {
      out.push(cur.trim());
      cur = '';
    } else cur += ch;
  }
  if (cur.trim()) out.push(cur.trim());
  return out;
}

const REGION = /^(\s*)\/\/ @inline (\w+)\((.*?)\)((?:; [^;]+)*)$/;
const LOCALS = /^(\s*)\/\/ @locals (\w+)$/;

// Names a kernel declares: `const a = ...`, `let a, b;`, `, b = ...`.
function declaredIn(text: string): Set<string> {
  const out = new Set<string>();
  for (const m of text.matchAll(/\b(?:const|let)\s+([^=;]+?)\s*(?:=|;)/g))
    for (const n of m[1]!.split(',')) out.add(n.split(':')[0]!.trim());
  for (const m of text.matchAll(/,\s+(\w+) = /g)) out.add(m[1]!);
  return out;
}

const NOT_FREE = new Set(
  'const let var if else return throw for of in while do break continue switch case default true false null undefined typeof instanceof void new Math NaN Infinity Number number boolean'.split(
    ' ',
  ),
);

// The kernel's free names that are neither its parameters, literal constants nor ever reassigned: the enclosing
// function's constants, which a @locals region hoists.
function closureNames(k: Kernel): string[] {
  const text = k.body
    .filter((l) => !/^\s*\/\//.test(l))
    .map((l) => l.replace(/\/\/.*$/, ''))
    .join('\n');
  const declared = declaredIn(text);
  const names = new Set<string>();
  // Words in string literals aren't names.
  const code = text.replace(/(['"`])(?:\\.|(?!\1).)*\1/g, '""');
  for (const m of code.matchAll(/(?<![.\w$])[A-Za-z_$][\w$]*\b(?!\s*:(?!\s*[\w(-]))/g)) {
    const n = m[0];
    if (NOT_FREE.has(n) || declared.has(n) || k.params.includes(n) || k.consts.has(n) || k.mutable.has(n)) continue;
    names.add(n);
  }
  const out = [...names].toSorted();
  for (const n of out)
    if (new RegExp(`(?<![.\\w$])${n}L\\b`).test(text)) throw new Error(`${n}L is taken: @locals names ${n} so`);
  return out;
}

function regions(
  lines: string[],
): { start: number; end: number; indent: string; name: string; args: string[]; opts: [string, string][] }[] {
  const out = [];
  for (let i = 0; i < lines.length; i++) {
    const m = REGION.exec(lines[i]!);
    if (!m) continue;
    // The next marker must be this region's @end: an @end at another indent would otherwise pair with a later one.
    const end = lines.findIndex((l, j) => j > i && MARKER.test(l));
    if (end < 0 || lines[end] !== `${m[1]}// @end`)
      throw new Error(`@inline at line ${i + 1} has no @end at its indent`);
    const opts = m[4]!
      .split(';')
      .slice(1)
      .map((o) => {
        const [k, ...v] = o.split('=');
        return [k!.trim(), v.join('=').trim()] as [string, string];
      });
    out.push({ start: i, end, indent: m[1]!, name: m[2]!, args: splitArgs(m[3]!), opts });
  }
  return out;
}

function dedent(body: string[]): string[] {
  const n = Math.min(...body.filter((l) => l.trim()).map((l) => l.length - l.trimStart().length));
  return body.map((l) => l.slice(n));
}

function expand(k: Kernel, name: string, args: string[], opts: [string, string][]): string[] {
  if (args.length !== k.params.length) throw new Error(`@inline ${name}: ${args.length} args for ${k.params.length}`);
  // Copies drop whole-line comments, the kernel being the commented reference, but keep lint directives.
  const body = dedent(k.body.filter((l) => !/^\s*\/\/(?! oxlint-disable-next-line )/.test(l)));
  const text = body.join('\n');
  const declared = declaredIn(text);
  const open = opts.some(([key, v]) => key === 'scope' && v === 'open');
  const pad = open ? '' : '  ';
  const out = open ? [] : ['{'];
  const exit = opts.find(([key]) => key === 'return')?.[1] ?? 'continue;';
  const renames = opts.filter(([key]) => key !== 'return' && key !== 'scope' && key !== 'locals');
  if (opts.some(([key]) => key === 'locals'))
    for (const n of closureNames(k)) if (!renames.some(([from]) => from === n)) renames.push([n, `${n}L`]);
  for (const [from] of renames)
    if (!k.params.includes(from) && !new RegExp(`(?<![.\\w$])${from}\\b`).test(text))
      throw new Error(`@inline ${name}: rename ${from} matches nothing`);
  // One pass, so a rename's target is never renamed again (s1 = s2; s2 = s3).
  const renamed = new Map(renames);
  if (renamed.size < renames.length) throw new Error(`@inline ${name}: a name renamed twice`);
  const renameRe = renames.length
    ? new RegExp(`(?<![.\\w$])(?:${renames.map(([from]) => from).join('|')})\\b`, 'g')
    : null;
  // The name each parameter is bound to in the copy.
  const bounds = k.params.map((p) => renames.find(([from]) => from === p)?.[1] ?? p);
  // Constants the copy doesn't shadow, as literals; a property name or key (`.K`, `K:`) is left alone.
  const lits = [...k.consts].filter(([c]) => !declared.has(c) && !bounds.includes(c) && !renamed.has(c));
  const litRe = lits.length ? new RegExp(`(?<![.\\w$])(?:${lits.map(([c]) => c).join('|')})\\b(?!\\s*:)`, 'g') : null;
  const litOf = new Map(lits);
  k.params.forEach((p, i) => {
    const a = args[i]!;
    const bound = bounds[i]!;
    if (a === bound) return;
    for (const id of a.match(/\b[A-Za-z_]\w*\b/g) ?? []) {
      if (declared.has(id) || bounds.some((q, j) => q === id && args[j] !== q))
        throw new Error(`@inline ${name}: argument ${a} uses ${id}, a name the kernel binds`);
    }
    const mutated = new RegExp(`\\b${p}\\s*(?:[-+*/%]?=)(?!=)`).test(text);
    out.push(`${pad}${mutated ? 'let' : 'const'} ${bound} = ${a};`);
  });
  // Blocks opened by loops and functions: a `return;` inside one can't become `continue;`.
  const nested: boolean[] = [];
  for (let line of body) {
    if (/\breturn\b(?!;)/.test(line.replace(/\breturn;/g, '')))
      throw new Error(`@inline ${name}: only a bare return can be replaced`);
    if (/\breturn;/.test(line) && nested.includes(true))
      throw new Error(`@inline ${name}: return inside a nested loop or function`);
    for (const [from] of renames)
      if (new RegExp(`['"\`][^'"\`]*\\b${from}\\b`).test(line)) throw new Error(`@inline ${name}: ${from} in a string`);
    for (const ch of line) {
      if (ch === '{') nested.push(/^\s*(?:for|while|do)\b|=>|\bfunction\b/.test(line));
      if (ch === '}') nested.pop();
    }
    line = line.replace(/\breturn;/g, exit);
    if (renameRe) line = line.replace(renameRe, (from) => renamed.get(from)!);
    if (litRe) line = line.replace(litRe, (c) => litOf.get(c)!);
    out.push(line ? pad + line : '');
  }
  if (!open) out.push('}');
  return out;
}

function generate(text: string, earlier: Map<string, Kernel>): string {
  let lines = text.split('\n');
  checkMarkers(lines);
  // A copy of a kernel that itself has regions may be stale until those are expanded: repeat until nothing changes.
  for (let pass = 0; pass < 10; pass++) {
    const own = kernels(lines);
    for (const name of own.keys()) if (earlier.has(name)) throw new Error(`@kernel ${name} is defined in two files`);
    const ks = new Map([...earlier, ...own]);
    const next = [...lines];
    const rs = regions(lines);
    // Last first, so splicing doesn't move the regions not yet done.
    for (let i = rs.length - 1; i >= 0; i--) {
      const r = rs[i]!;
      const k = ks.get(r.name);
      if (!k) throw new Error(`@inline ${r.name}: no @kernel of that name`);
      const copy = expand(k, r.name, r.args, r.opts).map((l) => (l ? r.indent + l : l));
      next.splice(r.start + 1, r.end - r.start - 1, ...copy);
    }
    // @locals regions, last first likewise.
    for (let i = next.length - 1; i >= 0; i--) {
      const m = LOCALS.exec(next[i]!);
      if (!m) continue;
      const k = ks.get(m[2]!);
      if (!k) throw new Error(`@locals ${m[2]}: no @kernel of that name`);
      const end = next.findIndex((l, j) => j > i && MARKER.test(l));
      if (end < 0 || next[end] !== `${m[1]}// @end`)
        throw new Error(`@locals at line ${i + 1} has no @end at its indent`);
      const names = closureNames(k);
      const decl = names.length ? [`${m[1]}const ${names.map((n) => `${n}L = ${n}`).join(', ')};`] : [];
      next.splice(i + 1, end - i - 1, ...decl);
    }
    if (next.join('\n') === lines.join('\n')) return lines.join('\n');
    lines = next;
  }
  throw new Error('@inline regions did not settle (a kernel inlines itself?)');
}

const check = process.argv.includes('--check');
const squash = (s: string) => s.replace(/\s+/g, '');
const stale: string[] = [];
const earlier = new Map<string, Kernel>();
for (const f of FILES) {
  const path = join(src, f);
  const text = readFileSync(path, 'utf8');
  const out = generate(text, earlier);
  for (const [name, k] of kernels(out.split('\n'))) earlier.set(name, k);
  // oxfmt may rewrap the copies, so compare ignoring whitespace.
  if (squash(out) === squash(text)) continue;
  if (check) stale.push(f);
  else writeFileSync(path, out);
}
if (check && stale.length) {
  console.error(`stale @inline regions in ${stale.join(', ')}: run bun scripts/inline.ts`);
  process.exit(1);
}
if (!check) execFileSync('bunx', ['oxfmt', ...FILES.map((f) => join(src, f))], { stdio: 'inherit' });
