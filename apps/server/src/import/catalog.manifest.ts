import type { CatalogEntry } from '@chess/shared';
import catalogManifest from './catalog.json';

/**
 * The curated download catalog (SPEC §5 / §10.5). The manifest lives in
 * `catalog.json` (statically imported so `nest build` copies it into `dist`) and
 * is exposed here typed as {@link CatalogEntry}[] so the controller and the
 * catalog source share one source of truth.
 *
 * Entries marked `bundled: true` have an offline PGN under
 * `sources/fixtures/bundled-pgns.ts`, keyed by the entry `id`; the rest point at
 * remote PGN URLs.
 *
 * The static `import … from './catalog.json'` resolves to the array under both the
 * app's CommonJS build (`esModuleInterop` default-imports `module.exports`) and
 * ts-jest. (The module is named `catalog.manifest` rather than `catalog` so jest's
 * `json`-before-`ts` extension resolution can't pick the JSON for `./catalog`.)
 */
export const CATALOG: readonly CatalogEntry[] = catalogManifest as CatalogEntry[];

/** Look up a catalog entry by id, or `undefined` if it is not in the manifest. */
export function findCatalogEntry(id: string): CatalogEntry | undefined {
  return CATALOG.find((entry) => entry.id === id);
}
