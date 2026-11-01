# fast-proj

Fast batch coordinate conversions for JavaScript and TypeScript: UTM, transverse Mercator and Web Mercator ↔ WGS84,
and WGS84 ↔ GCJ-02 for maps of China, with typed-array APIs and an optional WebAssembly backend.

- Krüger series to 6th order (Karney 2011). Accuracy: ≤5e-9 m (6e-9 m near ±180°) / 1e-13° vs an exact reference;
  ≈6e-9 m / 1.3e-13° vs proj4.
- GCJ-02: the published formula, 7–20× faster than gcoord (16–29× with WebAssembly); the inverse is accurate to 3e-12°
  (gcoord: 1e-6°).
- Web Mercator (EPSG:3857): within five ulps of the correctly rounded exact value up to the poles; no clamping at ±85.05°.
- No per-point allocations in the batch APIs; optional output buffers, in-place conversion.
- No dependencies, ESM-only, tree-shakeable. Node ≥ 20 and modern browsers.

```sh
npm install fast-proj
```

```ts
import { GCJ02, tmerc, utm, utmFor, webMercator } from 'fast-proj';
import { lineString } from 'fast-proj/geojson';

const zone33 = utm({ zone: 33 }); // or utm(utmFor(lon, lat))
const { lon, lat } = zone33.toLonLat(xs, ys); // Float64Array out
zone33.toLonLatInterleaved(xy, xy); // [x0, y0, x1, y1, ...] -> [lon0, lat0, ...], in place
const [x, y] = zone33.fromLonLatPoint(15, 52);
map.getSource('track').setData(lineString(xy)); // MapLibre

const gk = tmerc({ centralMeridian: 117, falseEasting: 500000 }); // Gauss-Krüger, CM 117E
utm({ zone: 50, geographic: GCJ02 }).toLonLatInterleaved(xy, xy); // UTM -> GCJ-02 for AMap/Tencent basemaps
GCJ02.fromWgs84Interleaved(lonlat, lonlat); // WGS84 -> GCJ-02, in place
webMercator().fromLonLatInterleaved(lonlat, lonlat); // lon/lat -> EPSG:3857 x/y (on GCJ-02 lon/lat: AMap tiles)

import { loadWasm } from 'fast-proj/wasm'; // opt-in, ~78 kB
const wasm = await loadWasm();
wasm.utm({ zone: 33 }).toLonLatInterleaved(xy, xy);
```

Transverse Mercator's valid domain: within ~45° of the central meridian (accuracy above holds to 30°); points 90° or more away give `NaN`.
Output longitudes are in [-180, 180]. Output buffers may be the input itself but must not otherwise overlap it.

**[API reference](https://github.com/cdcxd/fast-proj/blob/main/docs/api.md)** ·
**[Coming from proj4](https://github.com/cdcxd/fast-proj/blob/main/docs/proj4.md)**

## Benchmark

10k points (`bun run bench`), the mean of three runs of the median of 31 samples. UTM: zone 33N, against a reused
proj4 2.22 `proj4(from, to)` converter.

| Operation                | Implementation                                    | Node 24         | Bun 1.4        | Chromium 156    |
| ------------------------ | ------------------------------------------------- | --------------- | -------------- | --------------- |
| WGS84 → UTM              | proj4                                             | 5.04 ms         | 2.42 ms        | 5.66 ms         |
|                          | `fromLonLat`, JavaScript                          | 0.59 ms (8.5×)  | 0.57 ms (4.2×) | 0.58 ms (9.8×)  |
|                          | `fromLonLat`, WebAssembly                         | 0.38 ms (13.4×) | 0.40 ms (6.0×) | 0.38 ms (14.9×) |
| UTM → WGS84              | proj4                                             | 4.79 ms         | 2.60 ms        | 5.22 ms         |
|                          | `toLonLat`, JavaScript                            | 0.66 ms (7.3×)  | 0.62 ms (4.2×) | 0.62 ms (8.4×)  |
|                          | `toLonLat`, WebAssembly                           | 0.45 ms (10.6×) | 0.43 ms (6.0×) | 0.44 ms (11.9×) |
| UTM → GeoJSON LineString | proj4                                             | 5.03 ms         | 2.73 ms        | 5.39 ms         |
|                          | `toLonLatInterleaved` + `lineString`, JavaScript  | 0.73 ms (6.9×)  | 0.73 ms (3.8×) | 0.74 ms (7.3×)  |
|                          | `toLonLatInterleaved` + `lineString`, WebAssembly | 0.54 ms (9.4×)  | 0.54 ms (5.1×) | 0.52 ms (10.4×) |

GCJ-02: points in eastern China, against gcoord 1.0.7's `transform`.

| Operation      | Implementation           | Node 24         | Bun 1.4         | Chromium 156    |
| -------------- | ------------------------ | --------------- | --------------- | --------------- |
| WGS84 → GCJ-02 | gcoord                   | 9.76 ms         | 8.15 ms         | 6.76 ms         |
|                | `fromWgs84`, JavaScript  | 0.33 ms (29.6×) | 0.36 ms (22.6×) | 0.33 ms (20.3×) |
|                | `fromWgs84`, WebAssembly | 0.25 ms (39.0×) | 0.28 ms (29.1×) | 0.24 ms (28.2×) |
| GCJ-02 → WGS84 | gcoord                   | 14.22 ms        | 14.01 ms        | 11.61 ms        |
|                | `toWgs84`, JavaScript    | 0.96 ms (14.8×) | 1.10 ms (12.7×) | 0.89 ms (13.0×) |
|                | `toWgs84`, WebAssembly   | 0.58 ms (24.5×) | 0.82 ms (17.1×) | 0.58 ms (20.0×) |

UTM ↔ GCJ-02: `utm({ zone: 50, geographic: GCJ02 })`, against proj4 then gcoord (or gcoord then proj4).

| Operation    | Implementation            | Node 24         | Bun 1.4         | Chromium 156    |
| ------------ | ------------------------- | --------------- | --------------- | --------------- |
| UTM → GCJ-02 | proj4 + gcoord            | 16.08 ms        | 11.23 ms        | 12.23 ms        |
|              | `toLonLat`, JavaScript    | 0.97 ms (16.6×) | 0.99 ms (11.3×) | 0.94 ms (13.0×) |
|              | `toLonLat`, WebAssembly   | 0.65 ms (24.6×) | 0.64 ms (17.5×) | 0.65 ms (18.7×) |
| GCJ-02 → UTM | proj4 + gcoord            | 20.60 ms        | 17.26 ms        | 18.33 ms        |
|              | `fromLonLat`, JavaScript  | 1.56 ms (13.2×) | 1.66 ms (10.4×) | 1.52 ms (12.1×) |
|              | `fromLonLat`, WebAssembly | 0.96 ms (21.5×) | 1.22 ms (14.1×) | 0.95 ms (19.2×) |

Web Mercator: `webMercator()`, points in eastern China, against proj4's `EPSG:3857`.

| Operation            | Implementation            | Node 24         | Bun 1.4        | Chromium 156    |
| -------------------- | ------------------------- | --------------- | -------------- | --------------- |
| WGS84 → Web Mercator | proj4                     | 3.65 ms         | 0.75 ms        | 3.01 ms         |
|                      | `fromLonLat`, JavaScript  | 0.28 ms (13.0×) | 0.25 ms (3.0×) | 0.26 ms (11.6×) |
|                      | `fromLonLat`, WebAssembly | 0.26 ms (14.1×) | 0.25 ms (3.0×) | 0.26 ms (11.6×) |
| Web Mercator → WGS84 | proj4                     | 3.73 ms         | 0.73 ms        | 2.97 ms         |
|                      | `toLonLat`, JavaScript    | 0.24 ms (15.6×) | 0.27 ms (2.7×) | 0.21 ms (14.4×) |
|                      | `toLonLat`, WebAssembly   | 0.21 ms (17.8×) | 0.20 ms (3.7×) | 0.20 ms (14.8×) |

The interleaved variants run at the same speed as the array form. Single-point methods use the JavaScript kernel in
both backends. Single runs: `node bench/run.mts`, `bun bench/run.mts`, `node bench/run.mts --browser` (needs
`bunx playwright install chromium`).

## License

MIT
