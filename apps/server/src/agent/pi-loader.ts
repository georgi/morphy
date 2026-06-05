// ESM loader bridge for the Pi Agent SDK.
//
// `@earendil-works/pi-coding-agent` is published ESM-only ("type":"module", no
// `require` condition in its exports map). The server compiles to CommonJS, and
// TypeScript down-levels a dynamic `import()` to `Promise.resolve().then(() =>
// require(...))`, which throws ERR_REQUIRE_ESM / MODULE_NOT_FOUND for an
// ESM-only package. To get a *native* dynamic import that survives the CJS
// emit, we build the importer with `new Function` so the `import()` is never
// rewritten by the compiler. (Verified: `require()` of the SDK fails, native
// `import()` resolves it.)
//
// The SDK is cached after the first load so the module is only evaluated once.
import type {
  createAgentSession as CreateAgentSessionFn,
  defineTool as DefineToolFn,
  getAgentDir as GetAgentDirFn,
  SessionManager as SessionManagerClass,
  DefaultResourceLoader as DefaultResourceLoaderClass,
} from '@earendil-works/pi-coding-agent';

/** The subset of the Pi SDK surface this app uses. */
export interface PiSdk {
  createAgentSession: typeof CreateAgentSessionFn;
  defineTool: typeof DefineToolFn;
  getAgentDir: typeof GetAgentDirFn;
  SessionManager: typeof SessionManagerClass;
  DefaultResourceLoader: typeof DefaultResourceLoaderClass;
}

// `new Function`-built importer: emits a genuine runtime `import()` that the
// CommonJS down-level transform leaves untouched.
const nativeImport = new Function(
  'specifier',
  'return import(specifier);',
) as (specifier: string) => Promise<unknown>;

let cached: Promise<PiSdk> | undefined;

/** Load the Pi Agent SDK once, returning the cached module on subsequent calls. */
export function loadPiSdk(): Promise<PiSdk> {
  if (!cached) {
    cached = nativeImport('@earendil-works/pi-coding-agent') as Promise<PiSdk>;
  }
  return cached;
}
