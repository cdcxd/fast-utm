//! f64x2 Web Mercator (EPSG:3857) kernel — the vector twin of src/webmerc.ts.
//!
//! - forward: y = R asinh(tan phi) as 2 R atanh(tan(phi / 2)), from one sincos of the half latitude, or of the half
//!   colatitude poleward of 45 degrees (exact there; the TS kernel does the same);
//! - inverse: phi = atan(sinh(y / R)) as 2 atan(tanh(y / 2R)) below 45 degrees and pi/2 - 2 atan(exp(-|y| / R))
//!   above, from one exp and an atan without reduction (the TS kernel does the same).

use crate::kernel::{reduce_lon, D2R, R2D};
use crate::math::{AT, E, L, LN2_HI, LN2_LO, LOG2E, PI_2};
use core::arch::wasm32::{
    f32x4_demote_f64x2_zero, f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_lt,
    f64x2_mul, f64x2_nearest, f64x2_neg, f64x2_pmin, f64x2_splat, f64x2_sub, i32x4_trunc_sat_f32x4, i64x2_add,
    i64x2_extend_low_i32x4, i64x2_shl, i64x2_splat, i64x2_sub, v128, v128_and, v128_any_true, v128_bitselect,
    v128_or,
};

use crate::simd::{load_pair, poly_eo, store_pair, vlog_eo, vsincos_eo};

/// asinh(1), where the inverse switches form, and the rounding error of PI_2.
const ASINH1: f64 = 0.881373587019543;
const PI_2_LO: f64 = 6.123233995736766e-17;

/// The WGS84 semi-major axis, the sphere's radius.
pub const R: f64 = 6378137.0;
/// Metres per degree of longitude, rounded as in the TS kernel so that pi R divides to exactly 180.
const K: f64 = R * core::f64::consts::PI / 180.0;

#[inline]
fn spl(x: f64) -> v128 {
    f64x2_splat(x)
}

#[inline]
fn finite(x: v128) -> v128 {
    f64x2_lt(f64x2_abs(x), spl(f64::INFINITY))
}

/// `m` with the sign bit of `s`.
#[inline]
fn copysign(m: v128, s: v128) -> v128 {
    v128_bitselect(s, m, i64x2_splat(i64::MIN))
}

/// Rare: whole turns are removed per lane by the scalar reduction, so both kernels agree.
#[inline]
fn reduce(lon: v128) -> v128 {
    let out = v128_or(f64x2_gt(lon, spl(180.0)), f64x2_lt(lon, spl(-180.0)));
    if !v128_any_true(out) {
        return lon;
    }
    let r = |l: f64| if l > 180.0 || l < -180.0 { reduce_lon(l) } else { l };
    f64x2(r(f64x2_extract_lane::<0>(lon)), r(f64x2_extract_lane::<1>(lon)))
}

pub fn forward2(lon: v128, lat: v128) -> (v128, v128) {
    let alat = f64x2_abs(lat);
    // The poles have no finite y; NaN latitudes fail the comparison too.
    let ok = v128_and(f64x2_lt(alat, spl(90.0)), finite(lon));
    let x = f64x2_mul(reduce(lon), spl(K));

    // asinh(tan phi) = 2 atanh(t), t = tan(phi / 2): the log series in t while t is inside its fit domain (|t| <=
    // 0.1716, phi <= 19.47 degrees), else log1p(u) with u = 2t / (1 - t) = tan phi + sec phi - 1 > 0.4.
    let series = f64x2_lt(alat, spl(19.4));
    let polar = f64x2_gt(alat, spl(45.0));
    let ang = v128_bitselect(f64x2_sub(spl(90.0), alat), alat, polar);
    let (s, c) = vsincos_eo(f64x2_mul(ang, spl(D2R / 2.0)));
    let (s0, s1) = (f64x2_extract_lane::<0>(series), f64x2_extract_lane::<1>(series));
    let mut r = spl(0.0);
    if s0 != 0.0 || s1 != 0.0 {
        let t = f64x2_div(s, c);
        let t2 = f64x2_mul(t, t);
        r = f64x2_add(f64x2_add(t, t), f64x2_mul(f64x2_mul(spl(2.0), t2), f64x2_mul(t, poly_eo(t2, &L))));
    }
    if s0 == 0.0 || s1 == 0.0 {
        // u = 2s / (c - s) from the half latitude, (c - s) / s from the half colatitude (exact poleward of 45
        // degrees); log(1 + u) with the rounding of 1 + u compensated.
        let cs = f64x2_sub(c, s);
        let u = f64x2_div(v128_bitselect(cs, f64x2_add(s, s), polar), v128_bitselect(s, cs, polar));
        let q = f64x2_add(spl(1.0), u);
        let big = f64x2_add(vlog_eo(q), f64x2_div(f64x2_sub(u, f64x2_sub(q, spl(1.0))), q));
        r = v128_bitselect(r, big, series);
    }
    let y = f64x2_mul(copysign(r, lat), spl(R));

    let nan = spl(f64::NAN);
    (v128_bitselect(x, nan, ok), v128_bitselect(y, nan, ok))
}

pub fn inverse2(x: v128, y: v128) -> (v128, v128) {
    let ok = v128_and(finite(x), finite(y));
    let lon = reduce(f64x2_div(x, spl(K)));

    // As in the TS kernel: phi = gd(v), v = |y / R| = k ln 2 + r, as 2 atan(m / (m + 2)) with m = expm1(v) = 2^k (1 +
    // expm1(r)) - 1 below v = asinh(1) (phi = pi/4), else pi/2 - 2 atan(exp(-v)), exp(-v) = 2^-k (1 + expm1(-r)); both
    // atan arguments are within tan(pi/8). Clamped at v = 40, where phi rounds to pi/2.
    let v = f64x2_pmin(f64x2_abs(f64x2_mul(y, spl(1.0 / R))), spl(40.0));
    let k = f64x2_nearest(f64x2_mul(v, spl(LOG2E)));
    let r = f64x2_sub(f64x2_sub(v, f64x2_mul(k, spl(LN2_HI))), f64x2_mul(k, spl(LN2_LO)));
    let near = f64x2_lt(v, spl(ASINH1));
    let rr = v128_bitselect(r, f64x2_neg(r), near);
    let q = f64x2_add(rr, f64x2_mul(f64x2_mul(rr, rr), poly_eo(rr, &E)));
    // k is integral in [0, 58], exact through f32 and i32.
    let ki = i64x2_extend_low_i32x4(i32x4_trunc_sat_f32x4(f32x4_demote_f64x2_zero(k)));
    let s = i64x2_shl(i64x2_add(ki, i64x2_splat(1023)), 52);
    let is = i64x2_shl(i64x2_sub(i64x2_splat(1023), ki), 52);
    let sq = f64x2_mul(s, q);
    let num = v128_bitselect(f64x2_add(sq, f64x2_sub(s, spl(1.0))), f64x2_mul(f64x2_add(spl(1.0), q), is), near);
    let den = v128_bitselect(f64x2_add(sq, f64x2_add(s, spl(1.0))), spl(1.0), near);
    let u = f64x2_div(num, den);
    let t = f64x2_mul(u, u);
    let w = f64x2_mul(spl(2.0), f64x2_add(u, f64x2_mul(t, f64x2_mul(u, poly_eo(t, &AT)))));
    let g = v128_bitselect(w, f64x2_sub(spl(PI_2), f64x2_sub(w, spl(PI_2_LO))), near);
    let lat = f64x2_mul(copysign(g, y), spl(R2D));

    let nan = spl(f64::NAN);
    (v128_bitselect(lon, nan, ok), v128_bitselect(lat, nan, ok))
}

pub fn forward_batch(lon: &[f64], lat: &[f64], x: &mut [f64], y: &mut [f64]) {
    let mut i = 0;
    while i < lon.len() {
        let (a, b) = forward2(load_pair(lon, i), load_pair(lat, i));
        store_pair(a, x, i);
        store_pair(b, y, i);
        i += 2;
    }
}

pub fn inverse_batch(x: &[f64], y: &[f64], lon: &mut [f64], lat: &mut [f64]) {
    let mut i = 0;
    while i < x.len() {
        let (a, b) = inverse2(load_pair(x, i), load_pair(y, i));
        store_pair(a, lon, i);
        store_pair(b, lat, i);
        i += 2;
    }
}
