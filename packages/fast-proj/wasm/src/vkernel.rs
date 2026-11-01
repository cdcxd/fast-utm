//! f64x2 UTM kernel — the vector twin of `skernel` (see `kernel.rs` for the
//! math, the Karney reference, and the notation glossary; the phase banners
//! there match this file statement-for-statement).
//!
//! Deviations from the scalar twin, all accuracy-gated in bench/:
//! - transcendental calls go to the hand-written f64x2 primitives in
//!   `simd.rs` (≤ 2 ulp on the kernel ranges, `bench/sweeps.mts`);
//! - the guarded atan/log1p sites branch per pair: in-domain lanes take the
//!   fast path, any out-of-domain lane falls back to the atan2/asinh blend;
//! - `vexp` clamps its exponent term at ±1000 (RESULTS.md documents the
//!   boundary where classification diverges from libm);
//! - the forward batch takes two pairs at a time through `forward_dual` (`Vx`)
//!   while every lane is on the common path, 10% faster in V8; past about 9
//!   degrees from the central meridian each pair finishes from the shared
//!   intermediates (`forward_tail`), as fast as `forward2` alone.

use crate::kernel::{reduce_lon, K, D2R, R2D};
use core::arch::wasm32::{
    f64x2, f64x2_abs, f64x2_add, f64x2_div, f64x2_extract_lane, f64x2_gt, f64x2_lt, f64x2_mul,
    f64x2_neg, f64x2_splat, f64x2_sqrt, f64x2_sub, i64x2_splat, v128, v128_and, v128_any_true, v128_bitselect,
    v128_or, v128_xor,
};

use crate::simd::{load_pair, poly_eo, sincos_fold, store_pair, vatan2, vatan_q, vexp_eo, vlog1p_eo, vsincos_h, Vx};
use crate::math::PI_4;

const ASINH: [f64; 10] = [
    -1.0 / 6.0,
    3.0 / 40.0,
    -5.0 / 112.0,
    35.0 / 1152.0,
    -63.0 / 2816.0,
    231.0 / 13312.0,
    -143.0 / 10240.0,
    6435.0 / 557056.0,
    -12155.0 / 1245184.0,
    46189.0 / 5505024.0,
];
const SINH: [f64; 6] = [1.0 / 6.0, 1.0 / 120.0, 1.0 / 5040.0, 1.0 / 362880.0, 1.0 / 39916800.0, 1.0 / 6227020800.0];
const COSH: [f64; 7] = [0.5, 1.0 / 24.0, 1.0 / 720.0, 1.0 / 40320.0, 1.0 / 3628800.0, 1.0 / 479001600.0, 1.0 / 87178291200.0];

#[inline]
fn spl(x: f64) -> v128 {
    f64x2_splat(x)
}

/// Kernel parameters splatted across both lanes.
pub struct KS {
    d2r: v128,
    lon0: v128,
    feast: v128,
    k_a: v128,
    inv_k_a: v128,
    fnorth: v128,
    ap: [v128; 4],
    bp: [v128; 4],
    cp: [v128; 6],
    dp: [v128; 6],
    a5: v128,
    a6: v128,
    b5: v128,
    b6: v128,
}

pub fn splat_k(k: &K) -> KS {
    let s = spl;
    let s4 = |a: &[f64; 4]| [s(a[0]), s(a[1]), s(a[2]), s(a[3])];
    let s6 = |a: &[f64; 6]| [s(a[0]), s(a[1]), s(a[2]), s(a[3]), s(a[4]), s(a[5])];
    KS {
        d2r: s(D2R),
        lon0: s(k.lon0),
        feast: s(k.feast),
        k_a: s(k.k_a),
        inv_k_a: s(k.inv_k_a),
        fnorth: s(k.fnorth),
        ap: s4(&k.ap),
        bp: s4(&k.bp),
        cp: s6(&k.cp),
        dp: s6(&k.dp),
        a5: s(k.a56[0]),
        a6: s(k.a56[1]),
        b5: s(k.b56[0]),
        b6: s(k.b56[1]),
    }
}

/// c[0] + c[1] p + ... + c[5] p^5, as two interleaved Horner chains in p^2.
#[inline]
fn poly6_eo(p: v128, c: &[v128; 6]) -> v128 {
    let p2 = f64x2_mul(p, p);
    let e = f64x2_add(c[0], f64x2_mul(p2, f64x2_add(c[2], f64x2_mul(p2, c[4]))));
    let o = f64x2_add(c[1], f64x2_mul(p2, f64x2_add(c[3], f64x2_mul(p2, c[5]))));
    f64x2_add(e, f64x2_mul(p, o))
}

/// Per-32-bit-lane-all-ones mask when the f64 lane is finite.
#[inline]
fn is_finite(x: v128) -> v128 {
    f64x2_lt(f64x2_abs(x), spl(f64::INFINITY))
}

pub fn forward2(mut lon: v128, lat: v128, q: &KS) -> (v128, v128) {
    let phi = f64x2_mul(lat, q.d2r);
    // Rare: whole turns are removed per lane by the scalar reduction, so both kernels agree.
    let out = v128_or(f64x2_gt(lon, spl(180.0)), f64x2_lt(lon, spl(-180.0)));
    if v128_any_true(out) {
        let (l0, l1) = (f64x2_extract_lane::<0>(lon), f64x2_extract_lane::<1>(lon));
        let r = |l: f64| if l > 180.0 || l < -180.0 { reduce_lon(l) } else { l };
        lon = f64x2(r(l0), r(l1));
    }
    let lam = f64x2_sub(f64x2_mul(lon, q.d2r), q.lon0);

    let (sp, cp) = vsincos_h(phi);
    let p = f64x2_sub(spl(2.0), f64x2_mul(spl(4.0), f64x2_mul(sp, sp)));
    let q1 = poly6_eo(p, &q.cp);
    let dchi = f64x2_mul(f64x2_mul(f64x2_add(sp, sp), cp), q1);
    let dd = f64x2_mul(dchi, dchi);
    let sd = f64x2_mul(
        dchi,
        f64x2_add(
            spl(1.0),
            f64x2_mul(dd, f64x2_add(spl(-1.0 / 6.0), f64x2_mul(dd, spl(1.0 / 120.0)))),
        ),
    );
    let cd = f64x2_add(
        spl(1.0),
        f64x2_mul(dd, f64x2_add(spl(-0.5), f64x2_mul(dd, spl(1.0 / 24.0)))),
    );
    let sc = f64x2_add(f64x2_mul(sp, cd), f64x2_mul(cp, sd));
    let cc = f64x2_sub(f64x2_mul(cp, cd), f64x2_mul(sp, sd));

    let (sl, cl) = vsincos_h(lam);
    // !(cl > 1e-15) -> NaN pair (mirrors the early return in the TS kernel)
    let bad = v128_xor(f64x2_gt(cl, spl(1e-15)), i64x2_splat(-1));

    let ccl = f64x2_mul(cc, cl);
    let sc2 = f64x2_mul(sc, sc);
    let ccl2 = f64x2_mul(ccl, ccl);
    let ir = f64x2_div(spl(1.0), f64x2_sqrt(f64x2_add(sc2, ccl2)));
    let she = f64x2_mul(f64x2_mul(cc, sl), ir);
    forward_tail(Pre { sc, ccl, sc2, ccl2, ir, she, bad }, q)
}

/// The forward's intermediates through she = sinh(eta'), for the rest of `forward2`.
#[derive(Clone, Copy)]
struct Pre {
    sc: v128,
    ccl: v128,
    sc2: v128,
    ccl2: v128,
    ir: v128,
    she: v128,
    bad: v128,
}

/// `forward2` from xi' and eta' on.
#[inline]
fn forward_tail(p: Pre, q: &KS) -> (v128, v128) {
    let Pre { sc, ccl, sc2, ccl2, ir, she, bad } = p;
    let ccl0 = f64x2_extract_lane::<0>(ccl);
    let ccl1 = f64x2_extract_lane::<1>(ccl);
    let xip = if ccl0 > 0.0 && ccl1 > 0.0 {
        // every lane in-domain: atan alone matches atan2 for x > 0
        vatan_q(sc, ccl)
    } else {
        v128_bitselect(
            vatan_q(sc, ccl),
            vatan2(sc, ccl),
            f64x2_gt(ccl, spl(0.0)),
        )
    };
    // log1p eta' with the |she| <= 1024 guard; the test is hoisted out of the
    // lanes (select-based fallbacks would pay the asinh chain every iteration)
    let sh0 = f64x2_extract_lane::<0>(she);
    let sh1 = f64x2_extract_lane::<1>(she);
    let etap = if sh0.abs() < 0.16 && sh1.abs() < 0.16 {
        // asinh by its odd series within |she| < 0.16 (about 9 degrees from the central meridian; the next term is
        // below 3e-20 relative)
        let z = f64x2_mul(she, she);
        f64x2_add(she, f64x2_mul(f64x2_mul(she, z), poly_eo(z, &ASINH)))
    } else if sh0 > -1024.0 && sh0 < 1024.0 && sh1 > -1024.0 && sh1 < 1024.0 {
        vlog1p_eo(f64x2_add(
            she,
            f64x2_div(f64x2_mul(she, she), f64x2_add(ir, spl(1.0))),
        ))
    } else {
        f64x2(libm::asinh(sh0), libm::asinh(sh1))
    };

    let ir2 = f64x2_mul(ir, ir);
    let s2 = f64x2_mul(f64x2_mul(f64x2_mul(spl(2.0), sc), ccl), ir2);
    let c2x = f64x2_mul(f64x2_sub(ccl2, sc2), ir2);
    let ch = f64x2_add(ir2, f64x2_mul(she, she));
    let sh = f64x2_mul(f64x2_mul(spl(2.0), she), ir);
    let ar = f64x2_mul(f64x2_mul(spl(2.0), c2x), ch);
    let ai = f64x2_neg(f64x2_mul(f64x2_mul(spl(2.0), s2), sh));
    let rho = f64x2_add(f64x2_mul(ar, ar), f64x2_mul(ai, ai));
    let ta = f64x2_add(ar, ar);
    let u4 = f64x2_add(q.a5, f64x2_mul(ta, q.a6));
    let u3 = f64x2_sub(f64x2_add(q.ap[3], f64x2_mul(ta, u4)), f64x2_mul(rho, q.a6));
    let u2 = f64x2_sub(f64x2_add(q.ap[2], f64x2_mul(ta, u3)), f64x2_mul(rho, u4));
    let u1 = f64x2_sub(f64x2_add(q.ap[1], f64x2_mul(ta, u2)), f64x2_mul(rho, u3));
    let tr = f64x2_sub(f64x2_add(q.ap[0], f64x2_mul(ar, u1)), f64x2_mul(rho, u2));
    let ti = f64x2_mul(ai, u1);
    let sr = f64x2_mul(s2, ch);
    let si = f64x2_mul(c2x, sh);

    let x = f64x2_add(
        q.feast,
        f64x2_mul(
            q.k_a,
            f64x2_add(etap, f64x2_add(f64x2_mul(tr, si), f64x2_mul(ti, sr))),
        ),
    );
    let y = f64x2_add(
        q.fnorth,
        f64x2_mul(
            q.k_a,
            f64x2_sub(f64x2_add(xip, f64x2_mul(tr, sr)), f64x2_mul(ti, si)),
        ),
    );
    (
        v128_bitselect(spl(f64::NAN), x, bad),
        v128_bitselect(spl(f64::NAN), y, bad),
    )
}

/// The inverse's result and the intermediates a fused GCJ-02 offset reuses: sx/h and she/cx are proportional to
/// the sin/cos of the conformal latitude chi and of the longitude from the central meridian; r2 = sx^2 + h^2, and
/// dchi = phi - chi.
pub struct Inv {
    pub lon: v128,
    pub lat: v128,
    pub sx: v128,
    pub cx: v128,
    pub she: v128,
    pub h: v128,
    pub r2: v128,
    pub dchi: v128,
}

pub fn inverse2(x: v128, y: v128, q: &KS) -> (v128, v128) {
    let r = inverse_parts(x, y, q);
    (r.lon, r.lat)
}

/// The latency-bound chain (sincos/exp, then atan of the conformal latitude) takes the shallow polynomial forms:
/// `vsincos_eo`, `vexp_eo`, `vatan_q` and `poly6_eo`.
#[inline(always)]
pub fn inverse_parts(x: v128, y: v128, q: &KS) -> Inv {
    let xi = f64x2_mul(f64x2_sub(y, q.fnorth), q.inv_k_a);
    let eta = f64x2_mul(f64x2_sub(x, q.feast), q.inv_k_a);

    let (s1, c1x) = vsincos_h(xi);
    // sinh, cosh of eta from their series within |eta| < 0.35 (as the JavaScript kernel), else from exp
    let e0 = f64x2_extract_lane::<0>(eta).abs();
    let e1 = f64x2_extract_lane::<1>(eta).abs();
    let (sh1, ch1) = if e0 < 0.35 && e1 < 0.35 {
        let w = f64x2_mul(eta, eta);
        (
            f64x2_add(eta, f64x2_mul(f64x2_mul(eta, w), poly_eo(w, &SINH))),
            f64x2_add(spl(1.0), f64x2_mul(w, poly_eo(w, &COSH))),
        )
    } else {
        let e = vexp_eo(eta);
        let ie = f64x2_div(spl(1.0), e);
        (f64x2_mul(spl(0.5), f64x2_sub(e, ie)), f64x2_mul(spl(0.5), f64x2_add(e, ie)))
    };
    let s2 = f64x2_mul(f64x2_mul(spl(2.0), s1), c1x);
    let c2x = f64x2_sub(f64x2_mul(c1x, c1x), f64x2_mul(s1, s1));
    let ch = f64x2_add(f64x2_mul(ch1, ch1), f64x2_mul(sh1, sh1));
    let sh = f64x2_mul(f64x2_mul(spl(2.0), sh1), ch1);
    let ar = f64x2_mul(f64x2_mul(spl(2.0), c2x), ch);
    let ai = f64x2_neg(f64x2_mul(f64x2_mul(spl(2.0), s2), sh));
    let rho = f64x2_add(f64x2_mul(ar, ar), f64x2_mul(ai, ai));
    let ta = f64x2_add(ar, ar);
    let u4 = f64x2_add(q.b5, f64x2_mul(ta, q.b6));
    let u3 = f64x2_sub(f64x2_add(q.bp[3], f64x2_mul(ta, u4)), f64x2_mul(rho, q.b6));
    let u2 = f64x2_sub(f64x2_add(q.bp[2], f64x2_mul(ta, u3)), f64x2_mul(rho, u4));
    let u1 = f64x2_sub(f64x2_add(q.bp[1], f64x2_mul(ta, u2)), f64x2_mul(rho, u3));
    let tr = f64x2_sub(f64x2_add(q.bp[0], f64x2_mul(ar, u1)), f64x2_mul(rho, u2));
    let ti = f64x2_add(f64x2_mul(ai, u1), spl(0.0)); // retains the Clenshaw +0 sign
    let sr = f64x2_mul(s2, ch);
    let si = f64x2_mul(c2x, sh);
    let dxi = f64x2_sub(f64x2_mul(tr, sr), f64x2_mul(ti, si));
    let deta = f64x2_add(f64x2_mul(tr, si), f64x2_mul(ti, sr));

    let dx2 = f64x2_mul(dxi, dxi);
    let sdx = f64x2_mul(
        dxi,
        f64x2_add(
            spl(1.0),
            f64x2_mul(dx2, f64x2_add(spl(-1.0 / 6.0), f64x2_mul(dx2, spl(1.0 / 120.0)))),
        ),
    );
    let cdx = f64x2_add(
        spl(1.0),
        f64x2_mul(dx2, f64x2_add(spl(-0.5), f64x2_mul(dx2, spl(1.0 / 24.0)))),
    );
    let de2 = f64x2_mul(deta, deta);
    let shd = f64x2_mul(
        deta,
        f64x2_add(
            spl(1.0),
            f64x2_mul(de2, f64x2_add(spl(1.0 / 6.0), f64x2_mul(de2, spl(1.0 / 120.0)))),
        ),
    );
    let chd = f64x2_add(
        spl(1.0),
        f64x2_mul(de2, f64x2_add(spl(0.5), f64x2_mul(de2, spl(1.0 / 24.0)))),
    );
    let sx = f64x2_sub(f64x2_mul(s1, cdx), f64x2_mul(c1x, sdx));
    let cx = f64x2_add(f64x2_mul(c1x, cdx), f64x2_mul(s1, sdx));
    let she = f64x2_sub(f64x2_mul(sh1, chd), f64x2_mul(ch1, shd));

    let h2 = f64x2_add(f64x2_mul(she, she), f64x2_mul(cx, cx));
    let h = f64x2_sqrt(h2);
    // guarded atan sites hoisted per pair: in-domain lanes (cx > 0, she finite)
    // pay only atan; any out-of-domain lane falls back to the atan2 blend, which
    // keeps vatan_q for in-domain lanes so a lane's result never depends on its
    // neighbour
    let cx0 = f64x2_extract_lane::<0>(cx);
    let cx1 = f64x2_extract_lane::<1>(cx);
    let she0 = f64x2_extract_lane::<0>(she);
    let she1 = f64x2_extract_lane::<1>(she);
    let lam = if cx0 > 0.0 && cx1 > 0.0 && she0.is_finite() && she1.is_finite() {
        vatan_q(she, cx)
    } else {
        v128_bitselect(
            vatan_q(she, cx),
            vatan2(she, cx),
            v128_and(f64x2_gt(cx, spl(0.0)), is_finite(she)),
        )
    };
    let h0 = f64x2_extract_lane::<0>(h);
    let h1 = f64x2_extract_lane::<1>(h);
    let sx0 = f64x2_extract_lane::<0>(sx);
    let sx1 = f64x2_extract_lane::<1>(sx);
    let chi = if h0 > 0.0 && h1 > 0.0 && sx0.is_finite() && sx1.is_finite() {
        vatan_q(sx, h)
    } else {
        v128_bitselect(
            vatan_q(sx, h),
            vatan2(sx, h),
            v128_and(f64x2_gt(h, spl(0.0)), is_finite(sx)),
        )
    };

    let sx2 = f64x2_mul(sx, sx);
    let r2 = f64x2_add(sx2, h2);
    let p = f64x2_div(f64x2_mul(spl(2.0), f64x2_sub(h2, sx2)), r2);
    let q1 = poly6_eo(p, &q.dp);
    let dchi = f64x2_mul(f64x2_div(f64x2_mul(f64x2_mul(spl(2.0), sx), h), r2), q1);
    let phi = f64x2_add(chi, dchi);

    let mut lon = f64x2_mul(f64x2_add(q.lon0, lam), spl(R2D));
    lon = v128_bitselect(f64x2_sub(lon, spl(360.0)), lon, f64x2_gt(lon, spl(180.0)));
    lon = v128_bitselect(f64x2_add(lon, spl(360.0)), lon, f64x2_lt(lon, spl(-180.0)));
    Inv { lon, lat: f64x2_mul(phi, spl(R2D)), sx, cx, she, h, r2, dchi }
}

/// `forward2` on two pairs, interleaved, while every lane is on its common path (|lon| <= 180, |phi| and |lam| <=
/// 3 pi / 4, ccl > 0, |she| < 0.16): the same operations per lane. Otherwise `Err` with each pair's intermediates for
/// `forward_tail` if they were computed (only ccl or she out of range), for `forward2` if not.
#[inline(always)]
fn forward_dual(lon: [v128; 2], lat: [v128; 2], q: &KS) -> Result<([v128; 2], [v128; 2]), Option<[Pre; 2]>> {
    type T = [v128; 2];
    let s = T::splat;
    let k = |v: v128| -> T { [v; 2] };
    let phi = lat.mul(k(q.d2r));
    let lam = lon.mul(k(q.d2r)).sub(k(q.lon0));
    let fold = phi.abs().le(s(3.0 * PI_4)).and(lam.abs().le(s(3.0 * PI_4)));
    if lon.gt(s(180.0)).or(lon.lt(s(-180.0))).or(fold.not()).any() {
        return Err(None);
    }
    let (sp, cp) = sincos_fold(phi);
    let p = s(2.0).sub(s(4.0).mul(sp.mul(sp)));
    let c = q.cp;
    let p2 = p.mul(p);
    let e = k(c[0]).add(p2.mul(k(c[2]).add(p2.mul(k(c[4])))));
    let o = k(c[1]).add(p2.mul(k(c[3]).add(p2.mul(k(c[5])))));
    let q1 = e.add(p.mul(o));
    let dchi = sp.add(sp).mul(cp).mul(q1);
    let dd = dchi.mul(dchi);
    let sd = dchi.mul(s(1.0).add(dd.mul(s(-1.0 / 6.0).add(dd.mul(s(1.0 / 120.0))))));
    let cd = s(1.0).add(dd.mul(s(-0.5).add(dd.mul(s(1.0 / 24.0)))));
    let sc = sp.mul(cd).add(cp.mul(sd));
    let cc = cp.mul(cd).sub(sp.mul(sd));
    let (sl, cl) = sincos_fold(lam);
    let bad = cl.gt(s(1e-15)).not();
    let ccl = cc.mul(cl);
    let sc2 = sc.mul(sc);
    let ccl2 = ccl.mul(ccl);
    let ir = s(1.0).div(sc2.add(ccl2).sqrt());
    let she = cc.mul(sl).mul(ir);
    if ccl.gt(s(0.0)).and(she.abs().lt(s(0.16))).not().any() {
        let pre = |i: usize| Pre { sc: sc[i], ccl: ccl[i], sc2: sc2[i], ccl2: ccl2[i], ir: ir[i], she: she[i], bad: bad[i] };
        return Err(Some([pre(0), pre(1)]));
    }
    let xip = vatan_q(sc, ccl);
    let z = she.mul(she);
    let etap = she.add(she.mul(z).mul(poly_eo(z, &ASINH)));
    let ir2 = ir.mul(ir);
    let s2 = s(2.0).mul(sc).mul(ccl).mul(ir2);
    let c2x = ccl2.sub(sc2).mul(ir2);
    let ch = ir2.add(she.mul(she));
    let sh = s(2.0).mul(she).mul(ir);
    let ar = s(2.0).mul(c2x).mul(ch);
    let ai = s(2.0).mul(s2).mul(sh).neg();
    let rho = ar.mul(ar).add(ai.mul(ai));
    let ta = ar.add(ar);
    let u4 = k(q.a5).add(ta.mul(k(q.a6)));
    let u3 = k(q.ap[3]).add(ta.mul(u4)).sub(rho.mul(k(q.a6)));
    let u2 = k(q.ap[2]).add(ta.mul(u3)).sub(rho.mul(u4));
    let u1 = k(q.ap[1]).add(ta.mul(u2)).sub(rho.mul(u3));
    let tr = k(q.ap[0]).add(ar.mul(u1)).sub(rho.mul(u2));
    let ti = ai.mul(u1);
    let sr = s2.mul(ch);
    let si = c2x.mul(sh);
    let x = k(q.feast).add(k(q.k_a).mul(etap.add(tr.mul(si).add(ti.mul(sr)))));
    let y = k(q.fnorth).add(k(q.k_a).mul(xip.add(tr.mul(sr)).sub(ti.mul(si))));
    Ok((T::select(s(f64::NAN), x, bad), T::select(s(f64::NAN), y, bad)))
}

pub fn forward_batch(lon: &[f64], lat: &[f64], x: &mut [f64], y: &mut [f64], k: &K) {
    let q = splat_k(k);
    let mut i = 0;
    while i + 4 <= lon.len() {
        let l = [load_pair(lon, i), load_pair(lon, i + 2)];
        let p = [load_pair(lat, i), load_pair(lat, i + 2)];
        let (a, b) = forward_dual(l, p, &q).unwrap_or_else(|pre| {
            let ((a0, b0), (a1, b1)) = match pre {
                Some([p0, p1]) => (forward_tail(p0, &q), forward_tail(p1, &q)),
                None => (forward2(l[0], p[0], &q), forward2(l[1], p[1], &q)),
            };
            ([a0, a1], [b0, b1])
        });
        store_pair(a[0], x, i);
        store_pair(b[0], y, i);
        store_pair(a[1], x, i + 2);
        store_pair(b[1], y, i + 2);
        i += 4;
    }
    while i < lon.len() {
        let (a, b) = forward2(load_pair(lon, i), load_pair(lat, i), &q);
        store_pair(a, x, i);
        store_pair(b, y, i);
        i += 2;
    }
}

pub fn inverse_batch(x: &[f64], y: &[f64], lon: &mut [f64], lat: &mut [f64], k: &K) {
    let q = splat_k(k);
    let mut i = 0;
    while i < x.len() {
        let (a, b) = inverse2(load_pair(x, i), load_pair(y, i), &q);
        store_pair(a, lon, i);
        store_pair(b, lat, i);
        i += 2;
    }
}
