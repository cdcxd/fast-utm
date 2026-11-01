//! f64x2 vector math (+simd128): sincos, atan, atan2, exp, log, log1p, and
//! pair load/store helpers shared by the batch loops.

use crate::math::*;
use core::arch::wasm32::{
    f32x4_demote_f64x2_zero, f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_eq, f64x2_ge,
    f64x2_gt, f64x2_le, f64x2_lt, f64x2_mul, f64x2_neg, f64x2_ne, f64x2_nearest, f64x2_pmax,
    f64x2_pmin, f64x2_splat, f64x2_sqrt, f64x2_sub, i32x4_trunc_sat_f32x4,
    i64x2_add, i64x2_extend_low_i32x4, i64x2_lt, i64x2_shl, i64x2_splat, i64x2_sub,
    u64x2_shr, v128, v128_and, v128_andnot, v128_any_true, v128_bitselect, v128_not, v128_or, v128_xor,
};

#[inline]
fn spl(x: f64) -> v128 {
    f64x2_splat(x)
}

/// Lane-wise f64x2 operations on one pair (`v128`) or two (`[v128; 2]`). A kernel written over `Vx` runs two
/// independent pairs interleaved, op by op, so their dependency chains overlap: V8 emits wasm in order, and a
/// latency-bound kernel's next pair is otherwise too far ahead for the out-of-order window.
pub trait Vx: Copy {
    fn splat(x: f64) -> Self;
    fn add(self, o: Self) -> Self;
    fn sub(self, o: Self) -> Self;
    fn mul(self, o: Self) -> Self;
    fn div(self, o: Self) -> Self;
    fn sqrt(self) -> Self;
    fn abs(self) -> Self;
    fn neg(self) -> Self;
    fn gt(self, o: Self) -> Self;
    fn lt(self, o: Self) -> Self;
    fn le(self, o: Self) -> Self;
    fn and(self, o: Self) -> Self;
    fn or(self, o: Self) -> Self;
    fn andnot(self, o: Self) -> Self;
    fn xor(self, o: Self) -> Self;
    fn not(self) -> Self;
    /// All-ones lanes where the sign bit is set (-0 included).
    fn sign(self) -> Self;
    /// `a` where `m` is set, else `b` (`v128_bitselect`).
    fn select(a: Self, b: Self, m: Self) -> Self;
    fn any(self) -> bool;
}

impl Vx for v128 {
    #[inline(always)]
    fn splat(x: f64) -> Self {
        f64x2_splat(x)
    }
    #[inline(always)]
    fn add(self, o: Self) -> Self {
        f64x2_add(self, o)
    }
    #[inline(always)]
    fn sub(self, o: Self) -> Self {
        f64x2_sub(self, o)
    }
    #[inline(always)]
    fn mul(self, o: Self) -> Self {
        f64x2_mul(self, o)
    }
    #[inline(always)]
    fn div(self, o: Self) -> Self {
        f64x2_div(self, o)
    }
    #[inline(always)]
    fn sqrt(self) -> Self {
        f64x2_sqrt(self)
    }
    #[inline(always)]
    fn abs(self) -> Self {
        f64x2_abs(self)
    }
    #[inline(always)]
    fn neg(self) -> Self {
        f64x2_neg(self)
    }
    #[inline(always)]
    fn gt(self, o: Self) -> Self {
        f64x2_gt(self, o)
    }
    #[inline(always)]
    fn lt(self, o: Self) -> Self {
        f64x2_lt(self, o)
    }
    #[inline(always)]
    fn le(self, o: Self) -> Self {
        f64x2_le(self, o)
    }
    #[inline(always)]
    fn and(self, o: Self) -> Self {
        v128_and(self, o)
    }
    #[inline(always)]
    fn or(self, o: Self) -> Self {
        v128_or(self, o)
    }
    #[inline(always)]
    fn andnot(self, o: Self) -> Self {
        v128_andnot(self, o)
    }
    #[inline(always)]
    fn xor(self, o: Self) -> Self {
        v128_xor(self, o)
    }
    #[inline(always)]
    fn not(self) -> Self {
        v128_not(self)
    }
    #[inline(always)]
    fn sign(self) -> Self {
        i64x2_lt(self, i64x2_splat(0))
    }
    #[inline(always)]
    fn select(a: Self, b: Self, m: Self) -> Self {
        v128_bitselect(a, b, m)
    }
    #[inline(always)]
    fn any(self) -> bool {
        v128_any_true(self)
    }
}

impl Vx for [v128; 2] {
    #[inline(always)]
    fn splat(x: f64) -> Self {
        [f64x2_splat(x); 2]
    }
    #[inline(always)]
    fn add(self, o: Self) -> Self {
        [self[0].add(o[0]), self[1].add(o[1])]
    }
    #[inline(always)]
    fn sub(self, o: Self) -> Self {
        [self[0].sub(o[0]), self[1].sub(o[1])]
    }
    #[inline(always)]
    fn mul(self, o: Self) -> Self {
        [self[0].mul(o[0]), self[1].mul(o[1])]
    }
    #[inline(always)]
    fn div(self, o: Self) -> Self {
        [self[0].div(o[0]), self[1].div(o[1])]
    }
    #[inline(always)]
    fn sqrt(self) -> Self {
        [self[0].sqrt(), self[1].sqrt()]
    }
    #[inline(always)]
    fn abs(self) -> Self {
        [self[0].abs(), self[1].abs()]
    }
    #[inline(always)]
    fn neg(self) -> Self {
        [self[0].neg(), self[1].neg()]
    }
    #[inline(always)]
    fn gt(self, o: Self) -> Self {
        [self[0].gt(o[0]), self[1].gt(o[1])]
    }
    #[inline(always)]
    fn lt(self, o: Self) -> Self {
        [self[0].lt(o[0]), self[1].lt(o[1])]
    }
    #[inline(always)]
    fn le(self, o: Self) -> Self {
        [self[0].le(o[0]), self[1].le(o[1])]
    }
    #[inline(always)]
    fn and(self, o: Self) -> Self {
        [self[0].and(o[0]), self[1].and(o[1])]
    }
    #[inline(always)]
    fn or(self, o: Self) -> Self {
        [self[0].or(o[0]), self[1].or(o[1])]
    }
    #[inline(always)]
    fn andnot(self, o: Self) -> Self {
        [self[0].andnot(o[0]), self[1].andnot(o[1])]
    }
    #[inline(always)]
    fn xor(self, o: Self) -> Self {
        [self[0].xor(o[0]), self[1].xor(o[1])]
    }
    #[inline(always)]
    fn not(self) -> Self {
        [self[0].not(), self[1].not()]
    }
    #[inline(always)]
    fn sign(self) -> Self {
        [self[0].sign(), self[1].sign()]
    }
    #[inline(always)]
    fn select(a: Self, b: Self, m: Self) -> Self {
        [v128_bitselect(a[0], b[0], m[0]), v128_bitselect(a[1], b[1], m[1])]
    }
    #[inline(always)]
    fn any(self) -> bool {
        v128_any_true(v128_or(self[0], self[1]))
    }
}

#[inline]
pub fn poly(t: v128, c: &[f64]) -> v128 {
    let mut r = spl(0.0);
    for k in c.iter().rev() {
        r = f64x2_add(f64x2_mul(r, t), spl(*k));
    }
    r
}

/// `poly` as two interleaved Horner chains in t^2 (even and odd coefficients): half the dependency depth, two more
/// live values; rounded differently, within an ulp.
#[inline(always)]
pub fn poly_eo<T: Vx>(t: T, c: &[f64]) -> T {
    let t2 = t.mul(t);
    let mut e = T::splat(0.0);
    let mut o = T::splat(0.0);
    let mut k = c.len().div_ceil(2);
    while k > 0 {
        k -= 1;
        e = e.mul(t2).add(T::splat(c[2 * k]));
        if 2 * k + 1 < c.len() {
            o = o.mul(t2).add(T::splat(c[2 * k + 1]));
        }
    }
    e.add(o.mul(t))
}

/// `poly`, or with `EO` `poly_eo`.
#[inline(always)]
fn poly_p<const EO: bool>(t: v128, c: &[f64]) -> v128 {
    if EO { poly_eo(t, c) } else { poly(t, c) }
}

/// Load a pair; odd tails splat the last point into both lanes.
#[inline]
pub fn load_pair(inp: &[f64], i: usize) -> v128 {
    if i + 1 < inp.len() {
        f64x2(inp[i], inp[i + 1])
    } else {
        f64x2_splat(inp[i])
    }
}

/// Store both lanes; an odd tail writes lane 0 only.
#[inline]
pub fn store_pair(v: v128, out: &mut [f64], i: usize) {
    use core::arch::wasm32::f64x2_extract_lane;
    out[i] = f64x2_extract_lane::<0>(v);
    if i + 1 < out.len() {
        out[i + 1] = f64x2_extract_lane::<1>(v);
    }
}

/// atan(x) — the single-argument vector atan (|x| any; NaN/±0/±Inf handled).
pub fn vatan(x: v128) -> v128 {
    let a = f64x2_abs(x);
    let gt1 = f64x2_gt(a, spl(1.0));
    let t = v128_bitselect(f64x2_div(spl(1.0), a), a, gt1);
    let big = f64x2_gt(t, spl(TAN_PI_8));
    // reduced argument in (0, tan(pi/8)) for t in (tan(pi/8), 1]
    let u_r = f64x2_div(
        f64x2_sub(t, spl(TAN_PI_8)),
        f64x2_add(spl(1.0), f64x2_mul(t, spl(TAN_PI_8))),
    );
    let u = v128_bitselect(u_r, t, big);
    let t2 = f64x2_mul(u, u);
    let pr = f64x2_add(u, f64x2_mul(t2, f64x2_mul(u, poly(t2, &AT))));
    // atan(t) = atan(u) + pi/8 when the transform fired
    let r = f64x2_add(pr, v128_bitselect(spl(PI_8), spl(0.0), big));
    // |x| > 1: atan(x) = pi/2 - atan(1/x); restore sign of x (incl. -0)
    let comp = v128_bitselect(f64x2_sub(spl(PI_2), r), r, gt1);
    v128_bitselect(f64x2_neg(comp), comp, i64x2_lt(x, i64x2_splat(0)))
}

/// atan(n / d) for d > 0 and finite n, with one division (the quotient and the pi/8 reduction share it) and
/// `poly_eo`.
#[inline]
pub fn vatan_q<T: Vx>(n: T, d: T) -> T {
    let a = n.abs();
    let gt1 = a.gt(d);
    let num = T::select(d, a, gt1);
    let den = T::select(a, d, gt1);
    let big = num.gt(den.mul(T::splat(TAN_PI_8)));
    let nn = T::select(num.sub(den.mul(T::splat(TAN_PI_8))), num, big);
    let dd = T::select(den.add(num.mul(T::splat(TAN_PI_8))), den, big);
    let u = nn.div(dd);
    let t2 = u.mul(u);
    let pr = u.add(t2.mul(u.mul(poly_eo(t2, &AT))));
    let r = pr.add(T::select(T::splat(PI_8), T::splat(0.0), big));
    let comp = T::select(T::splat(PI_2).sub(r), r, gt1);
    T::select(comp.neg(), comp, n.sign())
}

/// atan2(y, x) — magnitude path plus exact-zero and quadrant handling.
pub fn vatan2(y: v128, x: v128) -> v128 {
    let ay = f64x2_abs(y);
    let ax = f64x2_abs(x);
    let mx = f64x2_pmax(ax, ay);
    let mn = f64x2_pmin(ax, ay);
    let r0 = vatan(f64x2_div(mn, mx)); // in [0, pi/4]
    let r1 = v128_bitselect(f64x2_sub(spl(PI_2), r0), r0, f64x2_gt(ay, ax));
    let neg_x = i64x2_lt(x, i64x2_splat(0)); // true for -0 too
    let neg_y = i64x2_lt(y, i64x2_splat(0));
    let m = v128_bitselect(f64x2_sub(spl(M_PI), r1), r1, neg_x);
    let m = v128_bitselect(f64x2_neg(m), m, neg_y);
    // x = +-0: Math.atan2/glibc return +-pi/2 by sign of y for any nonzero y
    // (the x sign only matters when y is also zero). i64 compares catch -0.
    let v_pi = v128_bitselect(spl(-M_PI), spl(M_PI), neg_y);
    let v_zero = v128_bitselect(spl(-0.0), spl(0.0), neg_y);
    let both_zero = v128_bitselect(v_pi, v_zero, neg_x);
    let v_half = v128_bitselect(f64x2_neg(spl(PI_2)), spl(PI_2), neg_y);
    let x_zero = f64x2_eq(ax, spl(0.0));
    let v_xz = v128_bitselect(both_zero, v_half, f64x2_eq(ay, spl(0.0)));
    let m = v128_bitselect(v_xz, m, x_zero);
    // both infinite: +-pi/4 (x > 0) or +-3pi/4 (x < 0) — mn/mx is NaN there
    let both_inf = v128_and(
        f64x2_eq(ay, spl(f64::INFINITY)),
        f64x2_eq(ax, spl(f64::INFINITY)),
    );
    let v_inf = v128_bitselect(
        spl(PI_4),
        f64x2_sub(spl(M_PI), spl(PI_4)),
        f64x2_gt(x, spl(0.0)),
    );
    let v_inf = v128_bitselect(f64x2_neg(v_inf), v_inf, neg_y);
    let m = v128_bitselect(v_inf, m, both_inf);
    // NaN in either operand propagates: pmin/pmax can drop a NaN lane
    let nan_in = v128_or(f64x2_ne(y, y), f64x2_ne(x, x));
    v128_bitselect(spl(f64::NAN), m, nan_in)
}

pub fn vsincos(x: v128) -> (v128, v128) {
    vsincos_p::<false>(x)
}

/// `vsincos` with `poly_eo`.
#[inline(always)]
pub fn vsincos_eo(x: v128) -> (v128, v128) {
    vsincos_p::<true>(x)
}

#[inline(always)]
fn vsincos_p<const EO: bool>(x: v128) -> (v128, v128) {
    let k = f64x2_nearest(f64x2_mul(x, spl(TWO_OVER_PI)));
    let r = f64x2_sub(
        f64x2_sub(f64x2_sub(x, f64x2_mul(k, spl(PIO2_1))), f64x2_mul(k, spl(PIO2_1T))),
        f64x2_mul(k, spl(PIO2_2T)),
    );
    let t = f64x2_mul(r, r);
    let sp = f64x2_add(r, f64x2_mul(t, f64x2_mul(r, poly_p::<EO>(t, &S))));
    let cp = f64x2_add(spl(1.0), f64x2_mul(t, poly_p::<EO>(t, &C)));
    // quadrant masks must be f64-lane masks: i32 lane masks from
    // trunc_sat_f64x2_zero do not align with 64-bit lanes; the residue must
    // be unsigned — a signed -1 would take the q==1 pattern
    let quarter = f64x2_nearest(f64x2_mul(k, spl(0.25)));
    let q2s = f64x2_sub(k, f64x2_mul(spl(4.0), quarter)); // k mod 4, in (-2,2]
    let q2 = v128_bitselect(f64x2_add(q2s, spl(4.0)), q2s, f64x2_lt(q2s, spl(0.0)));
    let rem_odd = f64x2_sub(q2, f64x2_mul(spl(2.0), f64x2_nearest(f64x2_mul(q2, spl(0.5)))));
    let m_odd = f64x2_ne(rem_odd, spl(0.0));
    let m_two = f64x2_ge(q2, spl(1.5));
    // sin: q=0 sp, 1 cp, 2 -sp, 3 -cp; cos: q=0 cp, 1 -sp, 2 -cp, 3 sp
    let s1 = v128_bitselect(cp, sp, m_odd);
    let sin_v = v128_bitselect(f64x2_neg(s1), s1, m_two);
    let c1 = v128_bitselect(f64x2_neg(sp), cp, m_odd);
    let cos_v = v128_bitselect(f64x2_neg(c1), c1, m_two);
    // sin(±0) = ±0: the reduction loses the input's sign (x − k·π/2 rounds
    // −0 up to +0, so the selected value is +0 on zero lanes); selecting the
    // input itself restores it. cos(±0) = +1 is unaffected.
    let sin_v = v128_bitselect(x, sin_v, f64x2_eq(x, spl(0.0)));
    (sin_v, cos_v)
}

/// exp with the exponent k clamped to +-1000 (|x| <= ~693 covers the UTM
/// kernel and the diagnostics suite; beyond that, classification differs
/// from libm — documented in RESULTS.md).
pub fn vexp(x: v128) -> v128 {
    vexp_p::<false>(x)
}

/// `vexp` with `poly_eo`.
#[inline(always)]
pub fn vexp_eo(x: v128) -> v128 {
    vexp_p::<true>(x)
}

#[inline(always)]
fn vexp_p<const EO: bool>(x: v128) -> v128 {
    let k = f64x2_nearest(f64x2_mul(x, spl(LOG2E)));
    let r = f64x2_sub(f64x2_sub(x, f64x2_mul(k, spl(LN2_HI))), f64x2_mul(k, spl(LN2_LO)));
    let p = f64x2_add(f64x2_add(spl(1.0), r), f64x2_mul(f64x2_mul(r, r), poly_p::<EO>(r, &E)));
    let kc = f64x2_pmin(f64x2_pmax(k, spl(-1000.0)), spl(1000.0));
    // k is integral and |k| <= 1000, exact through f32 and i32
    let ki32 = i32x4_trunc_sat_f32x4(f32x4_demote_f64x2_zero(kc));
    let bits = i64x2_shl(i64x2_add(i64x2_extend_low_i32x4(ki32), i64x2_splat(1023)), 52);
    f64x2_mul(p, bits)
}

/// log for positive normals; mantissa normalized into [sqrt(0.5), sqrt(2)),
/// the L fit domain.
pub fn vlog(x: v128) -> v128 {
    vlog_p::<false>(x)
}

/// `vlog` with `poly_eo`.
#[inline(always)]
pub fn vlog_eo(x: v128) -> v128 {
    vlog_p::<true>(x)
}

#[inline(always)]
fn vlog_p<const EO: bool>(x: v128) -> v128 {
    let e_i = i64x2_sub(
        v128_and(u64x2_shr(x, 52), i64x2_splat(0x7ff)),
        i64x2_splat(1023),
    );
    let m1 = v128_or(
        v128_and(x, i64x2_splat(!((0x7ffu64 as i64) << 52))),
        i64x2_splat(1023 << 52),
    );
    let big = f64x2_ge(m1, spl(SQRT2));
    let mant = v128_bitselect(f64x2_mul(m1, spl(0.5)), m1, big);
    let e2 = i64x2_add(e_i, v128_bitselect(i64x2_splat(1), i64x2_splat(0), big));
    let s = f64x2_div(f64x2_sub(mant, spl(1.0)), f64x2_add(mant, spl(1.0)));
    let t = f64x2_mul(s, s);
    let ef = f64x2(
        i64x2_extract_lane0(e2) as f64,
        i64x2_extract_lane1(e2) as f64,
    );
    let r = f64x2_add(
        f64x2_add(
            f64x2_add(
                f64x2_mul(spl(2.0), s),
                f64x2_mul(f64x2_mul(spl(2.0), t), f64x2_mul(s, poly_p::<EO>(t, &L))),
            ),
            f64x2_mul(ef, spl(LN2_HI)),
        ),
        f64x2_mul(ef, spl(LN2_LO)),
    );
    // domain completion: +Inf -> +Inf, +0/-0 -> -Inf, x < 0 or NaN -> NaN.
    // Positive subnormals are out of domain and return garbage (the poly runs
    // with exponent -1023); the kernel only feeds positive normals.
    let r = v128_bitselect(spl(f64::INFINITY), r, f64x2_eq(x, spl(f64::INFINITY)));
    let r = v128_bitselect(spl(f64::NEG_INFINITY), r, f64x2_eq(x, spl(0.0)));
    let nan_or_neg = v128_or(f64x2_lt(x, spl(0.0)), f64x2_ne(x, x));
    v128_bitselect(spl(f64::NAN), r, nan_or_neg)
}

#[inline]
fn i64x2_extract_lane0(v: v128) -> i64 {
    use core::arch::wasm32::i64x2_extract_lane;
    i64x2_extract_lane::<0>(v)
}

#[inline]
fn i64x2_extract_lane1(v: v128) -> i64 {
    use core::arch::wasm32::i64x2_extract_lane;
    i64x2_extract_lane::<1>(v)
}

/// log1p(t) for t in [-0.75, 2048]; ~1 ulp.
pub fn vlog1p(t: v128) -> v128 {
    vlog1p_p::<false>(t)
}

/// `vlog1p` with `poly_eo`.
#[inline(always)]
pub fn vlog1p_eo(t: v128) -> v128 {
    vlog1p_p::<true>(t)
}

#[inline(always)]
fn vlog1p_p<const EO: bool>(t: v128) -> v128 {
    let at = f64x2_abs(t);
    let small = f64x2_lt(at, spl(f64::from_bits(0x3CA0000000000000))); // 2^-53
    let mid = f64x2_le(at, spl(0.25));
    // Skip unused formulas only when both lanes choose the same path.
    // Mixed pairs and NaNs retain the original blend below.
    let a0 = core::arch::wasm32::f64x2_extract_lane::<0>(at);
    let a1 = core::arch::wasm32::f64x2_extract_lane::<1>(at);
    if a0 > 0.25 && a1 > 0.25 {
        return vlog_p::<EO>(f64x2_add(spl(1.0), t));
    }
    // s = t/(2+t) in [-1/7, 1/9], inside the L fit domain
    let s = f64x2_div(t, f64x2_add(spl(2.0), t));
    let s2 = f64x2_mul(s, s);
    let lm = f64x2_add(
        f64x2_mul(spl(2.0), s),
        f64x2_mul(f64x2_mul(spl(2.0), s2), f64x2_mul(s, poly_p::<EO>(s2, &L))),
    );
    if a0 <= 0.25 && a1 <= 0.25 {
        return v128_bitselect(t, lm, small);
    }
    let lg = vlog_p::<EO>(f64x2_add(spl(1.0), t));
    let base = v128_bitselect(lm, lg, mid);
    v128_bitselect(t, base, small)
}

/// `vsincos_eo` for pairs with both |x| <= 3 pi / 4: one fold about pi/2 (exact: Sterbenz) instead of the general
/// reduction; other pairs, infinities and NaNs take `vsincos_eo`.
#[inline(always)]
pub fn vsincos_h(x: v128) -> (v128, v128) {
    let a = f64x2_abs(x);
    if v128_any_true(v128_not(f64x2_le(a, spl(3.0 * PI_4)))) {
        return vsincos_eo(x);
    }
    sincos_fold(x)
}

/// `vsincos_h` for lanes known to be within |x| <= 3 pi / 4.
#[inline(always)]
pub fn sincos_fold<T: Vx>(x: T) -> (T, T) {
    let a = x.abs();
    let big = a.gt(T::splat(PI_4));
    let r = T::select(T::splat(PIO2_1).sub(a).add(T::splat(PIO2_1T)), a, big);
    let t = r.mul(r);
    let sp = r.add(t.mul(r.mul(poly_eo(t, &S))));
    let cp = T::splat(1.0).add(t.mul(poly_eo(t, &C)));
    let sa = T::select(cp, sp, big);
    let ca = T::select(sp, cp, big);
    // sin is odd (and keeps -0); cos is even
    (sa.xor(x.and(T::splat(-0.0))), ca)
}
