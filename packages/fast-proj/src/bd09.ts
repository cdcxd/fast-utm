/**
 * BD-09, Baidu's coordinate system: GCJ-02 plus Baidu's published offset, as in gcoord and coordtransform. In polar
 * form about (0, 0), a GCJ-02 point at radius r and angle a moves to radius r + 2e-5 sin(lat K) and angle
 * a + 3e-6 cos(lon K), K = 3000 pi / 180, then by (0.0065, 0.006).
 *
 * The forward takes cos and sin of the new angle by angle addition from lon / r and lat / r, so the offset is a small
 * term added to the input and the result is within an ulp. The inverse has no closed form; two Newton steps from the
 * input less (0.0065, 0.006), with the second step's sines rotated by the first step rather than recomputed, are
 * within an ulp of the exact solution (gcoord's closed form is off by up to 2e-6 degrees, 0.2 m).
 *
 * The offset applies everywhere, as in gcoord: outside the China box, 'passthrough' mode leaves out only GCJ-02. Its
 * angle term jumps across the antimeridian (by up to 1e-3 degrees of latitude), so within about 0.01 degrees of
 * longitude +-180 some BD-09 points have two GCJ-02 preimages (the inverse returns one) and some none (NaN).
 */
import { checkEven, checkSame, output } from './checks.js';
import { buildGcj02, gcj02Mode, type Gcj02Options } from './gcj02.js';
import * as K from './gcj02-constants.js';
import type { Bd09, Geographic, Impl } from './types.js';

// Bound here, not imported, as in gcj02.ts.
const KY = K.KY;
const reduce = K.reduce;

/** Same options as GCJ-02's; they apply to its step. */
export type Bd09Options = Gcj02Options;

// Radians per degree of the offset's angles (3000 degrees per degree), and the weights of its radius and angle terms.
const KB = (Math.PI * 3000) / 180;
const AR = 2e-5;
const AT = 3e-6;
const AKB = AR * KB;
const TKB = AT * KB;
const DLON = 0.0065;
const DLAT = 0.006;
// Adding and subtracting 1.5 2^52 rounds a double below 2^51 to the nearest integer.
const ROUND = 1.5 * 2 ** 52;
// sin h = h + h z S(z), cos h = 1 - z/2 + z^2 C(z), z = h^2, |h| <= pi/4, within 2.4e-15 and 2.1e-16: least-squares
// fits on Chebyshev nodes, a term shorter than poly.ts's (the offset needs them to about 1e-12).
const S1 = -0.1666666666660356;
const S2 = 0.008333333321635857;
const S3 = -0.00019841262251392823;
const S4 = 2.7555079875852748e-6;
const S5 = -2.474433021199332e-8;
const C1 = 0.04166666666659918;
const C2 = -0.001388888887795134;
const C3 = 2.480158085064316e-5;
const C4 = -2.7555547913821156e-7;
const C5 = 2.0646636973611476e-9;

/** The point kernels of the GCJ-02 <-> BD-09 offset, shared by every mode and backend. */
interface Offset {
  fromGcj02Point(lon: number, lat: number): [number, number];
  toGcj02Point(lon: number, lat: number): [number, number];
}

let shared: Offset | undefined;

function makeOffset(): Offset {
  let rx = 0;
  let ry = 0;

  // rx, ry = sin, cos of 3000 deg degrees, by quarter turns taken off in degrees: 3000 deg rounds by under 6e-11
  // degrees (1e-12 radians) up to 180, the rest is exact, and the offset needs these to about 1e-12. Math.sin and
  // Math.cos of thousands of radians cost twice as much.
  // @kernel
  // oxlint-disable-next-line no-unused-vars -- only ever copied in
  function turn(deg: number): void {
    const t = 3000 * deg;
    const q = t * (1 / 90) + ROUND - ROUND;
    const h = (t - 90 * q) * KY;
    const z = h * h;
    const sn = h + h * z * (S1 + z * (S2 + z * (S3 + z * (S4 + z * S5))));
    const cs = 1 - 0.5 * z + z * z * (C1 + z * (C2 + z * (C3 + z * (C4 + z * C5))));
    // Rotated by q quarter turns without branches, which random quadrants would mispredict.
    const o = q & 1;
    rx = (1 - (q & 2)) * (sn + o * (cs - sn));
    ry = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
  }

  // GCJ-02 -> BD-09. Latitudes beyond +-90, in or out, give NaN.
  // @kernel
  function fromGcj02(lon: number, lat: number): void {
    if (lon > 180 || lon < -180) lon = reduce(lon);
    if (!(lat >= -90 && lat <= 90)) {
      rx = NaN;
      ry = NaN;
      return;
    }
    // The offset differs at longitudes 180 and -180; use 180 for both, as GCJ-02 does.
    if (lon === -180) lon = 180;
    const r = Math.sqrt(lon * lon + lat * lat);
    const ir = r > 0 ? 1 / r : 0;
    // cos, sin of the angle; atan2(0, 0) = 0 at the origin.
    const ca = r > 0 ? lon * ir : 1;
    const sa = lat * ir;
    let sl = 0;
    let cx = 0;
    // oxlint-disable-next-line no-unused-vars -- cos(lat K) and sin(lon K), which the forward doesn't use
    let cl, sx;
    // @inline turn(lat); rx = sl; ry = cl
    {
      const deg = lat;
      const t = 3000 * deg;
      const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
      const h = (t - 90 * q) * 0.017453292519943295;
      const z = h * h;
      const sn =
        h +
        h *
          z *
          (-0.1666666666660356 +
            z *
              (0.008333333321635857 +
                z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
      const cs =
        1 -
        0.5 * z +
        z *
          z *
          (0.04166666666659918 +
            z *
              (-0.001388888887795134 +
                z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
      const o = q & 1;
      sl = (1 - (q & 2)) * (sn + o * (cs - sn));
      cl = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
    }
    // @end
    // @inline turn(lon); rx = sx; ry = cx
    {
      const deg = lon;
      const t = 3000 * deg;
      const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
      const h = (t - 90 * q) * 0.017453292519943295;
      const z = h * h;
      const sn =
        h +
        h *
          z *
          (-0.1666666666660356 +
            z *
              (0.008333333321635857 +
                z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
      const cs =
        1 -
        0.5 * z +
        z *
          z *
          (0.04166666666659918 +
            z *
              (-0.001388888887795134 +
                z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
      const o = q & 1;
      sx = (1 - (q & 2)) * (sn + o * (cs - sn));
      cx = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
    }
    // @end
    const w = AR * sl;
    const d = AT * cx;
    // |d| <= 3e-6: sin d and cos d - 1 to well under an ulp.
    const d2 = d * d;
    const sd = d - d * d2 * (1 / 6);
    const cm = -0.5 * d2;
    // (r + w)(cos, sin)(a + d) - (lon, lat), a small term to add to the input.
    const pc = ca + (ca * cm - sa * sd);
    const ps = sa + (sa * cm + ca * sd);
    const shifted = lat + (lat * cm + lon * sd + w * ps + DLAT);
    if (Math.abs(shifted) > 90) {
      rx = NaN;
      ry = NaN;
      return;
    }
    const x = lon + (lon * cm - lat * sd + w * pc + DLON);
    rx = x > 180 ? x - 360 : x;
    ry = shifted;
  }

  // BD-09 -> GCJ-02: Newton steps on F(w) = (lon, lat), F the forward, from w = (lon, lat) - (0.0065, 0.006). The
  // forward is defined on longitudes (-180, 180]; a solution at or below -180 is solved again for the target a turn
  // away.
  // @kernel
  function toGcj02(lon: number, lat: number): void {
    if (lon > 180 || lon < -180) lon = reduce(lon);
    if (!(lat >= -90 && lat <= 90)) {
      rx = NaN;
      ry = NaN;
      return;
    }
    let gx = lon;
    let x = 0;
    let y = 0;
    for (let pass = 0; ; pass++) {
      x = gx - DLON;
      y = lat - DLAT;
      let sy = 0;
      let cy = 0;
      let sx = 0;
      let cx = 0;
      // @inline turn(y); rx = sy; ry = cy
      {
        const deg = y;
        const t = 3000 * deg;
        const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
        const h = (t - 90 * q) * 0.017453292519943295;
        const z = h * h;
        const sn =
          h +
          h *
            z *
            (-0.1666666666660356 +
              z *
                (0.008333333321635857 +
                  z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
        const cs =
          1 -
          0.5 * z +
          z *
            z *
            (0.04166666666659918 +
              z *
                (-0.001388888887795134 +
                  z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
        const o = q & 1;
        sy = (1 - (q & 2)) * (sn + o * (cs - sn));
        cy = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
      }
      // @end
      // @inline turn(x); rx = sx; ry = cx
      {
        const deg = x;
        const t = 3000 * deg;
        const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
        const h = (t - 90 * q) * 0.017453292519943295;
        const z = h * h;
        const sn =
          h +
          h *
            z *
            (-0.1666666666660356 +
              z *
                (0.008333333321635857 +
                  z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
        const cs =
          1 -
          0.5 * z +
          z *
            z *
            (0.04166666666659918 +
              z *
                (-0.001388888887795134 +
                  z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
        const o = q & 1;
        sx = (1 - (q & 2)) * (sn + o * (cs - sn));
        cx = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
      }
      // @end
      for (let k = 0; k < 2; k++) {
        const r = Math.sqrt(x * x + y * y);
        const ir = r > 0 ? 1 / r : 0;
        const ca = r > 0 ? x * ir : 1;
        const sa = y * ir;
        const w = AR * sy;
        const d = AT * cx;
        const d2 = d * d;
        const sd = d - d * d2 * (1 / 6);
        const cm = -0.5 * d2;
        const pc = ca + (ca * cm - sa * sd);
        const ps = sa + (sa * cm + ca * sd);
        // F(w) - target, the large parts first: x - gx is exact near the solution.
        const fx = x - gx + (x * cm - y * sd + w * pc + DLON);
        const fy = y - lat + (y * cm + x * sd + w * ps + DLAT);
        // F = z (cos, sin)(t) with z = r + w, t = a + d: the Jacobian from the partials of z and t.
        const z = r + w;
        const zy = sa + AKB * cy;
        const tx = -sa * ir - TKB * sx;
        const ty = ca * ir;
        const j11 = pc * ca - z * ps * tx;
        const j12 = pc * zy - z * ps * ty;
        const j21 = ps * ca + z * pc * tx;
        const j22 = ps * zy + z * pc * ty;
        const idet = 1 / (j11 * j22 - j12 * j21);
        const dx = (j22 * fx - j12 * fy) * idet;
        const dy = (j11 * fy - j21 * fx) * idet;
        x -= dx;
        y -= dy;
        if (k === 1) break;
        // Rotate the sines by the step, |angle| < 0.04: series to under 1e-14.
        const ex = -dx * KB;
        const ey = -dy * KB;
        const ex2 = ex * ex;
        const ey2 = ey * ey;
        const sex = ex * (1 - ex2 * (1 / 6 - ex2 * (1 / 120)));
        const cex = 1 - ex2 * (0.5 - ex2 * (1 / 24 - ex2 * (1 / 720)));
        const sey = ey * (1 - ey2 * (1 / 6 - ey2 * (1 / 120)));
        const cey = 1 - ey2 * (0.5 - ey2 * (1 / 24 - ey2 * (1 / 720)));
        const sx0 = sx;
        const sy0 = sy;
        sx = sx0 * cex + cx * sex;
        cx = cx * cex - sx0 * sex;
        sy = sy0 * cey + cy * sey;
        cy = cy * cey - sy0 * sey;
      }
      if (x > -180 || pass === 1) break;
      gx += 360;
    }
    if (x > -180 && x <= 180 && y >= -90 && y <= 90) {
      rx = x;
      ry = y;
    } else {
      rx = NaN;
      ry = NaN;
    }
  }

  return {
    fromGcj02Point(lon, lat) {
      fromGcj02(lon, lat);
      return [rx, ry];
    },
    toGcj02Point(lon, lat) {
      toGcj02(lon, lat);
      return [rx, ry];
    },
  };
}

// Batch loops as in tmerc.ts: (o1, step) = (0, 1) for separate arrays, (1, 2) interleaved.
function fromGcj02Batch(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  outA: Float64Array,
  outB: Float64Array,
  o1: number,
  step: number,
  end: number,
): void {
  for (let j = 0; j < end; j += step) {
    // @inline fromGcj02(a[j]!, b[j + o1]!); rx = outA[j]; ry = outB[j + o1]
    {
      let lon = a[j]!;
      const lat = b[j + o1]!;
      if (lon > 180 || lon < -180) lon = reduce(lon);
      if (!(lat >= -90 && lat <= 90)) {
        outA[j] = NaN;
        outB[j + o1] = NaN;
        continue;
      }
      if (lon === -180) lon = 180;
      const r = Math.sqrt(lon * lon + lat * lat);
      const ir = r > 0 ? 1 / r : 0;
      const ca = r > 0 ? lon * ir : 1;
      const sa = lat * ir;
      let sl = 0;
      let cx = 0;
      // oxlint-disable-next-line no-unused-vars -- cos(lat K) and sin(lon K), which the forward doesn't use
      let cl, sx;
      {
        const deg = lat;
        const t = 3000 * deg;
        const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
        const h = (t - 90 * q) * 0.017453292519943295;
        const z = h * h;
        const sn =
          h +
          h *
            z *
            (-0.1666666666660356 +
              z *
                (0.008333333321635857 +
                  z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
        const cs =
          1 -
          0.5 * z +
          z *
            z *
            (0.04166666666659918 +
              z *
                (-0.001388888887795134 +
                  z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
        const o = q & 1;
        sl = (1 - (q & 2)) * (sn + o * (cs - sn));
        cl = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
      }
      {
        const deg = lon;
        const t = 3000 * deg;
        const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
        const h = (t - 90 * q) * 0.017453292519943295;
        const z = h * h;
        const sn =
          h +
          h *
            z *
            (-0.1666666666660356 +
              z *
                (0.008333333321635857 +
                  z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
        const cs =
          1 -
          0.5 * z +
          z *
            z *
            (0.04166666666659918 +
              z *
                (-0.001388888887795134 +
                  z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
        const o = q & 1;
        sx = (1 - (q & 2)) * (sn + o * (cs - sn));
        cx = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
      }
      const w = 0.00002 * sl;
      const d = 0.000003 * cx;
      const d2 = d * d;
      const sd = d - d * d2 * (1 / 6);
      const cm = -0.5 * d2;
      const pc = ca + (ca * cm - sa * sd);
      const ps = sa + (sa * cm + ca * sd);
      const shifted = lat + (lat * cm + lon * sd + w * ps + 0.006);
      if (Math.abs(shifted) > 90) {
        outA[j] = NaN;
        outB[j + o1] = NaN;
        continue;
      }
      const x = lon + (lon * cm - lat * sd + w * pc + 0.0065);
      outA[j] = x > 180 ? x - 360 : x;
      outB[j + o1] = shifted;
    }
    // @end
  }
}

function toGcj02Batch(
  a: ArrayLike<number>,
  b: ArrayLike<number>,
  outA: Float64Array,
  outB: Float64Array,
  o1: number,
  step: number,
  end: number,
): void {
  for (let j = 0; j < end; j += step) {
    // @inline toGcj02(a[j]!, b[j + o1]!); rx = outA[j]; ry = outB[j + o1]
    {
      let lon = a[j]!;
      const lat = b[j + o1]!;
      if (lon > 180 || lon < -180) lon = reduce(lon);
      if (!(lat >= -90 && lat <= 90)) {
        outA[j] = NaN;
        outB[j + o1] = NaN;
        continue;
      }
      let gx = lon;
      let x = 0;
      let y = 0;
      for (let pass = 0; ; pass++) {
        x = gx - 0.0065;
        y = lat - 0.006;
        let sy = 0;
        let cy = 0;
        let sx = 0;
        let cx = 0;
        {
          const deg = y;
          const t = 3000 * deg;
          const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
          const h = (t - 90 * q) * 0.017453292519943295;
          const z = h * h;
          const sn =
            h +
            h *
              z *
              (-0.1666666666660356 +
                z *
                  (0.008333333321635857 +
                    z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
          const cs =
            1 -
            0.5 * z +
            z *
              z *
              (0.04166666666659918 +
                z *
                  (-0.001388888887795134 +
                    z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
          const o = q & 1;
          sy = (1 - (q & 2)) * (sn + o * (cs - sn));
          cy = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
        }
        {
          const deg = x;
          const t = 3000 * deg;
          const q = t * (1 / 90) + 6755399441055744 - 6755399441055744;
          const h = (t - 90 * q) * 0.017453292519943295;
          const z = h * h;
          const sn =
            h +
            h *
              z *
              (-0.1666666666660356 +
                z *
                  (0.008333333321635857 +
                    z * (-0.00019841262251392823 + z * (0.0000027555079875852748 + z * -2.474433021199332e-8))));
          const cs =
            1 -
            0.5 * z +
            z *
              z *
              (0.04166666666659918 +
                z *
                  (-0.001388888887795134 +
                    z * (0.00002480158085064316 + z * (-2.7555547913821156e-7 + z * 2.0646636973611476e-9))));
          const o = q & 1;
          sx = (1 - (q & 2)) * (sn + o * (cs - sn));
          cx = (1 - ((q + 1) & 2)) * (cs + o * (sn - cs));
        }
        for (let k = 0; k < 2; k++) {
          const r = Math.sqrt(x * x + y * y);
          const ir = r > 0 ? 1 / r : 0;
          const ca = r > 0 ? x * ir : 1;
          const sa = y * ir;
          const w = 0.00002 * sy;
          const d = 0.000003 * cx;
          const d2 = d * d;
          const sd = d - d * d2 * (1 / 6);
          const cm = -0.5 * d2;
          const pc = ca + (ca * cm - sa * sd);
          const ps = sa + (sa * cm + ca * sd);
          const fx = x - gx + (x * cm - y * sd + w * pc + 0.0065);
          const fy = y - lat + (y * cm + x * sd + w * ps + 0.006);
          const z = r + w;
          const zy = sa + 0.0010471975511965978 * cy;
          const tx = -sa * ir - 0.00015707963267948965 * sx;
          const ty = ca * ir;
          const j11 = pc * ca - z * ps * tx;
          const j12 = pc * zy - z * ps * ty;
          const j21 = ps * ca + z * pc * tx;
          const j22 = ps * zy + z * pc * ty;
          const idet = 1 / (j11 * j22 - j12 * j21);
          const dx = (j22 * fx - j12 * fy) * idet;
          const dy = (j11 * fy - j21 * fx) * idet;
          x -= dx;
          y -= dy;
          if (k === 1) break;
          const ex = -dx * 52.35987755982988;
          const ey = -dy * 52.35987755982988;
          const ex2 = ex * ex;
          const ey2 = ey * ey;
          const sex = ex * (1 - ex2 * (1 / 6 - ex2 * (1 / 120)));
          const cex = 1 - ex2 * (0.5 - ex2 * (1 / 24 - ex2 * (1 / 720)));
          const sey = ey * (1 - ey2 * (1 / 6 - ey2 * (1 / 120)));
          const cey = 1 - ey2 * (0.5 - ey2 * (1 / 24 - ey2 * (1 / 720)));
          const sx0 = sx;
          const sy0 = sy;
          sx = sx0 * cex + cx * sex;
          cx = cx * cex - sx0 * sex;
          sy = sy0 * cey + cy * sey;
          cy = cy * cey - sy0 * sey;
        }
        if (x > -180 || pass === 1) break;
        gx += 360;
      }
      if (x > -180 && x <= 180 && y >= -90 && y <= 90) {
        outA[j] = x;
        outB[j + o1] = y;
      } else {
        outA[j] = NaN;
        outB[j + o1] = NaN;
      }
    }
    // @end
  }
}

// The first n elements, as the buffer itself when it has exactly n, as in geographic.ts.
function head(a: Float64Array, n: number): Float64Array {
  return a.length === n ? a : a.subarray(0, n);
}

/**
 * BD-09 over `gcj`, a GCJ-02 converter: WGS84 <-> `gcj` <-> the offset, the second step in place on the first n
 * elements of the output buffer. A wasm context passes its own GCJ-02.
 */
export function composeBd09(gcj: Geographic): Bd09 {
  const o = (shared ??= makeOffset());
  return Object.freeze({
    toWgs84(lon, lat, outLon?, outLat?) {
      const n = lon.length;
      checkSame(n, lat.length, 'lon and lat');
      const oLon = output(outLon, n, 'outLon'),
        oLat = output(outLat, n, 'outLat');
      toGcj02Batch(lon, lat, oLon, oLat, 0, 1, n);
      const lo = head(oLon, n),
        la = head(oLat, n);
      gcj.toWgs84(lo, la, lo, la);
      return { lon: oLon, lat: oLat };
    },
    fromWgs84(lon, lat, outLon?, outLat?) {
      const n = lon.length;
      checkSame(n, lat.length, 'lon and lat');
      const oLon = output(outLon, n, 'outLon'),
        oLat = output(outLat, n, 'outLat');
      const lo = head(oLon, n),
        la = head(oLat, n);
      gcj.fromWgs84(lon, lat, lo, la);
      fromGcj02Batch(lo, la, lo, la, 0, 1, n);
      return { lon: oLon, lat: oLat };
    },
    toWgs84Interleaved(lonlat, outBuf?) {
      const n = lonlat.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      toGcj02Batch(lonlat, lonlat, out, out, 1, 2, n);
      const h = head(out, n);
      gcj.toWgs84Interleaved(h, h);
      return out;
    },
    fromWgs84Interleaved(lonlat, outBuf?) {
      const n = lonlat.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      const h = head(out, n);
      gcj.fromWgs84Interleaved(lonlat, h);
      fromGcj02Batch(h, h, h, h, 1, 2, n);
      return out;
    },
    toWgs84Point(lon, lat) {
      const [x, y] = o.toGcj02Point(lon, lat);
      return gcj.toWgs84Point(x, y);
    },
    fromWgs84Point(lon, lat) {
      const [x, y] = gcj.fromWgs84Point(lon, lat);
      return o.fromGcj02Point(x, y);
    },
    toGcj02(lon, lat, outLon?, outLat?) {
      const n = lon.length;
      checkSame(n, lat.length, 'lon and lat');
      const oLon = output(outLon, n, 'outLon'),
        oLat = output(outLat, n, 'outLat');
      toGcj02Batch(lon, lat, oLon, oLat, 0, 1, n);
      return { lon: oLon, lat: oLat };
    },
    fromGcj02(lon, lat, outLon?, outLat?) {
      const n = lon.length;
      checkSame(n, lat.length, 'lon and lat');
      const oLon = output(outLon, n, 'outLon'),
        oLat = output(outLat, n, 'outLat');
      fromGcj02Batch(lon, lat, oLon, oLat, 0, 1, n);
      return { lon: oLon, lat: oLat };
    },
    toGcj02Interleaved(lonlat, outBuf?) {
      const n = lonlat.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      toGcj02Batch(lonlat, lonlat, out, out, 1, 2, n);
      return out;
    },
    fromGcj02Interleaved(lonlat, outBuf?) {
      const n = lonlat.length;
      checkEven(n);
      const out = output(outBuf, n, 'out');
      fromGcj02Batch(lonlat, lonlat, out, out, 1, 2, n);
      return out;
    },
    toGcj02Point: (lon, lat) => o.toGcj02Point(lon, lat),
    fromGcj02Point: (lon, lat) => o.fromGcj02Point(lon, lat),
  } satisfies Impl<Bd09>);
}

const built: { passthrough?: Bd09; transform?: Bd09 } = {};

export function bd09(options: Bd09Options = {}): Bd09 {
  const mode = gcj02Mode(options, 'bd09');
  return (built[mode] ??= composeBd09(buildGcj02(mode)));
}

/** BD-09 with the default options; the same object `bd09()` returns. */
export const BD09: Bd09 = /*#__PURE__*/ bd09();
