//! f64x2 GCJ-02 kernel (passthrough mode) — the vector twin of `gcj::sgcj`
//! and src/gcj02.ts.
//!
//! Out-of-box lanes compute garbage (wasm float ops don't trap) and select
//! their (reduced) input at the end; pairs with both lanes out of the box skip
//! the math, also within a group of two. The inverse's extra Newton steps near longitude 105 are masked
//! per lane, so each lane takes exactly the steps the TS loop would. The batch
//! loops take two pairs at a time through the same code (`Vx`): 6% (forward)
//! and 13% (inverse) faster in V8, within 1% in JavaScriptCore.

use crate::gcj::*;
use crate::kernel::reduce_lon;
use core::arch::wasm32::{
    f64x2, f64x2_extract_lane, f64x2_ge, f64x2_gt, f64x2_le, f64x2_lt, v128, v128_and, v128_any_true, v128_or,
};

use crate::math::{C, S};
use crate::simd::{load_pair, poly_eo, store_pair, Vx};

#[inline(always)]
fn spl<T: Vx>(x: f64) -> T {
    T::splat(x)
}

#[inline(always)]
fn add<T: Vx>(a: T, b: T) -> T {
    a.add(b)
}

#[inline(always)]
fn sub<T: Vx>(a: T, b: T) -> T {
    a.sub(b)
}

#[inline(always)]
fn mul<T: Vx>(a: T, b: T) -> T {
    a.mul(b)
}

/// 2ab
#[inline]
fn dbl<T: Vx>(a: T, b: T) -> T {
    mul(spl(2.0), mul(a, b))
}

/// 1 - 2a^2
#[inline]
fn one_m2<T: Vx>(a: T) -> T {
    sub(spl(1.0), mul(spl(2.0), mul(a, a)))
}

/// a(3 - 4a^2)
#[inline]
fn triple_s<T: Vx>(a: T) -> T {
    mul(a, sub(spl(3.0), mul(spl(4.0), mul(a, a))))
}

/// a(4a^2 - 3)
#[inline]
fn triple_c<T: Vx>(a: T) -> T {
    mul(a, sub(mul(spl(4.0), mul(a, a)), spl(3.0)))
}

/// `vsincos` without the reduction, for |r| <= pi/4: in-box latitudes give |r| <= 0.6 (out-of-box lanes are discarded).
#[inline]
fn small_sincos<T: Vx>(r: T) -> (T, T) {
    let t = mul(r, r);
    (add(r, mul(t, mul(r, poly_eo(t, &S)))), add(spl(1.0), mul(t, poly_eo(t, &C))))
}

/// sin and cos of a from a / 3 and triple angles: |a| <= 3 pi / 4 covers the box's longitudes.
#[inline]
fn sincos3<T: Vx>(a: T) -> (T, T) {
    let (s, c) = small_sincos(mul(a, spl(1.0 / 3.0)));
    (triple_s(s), triple_c(c))
}

/// The offset and, with `J`, the Newton matrix I + J: (ox, oy, ja, jb, jc, jd), without the sqrt(|x|) term's
/// derivative within `cut` of 0; without `J` the last four are zero.
#[inline(never)]
#[allow(clippy::too_many_arguments)]
fn offset<T: Vx, const J: bool>(x: T, y: T, s1: T, c1: T, u1: T, v1: T, cut: f64) -> [T; 6] {
    let s2 = dbl(s1, c1);
    let c2 = one_m2(s1);
    let s4 = dbl(s2, c2);
    let c4 = one_m2(s2);
    let s5 = add(mul(s4, c1), mul(c4, s1));
    let c5 = sub(mul(c4, c1), mul(s4, s1));
    let s10 = dbl(s5, c5);
    let c10 = one_m2(s5);
    let s20 = dbl(s10, c10);
    let c20 = one_m2(s10);
    let s60 = triple_s(s20);
    let c60 = triple_c(c20);
    let s120 = dbl(s60, c60);
    let s360 = triple_s(s120);

    let u3 = triple_s(u1);
    let v3 = triple_c(v1);
    let u6 = dbl(u3, v3);
    let v6 = one_m2(u3);
    let u12 = dbl(u6, v6);
    let v12 = one_m2(u6);
    let u15 = add(mul(u12, v3), mul(v12, u3));
    let v15 = sub(mul(v12, v3), mul(u12, u3));
    let u30 = dbl(u15, v15);
    let v30 = one_m2(u15);
    let u60 = dbl(u30, v30);
    let u180 = triple_s(u60);

    let sp = add(mul(u1, spl(C35)), mul(v1, spl(S35)));
    let cp = sub(mul(v1, spl(C35)), mul(u1, spl(S35)));

    let r = x.abs().sqrt();
    let common = mul(spl(40.0 / 3.0), add(s360, s120));
    let xy = mul(mul(spl(0.1), x), y);
    // Summed left to right, as in the TS kernel.
    let mut dlat = add(spl(-100.0), mul(spl(2.0), x));
    dlat = add(dlat, mul(spl(3.0), y));
    dlat = add(dlat, mul(mul(spl(0.2), y), y));
    dlat = add(dlat, xy);
    dlat = add(dlat, mul(spl(0.2), r));
    dlat = add(dlat, common);
    dlat = add(dlat, mul(spl(40.0 / 3.0), u180));
    dlat = add(dlat, mul(spl(80.0 / 3.0), u60));
    dlat = add(dlat, mul(spl(320.0 / 3.0), u15));
    dlat = add(dlat, mul(spl(640.0 / 3.0), u6));
    let mut dlon = add(spl(300.0), x);
    dlon = add(dlon, mul(spl(2.0), y));
    dlon = add(dlon, mul(mul(spl(0.1), x), x));
    dlon = add(dlon, xy);
    dlon = add(dlon, mul(spl(0.1), r));
    dlon = add(dlon, common);
    dlon = add(dlon, mul(spl(40.0 / 3.0), s60));
    dlon = add(dlon, mul(spl(80.0 / 3.0), s20));
    dlon = add(dlon, mul(spl(100.0), s5));
    dlon = add(dlon, mul(spl(200.0), s2));
    let m = sub(spl(1.0), mul(mul(spl(EE), sp), sp));
    let sm = m.sqrt();
    let oy = mul(mul(mul(dlat, spl(KLAT)), m), sm);
    if !J {
        // 1 / cp from 1 / (cp m), as in the TS kernel: 10% faster here than dividing the product by cp. The Jacobian
        // divides separately: its divisions overlap, and sharing one is 3% slower.
        let flon = mul(mul(spl(KLON), sm), mul(m, spl::<T>(1.0).div(mul(cp, m))));
        return [mul(dlon, flon), oy, spl(0.0), spl(0.0), spl(0.0), spl(0.0)];
    }
    let ox = mul(mul(dlon, spl(KLON)), sm).div(cp);
    let c120 = one_m2(s60);
    let c360 = triple_c(c120);
    let v60 = one_m2(u30);
    let v180 = triple_c(v60);
    // 0.05 sign(x) / sqrt|x|, dropped within `cut` of 105 (singular there).
    let dr = T::select(T::select(spl(0.05), spl(-0.05), x.gt(spl(0.0))).div(r), spl(0.0), x.abs().gt(spl(cut)));
    let dcommon = add(mul(spl(JS360), c360), mul(spl(JS120), c120));
    // Summed left to right, as in the TS kernel.
    let mut dlon_x = add(spl(1.0), mul(spl(0.2), x));
    dlon_x = add(dlon_x, mul(spl(0.1), y));
    dlon_x = add(dlon_x, dr);
    dlon_x = add(dlon_x, dcommon);
    dlon_x = add(dlon_x, mul(spl(JS60), c60));
    dlon_x = add(dlon_x, mul(spl(JS20), c20));
    dlon_x = add(dlon_x, mul(spl(JS5), c5));
    dlon_x = add(dlon_x, mul(spl(JS2), c2));
    let mut dlat_x = add(spl(2.0), mul(spl(0.1), y));
    dlat_x = add(dlat_x, mul(spl(2.0), dr));
    dlat_x = add(dlat_x, dcommon);
    let mut dlat_y = add(spl(3.0), mul(spl(0.4), y));
    dlat_y = add(dlat_y, mul(spl(0.1), x));
    dlat_y = add(dlat_y, mul(spl(JU180), v180));
    dlat_y = add(dlat_y, mul(spl(JU60), v60));
    dlat_y = add(dlat_y, mul(spl(JU15), v15));
    dlat_y = add(dlat_y, mul(spl(JU6), v6));
    let flon = mul(spl(KLON), sm).div(cp);
    let flat = mul(mul(spl(KLAT), m), sm);
    let t = mul(sp.div(cp), spl(KY));
    let em = mul(mul(mul(spl(EE), sp), cp), spl(KY)).div(m);
    [
        ox,
        oy,
        add(spl(1.0), mul(dlon_x, flon)),
        add(mul(add(spl(2.0), mul(spl(0.1), x)), flon), mul(ox, sub(t, em))),
        mul(dlat_x, flat),
        sub(add(spl(1.0), mul(dlat_y, flat)), mul(mul(spl(3.0), oy), em)),
    ]
}

/// Loads a pair, reduces lanes outside [-180, 180] by the scalar fmod (rare), and returns the box mask.
#[inline]
fn prepare(lon: &[f64], lat: &[f64], i: usize) -> (v128, v128, v128) {
    let mut lon = load_pair(lon, i);
    let lat = load_pair(lat, i);
    if v128_any_true(v128_or(f64x2_gt(lon, spl(180.0)), f64x2_lt(lon, spl(-180.0)))) {
        let r = |l: f64| {
            if l > 180.0 || l < -180.0 { reduce_lon(l) } else { l }
        };
        lon = f64x2(r(f64x2_extract_lane::<0>(lon)), r(f64x2_extract_lane::<1>(lon)));
    }
    let inbox = v128_and(
        v128_and(f64x2_ge(lon, spl(LON_MIN)), f64x2_le(lon, spl(LON_MAX))),
        v128_and(f64x2_ge(lat, spl(LAT_MIN)), f64x2_le(lat, spl(LAT_MAX))),
    );
    (lon, lat, inbox)
}

/// The offset added to in-box lanes of (l, p).
#[inline(always)]
fn forward<T: Vx>(l: T, p: T, inbox: T) -> (T, T) {
    let x = sub(l, spl(105.0));
    let y = sub(p, spl(35.0));
    let (s, c) = sincos3(mul(x, spl(KX)));
    let (u, v) = small_sincos(mul(y, spl(KY)));
    let [ox, oy, ..] = offset::<T, false>(x, y, s, c, u, v, CUSP);
    (T::select(add(l, ox), l, inbox), T::select(add(p, oy), p, inbox))
}

pub fn forward_batch(lon: &[f64], lat: &[f64], olon: &mut [f64], olat: &mut [f64]) {
    batch(lon, lat, olon, olat, forward, forward);
}

/// Runs `f2` on two pairs at a time when both have a lane in the box, `f1` on a single such pair (a mixed group or the
/// last pair, if odd): `(lon, lat, in-box mask) -> (lon, lat)`.
#[inline(always)]
fn batch(
    lon: &[f64],
    lat: &[f64],
    olon: &mut [f64],
    olat: &mut [f64],
    f2: impl Fn([v128; 2], [v128; 2], [v128; 2]) -> ([v128; 2], [v128; 2]),
    f1: impl Fn(v128, v128, v128) -> (v128, v128),
) {
    let mut i = 0;
    while i + 4 <= lon.len() {
        let (l0, p0, b0) = prepare(lon, lat, i);
        let (l1, p1, b1) = prepare(lon, lat, i + 2);
        let (ol, op) = match (v128_any_true(b0), v128_any_true(b1)) {
            (true, true) => f2([l0, l1], [p0, p1], [b0, b1]),
            (true, false) => {
                let (a, b) = f1(l0, p0, b0);
                ([a, l1], [b, p1])
            }
            (false, true) => {
                let (a, b) = f1(l1, p1, b1);
                ([l0, a], [p0, b])
            }
            (false, false) => ([l0, l1], [p0, p1]),
        };
        store_pair(ol[0], olon, i);
        store_pair(op[0], olat, i);
        store_pair(ol[1], olon, i + 2);
        store_pair(op[1], olat, i + 2);
        i += 4;
    }
    while i < lon.len() {
        let (l, p, inbox) = prepare(lon, lat, i);
        let (ol, op) = if v128_any_true(inbox) { f1(l, p, inbox) } else { (l, p) };
        store_pair(ol, olon, i);
        store_pair(op, olat, i);
        i += 2;
    }
}

/// Newton state: iterate (wx, wy), the sin/cos pairs at the iterate before the last step, and that step.
#[derive(Clone, Copy)]
struct W<T> {
    wx: T,
    wy: T,
    s: T,
    c: T,
    u: T,
    v: T,
    dx: T,
    dy: T,
}

/// One Newton step on w + offset(w) = (lon, lat), dropping the sqrt(|x|) derivative within `cut` of 105; the sin/cos
/// pairs must be at (wx, wy).
#[inline]
fn step<T: Vx>(lon: T, lat: T, w: W<T>, cut: f64) -> W<T> {
    let [ox, oy, ja, jb, jc, jd] =
        offset::<T, true>(sub(w.wx, spl(105.0)), sub(w.wy, spl(35.0)), w.s, w.c, w.u, w.v, cut);
    let gx = sub(sub(lon, ox), w.wx);
    let gy = sub(sub(lat, oy), w.wy);
    let idet = spl::<T>(1.0).div(sub(mul(ja, jd), mul(jb, jc)));
    let dx = mul(sub(mul(jd, gx), mul(jb, gy)), idet);
    let dy = mul(sub(mul(ja, gy), mul(jc, gx)), idet);
    W {
        wx: add(w.wx, dx),
        wy: add(w.wy, dy),
        dx,
        dy,
        ..w
    }
}

/// Rotates the sin/cos pairs by the last step, to the iterate (series terms scaled by reciprocals, not divided: the
/// difference is far below an ulp of the result).
#[inline]
fn rotate<T: Vx>(w: W<T>) -> W<T> {
    let d = mul(w.dx, spl(KX));
    let e = mul(w.dy, spl(KY));
    let d2 = mul(d, d);
    let e2 = mul(e, e);
    let sd = mul(d, sub(spl(1.0), mul(d2, spl(1.0 / 6.0))));
    let cd = sub(spl(1.0), mul(d2, sub(spl(0.5), mul(d2, spl(1.0 / 24.0)))));
    let se = mul(e, sub(spl(1.0), mul(e2, spl(1.0 / 6.0))));
    let ce = sub(spl(1.0), mul(e2, sub(spl(0.5), mul(e2, spl(1.0 / 24.0)))));
    W {
        s: add(mul(w.s, cd), mul(w.c, sd)),
        c: sub(mul(w.c, cd), mul(w.s, sd)),
        u: add(mul(w.u, ce), mul(w.v, se)),
        v: sub(mul(w.v, ce), mul(w.u, se)),
        ..w
    }
}

/// Lanes within CUSP of 105, unless outside DERIV_CUT with the last step below CUSP_TOL.
#[inline]
fn unsettled<T: Vx>(w: &W<T>) -> T {
    let x = sub(w.wx, spl(105.0)).abs();
    let tol: T = spl(CUSP_TOL);
    let small = w.dx.abs().lt(tol).and(w.dy.abs().lt(tol));
    x.lt(spl(CUSP)).andnot(x.gt(spl(DERIV_CUT)).and(small))
}

/// The Newton solution for in-box lanes of (l, p).
#[inline(always)]
fn inverse<T: Vx>(l: T, p: T, inbox: T) -> (T, T) {
    let (s, c) = sincos3(mul(sub(l, spl(105.0)), spl(KX)));
    let (u, v) = small_sincos(mul(sub(p, spl(35.0)), spl(KY)));
    let zero = spl(0.0);
    let mut w = step(l, p, W { wx: l, wy: p, s, c, u, v, dx: zero, dy: zero }, CUSP);
    for _ in 1..STEPS {
        w = step(l, p, rotate(w), DERIV_CUT);
    }
    let mut active = inbox.and(unsettled(&w));
    for _ in STEPS..CUSP_STEPS {
        if !active.any() {
            break;
        }
        let n = step(l, p, rotate(w), DERIV_CUT);
        // Inactive lanes never reactivate, so only their result needs freezing.
        w = W {
            wx: T::select(n.wx, w.wx, active),
            wy: T::select(n.wy, w.wy, active),
            ..n
        };
        active = active.and(unsettled(&w));
    }
    (T::select(w.wx, l, inbox), T::select(w.wy, p, inbox))
}

pub fn inverse_batch(lon: &[f64], lat: &[f64], olon: &mut [f64], olat: &mut [f64]) {
    batch(lon, lat, olon, olat, inverse, inverse);
}
