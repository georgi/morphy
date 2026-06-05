/**
 * Re-export of the canonical content-hash helpers. The single source of truth
 * lives in `persistence/content-hash.ts` (it predates this module — phase 1
 * introduced it for `GamesRepository`'s dedup). The import pipeline imports it
 * from here so the download subsystem reads as a self-contained unit, but there
 * is exactly one implementation.
 */
export { contentHash, normalizedSanList } from '../persistence/content-hash';
