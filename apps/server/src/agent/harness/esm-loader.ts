// ESM loader bridge for ESM-only agent SDKs.
//
// `@earendil-works/pi-coding-agent` and `@anthropic-ai/claude-agent-sdk` are both
// published ESM-only ("type":"module", no `require` condition for the package
// root). The server compiles to CommonJS, and TypeScript down-levels a dynamic
// `import()` to `Promise.resolve().then(() => require(...))`, which throws
// ERR_REQUIRE_ESM / MODULE_NOT_FOUND for an ESM-only package. To get a *native*
// dynamic import that survives the CJS emit, we build the importer with
// `new Function` so the `import()` is never rewritten by the compiler. (Verified:
// `require()` of these SDKs fails, native `import()` resolves them.)
//
// Each specifier is cached after the first load so the module is only evaluated
// once. Only **value** imports must go through here; type-only imports are erased
// and never emit a `require`.

// `new Function`-built importer: emits a genuine runtime `import()` that the
// CommonJS down-level transform leaves untouched.
const nativeImport = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<unknown>;

const cache = new Map<string, Promise<unknown>>();

/** Load an ESM-only package once via a native dynamic import (CJS-safe). */
export function loadEsm<T>(specifier: string): Promise<T> {
  let hit = cache.get(specifier);
  if (!hit) {
    hit = nativeImport(specifier);
    cache.set(specifier, hit);
  }
  return hit as Promise<T>;
}
