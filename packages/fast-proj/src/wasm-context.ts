/**
 * The converters of a loadWasm() context: wasm-backed ones over a fixed 64 Ki-point workspace, or the JavaScript ones
 * guarded against use after dispose(). wasm.ts loads the module and picks one.
 */
import { composeBd09 } from './bd09.js';
import { checkEven, checkSame, output } from './checks.js';
import { buildGcj02, gcj02Mode } from './gcj02.js';
import { type FusedInverse, fusers, tmInverses, withGeographic } from './geographic.js';
import { parseTmerc, tmerc as jsTmerc } from './tmerc.js';
import type { Bd09, Geographic, Impl, Projection, TransverseMercator } from './types.js';
import { parseUtm, utm as jsUtm } from './utm.js';
import { parseWebMercator, webMercator as jsWebMercator } from './webmerc.js';
import type { WasmContext } from './wasm.js';

// centralMeridian, scaleFactor, falseEasting, falseNorthing, a, f
type TmParams = [number, number, number, number, number, number];

export interface Exports {
  memory: WebAssembly.Memory;
  alloc(n: number): number;
  simd_enabled(): number;
  tm_forward_batch(lon: number, lat: number, x: number, y: number, n: number, ...params: TmParams): void;
  tm_inverse_batch(x: number, y: number, lon: number, lat: number, n: number, ...params: TmParams): void;
  // Absent from builds without simd128 and from modules older than 0.2.1.
  gcj_forward_batch?(lon: number, lat: number, outLon: number, outLat: number, n: number): void;
  gcj_inverse_batch?(lon: number, lat: number, outLon: number, outLat: number, n: number): void;
  // x/y -> GCJ-02 (passthrough) in one pass; absent from builds without simd128 and from modules older than 0.3.2.
  tm_gcj_batch?(x: number, y: number, lon: number, lat: number, n: number, ...params: TmParams): void;
  // Absent from builds without simd128 and from modules older than 0.4.0.
  wm_forward_batch?(lon: number, lat: number, x: number, y: number, n: number): void;
  wm_inverse_batch?(x: number, y: number, lon: number, lat: number, n: number): void;
}

const CAP = 1 << 16;
const DISPOSE: typeof Symbol.dispose = Symbol.dispose ?? (Symbol.for('Symbol.dispose') as typeof Symbol.dispose);

// Wraps a JavaScript converter so it throws once its context is disposed. A wrapped geographic system keeps fusing
// with JavaScript projections, checking per call.
function guarded<T extends object>(conv: T, disposed: () => boolean): T {
  const guard = () => {
    if (disposed()) throw new Error('fast-proj: converter used after its wasm context was disposed');
  };
  const out = {} as Record<string, unknown>;
  for (const [k, v] of Object.entries(conv)) {
    out[k] = typeof v === 'function' ? (...args: unknown[]) => (guard(), v(...args)) : v;
  }
  Object.freeze(out);
  const fuse = fusers.get(conv as unknown as Geographic);
  if (fuse) {
    fusers.set(out as unknown as Geographic, (t) => {
      const f = fuse(t);
      return {
        batch: (a, b, outA, outB, o1, step, end) => (guard(), f.batch(a, b, outA, outB, o1, step, end)),
        point: (x, y) => (guard(), f.point(x, y)),
      };
    });
  }
  return out as T;
}

export function jsContext(): WasmContext {
  let disposed = false;
  const live = <T extends object>(conv: T): T => guarded(conv, () => disposed);
  const open = () => {
    if (disposed) throw new Error('fast-proj: context used after dispose()');
  };
  // One converter per mode, as for the root gcj02().
  const gcj: Partial<Record<'passthrough' | 'transform', Geographic>> = {};
  const bd: Partial<Record<'passthrough' | 'transform', Bd09>> = {};
  const ctx: WasmContext = {
    backend: 'js',
    tmerc: (o) => (open(), live(jsTmerc(o))),
    utm: (o) => (open(), live(jsUtm(o))),
    webMercator: (o) => (open(), live(jsWebMercator(o))),
    gcj02: (o) => {
      open();
      const mode = gcj02Mode(o);
      return (gcj[mode] ??= live(buildGcj02(mode)));
    },
    bd09: (o) => {
      open();
      const mode = gcj02Mode(o, 'bd09');
      return (bd[mode] ??= live(composeBd09(ctx.gcj02({ outsideChina: mode }))));
    },
    dispose() {
      disposed = true;
    },
    [DISPOSE]() {
      disposed = true;
    },
  };
  return ctx;
}

function params(js: TransverseMercator): TmParams {
  const { a, f } = js.ellipsoid;
  return [js.centralMeridian, js.scaleFactor, js.falseEasting, js.falseNorthing, a, f];
}

export function wasmContext(exports: Exports): WasmContext {
  let e: Exports | null = exports;
  let busy = false;
  // The heap is a fixed static arena that never grows, so these views stay valid for the instance lifetime.
  // Reads `e`, not `exports`, so a disposed context doesn't retain the instance.
  const view = (n: number) => new Float64Array(e!.memory.buffer, e!.alloc(n), n);
  let wa: Float64Array | null = view(CAP);
  let wb: Float64Array | null = view(CAP);
  let wc: Float64Array | null = view(CAP);
  let wd: Float64Array | null = view(CAP);
  const pa = wa.byteOffset,
    pb = wb.byteOffset,
    pc = wc.byteOffset,
    pd = wd.byteOffset;

  function enter(): Exports {
    if (!e) throw new Error('fast-proj: converter used after its wasm context was disposed');
    if (busy) throw new Error('fast-proj: re-entrant call into the wasm backend');
    busy = true;
    return e;
  }

  type Kernel = (ex: Exports, m: number) => void;

  function run(kernel: Kernel, sa: ArrayLike<number>, sb: ArrayLike<number>, oa: Float64Array, ob: Float64Array) {
    const ex = enter();
    try {
      const n = sa.length;
      for (let i0 = 0; i0 < n; i0 += CAP) {
        const m = Math.min(CAP, n - i0);
        copyIn(wa!, sa, i0, m);
        copyIn(wb!, sb, i0, m);
        kernel(ex, m);
        copyOut(oa, wc!, i0, m);
        copyOut(ob, wd!, i0, m);
      }
    } finally {
      busy = false;
    }
  }

  function runInterleaved(kernel: Kernel, src: ArrayLike<number>, out: Float64Array) {
    const ex = enter();
    try {
      const half = src.length / 2;
      const A = wa!,
        B = wb!,
        C = wc!,
        D = wd!;
      for (let i0 = 0; i0 < half; i0 += CAP) {
        const m = Math.min(CAP, half - i0);
        for (let j = 0, k = 2 * i0; j < m; j++, k += 2) {
          A[j] = src[k]!;
          B[j] = src[k + 1]!;
        }
        kernel(ex, m);
        for (let j = 0, k = 2 * i0; j < m; j++, k += 2) {
          out[k] = C[j]!;
          out[k + 1] = D[j]!;
        }
      }
    } finally {
      busy = false;
    }
  }

  function live(): void {
    if (!e) throw new Error('fast-proj: converter used after its wasm context was disposed');
  }

  function buildTmerc<T extends TransverseMercator>(js: T): T {
    const [lon0, k0, falseEasting, falseNorthing, a, f] = params(js);
    const fwd: Kernel = (ex, m) => ex.tm_forward_batch(pa, pb, pc, pd, m, lon0, k0, falseEasting, falseNorthing, a, f);
    const inv: Kernel = (ex, m) => ex.tm_inverse_batch(pa, pb, pc, pd, m, lon0, k0, falseEasting, falseNorthing, a, f);
    return buildProjection(js, fwd, inv);
  }

  const wmFwd: Kernel = (ex, m) => ex.wm_forward_batch!(pa, pb, pc, pd, m);
  const wmInv: Kernel = (ex, m) => ex.wm_inverse_batch!(pa, pb, pc, pd, m);

  // The batch methods of `js` on the wasm kernels `fwd` and `inv`.
  function buildProjection<T extends Projection>(js: T, fwd: Kernel, inv: Kernel): T {
    return {
      ...js,
      toLonLat(x, y, lonBuf?, latBuf?) {
        const n = x.length;
        checkSame(n, y.length, 'x and y');
        const lon = output(lonBuf, n, 'lon'),
          lat = output(latBuf, n, 'lat');
        run(inv, x, y, lon, lat);
        return { lon, lat };
      },
      fromLonLat(lon, lat, xBuf?, yBuf?) {
        const n = lon.length;
        checkSame(n, lat.length, 'lon and lat');
        const x = output(xBuf, n, 'x'),
          y = output(yBuf, n, 'y');
        run(fwd, lon, lat, x, y);
        return { x, y };
      },
      toLonLatInterleaved(xy, outBuf?) {
        const n = xy.length;
        checkEven(n);
        const out = output(outBuf, n, 'out');
        runInterleaved(inv, xy, out);
        return out;
      },
      fromLonLatInterleaved(lonlat, outBuf?) {
        const n = lonlat.length;
        checkEven(n);
        const out = output(outBuf, n, 'out');
        runInterleaved(fwd, lonlat, out);
        return out;
      },
      // A single point costs more to pass into wasm than to compute; the JavaScript kernel handles it.
      toLonLatPoint: (x, y) => (live(), js.toLonLatPoint(x, y)),
      fromLonLatPoint: (lon, lat) => (live(), js.fromLonLatPoint(lon, lat)),
    } satisfies Impl<Projection>;
  }

  // x/y -> this context's wasm GCJ-02 in one call, for a projection composed with it; single points run the
  // JavaScript fused kernel.
  function fuse(js: TransverseMercator, g: Geographic | undefined): FusedInverse | undefined {
    if (!g || g !== wasmGcj || !e!.tm_gcj_batch) return undefined;
    const t = tmInverses.get(js.toLonLat)!;
    const { point } = fusers.get(buildGcj02('passthrough'))!(t);
    const [lon0, k0, falseEasting, falseNorthing, a, f] = params(js);
    const kernel: Kernel = (ex, m) => ex.tm_gcj_batch!(pa, pb, pc, pd, m, lon0, k0, falseEasting, falseNorthing, a, f);
    return {
      batch: (x, y, lon, lat, _o1, step) => (step === 1 ? run(kernel, x, y, lon, lat) : runInterleaved(kernel, x, lon)),
      point,
    };
  }

  const gcjFwd: Kernel = (ex, m) => ex.gcj_forward_batch!(pa, pb, pc, pd, m);
  const gcjInv: Kernel = (ex, m) => ex.gcj_inverse_batch!(pa, pb, pc, pd, m);

  function buildGcj(js: Geographic): Geographic {
    return (wasmGcj = Object.freeze({
      toWgs84(lon, lat, outLon?, outLat?) {
        const n = lon.length;
        checkSame(n, lat.length, 'lon and lat');
        const oLon = output(outLon, n, 'outLon'),
          oLat = output(outLat, n, 'outLat');
        run(gcjInv, lon, lat, oLon, oLat);
        return { lon: oLon, lat: oLat };
      },
      fromWgs84(lon, lat, outLon?, outLat?) {
        const n = lon.length;
        checkSame(n, lat.length, 'lon and lat');
        const oLon = output(outLon, n, 'outLon'),
          oLat = output(outLat, n, 'outLat');
        run(gcjFwd, lon, lat, oLon, oLat);
        return { lon: oLon, lat: oLat };
      },
      toWgs84Interleaved(lonlat, outBuf?) {
        const n = lonlat.length;
        checkEven(n);
        const out = output(outBuf, n, 'out');
        runInterleaved(gcjInv, lonlat, out);
        return out;
      },
      fromWgs84Interleaved(lonlat, outBuf?) {
        const n = lonlat.length;
        checkEven(n);
        const out = output(outBuf, n, 'out');
        runInterleaved(gcjFwd, lonlat, out);
        return out;
      },
      toWgs84Point: (lon, lat) => (live(), js.toWgs84Point(lon, lat)),
      fromWgs84Point: (lon, lat) => (live(), js.fromWgs84Point(lon, lat)),
    } satisfies Impl<Geographic>));
  }

  // One converter per mode, as for the root gcj02().
  const gcj: Partial<Record<'passthrough' | 'transform', Geographic>> = {};
  const bd: Partial<Record<'passthrough' | 'transform', Bd09>> = {};
  let wasmGcj: Geographic | undefined;
  const dispose = () => {
    if (busy) throw new Error('fast-proj: dispose() during an active call');
    e = null;
    wa = wb = wc = wd = null;
  };
  const open = () => {
    if (!e) throw new Error('fast-proj: context used after dispose()');
    return e;
  };
  const ctx: WasmContext = {
    backend: 'wasm',
    tmerc: (o) => {
      open();
      const [p, g] = parseTmerc(o);
      return withGeographic(buildTmerc(p), g, live, fuse(p, g));
    },
    utm: (o) => {
      open();
      const [p, g] = parseUtm(o);
      return withGeographic(buildTmerc(p), g, live, fuse(p, g));
    },
    webMercator: (o) => {
      const ex = open();
      const [p, g] = parseWebMercator(o);
      // A module older than 0.4.0 has no Web Mercator kernels: the JavaScript one, guarded.
      if (!ex.wm_forward_batch || !ex.wm_inverse_batch) return guarded(withGeographic(p, g), () => !e);
      return withGeographic(buildProjection(p, wmFwd, wmInv), g, live);
    },
    gcj02: (o) => {
      const ex = open();
      const mode = gcj02Mode(o);
      const js = buildGcj02(mode);
      // 'transform' mode iterates to a tolerance per point, which the fixed-step kernel doesn't do.
      return (gcj[mode] ??=
        mode === 'transform' || !ex.gcj_forward_batch || !ex.gcj_inverse_batch ? guarded(js, () => !e) : buildGcj(js));
    },
    // The offset runs in JavaScript over this context's GCJ-02, so WGS84 <-> BD-09 batches run its wasm kernel.
    bd09: (o) => {
      open();
      const mode = gcj02Mode(o, 'bd09');
      return (bd[mode] ??= guarded(composeBd09(ctx.gcj02({ outsideChina: mode })), () => !e));
    },
    dispose,
    [DISPOSE]: dispose,
  };
  return ctx;
}

function copyIn(dst: Float64Array, src: ArrayLike<number>, i0: number, n: number): void {
  if (src instanceof Float64Array) dst.set(src.subarray(i0, i0 + n));
  else for (let j = 0; j < n; j++) dst[j] = src[i0 + j]!;
}

function copyOut(dst: Float64Array, src: Float64Array, i0: number, n: number): void {
  dst.set(src.subarray(0, n), i0);
}
