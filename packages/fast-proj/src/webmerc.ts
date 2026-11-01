/**
 * Web Mercator (EPSG:3857): the spherical Mercator on a sphere of radius WGS84.a, applied to WGS84 longitude/latitude.
 *
 * - forward: x = R lambda, y = R ln tan(pi/4 + phi/2) from sin and cos of phi/2, with log1p near the equator, and from
 *   the colatitude poleward of 45 degrees, accurate near the poles;
 * - inverse: lambda = x / R, phi = atan(sinh(y / R)), the Gudermannian, as 2 atan(tanh(y / 2R)) below 45 degrees and
 *   pi/2 - 2 atan(exp(-|y| / R)) above, from an inline exp and atan (Math.sinh and Math.atan are calls into C++ in V8).
 */
import * as P from './poly.js';
import { checkEven, checkOptions, checkSame, output } from './checks.js';
import { checkGeographic, withGeographic } from './geographic.js';
import type { Geographic, Impl, Projection } from './types.js';

// Bound here, not imported, as in gcj02.ts.
const KC1 = P.KC1;
const KC2 = P.KC2;
const KC3 = P.KC3;
const KC4 = P.KC4;
const KC5 = P.KC5;
const KC6 = P.KC6;
const KS1 = P.KS1;
const KS2 = P.KS2;
const KS3 = P.KS3;
const KS4 = P.KS4;
const KS5 = P.KS5;
const KS6 = P.KS6;
const KA0 = P.KA0;
const KA1 = P.KA1;
const KA2 = P.KA2;
const KA3 = P.KA3;
const KA4 = P.KA4;
const KA5 = P.KA5;
const KA6 = P.KA6;
const KA7 = P.KA7;
const KA8 = P.KA8;
const KA9 = P.KA9;
const KE0 = P.KE0;
const KE1 = P.KE1;
const KE2 = P.KE2;
const KE3 = P.KE3;
const KE4 = P.KE4;
const KE5 = P.KE5;
const KE6 = P.KE6;
const KE7 = P.KE7;
const KE8 = P.KE8;
const KE9 = P.KE9;

export interface WebMercatorOptions {
  /** Geographic system of `toLonLat`/`fromLonLat`. Default WGS84. */
  geographic?: Geographic;
}

const OPTIONS = ['geographic'];
const R = 6378137;
const D2R = Math.PI / 180;
const R2D = 180 / Math.PI;
// Metres per degree of longitude, rounded so that pi R (the double nearest the half-circumference) divides to 180.
const K = (R * Math.PI) / 180;
const LOG2E = Math.LOG2E;
const LN2_HI = 6.9314718036912381649e-1;
const LN2_LO = 1.90821492927058770002e-10;
const PI_2 = Math.PI / 2;
const PI_2_LO = 6.123233995736766e-17;
const ASINH1 = Math.asinh(1);
const POW2 = new Float64Array(59).map((_, k) => 2 ** k);

/** Web Mercator, EPSG:3857. Latitudes beyond ±85.0511° (the square tile limit) are not clamped. */
export function webMercator(options: WebMercatorOptions = {}): Projection {
  const [p, g] = parseWebMercator(options);
  return withGeographic(p, g);
}

/** Validates the options and builds the JavaScript converter without its geographic step. */
export function parseWebMercator(options: WebMercatorOptions = {}): [Projection, Geographic | undefined] {
  checkOptions(options, 'webMercator', OPTIONS);
  const { geographic } = options;
  checkGeographic(geographic);
  return [sphericalMercator(), geographic];
}

function sphericalMercator(): Projection {
  let rx = 0;
  let ry = 0;

  // @kernel
  function wmForward(lonDeg: number, latDeg: number): void {
    // The poles have no finite y (tan(pi/2) rounds to a finite 1.6e16); infinite longitudes have no x.
    if (!(latDeg < 90 && latDeg > -90 && Math.abs(lonDeg) < Infinity)) {
      rx = NaN;
      ry = NaN;
      return;
    }
    // Whole turns first, exactly, as in tmerc.ts.
    if (lonDeg > 180 || lonDeg < -180) {
      lonDeg %= 360;
      if (lonDeg > 180) lonDeg -= 360;
      else if (lonDeg < -180) lonDeg += 360;
    }
    rx = K * lonDeg;
    // y = R ln tan(pi/4 + phi/2) = R ln((c + s) / (c - s)) for s, c = sin, cos(phi/2): log1p for the accuracy near the
    // equator; poleward of 45, R ln(c' / s') from half the colatitude, which is exact there (phi in radians would lose
    // digits as it nears pi/2).
    const alat = Math.abs(latDeg);
    const hx = 0.5 * D2R * (alat <= 45 ? latDeg : 90 - alat);
    const z = hx * hx;
    const sn = hx + hx * z * (KS1 + z * (KS2 + z * (KS3 + z * (KS4 + z * (KS5 + z * KS6)))));
    const cs = 1 - 0.5 * z + z * z * (KC1 + z * (KC2 + z * (KC3 + z * (KC4 + z * (KC5 + z * KC6)))));
    // latDeg = 0 keeps its sign.
    ry =
      alat <= 45
        ? latDeg === 0
          ? latDeg
          : R * Math.log1p((2 * sn) / (cs - sn))
        : R * Math.sign(latDeg) * Math.log(cs / sn);
  }

  // @kernel
  function wmInverse(x: number, y: number): void {
    // An infinite y would give ±90; keep infinite input NaN, as in the other projections.
    if (!(Math.abs(x) < Infinity && Math.abs(y) < Infinity)) {
      rx = NaN;
      ry = NaN;
      return;
    }
    let lon = x / K;
    if (lon > 180 || lon < -180) {
      lon %= 360;
      if (lon > 180) lon -= 360;
      else if (lon < -180) lon += 360;
    }
    rx = lon;
    // phi = gd(v) for v = |y| / R, from exp(r), v = k ln 2 + r. Below v = asinh(1), where phi = pi/4, phi = 2 atan(m /
    // (m + 2)) with m = expm1(v) = 2^k (1 + expm1(r)) - 1, an exact cancellation for k = 0; above, phi = pi/2 - 2
    // atan(exp(-v)) with exp(-v) = 2^-k (1 + expm1(-r)). Either atan argument is within tan(pi/8). Beyond v = 40, phi
    // rounds to pi/2.
    let v = Math.abs(y * (1 / R));
    if (v > 40) v = 40;
    const k = Math.round(v * LOG2E);
    const r = v - k * LN2_HI - k * LN2_LO;
    const r2 = r * r;
    const qe = KE0 + r2 * (KE2 + r2 * (KE4 + r2 * (KE6 + r2 * KE8)));
    const qo = KE1 + r2 * (KE3 + r2 * (KE5 + r2 * (KE7 + r2 * KE9)));
    const near = v < ASINH1;
    const rr = near ? r : -r;
    const q = rr + r2 * (qe + rr * qo);
    const s = POW2[k]!;
    const u = near ? (s * q + (s - 1)) / (s * q + (s + 1)) : (1 + q) / s;
    const t = u * u;
    const t2 = t * t;
    const ae = KA0 + t2 * (KA2 + t2 * (KA4 + t2 * (KA6 + t2 * KA8)));
    const ao = KA1 + t2 * (KA3 + t2 * (KA5 + t2 * (KA7 + t2 * KA9)));
    const w = 2 * (u + u * t * (ae + t * ao));
    const g = near ? w : PI_2 - (w - PI_2_LO);
    // y = -0 keeps its sign.
    ry = g * Math.sign(y) * R2D;
  }

  return {
    toLonLat(x, y, lonBuf?, latBuf?) {
      const n = x.length;
      checkSame(n, y.length, 'x and y');
      const lon = output(lonBuf, n, 'lon'),
        lat = output(latBuf, n, 'lat');
      inverseBatch(x, y, lon, lat, 0, 1, n);
      return { lon, lat };
    },
    fromLonLat(lon, lat, xBuf?, yBuf?) {
      const n = lon.length;
      checkSame(n, lat.length, 'lon and lat');
      const x = output(xBuf, n, 'x'),
        y = output(yBuf, n, 'y');
      forwardBatch(lon, lat, x, y, 0, 1, n);
      return { x, y };
    },
    toLonLatInterleaved(xy, outBuf?) {
      const n = xy.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      inverseBatch(xy, xy, out, out, 1, 2, n);
      return out;
    },
    fromLonLatInterleaved(lonlat, outBuf?) {
      const n = lonlat.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      forwardBatch(lonlat, lonlat, out, out, 1, 2, n);
      return out;
    },
    toLonLatPoint(x, y) {
      wmInverse(x, y);
      return [rx, ry];
    },
    fromLonLatPoint(lon, lat) {
      wmForward(lon, lat);
      return [rx, ry];
    },
  } satisfies Impl<Projection>;
}

// Batch loops as in tmerc.ts: (o1, step) = (0, 1) for separate arrays, (1, 2) interleaved.
function inverseBatch(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  outA: Float64Array,
  outB: Float64Array,
  o1: number,
  step: number,
  end: number,
): void {
  for (let j = 0; j < end; j += step) {
    // @inline wmInverse(a[j]!, b[j + o1]!); rx = outA[j]; ry = outB[j + o1]
    {
      const x = a[j]!;
      const y = b[j + o1]!;
      if (!(Math.abs(x) < Infinity && Math.abs(y) < Infinity)) {
        outA[j] = NaN;
        outB[j + o1] = NaN;
        continue;
      }
      let lon = x / 111319.49079327358;
      if (lon > 180 || lon < -180) {
        lon %= 360;
        if (lon > 180) lon -= 360;
        else if (lon < -180) lon += 360;
      }
      outA[j] = lon;
      let v = Math.abs(y * (1 / 6378137));
      if (v > 40) v = 40;
      const k = Math.round(v * Math.LOG2E);
      const r = v - k * 0.6931471803691238 - k * 1.9082149292705877e-10;
      const r2 = r * r;
      const qe =
        0.5000000000000001 +
        r2 *
          (0.04166666666662416 +
            r2 * (0.0013888888917198588 + r2 * (0.000024801521319879672 + r2 * 2.762007691611333e-7)));
      const qo =
        0.1666666666666667 +
        r2 *
          (0.008333333333326141 +
            r2 * (0.00019841269874802173 + r2 * (0.000002755725542387984 + r2 * 2.510520706464424e-8)));
      const near = v < 0.881373587019543;
      const rr = near ? r : -r;
      const q = rr + r2 * (qe + rr * qo);
      const s = POW2[k]!;
      const u = near ? (s * q + (s - 1)) / (s * q + (s + 1)) : (1 + q) / s;
      const t = u * u;
      const t2 = t * t;
      const ae =
        -0.3333333333333325 +
        t2 *
          (-0.14285714266539506 +
            t2 * (-0.09090853344129342 + t2 * (-0.06649743882366685 + t2 * -0.04485655846626989)));
      const ao =
        0.19999999999901275 +
        t2 *
          (0.11111109662900268 + t2 * (0.07691068361407245 + t2 * (0.05737080629289906 + t2 * 0.022780530526983894)));
      const w = 2 * (u + u * t * (ae + t * ao));
      const g = near ? w : 1.5707963267948966 - (w - 6.123233995736766e-17);
      outB[j + o1] = g * Math.sign(y) * 57.29577951308232;
    }
    // @end
  }
}

function forwardBatch(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  outA: Float64Array,
  outB: Float64Array,
  o1: number,
  step: number,
  end: number,
): void {
  for (let j = 0; j < end; j += step) {
    // @inline wmForward(a[j]!, b[j + o1]!); rx = outA[j]; ry = outB[j + o1]
    {
      let lonDeg = a[j]!;
      const latDeg = b[j + o1]!;
      if (!(latDeg < 90 && latDeg > -90 && Math.abs(lonDeg) < Infinity)) {
        outA[j] = NaN;
        outB[j + o1] = NaN;
        continue;
      }
      if (lonDeg > 180 || lonDeg < -180) {
        lonDeg %= 360;
        if (lonDeg > 180) lonDeg -= 360;
        else if (lonDeg < -180) lonDeg += 360;
      }
      outA[j] = 111319.49079327358 * lonDeg;
      const alat = Math.abs(latDeg);
      const hx = 0.5 * 0.017453292519943295 * (alat <= 45 ? latDeg : 90 - alat);
      const z = hx * hx;
      const sn =
        hx +
        hx *
          z *
          (-0.16666666666666632 +
            z *
              (0.00833333333332249 +
                z *
                  (-0.0001984126982985795 +
                    z * (0.0000027557313707070068 + z * (-2.5050760253406863e-8 + z * 1.58969099521155e-10)))));
      const cs =
        1 -
        0.5 * z +
        z *
          z *
          (0.0416666666666666 +
            z *
              (-0.001388888888887411 +
                z *
                  (0.00002480158728947673 +
                    z * (-2.7557314351390663e-7 + z * (2.087572321298175e-9 + z * -1.1359647557788195e-11)))));
      outB[j + o1] =
        alat <= 45
          ? latDeg === 0
            ? latDeg
            : 6378137 * Math.log1p((2 * sn) / (cs - sn))
          : 6378137 * Math.sign(latDeg) * Math.log(cs / sn);
    }
    // @end
  }
}
