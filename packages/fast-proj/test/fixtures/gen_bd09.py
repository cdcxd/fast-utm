"""Generate high-precision BD-09 reference points.

Baidu's published GCJ-02 -> BD-09 offset evaluated at 40 digits with exact pi; the inverse is Newton (findroot) from
the input less (0.0065, 0.006). Inputs are doubles, given exactly.

Usage: python gen_bd09.py > bd09.json   (requires mpmath)
"""

import json
import random

from mpmath import atan2, cos, findroot, mp, mpf, pi, sin, sqrt

mp.dps = 40
k = pi * 3000 / 180


def forward(lon, lat):
    if lon == -180:
        lon = mpf(180)
    z = sqrt(lon * lon + lat * lat) + mpf("0.00002") * sin(lat * k)
    t = atan2(lat, lon) + mpf("0.000003") * cos(lon * k)
    return z * cos(t) + mpf("0.0065"), z * sin(t) + mpf("0.006")


def inverse(glon, glat):
    def f(x, y):
        b = forward(x, y)
        return [b[0] - glon, b[1] - glat]

    w = findroot(f, (glon - mpf("0.0065"), glat - mpf("0.006")), tol=mpf(10) ** -70)
    r = f(w[0], w[1])
    if abs(r[0]) + abs(r[1]) > mpf(10) ** -35:
        raise RuntimeError("no convergence")
    return w[0], w[1]


random.seed(2026)
inputs = []
for i in range(14):
    for j in range(14):
        inputs.append((72.3 + i * 4.9 + 0.123 * j, 1.1 + j * 3.9 + 0.071 * i))
for _ in range(100):
    inputs.append((random.uniform(72.004, 137.8347), random.uniform(0.8293, 55.8271)))
# elsewhere, including both hemispheres, near the poles, near the origin (where the polar angle turns fastest) and
# within a degree of the antimeridian, clear of the seam band
for _ in range(60):
    inputs.append((random.uniform(-179, 179), random.uniform(-89.5, 89.5)))
for lon, lat in [(0.01, 0.01), (-0.003, 0.002), (1e-9, -2e-9), (0.0, 0.5), (0.5, 0.0), (-120.0, -89.0), (60.0, 89.0)]:
    inputs.append((lon, lat))
for lat in (-60.0, 0.0, 45.0):
    inputs += [(179.2, lat), (-179.2, lat)]
inputs += [(116.404, 39.915), (121.4737, 31.2304), (113.2644, 23.1291)]


def s(v):
    return mp.nstr(v, 22)


fwd = []
inv = []
for lon, lat in inputs:
    b = forward(mpf(lon), mpf(lat))
    fwd.append([lon, lat, s(b[0]), s(b[1])])
    w = inverse(mpf(lon), mpf(lat))
    inv.append([lon, lat, s(w[0]), s(w[1])])

print(json.dumps({"fromGcj02": fwd, "toGcj02": inv}))
