# fast-proj API

```ts
import { BD09, bd09, GCJ02, gcj02, tmerc, utm, utmFor, utmZoneFor, webMercator, WGS84, GRS80 } from 'fast-proj';
import { positions, lineString, latLngs } from 'fast-proj/geojson';
import { loadWasm } from 'fast-proj/wasm';
```

ESM-only, `sideEffects: false`: unused converters are removed by tree-shaking. Node ≥ 20 and modern browsers;
the types need TypeScript ≥ 5.7 (`Float64Array<ArrayBuffer>`). All angles are in degrees, all distances in metres.

Factories reject unknown option keys (own enumerable keys, including ones set to `undefined`). Errors are `TypeError`
for a wrong type (including unknown options) and `RangeError` for a value out of range; using a disposed wasm context
or re-entering one throws a plain `Error`. Messages start with `fast-proj:`.

- [The hub: WGS84 longitude/latitude](#the-hub-wgs84-longitudelatitude)
- [`utm(options)`](#utmoptions)
- [`tmerc(options)`](#tmercoptions)
- [`webMercator(options)`](#webmercatoroptions)
- [`GCJ02` and `gcj02(options)`](#gcj02-and-gcj02options)
- [`BD09` and `bd09(options)`](#bd09-and-bd09options)
- [Converter methods](#converter-methods)
- [Buffers and aliasing](#buffers-and-aliasing)
- [Zones: `utmFor`, `utmZoneFor`](#zones)
- [Ellipsoids](#ellipsoids)
- [GeoJSON and Leaflet helpers](#geojson-and-leaflet-helpers)
- [WebAssembly backend](#webassembly-backend)
- [Domain and accuracy](#domain-and-accuracy)
- [Chaining](#chaining)
- [Examples](#examples)
- [Migrating from 0.2](#migrating-from-02)
- [Coming from proj4](proj4.md)

## The hub: WGS84 longitude/latitude

Every converter is defined relative to one hub: WGS84 longitude/latitude in degrees, longitude in [-180, 180].

- **Projections** (`Projection`: `utm`, `tmerc`, `webMercator`) convert projected x/y ↔ longitude/latitude with
  `toLonLat` / `fromLonLat`. That longitude/latitude is WGS84, or the projection's `geographic` system when one is
  given.
- **Geographic systems** (`Geographic`: `GCJ02`) convert their own longitude/latitude ↔ WGS84 with `toWgs84` /
  `fromWgs84`.

```ts
utm({ zone: 50 }).toLonLatInterleaved(xy); // WGS84 lon/lat
utm({ zone: 50, geographic: GCJ02 }).toLonLatInterleaved(xy); // GCJ-02 lon/lat, for an AMap basemap
GCJ02.fromWgs84Interleaved(lonlat); // WGS84 -> GCJ-02
```

With `geographic`, x/y stay on the projection's grid of WGS84 longitude/latitude: x/y ↔ WGS84 ↔ `geographic`.
Converting between two other systems is two calls on the same buffer; see [Chaining](#chaining).

An ellipsoid is not a geographic system: a projection on another ellipsoid (e.g. GRS80 for CGCS2000 or ETRS89) treats
its longitude/latitude as WGS84. For those datums the difference from WGS84 is below a metre and usually ignored.

## `utm(options)`

Creates a converter for one UTM zone: `tmerc` with scale factor 0.9996, false easting 500 km and the zone's central
meridian.
Series coefficients are computed once here; keep the converter and reuse it.

```ts
function utm(options: UtmOptions): Utm;

interface UtmOptions {
  zone: number; // 1-60
  south?: boolean; // default false; true adds a false northing of 10 000 km
  ellipsoid?: Ellipsoid; // default WGS84
  geographic?: Geographic; // lon/lat system of toLonLat/fromLonLat, default WGS84
}

interface Utm extends TransverseMercator {
  readonly zone: number;
  readonly south: boolean;
}
```

Throws `RangeError` if `zone` is not an integer in 1-60 or the ellipsoid is unsupported, and `TypeError` for a
non-number `zone`, a non-boolean `south`, a non-object ellipsoid or a `geographic` without the six methods.

`south` only selects the false northing; it does not check the input. With `south: false`, points south of the
equator get negative northings; with `south: true`, points north of the equator get northings above 10 000 km.

## `tmerc(options)`

A general transverse Mercator projection, e.g. Gauss-Krüger zones (CGCS2000 3°/6°) and other grids whose latitude
of origin is the equator.

```ts
function tmerc(options: TransverseMercatorOptions): TransverseMercator;

interface TransverseMercatorOptions {
  centralMeridian: number; // degrees, in [-180, 180]
  scaleFactor?: number; // on the central meridian, default 1
  falseEasting?: number; // metres, default 0
  falseNorthing?: number; // metres, default 0
  latitudeOfOrigin?: number; // degrees; only 0, the default, is supported yet
  ellipsoid?: Ellipsoid; // default WGS84
  geographic?: Geographic; // lon/lat system of toLonLat/fromLonLat, default WGS84
}

interface TransverseMercator extends Projection {
  readonly centralMeridian: number;
  readonly scaleFactor: number;
  readonly falseEasting: number;
  readonly falseNorthing: number;
  readonly latitudeOfOrigin: number; // 0
  readonly ellipsoid: Ellipsoid;
}
```

Every projection also has `readonly geographic?: Geographic`, the system given as the `geographic` option. The
projection borrows it: a `geographic` from a wasm context works only while that context is live.

Throws `RangeError` for a non-finite option, `scaleFactor <= 0` or an unsupported ellipsoid. A latitude of origin other
than 0 (`+lat_0`, e.g. the British National Grid) is not supported yet and throws `RangeError`.

## `webMercator(options)`

Web Mercator (EPSG:3857), the projection of web map tiles: the spherical Mercator on a sphere of radius R = 6378137 m
(WGS84's semi-major axis), applied to WGS84 longitude/latitude.

```ts
function webMercator(options?: WebMercatorOptions): Projection;

interface WebMercatorOptions {
  geographic?: Geographic; // lon/lat system of toLonLat/fromLonLat, default WGS84
}
```

- **Formulas.** x = R λ, y = R asinh(tan φ), the same as R ln tan(π/4 + φ/2). The square tile world spans ±πR =
  ±20037508.342789244 m in x and y. Its latitude limit is ±85.0511287798066° (atan(sinh π)).
- **No clamping.** Latitudes beyond ±85.0511° project to |y| > πR, as in proj4 and PROJ. Clamp before projecting if a
  renderer needs the square. Latitudes of ±90° or beyond give `NaN`: the poles have no finite y.
- **Inverse.** x wraps: x beyond ±πR, such as tiles of a repeated world, gives longitudes reduced to [-180, 180], and ±πR
  gives ±180 exactly. Latitude saturates at ±90° for large finite |y|. Beyond about 2.4e8 m it is exactly ±90°, which
  `fromLonLat` maps to `NaN`.
- **Non-finite input.** `NaN` and `Infinity` give `NaN`.
- **Accuracy.** x is within 4e-9 m of a 40-digit reference. y is within five ulps of it (rounded to a double) in both
  backends, relative 1.2e-15 of the exact value, including near the poles. The inverse is within 3e-14° for |x| ≤ πR;
  x of a repeated world adds the rounding of x / R in degrees (5.6e-14° at x = 1e8 m). Agrees with proj4's EPSG:3857
  within 1e-8 m.
- **Errors.** Throws `TypeError` for an unknown option or a `geographic` without the six methods.

### Map tiles in China

AMap and Tencent tiles are Web Mercator of **GCJ-02** longitude/latitude. `webMercator({ geographic: GCJ02 })` is not
their grid: its x/y stay on the WGS84 grid (x/y ↔ WGS84 ↔ GCJ-02), and only its longitude/latitude side is GCJ-02. For
those tiles, chain the two converters:

```ts
const merc = webMercator();
merc.fromLonLatInterleaved(gcj, out); // GCJ-02 lon/lat -> AMap/Tencent x/y
GCJ02.fromWgs84Interleaved(buf, buf); // WGS84 (GPS) -> GCJ-02 ...
merc.fromLonLatInterleaved(buf, buf); // ... -> AMap/Tencent x/y
merc.toLonLatInterleaved(xy, xy); // AMap/Tencent x/y -> GCJ-02 lon/lat
```

## `GCJ02` and `gcj02(options)`

GCJ-02, the obfuscated coordinate system required for maps of mainland China (AMap/Gaode, Tencent, Google Maps in
China). It follows the published WGS84 → GCJ-02 formula, as gcoord and coordtransform do; for Baidu, see
[`BD09`](#bd09-and-bd09options). Use it standalone or as a projection's `geographic`.

```ts
const GCJ02: Geographic; // gcj02() with the default options; the same object
function gcj02(options?: Gcj02Options): Geographic;

interface Gcj02Options {
  outsideChina?: 'passthrough' | 'transform'; // default 'passthrough'
}
```

- **Outside China.** With `'passthrough'`, points outside the box longitude 72.004–137.8347, latitude 0.8293–55.8271
  (the box gcoord uses) are returned unchanged. With `'transform'`, the offset is applied everywhere; see below for
  the poles and the antimeridian. Throws `RangeError` for any other string and `TypeError` for a non-string.
- **Accuracy.** `fromWgs84` is within one ulp (1.6e-14°) of a 40-digit evaluation of the formula. The formula has no
  closed-form inverse; `toWgs84` takes two Newton steps, up to six within 1e-4° of longitude 105° (where the formula
  has a √|x| cusp), and is within 3e-12° (about 0.3 µm; longitude errors scaled by the cosine of latitude) of the exact
  inverse. Just west of 105° the cusp folds the formula over: WGS84 longitudes up to 2.6e-12° west of 105° (at
  latitude 55.8°, less further south) map onto GCJ-02 longitudes within about 6e-13° of the fold's tip (105.0054° at
  latitude 55.8°, 105.0021° at 1°). A point there can have three exact inverses, and `toWgs84` is within 3e-12° of one
  of them. gcoord's inverse stops at about 1e-6° (0.1 m), and coordtransform's one-step inverse is off by up to 3e-5°
  (3 m).
- **`'transform'` near the poles and the antimeridian.** `toWgs84` iterates until converged. Up to latitude ±89° it
  round-trips within 1e-11° (longitude errors scaled by the cosine of latitude), except within 1e-4° of longitude
  105°, where rounding the GCJ-02 coordinates alone moves the exact inverse by up to 1e-10° at ±89°. Closer to the poles the formula isn't one-to-one: `toWgs84` gives `NaN` or another point
  with the same GCJ-02 coordinates, and `fromWgs84` gives `NaN` where the offset would push latitude past ±90°. The
  offset differs at longitudes 180° and −180°; both are treated as 180°.
- Input longitudes outside [-180, 180] are reduced first; output longitudes are in [-180, 180].

## `BD09` and `bd09(options)`

BD-09, Baidu's coordinate system (Baidu Maps and the Baidu SDKs): GCJ-02 plus Baidu's published offset, as in gcoord
and coordtransform. A `Bd09` is a `Geographic` (WGS84 ↔ BD-09, for a projection's `geographic` too) that also converts
directly to and from GCJ-02.

```ts
const BD09: Bd09; // bd09() with the default options; the same object
function bd09(options?: Bd09Options): Bd09;

type Bd09Options = Gcj02Options; // outsideChina, for the GCJ-02 step

interface Bd09 extends Geographic {
  toGcj02(lon, lat, outLon?, outLat?): { lon; lat }; // BD-09 -> GCJ-02
  fromGcj02(lon, lat, outLon?, outLat?): { lon; lat }; // GCJ-02 -> BD-09
  toGcj02Interleaved(lonlat, out?); fromGcj02Interleaved(lonlat, out?);
  toGcj02Point(lon, lat); fromGcj02Point(lon, lat);
}
```

```ts
BD09.fromWgs84Interleaved(gps, out); // WGS84 (GPS) -> BD-09, for a Baidu map
BD09.fromGcj02Interleaved(amap, out); // AMap/Tencent GCJ-02 -> BD-09
BD09.toGcj02Interleaved(baidu, out); // BD-09 -> GCJ-02
utm({ zone: 50, geographic: BD09 }).toLonLatInterleaved(xy, xy); // UTM -> BD-09
```

- **Outside China.** The BD-09 offset applies everywhere, as in gcoord, coordtransform and Baidu's own maps;
  `outsideChina` only decides the GCJ-02 step of `toWgs84`/`fromWgs84` (so with `'passthrough'`, WGS84 points outside
  the box get the BD-09 offset alone). The GCJ-02 methods don't depend on it.
- **Accuracy.** `fromGcj02` is within one ulp (1.5e-14°) of a 40-digit evaluation of the formula. The offset has no
  closed-form inverse; `toGcj02` takes two Newton steps and is within one ulp of the exact inverse. gcoord's and
  coordtransform's closed-form inverse is off by up to 2e-6° (0.2 m). `toWgs84`/`fromWgs84` add GCJ-02's accuracy
  (above).
- **Poles and the antimeridian.** Latitudes beyond ±90°, in or out, give `NaN`. Longitudes 180° and −180° are treated
  as 180°. The offset's angle term jumps across the antimeridian (by up to 1e-3° of latitude), so within about 0.01°
  of longitude ±180° some BD-09 points have two GCJ-02 preimages (`toGcj02` returns one of them) and some have none
  (`NaN`).
- **Baidu tiles.** Baidu's map tiles use BD-09MC, Baidu's own Mercator, which isn't supported; `webMercator()` of
  BD-09 longitude/latitude is not their grid.
- Input longitudes outside [-180, 180] are reduced first; output longitudes are in [-180, 180].

## Converter methods

Every `Projection` has the methods below. A `Geographic` has the same set with lon/lat on both sides:
`toWgs84(lon, lat, outLon?, outLat?)`, `fromWgs84(...)`, `toWgs84Interleaved(lonlat, out?)`, `fromWgs84Interleaved`,
`toWgs84Point(lon, lat)` and `fromWgs84Point`. A `Bd09` adds the same six with `Gcj02` in place of `Wgs84`.

| method                                | input                         | output                                         |
| ------------------------------------- | ----------------------------- | ---------------------------------------------- |
| `toLonLat(x, y, lon?, lat?)`          | x and y arrays                | `{ lon, lat }` `Float64Array`s                 |
| `fromLonLat(lon, lat, x?, y?)`        | longitude and latitude arrays | `{ x, y }` `Float64Array`s                     |
| `toLonLatInterleaved(xy, out?)`       | `[x0, y0, x1, y1, ...]`       | `[lon0, lat0, lon1, lat1, ...]` `Float64Array` |
| `fromLonLatInterleaved(lonlat, out?)` | `[lon0, lat0, ...]`           | `[x0, y0, ...]` `Float64Array`                 |
| `toLonLatPoint(x, y)`                 | one point                     | `[lon, lat]`                                   |
| `fromLonLatPoint(lon, lat)`           | one point                     | `[x, y]`                                       |

Inputs may be any array-like of numbers (`number[]`, `Float64Array`, `Float32Array`, ...). Outputs are new
`Float64Array`s, typed `Float64Array<ArrayBuffer>` so they can go to a `Blob`, a `fetch` body or WebGL, unless output
buffers are passed, in which case those buffers are filled and returned with their own type (a buffer typed as possibly
`undefined` gives the union of the two; one typed by an explicit type argument must be passed). The output shapes `{ lon, lat }` and `{ x, y }` are stable.

Converters are frozen plain objects; their methods don't use `this` and can be destructured.

Throws `RangeError` when the two input arrays of `toLonLat`/`fromLonLat` differ in length, an interleaved input has an
odd length, or an output buffer is shorter than the input. The point methods never throw; invalid input gives `NaN`.

## Buffers and aliasing

- An output buffer must be at least as long as the input; extra elements are left untouched.
- An output buffer may be **the same array** as an input, for in-place conversion:
  `toLonLatInterleaved(xy, xy)`, `toLonLat(x, y, x, y)`, or swapped, `toLonLat(x, y, y, x)`.
- An output buffer must **not otherwise overlap** an input (for example `xy.subarray(2)` as the output of `xy`);
  results are then undefined.

## Zones

```ts
function utmFor(lon: number, lat: number): { zone: number; south: boolean };
function utmZoneFor(lon: number, lat: number): number;
```

`utmZoneFor` returns the standard UTM zone, including the Norway (32V) and Svalbard (31X, 33X, 35X, 37X) exceptions.
Longitude is wrapped, so 190 gives zone 2. `utmFor` adds `south: lat < 0`, and its result can be passed straight to
`utm`; it stays exactly `{ zone, south }`. Both throw `TypeError` for non-number input, and `RangeError` for non-finite input and for latitudes outside [-80, 84] (the polar regions use UPS,
which is not implemented).

A zone's central meridian is `zone * 6 - 183` degrees (zone 33: 15°), also `.centralMeridian` of a `utm` converter.

## Ellipsoids

```ts
interface Ellipsoid {
  readonly a: number; // semi-major axis, metres
  readonly f: number; // flattening
}
const WGS84: Ellipsoid; // frozen
const GRS80: Ellipsoid; // frozen; also CGCS2000 and ETRS89 in practice
```

Any ellipsoid with `a > 0` and `0 <= f < 0.01` is supported, which covers every terrestrial ellipsoid
(Earth's is 0.0034). The implementation's small-angle expansions are exact to double precision only in that range. The
accuracy figures under [Domain and accuracy](#domain-and-accuracy) hold for terrestrial flattenings. The series are
truncated at order n^6, so error grows with f: up to f = 0.005 it stays within those figures; near the limit (f =
0.0099999) it is about 1e-8 m within 6° of the central meridian, 2e-7 m at 30°, and 1e-12° inverse.

## GeoJSON and Leaflet helpers

`fast-proj/geojson` formats longitude/latitude buffers (the output of any converter or [chain](#chaining)) as the
nested arrays map libraries take. It does no conversion.

```ts
type Position = [lon: number, lat: number];

function positions(lonlat: ArrayLike<number>): Position[];
function positions(lon: ArrayLike<number>, lat: ArrayLike<number>): Position[];
function lineString(lonlat: ArrayLike<number>): { type: 'LineString'; coordinates: Position[] };
function lineString(lon: ArrayLike<number>, lat: ArrayLike<number>): { type: 'LineString'; coordinates: Position[] };
function latLngs(lonlat: ArrayLike<number>): [lat: number, lng: number][];
function latLngs(lon: ArrayLike<number>, lat: ArrayLike<number>): [lat: number, lng: number][];
```

Each takes interleaved input, or separate `lon` and `lat` arrays such as the result of `toLonLat`. They throw
`RangeError` for an odd interleaved length or arrays of different lengths. `latLngs` returns Leaflet's latitude-first
order.

## WebAssembly backend

`fast-proj/wasm` runs the batch methods in one combined Rust module (f64x2 SIMD where supported). It is opt-in: the
root entry never loads it.

```ts
function loadWasm(options?: {
  source?: URL | string | ArrayBuffer | ArrayBufferView | WebAssembly.Module;
}): Promise<WasmContext>;

interface WasmContext extends Disposable {
  readonly backend: 'wasm' | 'js';
  tmerc(options: TransverseMercatorOptions): TransverseMercator;
  utm(options: UtmOptions): Utm;
  webMercator(options?: WebMercatorOptions): Projection;
  gcj02(options?: Gcj02Options): Geographic;
  bd09(options?: Bd09Options): Bd09;
  dispose(): void;
}
```

```ts
const wasm = await loadWasm();
const zone33 = wasm.utm({ zone: 33 }); // same interface as utm()
zone33.toLonLatInterleaved(xy, xy);
wasm.dispose(); // or: using wasm = await loadWasm();
```

`using` needs a runtime with `Symbol.dispose`, which early Node 20 releases lack; `dispose()` works everywhere.

- **Loading.** By default the module is `fast-proj.wasm` next to `wasm.js`, resolved with `new URL('./fast-proj.wasm',
  import.meta.url)`. Vite and webpack 5 copy the asset; on Node and Bun it is read from disk. With a bundler that
  doesn't handle the pattern (esbuild), pass `source`: a URL you serve, the bytes, or a compiled `WebAssembly.Module`.
  The package exports the module as `fast-proj/fast-proj.wasm`, so you can import its URL, e.g.
  `import url from 'fast-proj/fast-proj.wasm'` with esbuild's `--loader:.wasm=file`, or resolve its path on Node.
- **Backend.** `wasm` normally (the module uses wasm SIMD). `js` when WebAssembly or wasm SIMD (Safari before 16.4) is unavailable, including
  when a `source` is given that can't compile without SIMD or is a non-SIMD build; the context's converters then run
  the JavaScript backend, which measured as fast as a scalar wasm build.
- **Instances.** The compiled module is cached per source. Each `loadWasm` call returns a new context with its own
  instance and a fixed 64 Ki-point workspace (about 2 MiB); larger inputs are processed in chunks. A failed load can
  be retried.
- **Disposal.** Only the context is disposable; `dispose()` is idempotent. Its converters hold nothing of their own
  and throw once it is disposed. Output arrays already returned are caller-owned and stay valid.
- **`geographic`.** `wasm.utm({ zone, geographic })` runs the wasm projection, then the geographic system's batch
  method on the same buffer: `wasm.gcj02()` for the wasm kernel, or the root `GCJ02` for the JavaScript one. With the
  same context's `wasm.gcj02()` (`'passthrough'` mode), x/y -> GCJ-02 runs as one wasm kernel instead, 22–28% faster
  and within 3e-14° of the two passes (longitude scaled by cos(latitude)).
- **Copies.** Converters take and return caller-owned arrays, so each batch call copies the input into the workspace
  and the result back (about 0.17 ns per point). There is no zero-copy access to wasm memory.
- **GCJ-02.** The context's `gcj02()` batch methods run the wasm kernel in `'passthrough'` mode (about 1.9–4×
  the JavaScript kernel); `'transform'` mode runs the JavaScript kernel. Each context returns one converter per mode.
- **BD-09.** The context's `bd09()` runs the BD-09 offset in JavaScript over the context's own `gcj02()`, so
  `toWgs84`/`fromWgs84` batches run the wasm GCJ-02 kernel in `'passthrough'` mode. Its GCJ-02 methods are the
  JavaScript ones.
- **Web Mercator.** `webMercator()` batch methods run a wasm kernel. With a `source` older than 0.4.0, which has no
  such kernel, they run the JavaScript one and `backend` still reports `wasm`.
- **Single points.** `toLonLatPoint`/`fromLonLatPoint` and `toWgs84Point`/`fromWgs84Point` run the JavaScript kernel:
  passing one point into wasm costs more than computing it.
- **Re-entrancy.** Calling the same context from inside an array-like getter during a batch call throws.
- **Accuracy contract.** Batch results match the JavaScript backend within 5e-9 m and 6e-14° (longitude differences
  scaled by cos(latitude)), not bit for bit. Coordinates above 2^24 m (about 16,777 km, such as northings north of the
  equator in a southern UTM zone or Gauss–Krüger eastings with a zone prefix) can differ by 7.5e-9 m, two ulps of the
  output (one above 2^25 m). Web Mercator y comes from y / R and so can differ by up to 7.5e-9 m below 2^25 m
  (latitude ±89.4°), and by two ulps above.
- **Composed accuracy.** A projection with a `geographic` system holds the same bound, except where the geographic
  system amplifies a one-ulp difference in the projection's WGS84 result. For GCJ-02 that is:
  - WGS84 longitude within 1e-11° of 105°, the formula's √|x| cusp: one ulp there moves GCJ-02 latitude by about
    2.2e-13°, so differences are up to 1e-12° below latitude 85° and grow toward the poles in `'transform'` mode
    (about 5e-12° at 89.9°).
  - In `'transform'` mode, WGS84 latitudes beyond ±89.9°, at any longitude: the offset is no longer one-to-one there
    (see [`gcj02`](#gcj02-and-gcj02options)), and differences grow toward the poles, measured at 2e-12° at 89.99° and
    2e-6° at 89.99999°.
  - In `'passthrough'` mode, WGS84 positions within one ulp of the China box edge: one backend may apply the offset and
    the other pass the point through, a difference of up to the offset itself (several hundred metres).

  Standalone `gcj02()` converters agree at the box edges; the jumps come only from the projection step in front.

## Domain and accuracy

For `tmerc` and `utm`; see [`webMercator`](#webmercatoroptions) for its own domain and accuracy.

- **Accuracy** for terrestrial ellipsoids, within 30° of the central meridian, all latitudes including the poles: at
  most 5e-9 m forward (6e-9 m for longitudes near ±180°, where one ulp of the input longitude is already 3e-9 m) and
  1e-13° inverse against a 30-digit reference (`packages/fast-proj/test/fixtures`) in all 60 UTM zones, both
  hemispheres, and about 6e-9 m / 1.3e-13° against proj4. Both backends.
- **Recommended domain:** within ~45° of the central meridian. Accuracy degrades further out, as for any Krüger series
  implementation.
- Points **90° or more** from the central meridian return `NaN` from the forward methods.
- At the poles, the inverse returns the central meridian as longitude.
- Output longitudes are normalised to [-180, 180]; input longitudes may be outside that range.
- `NaN` and `Infinity` inputs give `NaN`.

Reference: C. F. F. Karney, _Transverse Mercator with an accuracy of a few nanometers_, J. Geodesy 85 (2011) 475–485,
[doi:10.1007/s00190-011-0445-3](https://doi.org/10.1007/s00190-011-0445-3). Equation-level references are in
[`src/tmerc.ts`](../packages/fast-proj/src/tmerc.ts).

## Chaining

Converters compose through the hub on the same buffer, with no allocation:

```ts
const zone50 = utm({ zone: 50 });
const gk = tmerc({ centralMeridian: 117, falseEasting: 500000, ellipsoid: GRS80 });
zone50.toLonLatInterleaved(buf, buf); // UTM 50N -> lon/lat
gk.fromLonLatInterleaved(buf, buf); // lon/lat -> CGCS2000 3° zone, CM 117E
```

A projection's `geographic` option is the same two passes, for GCJ-02 lon/lat. In the JavaScript backend, x/y -> GCJ-02
on a `tmerc`/`utm` runs as one loop instead (a wasm context does the same in wasm; see [WebAssembly backend](#webassembly-backend)), 9-37% faster and within 3e-14° of the two passes (longitude scaled by
cos(latitude)), except in `'transform'` mode poleward of about 87°, where the longitude can differ by more, up to
degrees at the poles: the two passes are as unstable there (one ulp of WGS84 latitude moves the longitude by up to tens
of degrees). Pass the `gcj02()` object itself: a copy such as `{ ...GCJ02 }` gives the same results but runs the two
passes:

```ts
utm({ zone: 50, geographic: GCJ02 }).toLonLatInterleaved(buf, buf); // UTM 50N -> GCJ-02, for an AMap basemap
```

For two projections, a fused single loop measured no faster than two passes: the steps share no expensive
intermediate values.

## Migrating from 0.2

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

## Examples

### MapLibre GL: polyline from flat UTM data

```ts
import { utm } from 'fast-proj';
import { lineString } from 'fast-proj/geojson';

const zone = utm({ zone: 33 });
const lonlat = zone.toLonLatInterleaved(xy);
map.addSource('track', { type: 'geojson', data: lineString(lonlat) });
map.addLayer({ id: 'track', type: 'line', source: 'track' });
```

### Leaflet: polyline

```ts
import { latLngs } from 'fast-proj/geojson';

L.polyline(latLngs(zone.toLonLatInterleaved(xy))).addTo(map);
```

### deck.gl: binary attributes, no per-point arrays

```ts
const lonlat = zone.toLonLatInterleaved(xy); // or (xy, xy) to reuse the buffer
new ScatterplotLayer({
  data: { length: lonlat.length / 2, attributes: { getPosition: { value: lonlat, size: 2 } } },
});
```

### Worker: convert off the main thread without copying

```ts
// worker.js
const out = zone.toLonLatInterleaved(xy, xy);
postMessage(out, [out.buffer]);
```

### Mixed zones

```ts
const converters = new Map<string, Utm>();
function converterFor(zone: number, south: boolean) {
  const key = `${zone}${south ? 'S' : 'N'}`;
  let c = converters.get(key);
  if (!c) converters.set(key, (c = utm({ zone, south })));
  return c;
}
```
