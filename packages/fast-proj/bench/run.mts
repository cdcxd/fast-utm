// Usage: node bench/run.mts [--browser] [--runs=N]   (bun bench/run.mts for Bun)
// CHROME=/path/to/chrome overrides the Playwright Chromium.
import { readFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';

declare global {
  // Only defined when the script runs under Bun; the `typeof` guards keep Node honest.
  const Bun:
    | { version: string; Transpiler: new (options: { loader: 'ts' }) => { transformSync(code: string): string } }
    | undefined;
  interface Window {
    gcoord: {
      readonly WGS84: unknown;
      readonly GCJ02: unknown;
      readonly BD09: unknown;
      transform(...args: unknown[]): unknown;
    };
  }
}

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const args = process.argv.slice(2);
const runs = Number(args.find((a) => a.startsWith('--runs='))?.slice(7) ?? 31);
const n = 10000;

async function inProcess() {
  const { default: proj4 } = await import('proj4');
  const { default: gcoord } = await import('gcoord');
  const { GCJ02, bd09, gcj02, utm, webMercator } = await import('../dist/index.js');
  const { lineString } = await import('../dist/geojson.js');
  const { loadWasm } = await import('../dist/wasm.js');
  const { runBdCases, runCases, runComposedCases, runGcjCases, runMercatorCases } = await import('./cases.mts');
  const ctx = await loadWasm();
  const runtime = typeof Bun === 'undefined' ? `Node ${process.version}` : `Bun ${Bun.version}`;
  const backends = { js: utm, [ctx.backend]: ctx.utm };
  return {
    runtime,
    rows: runCases(proj4, backends, lineString, { n, runs }),
    gcjRows: runGcjCases(gcoord, { js: gcj02, [ctx.backend]: ctx.gcj02 }, { n, runs }),
    bdRows: runBdCases(gcoord, { js: bd09, [ctx.backend]: ctx.bd09 }, { n, runs }),
    composedRows: runComposedCases(
      proj4,
      gcoord,
      { js: utm({ zone: 50, geographic: GCJ02 }), [ctx.backend]: ctx.utm({ zone: 50, geographic: ctx.gcj02() }) },
      { n, runs },
    ),
    mercRows: runMercatorCases(proj4, { js: webMercator(), [ctx.backend]: ctx.webMercator() }, { n, runs }),
  };
}

// Chromium has no TypeScript stripping; Bun does not export node:module's, so each runtime uses its own.
async function toJavaScript(path: string): Promise<string> {
  const code = await readFile(path, 'utf8');
  if (typeof Bun !== 'undefined') return new Bun.Transpiler({ loader: 'ts' }).transformSync(code);
  const { stripTypeScriptTypes } = await import('node:module');
  return stripTypeScriptTypes(code);
}

async function inBrowser() {
  const { chromium } = await import('playwright');
  const browser = await chromium.launch(process.env.CHROME ? { executablePath: process.env.CHROME } : {});
  const page = await browser.newPage();
  const files: Record<string, [string, string]> = {
    '/': ['text/html', '<!doctype html><title>bench</title>'],
    '/proj4.js': ['text/javascript', join(root, '../../node_modules/proj4/dist/proj4.js')],
    '/gcoord.js': ['text/javascript', join(root, '../../node_modules/gcoord/dist/gcoord.global.prod.js')],
    '/cases.mjs': ['text/javascript', join(root, 'bench/cases.mts')],
  };
  await page.route('http://bench.local/**', async (route) => {
    const path = new URL(route.request().url()).pathname;
    if (path.startsWith('/dist/')) {
      const contentType = path.endsWith('.wasm') ? 'application/wasm' : 'text/javascript';
      return route.fulfill({ contentType, body: await readFile(join(root, path)) });
    }
    const f = files[path];
    if (!f) return route.fulfill({ status: 404 });
    // Chromium does not strip types: cases.mts is transpiled on the fly.
    const body = path === '/' ? f[1] : path === '/cases.mjs' ? await toJavaScript(f[1]) : await readFile(f[1]);
    return route.fulfill({ contentType: f[0], body });
  });
  await page.goto('http://bench.local/');
  await page.addScriptTag({ url: '/proj4.js' });
  await page.addScriptTag({ url: '/gcoord.js' });
  const { rows, gcjRows, bdRows, composedRows, mercRows } = await page.evaluate(
    async (opts) => {
      // Variables keep tsc from resolving browser-only URLs (Chromium cannot parse TS casts).
      const dist = '/dist/';
      const cases = '/cases.mjs';
      const { GCJ02, bd09, gcj02, utm, webMercator } = await import(dist + 'index.js');
      const { lineString } = await import(dist + 'geojson.js');
      const { loadWasm } = await import(dist + 'wasm.js');
      const { runBdCases, runCases, runComposedCases, runGcjCases, runMercatorCases } = await import(cases);
      const ctx = await loadWasm();
      return {
        rows: runCases(window.proj4, { js: utm, [ctx.backend]: ctx.utm }, lineString, opts),
        gcjRows: runGcjCases(window.gcoord, { js: gcj02, [ctx.backend]: ctx.gcj02 }, opts),
        bdRows: runBdCases(window.gcoord, { js: bd09, [ctx.backend]: ctx.bd09 }, opts),
        composedRows: runComposedCases(
          window.proj4,
          window.gcoord,
          { js: utm({ zone: 50, geographic: GCJ02 }), [ctx.backend]: ctx.utm({ zone: 50, geographic: ctx.gcj02() }) },
          opts,
        ),
        mercRows: runMercatorCases(window.proj4, { js: webMercator(), [ctx.backend]: ctx.webMercator() }, opts),
      };
    },
    { n, runs },
  );
  const runtime = `Chromium ${browser.version()}`;
  await browser.close();
  return { runtime, rows, gcjRows, bdRows, composedRows, mercRows };
}

const { runtime, rows, gcjRows, bdRows, composedRows, mercRows } = args.includes('--browser')
  ? await inBrowser()
  : await inProcess();
console.log(`${n} points, median of ${runs} (5 calls each) (${runtime})`);
for (const [baseline, table] of [
  ['proj4', rows],
  ['gcoord', gcjRows],
  ['gcoord', bdRows],
  ['proj4 + gcoord', composedRows],
  ['proj4', mercRows],
]) {
  const names = Object.keys(table[0].ms);
  console.log(`\n| direction | method | ${baseline} ms | ${names.map((k) => `${k} ms`).join(' | ')} |`);
  console.log(`|---|---|---:|${names.map(() => '---:').join('|')}|`);
  for (const r of table) {
    const cells = names.map((k) => `${r.ms[k].toFixed(2)} (${(r.base / r.ms[k]).toFixed(1)}×)`);
    console.log(`| ${r.direction} | ${r.method} | ${r.base.toFixed(2)} | ${cells.join(' | ')} |`);
  }
}
