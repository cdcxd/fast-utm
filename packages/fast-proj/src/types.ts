import type { Ellipsoid } from './ellipsoid.js';

/**
 * Projected x/y in metres <-> longitude/latitude in degrees on {@link Projection.geographic}, WGS84 (the hub) when
 * unset. Output longitude is in [-180, 180].
 *
 * Batch methods accept any array-like input and write into the optional output buffers, which must be at least as
 * long as the input. An output buffer may be the corresponding input itself (in place), but must not otherwise
 * overlap an input. Interleaved input must have an even length. Points outside the valid domain give `NaN`.
 */
/** An optional output buffer. */
export type Out = Float64Array | undefined;

/**
 * What a batch method returns for output buffer `T`: the buffer itself, or a new `Float64Array<ArrayBuffer>` when it
 * may be `undefined`.
 */
export type Output<T extends Out> = Exclude<T, undefined> | (undefined extends T ? Float64Array<ArrayBuffer> : never);

export interface Projection {
  /**
   * The geographic system of this projection's longitude/latitude; unset means WGS84. x/y stay on the grid of the
   * WGS84 longitude/latitude: x/y <-> WGS84 <-> `geographic`. Borrowed, not owned: one from a wasm context works
   * only while that context is live.
   */
  readonly geographic?: Geographic;
  /** x/y arrays in metres -> longitude/latitude arrays in degrees. */
  toLonLat(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
  ): { lon: Float64Array<ArrayBuffer>; lat: Float64Array<ArrayBuffer> };
  toLonLat<A extends Out>(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    lon: A,
  ): { lon: Output<A>; lat: Float64Array<ArrayBuffer> };
  toLonLat<A extends Out, B extends Out>(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    lon: A,
    lat: B,
  ): { lon: Output<A>; lat: Output<B> };
  /** Longitude/latitude arrays in degrees -> x/y arrays in metres. */
  fromLonLat(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
  ): { x: Float64Array<ArrayBuffer>; y: Float64Array<ArrayBuffer> };
  fromLonLat<A extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    x: A,
  ): { x: Output<A>; y: Float64Array<ArrayBuffer> };
  fromLonLat<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    x: A,
    y: B,
  ): { x: Output<A>; y: Output<B> };
  /** Interleaved [x0, y0, x1, y1, ...] -> interleaved [lon0, lat0, ...]. */
  toLonLatInterleaved(xy: ArrayLike<number>): Float64Array<ArrayBuffer>;
  toLonLatInterleaved<T extends Out>(xy: ArrayLike<number>, out: T): Output<T>;
  /** Interleaved [lon0, lat0, ...] -> interleaved [x0, y0, ...]. */
  fromLonLatInterleaved(lonlat: ArrayLike<number>): Float64Array<ArrayBuffer>;
  fromLonLatInterleaved<T extends Out>(lonlat: ArrayLike<number>, out: T): Output<T>;
  toLonLatPoint(x: number, y: number): [lon: number, lat: number];
  fromLonLatPoint(lon: number, lat: number): [x: number, y: number];
}

/**
 * A geographic coordinate system defined by its conversion to WGS84: this system's longitude/latitude <-> WGS84
 * longitude/latitude, both in degrees. Same buffer rules as {@link Projection}.
 */
export interface Geographic {
  /** This system's longitude/latitude arrays -> WGS84 longitude/latitude arrays. */
  toWgs84(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
  ): { lon: Float64Array<ArrayBuffer>; lat: Float64Array<ArrayBuffer> };
  toWgs84<A extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
  ): { lon: Output<A>; lat: Float64Array<ArrayBuffer> };
  toWgs84<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
    outLat: B,
  ): { lon: Output<A>; lat: Output<B> };
  /** WGS84 longitude/latitude arrays -> this system's longitude/latitude arrays. */
  fromWgs84(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
  ): { lon: Float64Array<ArrayBuffer>; lat: Float64Array<ArrayBuffer> };
  fromWgs84<A extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
  ): { lon: Output<A>; lat: Float64Array<ArrayBuffer> };
  fromWgs84<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
    outLat: B,
  ): { lon: Output<A>; lat: Output<B> };
  /** Interleaved [lon0, lat0, ...] in this system -> interleaved WGS84. */
  toWgs84Interleaved(lonlat: ArrayLike<number>): Float64Array<ArrayBuffer>;
  toWgs84Interleaved<T extends Out>(lonlat: ArrayLike<number>, out: T): Output<T>;
  /** Interleaved WGS84 [lon0, lat0, ...] -> interleaved in this system. */
  fromWgs84Interleaved(lonlat: ArrayLike<number>): Float64Array<ArrayBuffer>;
  fromWgs84Interleaved<T extends Out>(lonlat: ArrayLike<number>, out: T): Output<T>;
  toWgs84Point(lon: number, lat: number): [lon: number, lat: number];
  fromWgs84Point(lon: number, lat: number): [lon: number, lat: number];
}

/**
 * BD-09 (Baidu): a {@link Geographic} that also converts directly to and from GCJ-02, the system it is defined on.
 * Same buffer rules as {@link Projection}.
 */
export interface Bd09 extends Geographic {
  /** BD-09 longitude/latitude arrays -> GCJ-02 longitude/latitude arrays. */
  toGcj02(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
  ): { lon: Float64Array<ArrayBuffer>; lat: Float64Array<ArrayBuffer> };
  toGcj02<A extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
  ): { lon: Output<A>; lat: Float64Array<ArrayBuffer> };
  toGcj02<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
    outLat: B,
  ): { lon: Output<A>; lat: Output<B> };
  /** GCJ-02 longitude/latitude arrays -> BD-09 longitude/latitude arrays. */
  fromGcj02(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
  ): { lon: Float64Array<ArrayBuffer>; lat: Float64Array<ArrayBuffer> };
  fromGcj02<A extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
  ): { lon: Output<A>; lat: Float64Array<ArrayBuffer> };
  fromGcj02<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon: A,
    outLat: B,
  ): { lon: Output<A>; lat: Output<B> };
  /** Interleaved BD-09 [lon0, lat0, ...] -> interleaved GCJ-02. */
  toGcj02Interleaved(lonlat: ArrayLike<number>): Float64Array<ArrayBuffer>;
  toGcj02Interleaved<T extends Out>(lonlat: ArrayLike<number>, out: T): Output<T>;
  /** Interleaved GCJ-02 [lon0, lat0, ...] -> interleaved BD-09. */
  fromGcj02Interleaved(lonlat: ArrayLike<number>): Float64Array<ArrayBuffer>;
  fromGcj02Interleaved<T extends Out>(lonlat: ArrayLike<number>, out: T): Output<T>;
  toGcj02Point(lon: number, lat: number): [lon: number, lat: number];
  fromGcj02Point(lon: number, lat: number): [lon: number, lat: number];
}

/** A transverse Mercator projection. */
export interface TransverseMercator extends Projection {
  /** Degrees. */
  readonly centralMeridian: number;
  /** On the central meridian. */
  readonly scaleFactor: number;
  /** Metres. */
  readonly falseEasting: number;
  /** Metres. */
  readonly falseNorthing: number;
  /** Degrees. Always 0 until other values are supported. */
  readonly latitudeOfOrigin: number;
  readonly ellipsoid: Ellipsoid;
}

/** A transverse Mercator projection for one UTM zone. */
export interface Utm extends TransverseMercator {
  readonly zone: number;
  readonly south: boolean;
}

/** The batch overloads as the single signatures implementations write. */
interface BatchImpl {
  toLonLat<A extends Out, B extends Out>(
    x: ArrayLike<number>,
    y: ArrayLike<number>,
    lon?: A,
    lat?: B,
  ): { lon: Output<A>; lat: Output<B> };
  fromLonLat<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    x?: A,
    y?: B,
  ): { x: Output<A>; y: Output<B> };
  toLonLatInterleaved<T extends Out>(xy: ArrayLike<number>, out?: T): Output<T>;
  fromLonLatInterleaved<T extends Out>(lonlat: ArrayLike<number>, out?: T): Output<T>;
  toWgs84<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon?: A,
    outLat?: B,
  ): { lon: Output<A>; lat: Output<B> };
  fromWgs84<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon?: A,
    outLat?: B,
  ): { lon: Output<A>; lat: Output<B> };
  toWgs84Interleaved<T extends Out>(lonlat: ArrayLike<number>, out?: T): Output<T>;
  fromWgs84Interleaved<T extends Out>(lonlat: ArrayLike<number>, out?: T): Output<T>;
  toGcj02<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon?: A,
    outLat?: B,
  ): { lon: Output<A>; lat: Output<B> };
  fromGcj02<A extends Out, B extends Out>(
    lon: ArrayLike<number>,
    lat: ArrayLike<number>,
    outLon?: A,
    outLat?: B,
  ): { lon: Output<A>; lat: Output<B> };
  toGcj02Interleaved<T extends Out>(lonlat: ArrayLike<number>, out?: T): Output<T>;
  fromGcj02Interleaved<T extends Out>(lonlat: ArrayLike<number>, out?: T): Output<T>;
}

/** `P` as implementations write it, which is assignable to `P`. */
export type Impl<P> = { [K in keyof P]: K extends keyof BatchImpl ? BatchImpl[K] : P[K] };
