/**
 * GCJ-02 ("Mars coordinates"), the obfuscated coordinate system required for maps of China: the published WGS84 -> GCJ-02 offset
 * formula on the Krasovsky ellipsoid, as in gcoord and coordtransform.
 *
 * The 11 sines of the formula come from two sin/cos pairs, sin(x pi/60) and sin(y pi/180), by multiple-angle
 * identities. The inverse has no closed form; two Newton steps on w + offset(w) = g (up to six near longitude 105),
 * with the Jacobian from the same multiple-angle values, converge to ~1e-12 degrees, and after the first step the two
 * pairs are rotated by the step rather than recomputed.
 */
import * as P from './poly.js';
import { checkEven, checkOptions, checkSame, output } from './checks.js';
import { fuser } from './gcj02-fused.js';
import * as K from './gcj02-constants.js';
import { fusers } from './geographic.js';
import type { Geographic, Impl } from './types.js';

// Bound here, not imported: V8 reads a module's own consts faster than imported ones (fromWgs84 12% in Node).
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
const C35 = K.C35;
const EE = K.EE;
const KLAT = K.KLAT;
const KLON = K.KLON;
const KX = K.KX;
const KY = K.KY;
const LAT_MAX = K.LAT_MAX;
const LAT_MIN = K.LAT_MIN;
const LON_MAX = K.LON_MAX;
const LON_MIN = K.LON_MIN;
const reduce = K.reduce;
const S35 = K.S35;

export interface Gcj02Options {
  /**
   * Points outside the China bounding box (longitude 72.004 to 137.8347, latitude 0.8293 to 55.8271): `'passthrough'`
   * (default) returns them unchanged, `'transform'` applies the offset everywhere.
   */
  outsideChina?: 'passthrough' | 'transform';
}

const STEPS = 2;
// The sqrt(|x|) term's derivative is singular at longitude 105. The Newton steps drop it within DERIV_CUT of 105, or
// within CUSP on the first step, which starts at the input and may be across 105 from the solution; they converge
// more slowly near 105, so take up to CUSP_STEPS within CUSP of it. Outside DERIV_CUT they stop once a step is below
// CUSP_TOL: the next would be under a seventh of it, so the backends can stop a step apart and still agree within an
// ulp. Within DERIV_CUT the steps don't shrink steadily (the next can be 3x the last), so all CUSP_STEPS run.
const CUSP = 1e-4;
const DERIV_CUT = 1e-10;
const CUSP_STEPS = 6;
const CUSP_TOL = 1e-13;
// Derivatives of the offset's sine terms, per degree: (term weight) * (multiple) * (radians per degree of the angle).
const JS360 = (40 / 3) * 360 * KX;
const JS120 = (40 / 3) * 120 * KX;
const JS60 = (40 / 3) * 60 * KX;
const JS20 = (80 / 3) * 20 * KX;
const JS5 = 100 * 5 * KX;
const JS2 = 200 * 2 * KX;
const JU180 = (40 / 3) * 180 * KY;
const JU60 = (80 / 3) * 60 * KY;
const JU15 = (320 / 3) * 15 * KY;
const JU6 = (640 / 3) * 6 * KY;
// 'transform' mode iterates until a step is below TOL degrees, and gives NaN if none is below LOOSE.
const MAX_STEPS = 20;
const TOL = 1e-10;
const LOOSE = 1e-9;

export function gcj02(options: Gcj02Options = {}): Geographic {
  return buildGcj02(gcj02Mode(options));
}

/** Validates the options, reading each once; `fn` names the factory in errors. */
export function gcj02Mode(options: Gcj02Options = {}, fn = 'gcj02'): 'passthrough' | 'transform' {
  checkOptions(options, fn, ['outsideChina']);
  const { outsideChina = 'passthrough' } = options;
  if (typeof outsideChina !== 'string') {
    throw new TypeError(`fast-proj: outsideChina must be a string, got ${typeof outsideChina}`);
  }
  if (outsideChina !== 'passthrough' && outsideChina !== 'transform') {
    throw new RangeError(`fast-proj: outsideChina must be 'passthrough' or 'transform', got '${outsideChina}'`);
  }
  return outsideChina;
}

const built: { passthrough?: Geographic; transform?: Geographic } = {};

/**
 * One shared converter per mode: they are stateless between calls, and engines optimize a closure with a single
 * instance better (JavaScriptCore measured 8% faster).
 */
export function buildGcj02(mode: 'passthrough' | 'transform'): Geographic {
  return (built[mode] ??= makeGcj02(mode));
}

function makeGcj02(mode: 'passthrough' | 'transform'): Geographic {
  const all = mode === 'transform';

  let ox = 0;
  let oy = 0;
  let rx = 0;
  let ry = 0;
  // Results of the 'transform'-mode solver.
  let tx = 0;
  let ty = 0;

  // x = lon - 105, y = lat - 35; s1, c1 = sin, cos(x pi/60); u1, v1 = sin, cos(y pi/180).
  // @kernel
  function offset(x: number, y: number, s1: number, c1: number, u1: number, v1: number): void {
    const s2 = 2 * s1 * c1;
    const c2 = 1 - 2 * s1 * s1;
    const s4 = 2 * s2 * c2;
    const c4 = 1 - 2 * s2 * s2;
    const s5 = s4 * c1 + c4 * s1;
    const c5 = c4 * c1 - s4 * s1;
    const s10 = 2 * s5 * c5;
    const c10 = 1 - 2 * s5 * s5;
    const s20 = 2 * s10 * c10;
    const c20 = 1 - 2 * s10 * s10;
    const s60 = s20 * (3 - 4 * s20 * s20);
    const c60 = c20 * (4 * c20 * c20 - 3);
    const s120 = 2 * s60 * c60;
    const s360 = s120 * (3 - 4 * s120 * s120);

    const u3 = u1 * (3 - 4 * u1 * u1);
    const v3 = v1 * (4 * v1 * v1 - 3);
    const u6 = 2 * u3 * v3;
    const v6 = 1 - 2 * u3 * u3;
    const u12 = 2 * u6 * v6;
    const v12 = 1 - 2 * u6 * u6;
    const u15 = u12 * v3 + v12 * u3;
    const v15 = v12 * v3 - u12 * u3;
    const u30 = 2 * u15 * v15;
    const v30 = 1 - 2 * u15 * u15;
    const u60 = 2 * u30 * v30;
    const u180 = u60 * (3 - 4 * u60 * u60);

    // sin/cos of the latitude itself, by angle addition from y = lat - 35.
    const sp = u1 * C35 + v1 * S35;
    const cp = v1 * C35 - u1 * S35;

    const r = Math.sqrt(Math.abs(x));
    const common = (40 / 3) * (s360 + s120);
    const dLat =
      -100 +
      2 * x +
      3 * y +
      0.2 * y * y +
      0.1 * x * y +
      0.2 * r +
      common +
      (40 / 3) * u180 +
      (80 / 3) * u60 +
      (320 / 3) * u15 +
      (640 / 3) * u6;
    const dLon =
      300 +
      x +
      2 * y +
      0.1 * x * x +
      0.1 * x * y +
      0.1 * r +
      common +
      (40 / 3) * s60 +
      (80 / 3) * s20 +
      100 * s5 +
      200 * s2;
    const m = 1 - EE * sp * sp;
    const sm = Math.sqrt(m);
    // One division for 1 / cp here and 1 / m in the inverse's Jacobian.
    const qcm = 1 / (cp * m);
    const icp = m * qcm;
    const fLon = KLON * sm * icp;
    ox = dLon * fLon;
    oy = dLat * KLAT * m * sm;
  }

  function inDomain(lon: number, lat: number): boolean {
    return all ? lat > -90 && lat < 90 : lon >= LON_MIN && lon <= LON_MAX && lat >= LAT_MIN && lat <= LAT_MAX;
  }

  // @kernel
  function fromWgs84(lon: number, lat: number): void {
    let offLon = 0;
    let offLat = 0;
    if (lon > 180 || lon < -180) lon = reduce(lon);
    if (!inDomain(lon, lat)) {
      rx = all ? NaN : lon;
      ry = all ? NaN : lat;
      return;
    }
    // The offset differs at longitudes 180 and -180; use 180 for both.
    if (lon === -180) lon = 180;
    const x = lon - 105;
    const y = lat - 35;
    let sX: number, cX: number, uY: number, vY: number;
    // sin, cos of x KX by double angles from half of it (|x KX| < pi / 2) and of y KY directly (|y KY| < pi / 4).
    if (x > -30 && x < 30 && y > -45 && y < 45) {
      const hx = 0.5 * KX * x;
      const z = hx * hx;
      const sn = hx + hx * z * (KS1 + z * (KS2 + z * (KS3 + z * (KS4 + z * (KS5 + z * KS6)))));
      const cs = 1 - 0.5 * z + z * z * (KC1 + z * (KC2 + z * (KC3 + z * (KC4 + z * (KC5 + z * KC6)))));
      sX = 2 * sn * cs;
      cX = (cs - sn) * (cs + sn);
      const hy = KY * y;
      const t = hy * hy;
      uY = hy + hy * t * (KS1 + t * (KS2 + t * (KS3 + t * (KS4 + t * (KS5 + t * KS6)))));
      vY = 1 - 0.5 * t + t * t * (KC1 + t * (KC2 + t * (KC3 + t * (KC4 + t * (KC5 + t * KC6)))));
    } else {
      sX = Math.sin(x * KX);
      cX = Math.cos(x * KX);
      uY = Math.sin(y * KY);
      vY = Math.cos(y * KY);
    }
    // @inline offset(x, y, sX, cX, uY, vY); ox = offLon; oy = offLat
    {
      const s1 = sX;
      const c1 = cX;
      const u1 = uY;
      const v1 = vY;
      const s2 = 2 * s1 * c1;
      const c2 = 1 - 2 * s1 * s1;
      const s4 = 2 * s2 * c2;
      const c4 = 1 - 2 * s2 * s2;
      const s5 = s4 * c1 + c4 * s1;
      const c5 = c4 * c1 - s4 * s1;
      const s10 = 2 * s5 * c5;
      const c10 = 1 - 2 * s5 * s5;
      const s20 = 2 * s10 * c10;
      const c20 = 1 - 2 * s10 * s10;
      const s60 = s20 * (3 - 4 * s20 * s20);
      const c60 = c20 * (4 * c20 * c20 - 3);
      const s120 = 2 * s60 * c60;
      const s360 = s120 * (3 - 4 * s120 * s120);

      const u3 = u1 * (3 - 4 * u1 * u1);
      const v3 = v1 * (4 * v1 * v1 - 3);
      const u6 = 2 * u3 * v3;
      const v6 = 1 - 2 * u3 * u3;
      const u12 = 2 * u6 * v6;
      const v12 = 1 - 2 * u6 * u6;
      const u15 = u12 * v3 + v12 * u3;
      const v15 = v12 * v3 - u12 * u3;
      const u30 = 2 * u15 * v15;
      const v30 = 1 - 2 * u15 * u15;
      const u60 = 2 * u30 * v30;
      const u180 = u60 * (3 - 4 * u60 * u60);

      const sp = u1 * 0.8191520442889918 + v1 * 0.573576436351046;
      const cp = v1 * 0.8191520442889918 - u1 * 0.573576436351046;

      const r = Math.sqrt(Math.abs(x));
      const common = (40 / 3) * (s360 + s120);
      const dLat =
        -100 +
        2 * x +
        3 * y +
        0.2 * y * y +
        0.1 * x * y +
        0.2 * r +
        common +
        (40 / 3) * u180 +
        (80 / 3) * u60 +
        (320 / 3) * u15 +
        (640 / 3) * u6;
      const dLon =
        300 +
        x +
        2 * y +
        0.1 * x * x +
        0.1 * x * y +
        0.1 * r +
        common +
        (40 / 3) * s60 +
        (80 / 3) * s20 +
        100 * s5 +
        200 * s2;
      const m = 1 - 0.006693421622965943 * sp * sp;
      const sm = Math.sqrt(m);
      const qcm = 1 / (cp * m);
      const icp = m * qcm;
      const fLon = 0.000008983000733443498 * sm * icp;
      offLon = dLon * fLon;
      offLat = dLat * 0.000009043532912185927 * m * sm;
    }
    // @end
    if (!all) {
      rx = lon + offLon;
      ry = lat + offLat;
      return;
    }
    // Near the poles the offset can exceed a turn of longitude or push latitude past 90.
    const shifted = lat + offLat;
    if (Math.abs(shifted) <= 90) {
      rx = reduce(lon + offLon);
      ry = shifted;
    } else {
      rx = NaN;
      ry = NaN;
    }
  }

  // 'transform' mode. The offset is not periodic in longitude, so iterate without wrapping and, if the solution falls
  // outside [-180, 180] where the forward is defined, solve again for the target a turn away. Gives NaN if a
  // solution isn't found.
  function solve(lon: number, lat: number): boolean {
    let wx = lon;
    let wy = lat;
    let s = 0;
    let c = 0;
    let u = 0;
    let v = 0;
    let d = Infinity;
    let e = Infinity;
    let step = Infinity;
    for (let k = 0; k < MAX_STEPS && !(step < TOL); k++) {
      if (Math.abs(d) < 1e-3 && Math.abs(e) < 1e-3) {
        const d2 = d * d;
        const e2 = e * e;
        const sd = d * (1 - d2 * (1 / 6));
        const cd = 1 - d2 * (0.5 - d2 * (1 / 24));
        const se = e * (1 - e2 * (1 / 6));
        const ce = 1 - e2 * (0.5 - e2 * (1 / 24));
        const s0 = s;
        const u0 = u;
        s = s0 * cd + c * sd;
        c = c * cd - s0 * sd;
        u = u0 * ce + v * se;
        v = v * ce - u0 * se;
      } else {
        s = Math.sin((wx - 105) * KX);
        c = Math.cos((wx - 105) * KX);
        u = Math.sin((wy - 35) * KY);
        v = Math.cos((wy - 35) * KY);
      }
      offset(wx - 105, wy - 35, s, c, u, v);
      const nx = lon - ox;
      const ny = lat - oy;
      d = (nx - wx) * KX;
      e = (ny - wy) * KY;
      step = Math.abs(nx - wx) + Math.abs(ny - wy);
      wx = nx;
      wy = ny;
    }
    tx = wx;
    ty = wy;
    return step < LOOSE && Math.abs(wy) < 90;
  }

  // A solution just past +-180 is on that side's branch of the formula: snap it to the nearest longitude of the same
  // branch (180, or the double above -180, since -180 is treated as 180) and keep it only if the forward still hits
  // the target.
  function snap(lon: number, lat: number): boolean {
    const wx = tx > 180 ? 180 : -180 + 2 ** -45;
    const wy = ty;
    const x = wx - 105;
    const y = wy - 35;
    offset(x, y, Math.sin(x * KX), Math.cos(x * KX), Math.sin(y * KY), Math.cos(y * KY));
    let dx = Math.abs(wx + ox - lon) % 360;
    if (dx > 180) dx = 360 - dx;
    tx = wx;
    return dx + Math.abs(wy + oy - lat) < LOOSE;
  }

  function seam(lon: number, lat: number): boolean {
    if (tx >= -180 && tx <= 180 && tx !== -180) return true;
    if (Math.abs(Math.abs(tx) - 180) < LOOSE) return snap(lon, lat);
    return false;
  }

  function toWgs84All(lon: number, lat: number): void {
    let ok = solve(lon, lat);
    if (ok && !seam(lon, lat)) {
      ok = solve(tx > 0 ? lon - 360 : lon + 360, lat) && seam(lon, lat);
    }
    if (!ok) {
      tx = NaN;
      ty = NaN;
    }
  }

  // @kernel
  function toWgs84(lon: number, lat: number): void {
    let offLon = 0;
    let offLat = 0;
    if (lon > 180 || lon < -180) lon = reduce(lon);
    if (!inDomain(lon, lat)) {
      rx = all ? NaN : lon;
      ry = all ? NaN : lat;
      return;
    }
    if (all) {
      toWgs84All(lon, lat);
      rx = tx;
      ry = ty;
      return;
    }
    const x0 = lon - 105;
    const y0 = lat - 35;
    let s: number, c: number, u: number, v: number;
    // sin, cos of x KX by double angles from half of it (|x KX| < pi / 2) and of y KY directly (|y KY| < pi / 4).
    if (x0 > -30 && x0 < 30 && y0 > -45 && y0 < 45) {
      const hx = 0.5 * KX * x0;
      const z = hx * hx;
      const sn = hx + hx * z * (KS1 + z * (KS2 + z * (KS3 + z * (KS4 + z * (KS5 + z * KS6)))));
      const cs = 1 - 0.5 * z + z * z * (KC1 + z * (KC2 + z * (KC3 + z * (KC4 + z * (KC5 + z * KC6)))));
      s = 2 * sn * cs;
      c = (cs - sn) * (cs + sn);
      const hy = KY * y0;
      const t = hy * hy;
      u = hy + hy * t * (KS1 + t * (KS2 + t * (KS3 + t * (KS4 + t * (KS5 + t * KS6)))));
      v = 1 - 0.5 * t + t * t * (KC1 + t * (KC2 + t * (KC3 + t * (KC4 + t * (KC5 + t * KC6)))));
    } else {
      s = Math.sin(x0 * KX);
      c = Math.cos(x0 * KX);
      u = Math.sin(y0 * KY);
      v = Math.cos(y0 * KY);
    }
    let wx = lon;
    let wy = lat;
    // Newton steps on w + offset(w) = (lon, lat), from w = (lon, lat).
    for (let k = 1; ; k++) {
      // @inline offset(wx - 105, wy - 35, s, c, u, v); ox = offLon; oy = offLat; scope = open
      const x = wx - 105;
      const y = wy - 35;
      const s1 = s;
      const c1 = c;
      const u1 = u;
      const v1 = v;
      const s2 = 2 * s1 * c1;
      const c2 = 1 - 2 * s1 * s1;
      const s4 = 2 * s2 * c2;
      const c4 = 1 - 2 * s2 * s2;
      const s5 = s4 * c1 + c4 * s1;
      const c5 = c4 * c1 - s4 * s1;
      const s10 = 2 * s5 * c5;
      const c10 = 1 - 2 * s5 * s5;
      const s20 = 2 * s10 * c10;
      const c20 = 1 - 2 * s10 * s10;
      const s60 = s20 * (3 - 4 * s20 * s20);
      const c60 = c20 * (4 * c20 * c20 - 3);
      const s120 = 2 * s60 * c60;
      const s360 = s120 * (3 - 4 * s120 * s120);

      const u3 = u1 * (3 - 4 * u1 * u1);
      const v3 = v1 * (4 * v1 * v1 - 3);
      const u6 = 2 * u3 * v3;
      const v6 = 1 - 2 * u3 * u3;
      const u12 = 2 * u6 * v6;
      const v12 = 1 - 2 * u6 * u6;
      const u15 = u12 * v3 + v12 * u3;
      const v15 = v12 * v3 - u12 * u3;
      const u30 = 2 * u15 * v15;
      const v30 = 1 - 2 * u15 * u15;
      const u60 = 2 * u30 * v30;
      const u180 = u60 * (3 - 4 * u60 * u60);

      const sp = u1 * 0.8191520442889918 + v1 * 0.573576436351046;
      const cp = v1 * 0.8191520442889918 - u1 * 0.573576436351046;

      const r = Math.sqrt(Math.abs(x));
      const common = (40 / 3) * (s360 + s120);
      const dLat =
        -100 +
        2 * x +
        3 * y +
        0.2 * y * y +
        0.1 * x * y +
        0.2 * r +
        common +
        (40 / 3) * u180 +
        (80 / 3) * u60 +
        (320 / 3) * u15 +
        (640 / 3) * u6;
      const dLon =
        300 +
        x +
        2 * y +
        0.1 * x * x +
        0.1 * x * y +
        0.1 * r +
        common +
        (40 / 3) * s60 +
        (80 / 3) * s20 +
        100 * s5 +
        200 * s2;
      const m = 1 - 0.006693421622965943 * sp * sp;
      const sm = Math.sqrt(m);
      const qcm = 1 / (cp * m);
      const icp = m * qcm;
      const fLon = 0.000008983000733443498 * sm * icp;
      offLon = dLon * fLon;
      offLat = dLat * 0.000009043532912185927 * m * sm;
      // @end
      // Jacobian of the offset in degrees per degree, from the copy's multiple-angle values. sm / cp and m * sm vary
      // with latitude too: d(sm / cp) = (sm / cp) (t - em), d(m * sm) = -3 m * sm * em, per degree.
      const c120 = 1 - 2 * s60 * s60;
      const c360 = c120 * (4 * c120 * c120 - 3);
      const v60 = 1 - 2 * u30 * u30;
      const v180 = v60 * (4 * v60 * v60 - 3);
      const dr = Math.abs(x) > (k === 1 ? CUSP : DERIV_CUT) ? (x > 0 ? 0.05 : -0.05) / r : 0;
      const dCommon = JS360 * c360 + JS120 * c120;
      const dLonX = 1 + 0.2 * x + 0.1 * y + dr + dCommon + JS60 * c60 + JS20 * c20 + JS5 * c5 + JS2 * c2;
      const dLatX = 2 + 0.1 * y + 2 * dr + dCommon;
      const dLatY = 3 + 0.4 * y + 0.1 * x + JU180 * v180 + JU60 * v60 + JU15 * v15 + JU6 * v6;
      const fLat = KLAT * m * sm;
      const t = sp * icp * KY;
      const em = EE * sp * cp * cp * qcm * KY;
      // Solve (I + J) step = (lon, lat) - w - offset(w).
      const ja = 1 + dLonX * fLon;
      const jb = (2 + 0.1 * x) * fLon + offLon * (t - em);
      const jc = dLatX * fLat;
      const jd = 1 + dLatY * fLat - 3 * offLat * em;
      const gx = lon - offLon - wx;
      const gy = lat - offLat - wy;
      const idet = 1 / (ja * jd - jb * jc);
      const dx = (jd * gx - jb * gy) * idet;
      const dy = (ja * gy - jc * gx) * idet;
      wx += dx;
      wy += dy;
      if (
        k >= STEPS &&
        (k === CUSP_STEPS ||
          !(Math.abs(wx - 105) < CUSP) ||
          (Math.abs(wx - 105) > DERIV_CUT && Math.abs(dx) < CUSP_TOL && Math.abs(dy) < CUSP_TOL))
      )
        break;
      // Rotate the sines by the step instead of recomputing them; inside the China box a step is below 6e-4 rad.
      const d = dx * KX;
      const e = dy * KY;
      const d2 = d * d;
      const e2 = e * e;
      const sd = d * (1 - d2 * (1 / 6));
      const cd = 1 - d2 * (0.5 - d2 * (1 / 24));
      const se = e * (1 - e2 * (1 / 6));
      const ce = 1 - e2 * (0.5 - e2 * (1 / 24));
      const s0 = s;
      const u0 = u;
      s = s0 * cd + c * sd;
      c = c * cd - s0 * sd;
      u = u0 * ce + v * se;
      v = v * ce - u0 * se;
    }
    rx = wx;
    ry = wy;
  }

  // Batch loops over element j of a and b[j + o1], every `step` up to `end`, written to the same places in outA and
  // outB: (0, 1) for separate arrays, (1, 2) interleaved. Each holds a copy of its kernel (see scripts/inline.ts).
  function toWgs84Batch(
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    outA: Float64Array,
    outB: Float64Array,
    o1: number,
    step: number,
    end: number,
  ): void {
    for (let j = 0; j < end; j += step) {
      // @inline toWgs84(a[j]!, b[j + o1]!); rx = outA[j]; ry = outB[j + o1]
      {
        let lon = a[j]!;
        const lat = b[j + o1]!;
        let offLon = 0;
        let offLat = 0;
        if (lon > 180 || lon < -180) lon = reduce(lon);
        if (!inDomain(lon, lat)) {
          outA[j] = all ? NaN : lon;
          outB[j + o1] = all ? NaN : lat;
          continue;
        }
        if (all) {
          toWgs84All(lon, lat);
          outA[j] = tx;
          outB[j + o1] = ty;
          continue;
        }
        const x0 = lon - 105;
        const y0 = lat - 35;
        let s: number, c: number, u: number, v: number;
        if (x0 > -30 && x0 < 30 && y0 > -45 && y0 < 45) {
          const hx = 0.5 * 0.05235987755982988 * x0;
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
          s = 2 * sn * cs;
          c = (cs - sn) * (cs + sn);
          const hy = 0.017453292519943295 * y0;
          const t = hy * hy;
          u =
            hy +
            hy *
              t *
              (-0.16666666666666632 +
                t *
                  (0.00833333333332249 +
                    t *
                      (-0.0001984126982985795 +
                        t * (0.0000027557313707070068 + t * (-2.5050760253406863e-8 + t * 1.58969099521155e-10)))));
          v =
            1 -
            0.5 * t +
            t *
              t *
              (0.0416666666666666 +
                t *
                  (-0.001388888888887411 +
                    t *
                      (0.00002480158728947673 +
                        t * (-2.7557314351390663e-7 + t * (2.087572321298175e-9 + t * -1.1359647557788195e-11)))));
        } else {
          s = Math.sin(x0 * 0.05235987755982988);
          c = Math.cos(x0 * 0.05235987755982988);
          u = Math.sin(y0 * 0.017453292519943295);
          v = Math.cos(y0 * 0.017453292519943295);
        }
        let wx = lon;
        let wy = lat;
        for (let k = 1; ; k++) {
          const x = wx - 105;
          const y = wy - 35;
          const s1 = s;
          const c1 = c;
          const u1 = u;
          const v1 = v;
          const s2 = 2 * s1 * c1;
          const c2 = 1 - 2 * s1 * s1;
          const s4 = 2 * s2 * c2;
          const c4 = 1 - 2 * s2 * s2;
          const s5 = s4 * c1 + c4 * s1;
          const c5 = c4 * c1 - s4 * s1;
          const s10 = 2 * s5 * c5;
          const c10 = 1 - 2 * s5 * s5;
          const s20 = 2 * s10 * c10;
          const c20 = 1 - 2 * s10 * s10;
          const s60 = s20 * (3 - 4 * s20 * s20);
          const c60 = c20 * (4 * c20 * c20 - 3);
          const s120 = 2 * s60 * c60;
          const s360 = s120 * (3 - 4 * s120 * s120);

          const u3 = u1 * (3 - 4 * u1 * u1);
          const v3 = v1 * (4 * v1 * v1 - 3);
          const u6 = 2 * u3 * v3;
          const v6 = 1 - 2 * u3 * u3;
          const u12 = 2 * u6 * v6;
          const v12 = 1 - 2 * u6 * u6;
          const u15 = u12 * v3 + v12 * u3;
          const v15 = v12 * v3 - u12 * u3;
          const u30 = 2 * u15 * v15;
          const v30 = 1 - 2 * u15 * u15;
          const u60 = 2 * u30 * v30;
          const u180 = u60 * (3 - 4 * u60 * u60);

          const sp = u1 * 0.8191520442889918 + v1 * 0.573576436351046;
          const cp = v1 * 0.8191520442889918 - u1 * 0.573576436351046;

          const r = Math.sqrt(Math.abs(x));
          const common = (40 / 3) * (s360 + s120);
          const dLat =
            -100 +
            2 * x +
            3 * y +
            0.2 * y * y +
            0.1 * x * y +
            0.2 * r +
            common +
            (40 / 3) * u180 +
            (80 / 3) * u60 +
            (320 / 3) * u15 +
            (640 / 3) * u6;
          const dLon =
            300 +
            x +
            2 * y +
            0.1 * x * x +
            0.1 * x * y +
            0.1 * r +
            common +
            (40 / 3) * s60 +
            (80 / 3) * s20 +
            100 * s5 +
            200 * s2;
          const m = 1 - 0.006693421622965943 * sp * sp;
          const sm = Math.sqrt(m);
          const qcm = 1 / (cp * m);
          const icp = m * qcm;
          const fLon = 0.000008983000733443498 * sm * icp;
          offLon = dLon * fLon;
          offLat = dLat * 0.000009043532912185927 * m * sm;
          const c120 = 1 - 2 * s60 * s60;
          const c360 = c120 * (4 * c120 * c120 - 3);
          const v60 = 1 - 2 * u30 * u30;
          const v180 = v60 * (4 * v60 * v60 - 3);
          const dr = Math.abs(x) > (k === 1 ? CUSP : 1e-10) ? (x > 0 ? 0.05 : -0.05) / r : 0;
          const dCommon = 251.32741228718345 * c360 + 83.7758040957278 * c120;
          const dLonX =
            1 +
            0.2 * x +
            0.1 * y +
            dr +
            dCommon +
            41.8879020478639 * c60 +
            27.925268031909273 * c20 +
            26.17993877991494 * c5 +
            20.94395102393195 * c2;
          const dLatX = 2 + 0.1 * y + 2 * dr + dCommon;
          const dLatY =
            3 +
            0.4 * y +
            0.1 * x +
            41.88790204786391 * v180 +
            27.925268031909273 * v60 +
            27.925268031909273 * v15 +
            22.340214425527417 * v6;
          const fLat = 0.000009043532912185927 * m * sm;
          const t = sp * icp * 0.017453292519943295;
          const em = 0.006693421622965943 * sp * cp * cp * qcm * 0.017453292519943295;
          const ja = 1 + dLonX * fLon;
          const jb = (2 + 0.1 * x) * fLon + offLon * (t - em);
          const jc = dLatX * fLat;
          const jd = 1 + dLatY * fLat - 3 * offLat * em;
          const gx = lon - offLon - wx;
          const gy = lat - offLat - wy;
          const idet = 1 / (ja * jd - jb * jc);
          const dx = (jd * gx - jb * gy) * idet;
          const dy = (ja * gy - jc * gx) * idet;
          wx += dx;
          wy += dy;
          if (
            k >= 2 &&
            (k === 6 ||
              !(Math.abs(wx - 105) < 0.0001) ||
              (Math.abs(wx - 105) > 1e-10 && Math.abs(dx) < 1e-13 && Math.abs(dy) < 1e-13))
          )
            break;
          const d = dx * 0.05235987755982988;
          const e = dy * 0.017453292519943295;
          const d2 = d * d;
          const e2 = e * e;
          const sd = d * (1 - d2 * (1 / 6));
          const cd = 1 - d2 * (0.5 - d2 * (1 / 24));
          const se = e * (1 - e2 * (1 / 6));
          const ce = 1 - e2 * (0.5 - e2 * (1 / 24));
          const s0 = s;
          const u0 = u;
          s = s0 * cd + c * sd;
          c = c * cd - s0 * sd;
          u = u0 * ce + v * se;
          v = v * ce - u0 * se;
        }
        outA[j] = wx;
        outB[j + o1] = wy;
      }
      // @end
    }
  }

  function fromWgs84Batch(
    a: ArrayLike<number>,
    b: ArrayLike<number>,
    outA: Float64Array,
    outB: Float64Array,
    o1: number,
    step: number,
    end: number,
  ): void {
    for (let j = 0; j < end; j += step) {
      // @inline fromWgs84(a[j]!, b[j + o1]!); rx = outA[j]; ry = outB[j + o1]
      {
        let lon = a[j]!;
        const lat = b[j + o1]!;
        let offLon = 0;
        let offLat = 0;
        if (lon > 180 || lon < -180) lon = reduce(lon);
        if (!inDomain(lon, lat)) {
          outA[j] = all ? NaN : lon;
          outB[j + o1] = all ? NaN : lat;
          continue;
        }
        if (lon === -180) lon = 180;
        const x = lon - 105;
        const y = lat - 35;
        let sX: number, cX: number, uY: number, vY: number;
        if (x > -30 && x < 30 && y > -45 && y < 45) {
          const hx = 0.5 * 0.05235987755982988 * x;
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
          sX = 2 * sn * cs;
          cX = (cs - sn) * (cs + sn);
          const hy = 0.017453292519943295 * y;
          const t = hy * hy;
          uY =
            hy +
            hy *
              t *
              (-0.16666666666666632 +
                t *
                  (0.00833333333332249 +
                    t *
                      (-0.0001984126982985795 +
                        t * (0.0000027557313707070068 + t * (-2.5050760253406863e-8 + t * 1.58969099521155e-10)))));
          vY =
            1 -
            0.5 * t +
            t *
              t *
              (0.0416666666666666 +
                t *
                  (-0.001388888888887411 +
                    t *
                      (0.00002480158728947673 +
                        t * (-2.7557314351390663e-7 + t * (2.087572321298175e-9 + t * -1.1359647557788195e-11)))));
        } else {
          sX = Math.sin(x * 0.05235987755982988);
          cX = Math.cos(x * 0.05235987755982988);
          uY = Math.sin(y * 0.017453292519943295);
          vY = Math.cos(y * 0.017453292519943295);
        }
        {
          const s1 = sX;
          const c1 = cX;
          const u1 = uY;
          const v1 = vY;
          const s2 = 2 * s1 * c1;
          const c2 = 1 - 2 * s1 * s1;
          const s4 = 2 * s2 * c2;
          const c4 = 1 - 2 * s2 * s2;
          const s5 = s4 * c1 + c4 * s1;
          const c5 = c4 * c1 - s4 * s1;
          const s10 = 2 * s5 * c5;
          const c10 = 1 - 2 * s5 * s5;
          const s20 = 2 * s10 * c10;
          const c20 = 1 - 2 * s10 * s10;
          const s60 = s20 * (3 - 4 * s20 * s20);
          const c60 = c20 * (4 * c20 * c20 - 3);
          const s120 = 2 * s60 * c60;
          const s360 = s120 * (3 - 4 * s120 * s120);

          const u3 = u1 * (3 - 4 * u1 * u1);
          const v3 = v1 * (4 * v1 * v1 - 3);
          const u6 = 2 * u3 * v3;
          const v6 = 1 - 2 * u3 * u3;
          const u12 = 2 * u6 * v6;
          const v12 = 1 - 2 * u6 * u6;
          const u15 = u12 * v3 + v12 * u3;
          const v15 = v12 * v3 - u12 * u3;
          const u30 = 2 * u15 * v15;
          const v30 = 1 - 2 * u15 * u15;
          const u60 = 2 * u30 * v30;
          const u180 = u60 * (3 - 4 * u60 * u60);

          const sp = u1 * 0.8191520442889918 + v1 * 0.573576436351046;
          const cp = v1 * 0.8191520442889918 - u1 * 0.573576436351046;

          const r = Math.sqrt(Math.abs(x));
          const common = (40 / 3) * (s360 + s120);
          const dLat =
            -100 +
            2 * x +
            3 * y +
            0.2 * y * y +
            0.1 * x * y +
            0.2 * r +
            common +
            (40 / 3) * u180 +
            (80 / 3) * u60 +
            (320 / 3) * u15 +
            (640 / 3) * u6;
          const dLon =
            300 +
            x +
            2 * y +
            0.1 * x * x +
            0.1 * x * y +
            0.1 * r +
            common +
            (40 / 3) * s60 +
            (80 / 3) * s20 +
            100 * s5 +
            200 * s2;
          const m = 1 - 0.006693421622965943 * sp * sp;
          const sm = Math.sqrt(m);
          const qcm = 1 / (cp * m);
          const icp = m * qcm;
          const fLon = 0.000008983000733443498 * sm * icp;
          offLon = dLon * fLon;
          offLat = dLat * 0.000009043532912185927 * m * sm;
        }
        if (!all) {
          outA[j] = lon + offLon;
          outB[j + o1] = lat + offLat;
          continue;
        }
        const shifted = lat + offLat;
        if (Math.abs(shifted) <= 90) {
          outA[j] = reduce(lon + offLon);
          outB[j + o1] = shifted;
        } else {
          outA[j] = NaN;
          outB[j + o1] = NaN;
        }
      }
      // @end
    }
  }

  const g = Object.freeze({
    toWgs84(lon, lat, outLon?, outLat?) {
      const n = lon.length;
      checkSame(n, lat.length, 'lon and lat');
      const oLon = output(outLon, n, 'outLon'),
        oLat = output(outLat, n, 'outLat');
      toWgs84Batch(lon, lat, oLon, oLat, 0, 1, n);
      return { lon: oLon, lat: oLat };
    },
    fromWgs84(lon, lat, outLon?, outLat?) {
      const n = lon.length;
      checkSame(n, lat.length, 'lon and lat');
      const oLon = output(outLon, n, 'outLon'),
        oLat = output(outLat, n, 'outLat');
      fromWgs84Batch(lon, lat, oLon, oLat, 0, 1, n);
      return { lon: oLon, lat: oLat };
    },
    toWgs84Interleaved(lonlat, outBuf?) {
      const n = lonlat.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      toWgs84Batch(lonlat, lonlat, out, out, 1, 2, n);
      return out;
    },
    fromWgs84Interleaved(lonlat, outBuf?) {
      const n = lonlat.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      fromWgs84Batch(lonlat, lonlat, out, out, 1, 2, n);
      return out;
    },
    toWgs84Point(lon, lat) {
      toWgs84(lon, lat);
      return [rx, ry];
    },
    fromWgs84Point(lon, lat) {
      fromWgs84(lon, lat);
      return [rx, ry];
    },
  } satisfies Impl<Geographic>);
  fusers.set(g, fuser(mode));
  return g;
}

/** GCJ-02 with the default options; the same object `gcj02()` returns. */
export const GCJ02: Geographic = /*#__PURE__*/ gcj02();
