---
'fast-proj': patch
---

Faster WebAssembly batches in V8 (Node, Chromium, Deno): the GCJ-02 kernels and the transverse Mercator forward take two coordinate pairs at a time through the same code, so their dependency chains overlap. GCJ-02 `toWgs84` is 13% faster, GCJ-02 → UTM 11%, UTM `fromLonLat` 7% and GCJ-02 `fromWgs84` 6%; Bun is within 2%. The TM gain is within about 9° of the central meridian; farther out V8 is even, and Bun is up to 15% slower. Output is unchanged, bit for bit. The `.wasm` grows from 57 to 78 kB (18 to 24 kB gzipped). Both backends' Web Mercator inverse multiplies by 1/R instead of dividing, 2–3% faster; the worst error is unchanged (2.13e-14°), and individual latitudes move by up to 4 ulps.
