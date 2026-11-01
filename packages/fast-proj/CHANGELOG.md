# Changelog

## 0.5.2

### Patch Changes

- 06f5254: Faster WebAssembly GCJ-02 and Web Mercator batches, steadier Bun transverse Mercator batches. JavaScript backend: the transverse Mercator batch loops read the projection's coefficients as locals, which removes a case where Bun ran them 7–10% slower (a converter timed on its own; the README benchmark already got the fast code), with Node and Chromium unchanged and output bit-identical. WebAssembly backend: GCJ-02 `fromWgs84` batches are 10% faster; the Web Mercator inverse takes the JavaScript kernel's formulas, 3% faster and within four ulps of the exact latitude instead of seven (worst 2.1e-14° instead of 2.8e-14°), with a slightly smaller `.wasm`.
- 61f43f0: Faster WebAssembly batches in V8 (Node, Chromium, Deno): the GCJ-02 kernels and the transverse Mercator forward take two coordinate pairs at a time through the same code, so their dependency chains overlap. GCJ-02 `toWgs84` is 13% faster, GCJ-02 → UTM 11%, UTM `fromLonLat` 7% and GCJ-02 `fromWgs84` 6%; Bun is within 2%. The TM gain is within about 9° of the central meridian; farther out V8 is even, and Bun is up to 15% slower. Output is unchanged, bit for bit. The `.wasm` grows from 57 to 78 kB (18 to 24 kB gzipped). Both backends' Web Mercator inverse multiplies by 1/R instead of dividing, 2–3% faster; the worst error is unchanged (2.13e-14°), and individual latitudes move by up to 4 ulps.

## 0.5.1

### Patch Changes

- e972898: Faster batch conversions; results are unchanged within the documented bounds. JavaScript backend: the transverse Mercator kernels take atan, and asinh within about 6° of the central meridian, from inline polynomials and series instead of `Math.atan`/`Math.log1p`, and the Web Mercator inverse takes its latitude from an inline exp and atan instead of `Math.atan(Math.sinh(…))`. The batch loops also read their constants as literals: V8 reloads module constants on every use in a loop compiled while it runs. Batch calls are 17–42% faster in Node, 10–51% in Chromium (GCJ-02 `fromWgs84` and Web Mercator `fromLonLat` unchanged there), and Bun stays within about 8% of 0.5.0 either way. WebAssembly backend: transverse Mercator and GCJ-02 batch calls are 7–12% faster, from sin/cos without the general range reduction and sinh/cosh/asinh from series near the central meridian; the `.wasm` grows by 4.5 kB (53,194 → 57,711 bytes).

## 0.5.0

### Minor Changes

- ceff0a6: New output arrays are typed `Float64Array<ArrayBuffer>`, so they type-check where TypeScript 5.7+ wants an `ArrayBuffer`-backed array (`Blob`, `fetch` bodies, WebGL); output buffers you pass come back with their own type. The types now need TypeScript ≥ 5.7. The wasm module is exported as `fast-proj/fast-proj.wasm`, for bundlers that need its URL imported explicitly.

### Patch Changes

- 1bb71b7: JavaScript backend: the `tmerc`/`utm`, GCJ-02 and Web Mercator forward kernels take sin/cos from inline polynomials instead of `Math.sin`/`Math.cos`, and the transverse Mercator inverse takes sinh/cosh from a series instead of `Math.exp`. Batch calls are 15–62% faster in Chromium and 4–38% in Bun; in Node, whose `Math.sin` is about twice as fast as Chromium's, they range from 8% faster to 7% slower. Results move by a few ulps: Web Mercator y is now within five ulps of the correctly rounded value, as in wasm (three before), GCJ-02 `fromWgs84` within one. The documented transverse Mercator forward bound is now 5e-9 m (from 4e-9 m), which the wasm backend already needed (it reaches 4.7e-9 m within 30° of the central meridian), and the two backends agree within 5e-9 m, or 7.5e-9 m above 2^24 m.

## 0.4.0

### Minor Changes

- 8c307b8: Add `webMercator()`, Web Mercator (EPSG:3857), in both backends (`loadWasm().webMercator()` runs a wasm kernel). Within three ulps (five in wasm) of an exact reference up to the poles; latitudes beyond ±85.05° are not clamped, and the poles give `NaN`. Takes the `geographic` option like `tmerc`/`utm`; see the API docs for placing points on AMap/Tencent tiles, which are Web Mercator of GCJ-02 coordinates.

### Patch Changes

- ae084dc: `loadWasm()`: the batch `fromLonLat` methods of `tmerc`/`utm` are 17–24% faster in Node, Bun and Chromium. Results move by a few ulp and stay within the documented 4e-9 m of the JavaScript backend.
- bb28a39: `loadWasm()`: the batch GCJ-02 conversions are faster in Node, Bun and Chromium: `fromWgs84` by 5–11%, `toWgs84` by 3–8%, GCJ-02 `fromLonLat` by 1–3%. The docs now note that the formula folds over just west of longitude 105°: GCJ-02 points within about 6e-13° of the fold's tip (105.0054° at latitude 55.8°) can have three exact WGS84 inverses, up to 2.6e-12° west of 105°; `toWgs84` is within 3e-12° of one of them.

## 0.3.2

### Patch Changes

- 4bec5e2: `loadWasm()`: the batch `toLonLat` methods of `tmerc`/`utm` are 14–16% faster. Results move by a few ulp and stay within the documented 6e-14° of the JavaScript backend.
- 88f8cbe: JavaScript `utm`/`tmerc` with `geographic: GCJ02`: x/y → GCJ-02 runs as one loop, 9–11% faster in Node and Bun and 36–37% in Chromium (point method 14–48%). Results move by up to 3e-14° (longitude scaled by cos(latitude)), except in `'transform'` mode poleward of about 87°, where the longitude can move more.
- 4bec5e2: `loadWasm()`: a context's `utm`/`tmerc` with that context's `gcj02()` as `geographic` runs x/y → GCJ-02 as one wasm kernel, 32–37% faster than 0.3.1 in Node, Bun and Chromium. Results move by up to 3e-14° (longitude scaled by cos(latitude)).

## 0.3.1

### Patch Changes

- abbbe52: `gcj02` inverse (`toWgs84`): two Newton steps replace four fixed-point steps, in JavaScript and WebAssembly. 25–46% faster and 3–20× more accurate: within 3e-12° of the exact inverse (was 2e-11°). Results move by up to 2e-11°.
- 709257f: Faster JavaScript batch methods, with identical results: `utm`/`tmerc` 23–37% and `gcj02` 28–89% (Node, Bun, Chromium).

## 0.3.0

### Minor Changes

- 14b5595: The one breaking release before 1.0. GCJ-02 can now be a projection's longitude/latitude system:
  `utm({ zone: 50, geographic: GCJ02 })` gives x/y on the UTM grid and GCJ-02 longitude/latitude, for AMap and Tencent
  basemaps. `GCJ02` is `gcj02()` with the default options.

  | 0.2                                                      | 0.3                                                                                       |
  | -------------------------------------------------------- | ----------------------------------------------------------------------------------------- |
  | `tmerc({ lon0, k0 })`                                    | `tmerc({ centralMeridian, scaleFactor })`; the old names throw naming the new ones        |
  | `t.lon0`, `t.k0`                                         | `t.centralMeridian`, `t.scaleFactor`                                                      |
  | `GeographicTransform` type                               | `Geographic`                                                                              |
  | `gcj02()` then `fromWgs84Interleaved` after a projection | `utm({ zone, geographic: GCJ02 })`, or `GCJ02.fromWgs84Interleaved`                       |
  | `gcj02()` returned a new object per call                 | one shared frozen converter per mode: `gcj02() === GCJ02`; per context for `wasm.gcj02()` |
  | `zoneFor(lon, lat)`                                      | `utmZoneFor(lon, lat)`                                                                    |
  | `centralMeridian(zone)`                                  | `zone * 6 - 183` (zone 33 → 15); `.centralMeridian` of a converter you already have       |
  | `MAX_FLATTENING`                                         | `0.01`                                                                                    |
  | `positionsFromArrays(lon, lat)`                          | `positions(lon, lat)`; `lineString` and `latLngs` take `(lon, lat)` too                   |
  | `wasm.utm(...).dispose()` (converters)                   | dispose the context; converters have no `dispose`                                         |
  | `WasmDisposable` type                                    | removed; `WasmContext` extends `Disposable`                                               |
  | `backend === 'wasm-simd'`                                | `'wasm'`; a non-SIMD custom build gives `'js'`                                            |
  | unknown option keys ignored, also by `loadWasm`          | `TypeError`                                                                               |
  | `loadWasm({ source: 123 })` failed inside the engine     | `TypeError`                                                                               |
  | `utm({ zone: '50' })` threw `RangeError`                 | `TypeError`: wrong types throw `TypeError`, bad values `RangeError`                       |
  | error messages                                           | prefixed `fast-proj:`                                                                     |
  | converters were mutable objects                          | frozen; a custom ellipsoid is copied                                                      |

  `latitudeOfOrigin` is accepted when 0; other values throw until supported. The wasm module no longer exports the
  unused zone-based `forward_batch`/`inverse_batch`.

### Patch Changes

- 0d209e4: Add a WebAssembly GCJ-02 kernel: `loadWasm().gcj02()` batch methods run about 1.9–4× faster in `'passthrough'` mode.

## 0.2.0

### Minor Changes

- `gcj02()`: WGS84 ↔ GCJ-02 for maps of China, with an `outsideChina` option. The inverse is accurate to 2e-11°.
  Against gcoord 1.0.7 it is 4.9–11.7× faster forward and 3.5–6.2× faster inverse (Node, Bun, Chromium).
  The `fast-proj/wasm` context has it too, running the JavaScript kernel.

## 0.1.1 (2026-10-12)

- `fast-proj/wasm` ships only the SIMD module. Engines without wasm SIMD (Safari before 16.4) now get the JavaScript
  backend (`backend: 'js'`), also when a `source` is given that can't compile there; the removed scalar wasm build was
  no faster than it.
- Removed `dist/fast-proj-scalar.wasm`. If your build copies it or passes it as `source`, drop it.
- Releases are published with npm trusted publishing.

## 0.1.0 (2026-10-12)

First release.

- `utm()` and general transverse Mercator `tmerc()`, to and from WGS84 lon/lat. Krüger series to order n^6
  (Karney 2011), within 4e-9 m of an exact reference (6e-9 m near ±180°).
- Batch methods on separate or interleaved arrays, in place or into caller buffers, plus single-point methods.
- `zoneFor`, `utmFor`, and the `WGS84` and `GRS80` ellipsoids.
- `fast-proj/geojson`: `positions`, `positionsFromArrays`, `lineString`, `latLngs`.
- `fast-proj/wasm`: opt-in `loadWasm()` backend, SIMD with a scalar fallback.
- ESM only, no dependencies, Node 20 or later.
