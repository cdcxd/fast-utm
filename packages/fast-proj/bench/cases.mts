import type { Bd09, Geographic, Projection, UtmOptions } from '../dist/index.js';
import type { LineString } from '../dist/geojson.js';

/** One row per direction/method: baseline median plus one column per backend. */
type BenchRow = { direction: string; method: string; base: number; ms: Record<string, number> };
/** Point count and timing repetitions shared by both case runners. */
type BenchOptions = { n?: number; runs?: number; reps?: number };
function time(fn: () => void, runs: number, reps: number): number {
  for (let i = 0; i < 10; i++) fn();
  const t = [];
  for (let i = 0; i < runs; i++) {
    const s = performance.now();
    for (let r = 0; r < reps; r++) fn();
    t.push((performance.now() - s) / reps);
  }
  t.sort((x, y) => x - y);
  return t[runs >> 1]!;
}

// `backends` maps a column name to a `utm` factory, e.g. { js: utm, wasm: ctx.utm }.
export function runCases(
  proj4: (from: string, to: string) => { forward(point: unknown): unknown; inverse(point: unknown): unknown },
  backends: Record<string, (options: UtmOptions) => Projection>,
  lineString: (lonlat: ArrayLike<number>) => LineString,
  { n = 10000, runs = 31, reps = 5 }: BenchOptions = {},
): BenchRow[] {
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const lonIn = new Float64Array(n);
  const latIn = new Float64Array(n);
  for (let i = 0; i < n; i++) {
    xs[i] = 300000 + ((i * 7919) % n) * (400000 / n);
    ys[i] = 5000000 + ((i * 104729) % n) * (2000000 / n);
    lonIn[i] = 12 + ((i * 7919) % n) * (6 / n);
    latIn[i] = 45 + ((i * 104729) % n) * (18 / n);
  }
  const xy = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    xy[2 * i] = xs[i]!;
    xy[2 * i + 1] = ys[i]!;
  }
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const out = new Float64Array(2 * n);
  const inv = proj4('+proj=utm +zone=33 +datum=WGS84 +units=m +no_defs', 'WGS84');

  const baselines = {
    'UTM → WGS84': () => {
      for (let i = 0; i < n; i++) inv.forward([xs[i], ys[i]]);
    },
    'WGS84 → UTM': () => {
      for (let i = 0; i < n; i++) inv.inverse([lonIn[i], latIn[i]]);
    },
    'flat UTM → GeoJSON LineString': () => {
      const coordinates = [];
      for (let i = 0; i < n; i++) coordinates.push(inv.forward([xy[2 * i], xy[2 * i + 1]]));
      return { type: 'LineString', coordinates };
    },
  };
  const cases = (conv: Projection | null): [string, string, () => void][] => [
    [
      'UTM → WGS84',
      'toLonLatPoint',
      () => {
        for (let i = 0; i < n; i++) conv!.toLonLatPoint(xs[i]!, ys[i]!);
      },
    ],
    ['UTM → WGS84', 'toLonLat (output buffers)', () => conv!.toLonLat(xs, ys, a, b)],
    ['UTM → WGS84', 'toLonLatInterleaved (output buffer)', () => conv!.toLonLatInterleaved(xy, out)],
    ['WGS84 → UTM', 'fromLonLat (output buffers)', () => conv!.fromLonLat(lonIn, latIn, a, b)],
    [
      'flat UTM → GeoJSON LineString',
      'toLonLatInterleaved + lineString',
      () => lineString(conv!.toLonLatInterleaved(xy, out)),
    ],
  ];

  const proj4Ms = Object.fromEntries(Object.entries(baselines).map(([k, fn]) => [k, time(fn, runs, reps)]));
  const rows: BenchRow[] = cases(null).map(([direction, method]) => ({
    direction,
    method,
    base: proj4Ms[direction]!,
    ms: {},
  }));
  for (const [name, utm] of Object.entries(backends)) {
    cases(utm({ zone: 33 })).forEach(([, , fn], i) => {
      rows[i]!.ms[name] = time(fn, runs, reps);
    });
  }
  return rows;
}

// Points spread over eastern China; the baseline is gcoord's per-point `transform`. `backends` maps a column name to a
// `gcj02` factory.
export function runGcjCases(
  gcoord: { readonly WGS84: unknown; readonly GCJ02: unknown; transform(...args: unknown[]): unknown },
  backends: Record<string, () => Geographic>,
  { n = 10000, runs = 31, reps = 5 }: BenchOptions = {},
): BenchRow[] {
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const ll = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    lon[i] = ll[2 * i] = 100 + ((i * 7919) % n) * (20 / n);
    lat[i] = ll[2 * i + 1] = 22 + ((i * 104729) % n) * (18 / n);
  }
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const out = new Float64Array(2 * n);
  const directions: [string, unknown, unknown][] = [
    ['WGS84 → GCJ-02', gcoord.WGS84, gcoord.GCJ02],
    ['GCJ-02 → WGS84', gcoord.GCJ02, gcoord.WGS84],
  ];
  const cases = (g: Geographic | null): [string, () => void][][] => [
    [
      [
        'fromWgs84Point',
        () => {
          for (let i = 0; i < n; i++) g!.fromWgs84Point(lon[i]!, lat[i]!);
        },
      ],
      ['fromWgs84 (output buffers)', () => g!.fromWgs84(lon, lat, a, b)],
      ['fromWgs84Interleaved (output buffer)', () => g!.fromWgs84Interleaved(ll, out)],
    ],
    [
      [
        'toWgs84Point',
        () => {
          for (let i = 0; i < n; i++) g!.toWgs84Point(lon[i]!, lat[i]!);
        },
      ],
      ['toWgs84 (output buffers)', () => g!.toWgs84(lon, lat, a, b)],
      ['toWgs84Interleaved (output buffer)', () => g!.toWgs84Interleaved(ll, out)],
    ],
  ];
  const rows: BenchRow[] = directions.flatMap(([direction, from, to], d) => {
    const base = time(
      () => {
        for (let i = 0; i < n; i++) gcoord.transform([lon[i], lat[i]], from, to);
      },
      runs,
      reps,
    );
    return cases(null)[d]!.map(([method]) => ({ direction, method, base, ms: {} }));
  });
  for (const [name, gcj02] of Object.entries(backends)) {
    cases(gcj02())
      .flat()
      .forEach(([, fn], i) => {
        rows[i]!.ms[name] = time(fn, runs, reps);
      });
  }
  return rows;
}

// BD-09 as runGcjCases, plus GCJ-02 <-> BD-09. `backends` maps a column name to a `bd09` factory.
export function runBdCases(
  gcoord: {
    readonly WGS84: unknown;
    readonly GCJ02: unknown;
    readonly BD09: unknown;
    transform(...args: unknown[]): unknown;
  },
  backends: Record<string, () => Bd09>,
  { n = 10000, runs = 31, reps = 5 }: BenchOptions = {},
): BenchRow[] {
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const ll = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    lon[i] = ll[2 * i] = 100 + ((i * 7919) % n) * (20 / n);
    lat[i] = ll[2 * i + 1] = 22 + ((i * 104729) % n) * (18 / n);
  }
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const out = new Float64Array(2 * n);
  const directions: [string, unknown, unknown, 'fromWgs84' | 'toWgs84' | 'fromGcj02' | 'toGcj02'][] = [
    ['WGS84 → BD-09', gcoord.WGS84, gcoord.BD09, 'fromWgs84'],
    ['BD-09 → WGS84', gcoord.BD09, gcoord.WGS84, 'toWgs84'],
    ['GCJ-02 → BD-09', gcoord.GCJ02, gcoord.BD09, 'fromGcj02'],
    ['BD-09 → GCJ-02', gcoord.BD09, gcoord.GCJ02, 'toGcj02'],
  ];
  const cases = (g: Bd09 | null): [string, () => void][][] =>
    directions.map(([, , , m]) => [
      [
        `${m}Point`,
        () => {
          const f = g![`${m}Point`];
          for (let i = 0; i < n; i++) f(lon[i]!, lat[i]!);
        },
      ],
      [`${m} (output buffers)`, () => g![m](lon, lat, a, b)],
      [`${m}Interleaved (output buffer)`, () => g![`${m}Interleaved`](ll, out)],
    ]);
  const rows: BenchRow[] = directions.flatMap(([direction, from, to], d) => {
    const base = time(
      () => {
        for (let i = 0; i < n; i++) gcoord.transform([lon[i], lat[i]], from, to);
      },
      runs,
      reps,
    );
    return cases(null)[d]!.map(([method]) => ({ direction, method, base, ms: {} }));
  });
  for (const [name, bd09] of Object.entries(backends)) {
    cases(bd09())
      .flat()
      .forEach(([, fn], i) => {
        rows[i]!.ms[name] = time(fn, runs, reps);
      });
  }
  return rows;
}

// UTM zone 50 <-> GCJ-02, points in China. `backends` maps column name to a converter with `geographic` set.
export function runComposedCases(
  proj4: (from: string, to: string) => { forward(point: unknown): unknown; inverse(point: unknown): unknown },
  gcoord: { readonly WGS84: unknown; readonly GCJ02: unknown; transform(...args: unknown[]): unknown },
  backends: Record<string, Projection>,
  { n = 10000, runs = 31, reps = 5 }: BenchOptions = {},
): BenchRow[] {
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const xy = new Float64Array(2 * n);
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const ll = new Float64Array(2 * n);
  for (let i = 0; i < n; i++) {
    xs[i] = xy[2 * i] = 300000 + ((i * 7919) % n) * (400000 / n);
    ys[i] = xy[2 * i + 1] = 2500000 + ((i * 104729) % n) * (2000000 / n);
    lon[i] = ll[2 * i] = 114 + ((i * 7919) % n) * (6 / n);
    lat[i] = ll[2 * i + 1] = 22.5 + ((i * 104729) % n) * (18 / n);
  }
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const out = new Float64Array(2 * n);
  const inv = proj4('+proj=utm +zone=50 +datum=WGS84 +units=m +no_defs', 'WGS84');
  const baselines: Record<string, () => void> = {
    'UTM → GCJ-02': () => {
      for (let i = 0; i < n; i++) gcoord.transform(inv.forward([xs[i], ys[i]]), gcoord.WGS84, gcoord.GCJ02);
    },
    'GCJ-02 → UTM': () => {
      for (let i = 0; i < n; i++) inv.inverse(gcoord.transform([lon[i], lat[i]], gcoord.GCJ02, gcoord.WGS84));
    },
  };
  const cases = (conv: Projection | null): [string, string, () => void][] => [
    [
      'UTM → GCJ-02',
      'toLonLatPoint',
      () => {
        for (let i = 0; i < n; i++) conv!.toLonLatPoint(xs[i]!, ys[i]!);
      },
    ],
    ['UTM → GCJ-02', 'toLonLat (output buffers)', () => conv!.toLonLat(xs, ys, a, b)],
    ['UTM → GCJ-02', 'toLonLatInterleaved (output buffer)', () => conv!.toLonLatInterleaved(xy, out)],
    [
      'GCJ-02 → UTM',
      'fromLonLatPoint',
      () => {
        for (let i = 0; i < n; i++) conv!.fromLonLatPoint(lon[i]!, lat[i]!);
      },
    ],
    ['GCJ-02 → UTM', 'fromLonLat (output buffers)', () => conv!.fromLonLat(lon, lat, a, b)],
    ['GCJ-02 → UTM', 'fromLonLatInterleaved (output buffer)', () => conv!.fromLonLatInterleaved(ll, out)],
  ];
  const baseMs = Object.fromEntries(Object.entries(baselines).map(([k, fn]) => [k, time(fn, runs, reps)]));
  const rows: BenchRow[] = cases(null).map(([direction, method]) => ({
    direction,
    method,
    base: baseMs[direction]!,
    ms: {},
  }));
  for (const [name, conv] of Object.entries(backends)) {
    cases(conv).forEach(([, , fn], i) => {
      rows[i]!.ms[name] = time(fn, runs, reps);
    });
  }
  return rows;
}

// Web Mercator, points over eastern China (both sides of 45°N), against proj4's EPSG:3857. `backends` maps column name
// to a converter.
export function runMercatorCases(
  proj4: (from: string, to: string) => { forward(point: unknown): unknown; inverse(point: unknown): unknown },
  backends: Record<string, Projection>,
  { n = 10000, runs = 31, reps = 5 }: BenchOptions = {},
): BenchRow[] {
  const lon = new Float64Array(n);
  const lat = new Float64Array(n);
  const ll = new Float64Array(2 * n);
  const xs = new Float64Array(n);
  const ys = new Float64Array(n);
  const xy = new Float64Array(2 * n);
  const merc = proj4('EPSG:4326', 'EPSG:3857');
  for (let i = 0; i < n; i++) {
    lon[i] = ll[2 * i] = 100 + ((i * 7919) % n) * (30 / n);
    lat[i] = ll[2 * i + 1] = 20 + ((i * 104729) % n) * (30 / n);
    const p = merc.forward([lon[i], lat[i]]) as number[];
    xs[i] = xy[2 * i] = p[0]!;
    ys[i] = xy[2 * i + 1] = p[1]!;
  }
  const a = new Float64Array(n);
  const b = new Float64Array(n);
  const out = new Float64Array(2 * n);
  const baselines: Record<string, () => void> = {
    'WGS84 → Web Mercator': () => {
      for (let i = 0; i < n; i++) merc.forward([lon[i], lat[i]]);
    },
    'Web Mercator → WGS84': () => {
      for (let i = 0; i < n; i++) merc.inverse([xs[i], ys[i]]);
    },
  };
  const cases = (conv: Projection | null): [string, string, () => void][] => [
    [
      'WGS84 → Web Mercator',
      'fromLonLatPoint',
      () => {
        for (let i = 0; i < n; i++) conv!.fromLonLatPoint(lon[i]!, lat[i]!);
      },
    ],
    ['WGS84 → Web Mercator', 'fromLonLat (output buffers)', () => conv!.fromLonLat(lon, lat, a, b)],
    ['WGS84 → Web Mercator', 'fromLonLatInterleaved (output buffer)', () => conv!.fromLonLatInterleaved(ll, out)],
    [
      'Web Mercator → WGS84',
      'toLonLatPoint',
      () => {
        for (let i = 0; i < n; i++) conv!.toLonLatPoint(xs[i]!, ys[i]!);
      },
    ],
    ['Web Mercator → WGS84', 'toLonLat (output buffers)', () => conv!.toLonLat(xs, ys, a, b)],
    ['Web Mercator → WGS84', 'toLonLatInterleaved (output buffer)', () => conv!.toLonLatInterleaved(xy, out)],
  ];
  const baseMs = Object.fromEntries(Object.entries(baselines).map(([k, fn]) => [k, time(fn, runs, reps)]));
  const rows: BenchRow[] = cases(null).map(([direction, method]) => ({
    direction,
    method,
    base: baseMs[direction]!,
    ms: {},
  }));
  for (const [name, conv] of Object.entries(backends)) {
    cases(conv).forEach(([, , fn], i) => {
      rows[i]!.ms[name] = time(fn, runs, reps);
    });
  }
  return rows;
}
