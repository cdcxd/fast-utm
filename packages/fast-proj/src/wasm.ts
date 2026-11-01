/**
 * Opt-in WebAssembly backend: one combined Rust module (f64x2 SIMD where supported) behind the same converter
 * interfaces as the JavaScript build. Batch results match the JavaScript backend within 5e-9 m and 6e-14 degrees
 * (longitude differences scaled by cos(latitude), so raw longitudes near the poles differ more), or 7.5e-9 m for
 * outputs above 2^24 m; single-point methods run the JavaScript kernel. Composed with GCJ-02, results near
 * longitude 105 (the formula's cusp), the China box edge, and the poles in 'transform' mode can differ more; see
 * docs/api.md.
 */
/// <reference lib="esnext.disposable" preserve="true" />
import { checkOptions } from './checks.js';
import type { Bd09Options } from './bd09.js';
import type { Gcj02Options } from './gcj02.js';
import type { TransverseMercatorOptions } from './tmerc.js';
import type { Bd09, Geographic, Projection, TransverseMercator, Utm } from './types.js';
import type { UtmOptions } from './utm.js';
import type { WebMercatorOptions } from './webmerc.js';
import { type Exports, jsContext, wasmContext } from './wasm-context.js';

type Loadable = URL | string | ArrayBuffer | ArrayBufferView;

/** A URL (or URL string), the module bytes, or an already compiled module. */
export type WasmSource = Loadable | WebAssembly.Module;

export interface LoadWasmOptions {
  /**
   * Where to load the module from. Default: `fast-proj.wasm` next to this file, resolved with
   * `new URL('./fast-proj.wasm', import.meta.url)`. Pass bytes or a URL when a bundler doesn't copy the
   * asset. Relative URL strings resolve against the page URL in browsers.
   */
  source?: WasmSource;
}

export type WasmBackend = 'wasm' | 'js';

/**
 * Same factories as the root entry. Converters hold no resources of their own: they stay valid until the context is
 * disposed, and throw after that.
 */
export interface WasmContext extends Disposable {
  /**
   * `js` when WebAssembly or wasm SIMD is unavailable (a `source` that doesn't compile without SIMD, or a custom
   * non-SIMD build, also falls back); converters then run the JavaScript backend.
   */
  readonly backend: WasmBackend;
  tmerc(options: TransverseMercatorOptions): TransverseMercator;
  utm(options: UtmOptions): Utm;
  webMercator(options?: WebMercatorOptions): Projection;
  /**
   * Batch methods run the wasm kernel in `'passthrough'` mode; `'transform'` mode, single points, and the `js`
   * backend run the JavaScript kernel. As the `geographic` of this context's `tmerc`/`utm`, x/y -> GCJ-02 runs as one
   * wasm kernel in `'passthrough'` mode.
   */
  gcj02(options?: Gcj02Options): Geographic;
  /**
   * BD-09 over this context's {@link WasmContext.gcj02}: WGS84 <-> BD-09 batches run its GCJ-02 step as that does,
   * and the BD-09 offset in JavaScript.
   */
  bd09(options?: Bd09Options): Bd09;
  /** Idempotent. Output arrays already returned stay valid. */
  dispose(): void;
}

// (module (func (result f64) f64x2.extract_lane 0 (v128.const i64x2 0 0)))
const SIMD_PROBE = new Uint8Array([
  0, 97, 115, 109, 1, 0, 0, 0, 1, 5, 1, 96, 0, 1, 124, 3, 2, 1, 0, 10, 25, 1, 23, 0, 253, 12, 0, 0, 0, 0, 0, 0, 0, 0, 0,
  0, 0, 0, 0, 0, 0, 0, 253, 33, 0, 11,
]);

const moduleUrl = import.meta.url;
const runtime = globalThis as { document?: { baseURI?: string }; location?: { href?: string } };

// Caller URLs resolve like fetch: against the page (or worker) URL in browsers, else against this module. Not
// `new URL(variable, import.meta.url)`: bundlers rewrite that into an asset context, and may replace import.meta.url
// with a build-time file: URL.
function base(): string {
  return runtime.document?.baseURI ?? runtime.location?.href ?? moduleUrl;
}
const byUrl = new Map<string, Promise<WebAssembly.Module>>();
// Weak, so the cache doesn't keep the caller's bytes (and their whole backing buffer) alive.
const byBytes = new WeakMap<object, Promise<WebAssembly.Module>>();

const REQUIRED = ['alloc', 'simd_enabled', 'tm_forward_batch', 'tm_inverse_batch'] as const;

async function readFileUrl(url: URL): Promise<Uint8Array> {
  const fs = 'node:fs/promises';
  const { readFile } = (await import(/* @vite-ignore */ /* webpackIgnore: true */ fs)) as {
    readFile(u: URL): Promise<Uint8Array>;
  };
  return readFile(url);
}

// Tags rather than instanceof, so values from another realm (iframe, Node vm) are recognized.
function isUrl(source: unknown): source is string | URL {
  return typeof source === 'string' || Object.prototype.toString.call(source) === '[object URL]';
}

function isArrayBuffer(source: unknown): source is ArrayBuffer {
  return Object.prototype.toString.call(source) === '[object ArrayBuffer]';
}

function isModule(source: unknown): source is WebAssembly.Module {
  return Object.prototype.toString.call(source) === '[object WebAssembly.Module]';
}

async function compile(source: Loadable): Promise<WebAssembly.Module> {
  if (!isUrl(source)) {
    const bytes = ArrayBuffer.isView(source)
      ? new Uint8Array(source.buffer, source.byteOffset, source.byteLength)
      : new Uint8Array(source);
    return WebAssembly.compile(bytes as Uint8Array<ArrayBuffer>);
  }
  const url = new URL(source, base());
  if (url.protocol === 'file:') return WebAssembly.compile((await readFileUrl(url)) as Uint8Array<ArrayBuffer>);
  const response = fetch(url);
  if (typeof WebAssembly.compileStreaming === 'function') {
    try {
      return await WebAssembly.compileStreaming(response);
    } catch (err) {
      // Servers without the application/wasm MIME type: fall back to compiling the bytes.
      if (!(err instanceof TypeError)) throw err;
    }
  }
  const res = await response;
  if (!res.ok) throw new Error(`fast-proj: failed to fetch ${url}: ${res.status} ${res.statusText}`);
  return WebAssembly.compile(await res.arrayBuffer());
}

/** Returns the cached compile promise and a function evicting it, for compile or initialization failures. */
function getModule(source: Loadable): [Promise<WebAssembly.Module>, () => void] {
  const url = isUrl(source);
  const cache = (url ? byUrl : byBytes) as Map<unknown, Promise<WebAssembly.Module>>;
  const key = url ? new URL(source, base()).href : source;
  let promise = cache.get(key);
  if (!promise) {
    promise = compile(source);
    cache.set(key, promise);
  }
  const evict = () => {
    if (cache.get(key) === promise) cache.delete(key);
  };
  return [promise, evict];
}

/**
 * Loads the WebAssembly backend and returns a context owning one instance and a fixed 64 Ki-point workspace (about
 * 2 MiB). The compiled module is cached per source; each call creates a new context. A failed load or
 * initialization can be retried.
 */
export async function loadWasm(options: LoadWasmOptions = {}): Promise<WasmContext> {
  checkOptions(options, 'loadWasm', ['source']);
  const { source: given } = options;
  if (given !== undefined && !isUrl(given) && !isModule(given) && !ArrayBuffer.isView(given) && !isArrayBuffer(given)) {
    throw new TypeError('fast-proj: source must be a URL, string, ArrayBuffer, ArrayBufferView or WebAssembly.Module');
  }
  if (typeof WebAssembly === 'undefined') return jsContext();
  // A scalar wasm build measured no faster than the JavaScript kernel, so engines without SIMD use that.
  const simd = WebAssembly.validate(SIMD_PROBE);
  if (given === undefined && !simd) return jsContext();
  // A literal URL expression, so bundlers such as Vite and webpack copy the asset.
  const source = given ?? new URL('./fast-proj.wasm', import.meta.url);
  let module = source as WebAssembly.Module;
  let evict: (() => void) | undefined;
  if (!isModule(source)) {
    const [promise, ev] = getModule(source);
    evict = ev;
    try {
      module = await promise;
    } catch (err) {
      ev();
      // A SIMD module given as `source` can't compile here either.
      if (!simd && err instanceof WebAssembly.CompileError) return jsContext();
      throw err;
    }
  }
  try {
    const instance = await WebAssembly.instantiate(module, {});
    const exports = instance.exports as unknown as Exports;
    if (!(exports.memory instanceof WebAssembly.Memory) || REQUIRED.some((k) => typeof exports[k] !== 'function')) {
      throw new TypeError('fast-proj: not a fast-proj wasm module');
    }
    // A scalar build is no faster than the JavaScript kernel (see above).
    return exports.simd_enabled() ? wasmContext(exports) : jsContext();
  } catch (err) {
    evict?.();
    throw err;
  }
}
