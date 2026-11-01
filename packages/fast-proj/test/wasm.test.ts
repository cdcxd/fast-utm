import { copyFileSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { pathToFileURL } from 'node:url';
import vm from 'node:vm';
import { describe, expect, it, vi } from 'vitest';
import { LAT_MAX, LAT_MIN, LON_MAX, LON_MIN } from '../src/gcj02-constants.js';
import { fusers } from '../src/geographic.js';
import { BD09, GCJ02, gcj02, tmerc as jsTmerc, utm, webMercator } from '../src/index.js';
import type { Geographic, Projection } from '../src/types.js';
import { loadWasm, type WasmContext } from '../src/wasm.js';

const url = new URL('../dist/fast-proj.wasm', import.meta.url);

type Factories = Pick<WasmContext, 'utm' | 'tmerc'>;
type Make = (m: Factories, geographic?: Geographic) => Projection;
const zone1: Make = (m, geographic) => m.utm({ zone: 1, geographic });

describe('loadWasm', () => {
  it('accepts a URL, bytes or a compiled module', async () => {
    const bytes = readFileSync(url);
    const module = await WebAssembly.compile(bytes);
    const sources = [
      url,
      url.href,
      bytes,
      bytes.buffer.slice(bytes.byteOffset, bytes.byteOffset + bytes.length),
      module,
    ];
    const contexts = await Promise.all(sources.map((source) => loadWasm({ source })));
    const expected = utm({ zone: 33 }).fromLonLat([15, 16], [52, -1]);
    for (const ctx of contexts) {
      expect(ctx.backend).toBe('wasm');
      const got = ctx.utm({ zone: 33 }).fromLonLat([15, 16], [52, -1]);
      expect(Math.abs(got.x[1]! - expected.x[1]!)).toBeLessThan(5e-9);
      ctx.dispose();
    }
  });

  it('falls back to the JavaScript backend without wasm SIMD', async () => {
    const validate = vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    const ctx = await loadWasm().finally(() => validate.mockRestore());
    expect(ctx.backend).toBe('js');
    expect(ctx.utm({ zone: 33 }).toLonLat([500000], [0]).lon[0]).toBeCloseTo(15, 12);
  });

  it('without SIMD, still loads a given source, and falls back if it does not compile', async () => {
    const validate = vi.spyOn(WebAssembly, 'validate').mockReturnValue(false);
    try {
      expect((await loadWasm({ source: url })).backend).toBe('wasm');
      const bad = new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 9]);
      expect((await loadWasm({ source: bad })).backend).toBe('js');
    } finally {
      validate.mockRestore();
    }
  });

  it('gives each context its own instance', async () => {
    const a = await loadWasm({ source: url });
    const b = await loadWasm({ source: url });
    const ua = a.utm({ zone: 33 });
    const ub = b.utm({ zone: 33 });
    a.dispose();
    expect(() => ua.toLonLatPoint(500000, 0)).toThrow(/dispose/);
    expect(ub.toLonLatPoint(500000, 0)[0]).toBeCloseTo(15, 12);
  });

  it('rejects a corrupt module and can retry', async () => {
    await expect(loadWasm({ source: new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0, 9]) })).rejects.toBeInstanceOf(
      WebAssembly.CompileError,
    );
    await expect(loadWasm({ source: new URL('./missing.wasm', url) })).rejects.toThrow(/ENOENT/);
    expect((await loadWasm({ source: url })).backend).toBe('wasm');
  });

  it('evicts a module that fails initialization, so a fixed file can be retried', async () => {
    const file = join(mkdtempSync(join(tmpdir(), 'fast-proj-')), 'm.wasm');
    writeFileSync(file, new Uint8Array([0, 97, 115, 109, 1, 0, 0, 0]));
    const source = pathToFileURL(file);
    await expect(loadWasm({ source })).rejects.toThrow(/not a fast-proj wasm module/);
    copyFileSync(url, file);
    expect((await loadWasm({ source })).backend).toBe('wasm');
  });

  it('accepts a module compiled in another realm', async () => {
    const module = vm.runInNewContext('new WebAssembly.Module(bytes)', {
      bytes: readFileSync(url),
    }) as WebAssembly.Module;
    expect(module instanceof WebAssembly.Module).toBe(false);
    expect((await loadWasm({ source: module })).backend).toBe('wasm');
  });

  it('handles inputs larger than the 64 Ki-point workspace', async () => {
    const ctx = await loadWasm({ source: url });
    const n = 150001;
    const lon = Float64Array.from({ length: n }, (_, i) => 12 + (6 * i) / n);
    const lat = Float64Array.from({ length: n }, (_, i) => -80 + (164 * i) / n);
    const js = utm({ zone: 33 }).fromLonLat(lon, lat);
    const w = ctx.utm({ zone: 33 });
    const res = w.fromLonLat(lon, lat);
    const ll = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      ll[2 * i] = lon[i]!;
      ll[2 * i + 1] = lat[i]!;
    }
    const inter = w.fromLonLatInterleaved(ll, ll);
    let max = 0;
    for (let i = 0; i < n; i++) {
      max = Math.max(max, Math.abs(res.x[i]! - js.x[i]!), Math.abs(res.y[i]! - js.y[i]!));
      max = Math.max(max, Math.abs(inter[2 * i]! - js.x[i]!), Math.abs(inter[2 * i + 1]! - js.y[i]!));
    }
    expect(max).toBeLessThan(5e-9);
  });

  it('ships the wasm gcj02 kernel', async () => {
    const names = WebAssembly.Module.exports(await WebAssembly.compile(readFileSync(url))).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['gcj_forward_batch', 'gcj_inverse_batch']));
    expect(names).not.toContain('forward_batch');
    expect(names).not.toContain('inverse_batch');
  });

  it('falls back to the JavaScript backend for a non-SIMD module', async () => {
    const module = await WebAssembly.compile(readFileSync(url));
    const instantiate = WebAssembly.instantiate;
    const spy = vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (m: WebAssembly.Module) => {
      const { exports } = await instantiate(m, {});
      return { exports: { ...exports, simd_enabled: () => 0 } };
    }) as unknown as typeof WebAssembly.instantiate);
    const ctx = await loadWasm({ source: module }).finally(() => spy.mockRestore());
    expect(ctx.backend).toBe('js');
    expect(ctx.utm({ zone: 33 }).fromLonLatPoint(15, 0)[0]).toBeCloseTo(500000, 6);
    // Its gcj02() fuses with JavaScript projections like the root one.
    const x = [440000, 449000.5, 600000];
    const y = [4420000, 4430000, 3500000];
    const fused = utm({ zone: 50, geographic: GCJ02 }).toLonLat(x, y);
    const own = ctx.utm({ zone: 50, geographic: ctx.gcj02() });
    const root = utm({ zone: 50, geographic: ctx.gcj02() });
    expect(fusers.has(root.geographic!)).toBe(true);
    expect(own.toLonLat(x, y)).toEqual(fused);
    expect(root.toLonLat(x, y)).toEqual(fused);
    expect(root.toLonLatPoint(x[0]!, y[0]!)).toEqual([fused.lon[0], fused.lat[0]]);
    ctx.dispose();
    expect(() => ctx.utm({ zone: 33 })).toThrow(/dispose/);
    expect(() => root.toLonLat(x, y)).toThrow(/disposed/);
    expect(() => root.toLonLatInterleaved([x[0]!, y[0]!])).toThrow(/disposed/);
    expect(() => root.toLonLatPoint(x[0]!, y[0]!)).toThrow(/disposed/);
  });

  it('a root projection with a wasm geographic throws once disposed, outputs untouched', async () => {
    const ctx = await loadWasm({ source: url });
    const root = utm({ zone: 50, geographic: ctx.gcj02({ outsideChina: 'transform' }) });
    // 'transform' runs the guarded JavaScript kernel, which fuses; the wasm kernel never does.
    expect(fusers.has(root.geographic!)).toBe(true);
    expect(fusers.has(ctx.gcj02())).toBe(false);
    expect(root.toLonLatPoint(440000, 4420000)).toEqual(
      utm({ zone: 50, geographic: gcj02({ outsideChina: 'transform' }) }).toLonLatPoint(440000, 4420000),
    );
    ctx.dispose();
    const lon = new Float64Array(1);
    const lat = new Float64Array(1);
    expect(() => root.toLonLat([440000], [4420000], lon, lat)).toThrow(/disposed/);
    expect([lon[0], lat[0]]).toEqual([0, 0]);
  });

  it('runs the JavaScript gcj02 kernel for modules without the wasm one', async () => {
    const module = await WebAssembly.compile(readFileSync(url));
    const instantiate = WebAssembly.instantiate;
    const spy = vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (m: WebAssembly.Module) => {
      const { gcj_forward_batch: _f, gcj_inverse_batch: _i, ...exports } = (await instantiate(m, {})).exports;
      return { exports };
    }) as typeof WebAssembly.instantiate);
    const ctx = await loadWasm({ source: module }).finally(() => spy.mockRestore());
    expect(ctx.backend).toBe('wasm');
    const lon = [116.391, 105.004];
    const lat = [39.907, 30];
    expect(ctx.gcj02().toWgs84(lon, lat)).toEqual(gcj02().toWgs84(lon, lat));
  });

  it('runs webMercator in wasm, and in JavaScript for modules without its kernels', async () => {
    const names = WebAssembly.Module.exports(await WebAssembly.compile(readFileSync(url))).map((e) => e.name);
    expect(names).toEqual(expect.arrayContaining(['wm_forward_batch', 'wm_inverse_batch']));
    const module = await WebAssembly.compile(readFileSync(url));
    const instantiate = WebAssembly.instantiate;
    const spy = vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (m: WebAssembly.Module) => {
      const { wm_forward_batch: _f, wm_inverse_batch: _i, ...exports } = (await instantiate(m, {})).exports;
      return { exports };
    }) as typeof WebAssembly.instantiate);
    const old = await loadWasm({ source: module }).finally(() => spy.mockRestore());
    expect(old.backend).toBe('wasm');
    const lon = [116.391, -73.98, 179.9];
    const lat = [39.907, 40.75, -85];
    expect(old.webMercator().fromLonLat(lon, lat)).toEqual(webMercator().fromLonLat(lon, lat));
    expect(() => old.webMercator({ radius: 1 } as never)).toThrow(TypeError);
    old.dispose();
  });

  it('composes webMercator with its own wasm gcj02 and throws once disposed', async () => {
    const ctx = await loadWasm({ source: url });
    const g = ctx.gcj02();
    const p = ctx.webMercator({ geographic: g });
    const x = [12958000, 13530000];
    const y = [4852000, 3640000];
    const w = ctx.webMercator().toLonLat(x, y);
    expect(p.toLonLat(x, y)).toEqual(g.fromWgs84(w.lon, w.lat));
    const m = ctx.webMercator();
    ctx.dispose();
    expect(() => ctx.webMercator()).toThrow(/dispose/);
    expect(() => m.toLonLat(x, y)).toThrow(/disposed/);
    expect(() => m.fromLonLatPoint(0, 0)).toThrow(/disposed/);
    expect(() => p.toLonLatInterleaved([x[0]!, y[0]!])).toThrow(/disposed/);
  });

  it('runs bd09 over its own gcj02 and throws once disposed', async () => {
    const ctx = await loadWasm({ source: url });
    const b = ctx.bd09();
    expect(ctx.bd09()).toBe(b);
    const lon = [116.391, 121.4737];
    const lat = [39.907, 31.2304];
    const g = ctx.gcj02().fromWgs84(lon, lat);
    expect(b.fromWgs84(lon, lat)).toEqual(BD09.fromGcj02(g.lon, g.lat));
    expect(b.fromGcj02(lon, lat)).toEqual(BD09.fromGcj02(lon, lat));
    expect(() => ctx.bd09({ foo: 1 } as never)).toThrow(/bd09\(\)/);
    ctx.dispose();
    expect(() => ctx.bd09()).toThrow(/dispose/);
    expect(() => b.fromGcj02(lon, lat)).toThrow(/disposed/);
    expect(() => b.toGcj02Point(116, 40)).toThrow(/disposed/);
    expect(() => b.toWgs84Interleaved([116, 40])).toThrow(/disposed/);
  });

  it('fuses a projection with its own wasm gcj02 into one wasm call', async () => {
    const module = await WebAssembly.compile(readFileSync(url));
    const instantiate = WebAssembly.instantiate;
    const calls: string[] = [];
    const count =
      (k: string, f: unknown) =>
      (...a: unknown[]) => (calls.push(k), (f as (...b: unknown[]) => void)(...a));
    // Counts the kernel calls, optionally dropping the fused export as modules older than 0.3.2 do.
    const load = async (fused: boolean) => {
      const spy = vi.spyOn(WebAssembly, 'instantiate').mockImplementation((async (m: WebAssembly.Module) => {
        const { tm_gcj_batch, ...exports } = (await instantiate(m, {})).exports as Record<string, unknown>;
        return {
          exports: {
            ...exports,
            tm_inverse_batch: count('inverse', exports.tm_inverse_batch),
            gcj_forward_batch: count('gcj', exports.gcj_forward_batch),
            ...(fused && { tm_gcj_batch: count('fused', tm_gcj_batch) }),
          },
        };
      }) as unknown as typeof WebAssembly.instantiate);
      return loadWasm({ source: module }).finally(() => spy.mockRestore());
    };
    const ctx = await load(true);
    const other = await load(true);
    const old = await load(false);
    // Odd and past the workspace.
    const n = 150001;
    const gx = Float64Array.from({ length: n }, (_, i) => -300000 + ((i * 7919) % n) * (1600000 / n));
    const gy = Float64Array.from({ length: n }, (_, i) => -1e6 + ((i * 104729) % n) * (8e6 / n));
    const glon = Float64Array.from({ length: n }, (_, i) => 70 + ((i * 7919) % n) * (70 / n));
    const glat = Float64Array.from({ length: n }, (_, i) => -2 + ((i * 104729) % n) * (60 / n));
    const interleave = (a: Float64Array, b: Float64Array) => {
      const ab = new Float64Array(2 * n);
      for (let i = 0; i < n; i++) {
        ab[2 * i] = a[i]!;
        ab[2 * i + 1] = b[i]!;
      }
      return ab;
    };
    const projections: Make[] = [
      (m, geographic) => m.utm({ zone: 50, geographic }),
      (m, geographic) => m.utm({ zone: 50, south: true, geographic }),
      zone1,
      (m, geographic) =>
        m.tmerc({ centralMeridian: 117.5, scaleFactor: 0.9999, falseEasting: 250000, falseNorthing: -1e6, geographic }),
      (m, geographic) => m.tmerc({ centralMeridian: 104.25, ellipsoid: { a: 6371000, f: 0 }, geographic }),
      (m, geographic) => m.tmerc({ centralMeridian: 105, ellipsoid: { a: 6378137, f: 0.0099 }, geographic }),
    ];
    for (const make of projections) {
      // In and around the China box (86% in it); zone 1 can't reach China, so the x/y grid, all passing through.
      const { x, y } = make === zone1 ? { x: gx, y: gy } : make({ utm, tmerc: jsTmerc }).fromLonLat(glon, glat);
      const xy = interleave(x, y);
      const js = make({ utm, tmerc: jsTmerc }, GCJ02);
      const want = js.toLonLat(x, y);
      let inBox = 0;
      for (let i = 0; i < n; i++) {
        const lon = want.lon[i]!,
          lat = want.lat[i]!;
        if (lon >= LON_MIN && lon <= LON_MAX && lat >= LAT_MIN && lat <= LAT_MAX) inBox++;
      }
      expect(inBox / n).toBeCloseTo(make === zone1 ? 0 : 0.86, 2);
      calls.length = 0;
      const w = make(ctx, ctx.gcj02());
      const got = w.toLonLat(x, y);
      const inter = w.toLonLatInterleaved(xy, new Float64Array(2 * n));
      expect(calls).toEqual(['fused', 'fused', 'fused', 'fused', 'fused', 'fused']);
      let max = 0;
      for (let i = 0; i < n; i++) {
        const k = Math.cos((want.lat[i]! * Math.PI) / 180);
        max = Math.max(max, Math.abs(got.lon[i]! - want.lon[i]!) * k, Math.abs(got.lat[i]! - want.lat[i]!));
        max = Math.max(max, Math.abs(inter[2 * i]! - want.lon[i]!) * k, Math.abs(inter[2 * i + 1]! - want.lat[i]!));
      }
      expect(max).toBeLessThan(6e-14);
      expect(w.toLonLatPoint(x[7]!, y[7]!)).toEqual(js.toLonLatPoint(x[7]!, y[7]!));
      // Another context's converter, or a module without the fused export, takes the two passes.
      for (const [c, g] of [
        [ctx, other.gcj02()],
        [old, old.gcj02()],
      ] as const) {
        calls.length = 0;
        const two = make(c, g).toLonLat(x, y);
        expect(calls).toEqual(['inverse', 'inverse', 'inverse', 'gcj', 'gcj', 'gcj']);
        let d = 0;
        for (let i = 0; i < n; i++) {
          const k = Math.cos((got.lat[i]! * Math.PI) / 180);
          d = Math.max(d, Math.abs(two.lon[i]! - got.lon[i]!) * k, Math.abs(two.lat[i]! - got.lat[i]!));
        }
        expect(d).toBeLessThan(3e-14);
      }
    }
    // The fused kernel's per-meridian rotation, across the zones that reach China, against the two passes.
    const m = 4001;
    const sweep = (make: Make, cm: number) => {
      // Within 3 degrees of the central meridian.
      const lon = glon.subarray(0, m).map((l) => cm - 3 + (l - 70) * (6 / 70));
      const { x, y } = make({ utm, tmerc: jsTmerc }).fromLonLat(lon, glat.subarray(0, m));
      const got = make(ctx, ctx.gcj02()).toLonLat(x, y);
      const two = make(ctx, other.gcj02()).toLonLat(x, y);
      let d = 0;
      for (let i = 0; i < m; i++) {
        const k = Math.cos((got.lat[i]! * Math.PI) / 180);
        d = Math.max(d, Math.abs(two.lon[i]! - got.lon[i]!) * k, Math.abs(two.lat[i]! - got.lat[i]!));
      }
      expect(d).toBeLessThan(3e-14);
    };
    for (let zone = 43; zone <= 53; zone++) {
      sweep((f, geographic) => f.utm({ zone, geographic }), 6 * zone - 183);
    }
    // Flattening near the supported limit: the latitude rotation needs its fifth-order term.
    const flat = (g: Geographic) =>
      ctx.tmerc({ centralMeridian: 105, ellipsoid: { a: 6378137, f: 0.0099 }, geographic: g });
    expect(flat(ctx.gcj02()).toLonLatInterleaved([457626.24907291203, 3843984.001237645])).toEqual(
      flat(other.gcj02()).toLonLatInterleaved([457626.24907291203, 3843984.001237645]),
    );
    // A lane's result doesn't depend on its neighbour, here a NaN, on either side of the box edge.
    const [px, py] = [-58408.45555193231, 6189705.326985675];
    for (const t of [ctx.tmerc({ centralMeridian: 75, geographic: ctx.gcj02() }), ctx.tmerc({ centralMeridian: 75 })]) {
      const alone = t.toLonLat([px], [py]);
      const paired = t.toLonLat([NaN, px], [NaN, py]);
      expect([paired.lon[1], paired.lat[1]]).toEqual([alone.lon[0], alone.lat[0]]);
    }
    const w = ctx.utm({ zone: 50, geographic: ctx.gcj02() });
    // Far from the central meridian, yet in the box: the offset's angle sums must not overflow.
    const far = [48707797.27050504, 32399795.303083114] as const;
    const [fl, fb] = w.toLonLatInterleaved(far);
    const [tl, tb] = ctx.utm({ zone: 50, geographic: other.gcj02() }).toLonLatInterleaved(far);
    expect(Math.abs(fl! - tl!) * Math.cos((tb! * Math.PI) / 180)).toBeLessThan(3e-14);
    expect(Math.abs(fb! - tb!)).toBeLessThan(3e-14);
    // In place, interleaved.
    const xy = interleave(gx, gy);
    const copy = xy.slice();
    expect(w.toLonLatInterleaved(copy, copy)).toEqual(w.toLonLatInterleaved(xy));
    // Disposal: throws before writing.
    ctx.dispose();
    const lon = new Float64Array(1);
    const lat = new Float64Array(1);
    expect(() => w.toLonLat([440000], [4420000], lon, lat)).toThrow(/disposed/);
    expect(() => w.toLonLatPoint(440000, 4420000)).toThrow(/disposed/);
    expect([lon[0], lat[0]]).toEqual([0, 0]);
  });

  it('handles gcj02 inputs larger than the 64 Ki-point workspace', async () => {
    const ctx = await loadWasm({ source: url });
    const n = 150001;
    const ll = new Float64Array(2 * n);
    for (let i = 0; i < n; i++) {
      ll[2 * i] = 70 + ((i * 7919) % n) * (70 / n);
      ll[2 * i + 1] = ((i * 104729) % n) * (58 / n);
    }
    const js = gcj02().toWgs84Interleaved(ll);
    const res = ctx.gcj02().toWgs84Interleaved(ll, ll);
    let max = 0;
    for (let i = 0; i < 2 * n; i++) max = Math.max(max, Math.abs(res[i]! - js[i]!));
    expect(max).toBeLessThan(6e-14);
  });
});

describe('dispose', () => {
  it('only the context is disposable', async () => {
    const ctx = await loadWasm({ source: url });
    for (const conv of [ctx.utm({ zone: 33 }), ctx.tmerc({ centralMeridian: 117 }), ctx.gcj02()]) {
      expect('dispose' in conv || Symbol.dispose in conv).toBe(false);
      expect(Object.isFrozen(conv)).toBe(true);
    }
  });

  it('context dispose invalidates its converters and factories', async () => {
    const ctx = await loadWasm({ source: url });
    const a = ctx.utm({ zone: 33 });
    const out = a.toLonLat([500000], [0]);
    ctx[Symbol.dispose]();
    expect(out.lon[0]).toBeCloseTo(15, 12);
    ctx.dispose();
    expect(() => a.fromLonLatPoint(15, 0)).toThrow(/dispose/);
    expect(() => ctx.utm({ zone: 33 })).toThrow(/dispose/);
    expect(() => ctx.tmerc({ centralMeridian: 0 })).toThrow(/dispose/);
  });

  it('gcj02 follows the disposal rules', async () => {
    const ctx = await loadWasm({ source: url });
    const g = ctx.gcj02();
    const h = ctx.gcj02({ outsideChina: 'transform' });
    const [l, p] = g.fromWgs84Interleaved([116.391, 39.907]);
    const [rl, rp] = gcj02().fromWgs84Interleaved([116.391, 39.907]);
    expect(Math.abs(l! - rl!) + Math.abs(p! - rp!)).toBeLessThan(6e-14);
    // 'transform' mode runs the JavaScript kernel.
    expect(h.fromWgs84([0, 116.391], [0, 39.907])).toEqual(
      gcj02({ outsideChina: 'transform' }).fromWgs84([0, 116.391], [0, 39.907]),
    );
    // The option is read once, so point and batch methods agree.
    let reads = 0;
    const m = ctx.gcj02({
      get outsideChina() {
        return ++reads === 1 ? 'transform' : 'passthrough';
      },
    });
    expect(m.fromWgs84([13.4], [52.5]).lon[0]).toBe(m.fromWgs84Point(13.4, 52.5)[0]);
    expect(reads).toBe(1);
    expect(h.toWgs84Point(116, 39)[0]).toBeCloseTo(116, 1);
    ctx.dispose();
    expect(() => g.toWgs84Point(116, 39)).toThrow(/dispose/);
    expect(() => g.fromWgs84Interleaved([116, 39])).toThrow(/dispose/);
    expect(() => h.toWgs84([116], [39])).toThrow(/dispose/);
    expect(() => ctx.gcj02()).toThrow(/dispose/);
  });

  it('JavaScript fallback follows the same disposal rules', async () => {
    vi.stubGlobal('WebAssembly', undefined);
    const ctx = await loadWasm().finally(() => vi.unstubAllGlobals());
    expect(ctx.backend).toBe('js');
    const a = ctx.utm({ zone: 33 });
    const g = ctx.gcj02();
    expect(a.toLonLatPoint(500000, 0)[0]).toBeCloseTo(15, 12);
    ctx.dispose();
    expect(() => a.toLonLatPoint(500000, 0)).toThrow(/dispose/);
    expect(() => g.fromWgs84Point(116, 39)).toThrow(/dispose/);
    expect(() => ctx.utm({ zone: 33 })).toThrow(/dispose/);
    expect(() => ctx.tmerc({ centralMeridian: 0 })).toThrow(/dispose/);
    expect(() => ctx.gcj02()).toThrow(/dispose/);
  });

  it('supports using', async () => {
    let conv;
    {
      using ctx = await loadWasm({ source: url });
      conv = ctx.utm({ zone: 33 });
      expect(conv.toLonLatPoint(500000, 0)[0]).toBeCloseTo(15, 12);
    }
    expect(() => conv.toLonLatPoint(500000, 0)).toThrow(/dispose/);
  });

  it('rejects re-entrant calls from array-like getters, then recovers', async () => {
    const ctx = await loadWasm({ source: url });
    const conv = ctx.utm({ zone: 33 });
    const evil = {
      length: 1,
      get 0() {
        return conv.toLonLat([500000], [0]).lon[0]!;
      },
    };
    expect(() => conv.fromLonLat(evil, [0])).toThrow(/re-entrant/);
    expect(conv.fromLonLat([15], [0]).x[0]).toBeCloseTo(500000, 6);
  });

  it('validates options like the JavaScript backend', async () => {
    const ctx = await loadWasm({ source: url });
    expect(() => ctx.utm({ zone: 61 })).toThrow(RangeError);
    expect(() => ctx.utm({ zone: 33, south: 'yes' as unknown as boolean })).toThrow(TypeError);
    expect(() => ctx.tmerc({ centralMeridian: 0, scaleFactor: 0 })).toThrow(RangeError);
    const conv = ctx.utm({ zone: 33 });
    expect(() => conv.toLonLatInterleaved([1, 2, 3])).toThrow(RangeError);
    expect(() => conv.toLonLat([1, 2], [1, 2], new Float64Array(1))).toThrow(RangeError);
  });
});
