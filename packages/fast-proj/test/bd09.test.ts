import coordtransform from 'coordtransform';
import gcoord from 'gcoord';
import { describe, expect, it } from 'vitest';
import { BD09, bd09, GCJ02, gcj02 } from '../src/index.js';
import { backends } from './backends.js';
import fixture from './fixtures/bd09.json';

const cosd = (deg: number) => Math.cos((deg * Math.PI) / 180);

function maxError(rows: (string | number)[][], f: (lon: number, lat: number) => [number, number]) {
  let max = 0;
  for (const [lon, lat, rl, rp] of rows as [number, number, string, string][]) {
    const [l, p] = f(lon, lat);
    max = Math.max(max, Math.abs(l - Number(rl)) * cosd(lat), Math.abs(p - Number(rp)));
  }
  return max;
}

describe('bd09', () => {
  const b = bd09();

  it('is the shared default', () => {
    expect(bd09()).toBe(BD09);
    expect(bd09({ outsideChina: 'transform' })).not.toBe(BD09);
  });

  it('matches the 40-digit reference', () => {
    // Against the references rounded to doubles: within an ulp both ways.
    expect(maxError(fixture.fromGcj02, b.fromGcj02Point)).toBeLessThan(1.5e-14);
    expect(maxError(fixture.toGcj02, b.toGcj02Point)).toBeLessThan(1.5e-14);
  });

  it('matches gcoord and coordtransform forward, and their closed-form inverse within 3e-6', () => {
    let fwd = 0;
    let wgs = 0;
    let inv = 0;
    for (let lon = 74; lon <= 135; lon += 0.37) {
      for (let lat = 4; lat <= 53; lat += 0.41) {
        const [l, p] = b.fromGcj02Point(lon, lat);
        const r = gcoord.transform([lon, lat], gcoord.GCJ02, gcoord.BD09);
        const c = coordtransform.gcj02tobd09(lon, lat);
        fwd = Math.max(fwd, Math.abs(l - r[0]!), Math.abs(p - r[1]!), Math.abs(l - c[0]!), Math.abs(p - c[1]!));
        const [wl, wp] = b.fromWgs84Point(lon, lat);
        const rw = gcoord.transform([lon, lat], gcoord.WGS84, gcoord.BD09);
        wgs = Math.max(wgs, Math.abs(wl - rw[0]!), Math.abs(wp - rw[1]!));
        const [il, ip] = b.toGcj02Point(lon, lat);
        const ri = gcoord.transform([lon, lat], gcoord.BD09, gcoord.GCJ02);
        inv = Math.max(inv, Math.abs(il - ri[0]!), Math.abs(ip - ri[1]!));
      }
    }
    expect(fwd).toBeLessThan(1e-13);
    expect(wgs).toBeLessThan(1e-13);
    expect(inv).toBeLessThan(3e-6);
  });

  it('is GCJ-02 then the offset', () => {
    for (const [lon, lat] of [
      [116.391, 39.907],
      [13.4, 52.5],
      [-74, 40.7],
    ] as const) {
      expect(b.fromWgs84Point(lon, lat)).toEqual(b.fromGcj02Point(...GCJ02.fromWgs84Point(lon, lat)));
      expect(b.toWgs84Point(lon, lat)).toEqual(GCJ02.toWgs84Point(...b.toGcj02Point(lon, lat)));
    }
  });

  it('round-trips', () => {
    let gcj = 0;
    let wgs = 0;
    for (let lon = 72.1; lon <= 137.8; lon += 0.29) {
      for (let lat = 0.9; lat <= 55.8; lat += 0.31) {
        const [l, p] = b.toGcj02Point(...b.fromGcj02Point(lon, lat));
        gcj = Math.max(gcj, Math.abs(l - lon) * cosd(lat), Math.abs(p - lat));
        const [wl, wp] = b.toWgs84Point(...b.fromWgs84Point(lon, lat));
        wgs = Math.max(wgs, Math.abs(wl - lon) * cosd(lat), Math.abs(wp - lat));
      }
    }
    expect(gcj).toBeLessThan(3e-14);
    expect(wgs).toBeLessThan(1e-12);
  });

  it('round-trips GCJ-02 everywhere clear of the antimeridian', () => {
    let max = 0;
    for (let lat = -89.5; lat <= 89.5; lat += 0.73) {
      for (let lon = -179.9; lon <= 179.9; lon += 3.7) {
        const [l, p] = b.toGcj02Point(...b.fromGcj02Point(lon, lat));
        max = Math.max(max, Math.abs(l - lon) * cosd(lat), Math.abs(p - lat));
      }
    }
    for (let lat = -0.02; lat <= 0.02; lat += 0.0013) {
      for (let lon = -0.02; lon <= 0.02; lon += 0.0017) {
        const [l, p] = b.toGcj02Point(...b.fromGcj02Point(lon, lat));
        max = Math.max(max, Math.abs(l - lon), Math.abs(p - lat));
      }
    }
    expect(max).toBeLessThan(3e-14);
  });

  it('applies the offset outside China; outsideChina only governs the GCJ-02 step', () => {
    const [l, p] = b.fromWgs84Point(13.4, 52.5);
    expect([l, p]).toEqual(b.fromGcj02Point(13.4, 52.5));
    expect(Math.abs(l - 13.4)).toBeGreaterThan(1e-3);
    const t = bd09({ outsideChina: 'transform' });
    expect(t.fromWgs84Point(13.4, 52.5)).toEqual(
      b.fromGcj02Point(...gcj02({ outsideChina: 'transform' }).fromWgs84Point(13.4, 52.5)),
    );
    expect(t.fromGcj02Point(13.4, 52.5)).toEqual(b.fromGcj02Point(13.4, 52.5));
    expect(t.fromWgs84Point(116, 39.9)).toEqual(b.fromWgs84Point(116, 39.9));
  });

  it('gives a valid preimage or NaN near the antimeridian', () => {
    expect(b.fromGcj02Point(-180, 30)).toEqual(b.fromGcj02Point(180, 30));
    // Points that are neither NaN in both coordinates nor a preimage within 1e-12 in (-180, 180].
    const bad: number[][] = [];
    for (const lat of [-75, -30, 0, 30, 60, 88]) {
      for (let lon = -180; lon <= -179.98; lon += 0.00037) {
        for (const g of [lon, -lon]) {
          const [l, p] = b.toGcj02Point(g, lat);
          if (Number.isNaN(l) && Number.isNaN(p)) continue;
          const [bl, bp] = b.fromGcj02Point(l, p);
          const d = Math.abs(bl - g) % 360;
          if (!(l > -180 && l <= 180 && Math.min(d, 360 - d) < 1e-12 && Math.abs(bp - lat) < 1e-12)) bad.push([g, lat]);
        }
        const [fl, fp] = b.fromGcj02Point(lon, lat);
        if (!(Math.abs(fl) <= 180 && Math.abs(fp) <= 90)) bad.push([lon, lat]);
      }
    }
    expect(bad).toEqual([]);
  });

  it('gives valid coordinates or NaN near the poles', () => {
    for (const lat of [89.9, 89.99, 89.999, 90, -89.999, -90]) {
      for (let lon = -180; lon <= 180; lon += 7.5) {
        for (const [l, p] of [b.fromGcj02Point(lon, lat), b.toGcj02Point(lon, lat)]) {
          const valid = Math.abs(l) <= 180 && Math.abs(p) <= 90;
          const nan = Number.isNaN(l) && Number.isNaN(p);
          expect(valid || nan).toBe(true);
        }
      }
    }
    expect(b.fromGcj02Point(0, 90.5)).toEqual([NaN, NaN]);
    expect(b.toGcj02Point(0, -91)).toEqual([NaN, NaN]);
  });

  it('reduces input longitudes', () => {
    expect(b.fromGcj02Point(116.375 + 360, 39.875)).toEqual(b.fromGcj02Point(116.375, 39.875));
    expect(b.toGcj02Point(116.375 - 720, 39.875)).toEqual(b.toGcj02Point(116.375, 39.875));
  });

  it('propagates NaN and rejects infinities', () => {
    for (const f of [b.fromGcj02Point, b.toGcj02Point]) {
      expect(f(NaN, 30)).toEqual([NaN, NaN]);
      expect(f(116, NaN)).toEqual([NaN, NaN]);
      expect(f(Infinity, 30)).toEqual([NaN, NaN]);
    }
  });

  it('validates options', () => {
    // @ts-expect-error invalid option
    expect(() => bd09({ outsideChina: 'clip' })).toThrow(RangeError);
    expect(() => bd09({ foo: 1 } as never)).toThrow(/unknown bd09\(\) option 'foo'/);
  });
});

// Batch methods against the JavaScript point form: exact for the offset, which always runs in JavaScript; through
// WGS84, within the GCJ-02 batch tolerance (the wasm GCJ-02 kernel).
describe.each(backends)('$name backend bd09 batch', ({ bd09: make }) => {
  const b = make();
  const ref = bd09();
  const rows = [...fixture.fromGcj02, ...fixture.toGcj02] as [number, number][];
  const lon = [...rows.map((r) => r[0]), 13.4, -179.99, NaN];
  const lat = [...rows.map((r) => r[1]), 52.5, 30, 1];

  it('validates arguments', () => {
    expect(() => b.fromGcj02([1, 2], [1])).toThrow(RangeError);
    expect(() => b.toGcj02Interleaved([1, 2, 3])).toThrow(RangeError);
    expect(() => b.fromWgs84Interleaved([1, 2], new Float64Array(1))).toThrow(RangeError);
    expect(() => b.toWgs84([1], [2], new Float64Array(0))).toThrow(RangeError);
  });

  function batchError(
    batch: typeof b.toGcj02,
    inter: typeof b.toGcj02Interleaved,
    point: (lon: number, lat: number) => [number, number],
  ) {
    const ll = new Float64Array(lon.flatMap((v, i) => [v, lat[i]!]));
    const r = batch(lon, lat);
    const i = inter(ll);
    let max = 0;
    lon.forEach((v, k) => {
      const [pl, pp] = point(v, lat[k]!);
      for (const [l, p] of [
        [r.lon[k]!, r.lat[k]!],
        [i[2 * k]!, i[2 * k + 1]!],
      ]) {
        if (Object.is(l, pl) && Object.is(p, pp)) continue;
        max = Math.max(max, Math.abs(l! - pl) * cosd(pp), Math.abs(p! - pp));
      }
    });
    return max;
  }

  it('matches the point form', () => {
    expect(batchError(b.fromGcj02, b.fromGcj02Interleaved, ref.fromGcj02Point)).toBe(0);
    expect(batchError(b.toGcj02, b.toGcj02Interleaved, ref.toGcj02Point)).toBe(0);
    expect(batchError(b.fromWgs84, b.fromWgs84Interleaved, ref.fromWgs84Point)).toBeLessThan(6e-14);
    expect(batchError(b.toWgs84, b.toWgs84Interleaved, ref.toWgs84Point)).toBeLessThan(6e-14);
  });

  it('converts in place, into longer buffers', () => {
    for (const [fwd, inv] of [
      [b.fromWgs84, b.toWgs84],
      [b.fromGcj02, b.toGcj02],
    ] as const) {
      const lo = new Float64Array([116.391, 121.4737]);
      const la = new Float64Array([39.907, 31.2304]);
      const want = fwd(lo, la);
      expect(fwd(lo, la, lo, la)).toEqual({ lon: lo, lat: la });
      expect([...lo, ...la]).toEqual([...want.lon, ...want.lat]);
      const big = new Float64Array(5).fill(7);
      inv(lo, la, big, new Float64Array(3));
      expect(big[2]).toBe(7);
      expect(Math.abs(big[0]! - 116.391)).toBeLessThan(1e-12);
    }
    const ll = new Float64Array([116.391, 39.907]);
    const want = b.fromWgs84Interleaved(ll);
    b.fromWgs84Interleaved(ll, ll);
    expect(ll).toEqual(want);
  });
});
