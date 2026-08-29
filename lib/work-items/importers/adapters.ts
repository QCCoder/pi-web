import { ChandaoImporter } from "./chandao-importer.ts";
import type { ChandaoConfig } from "./types.ts";

/** Importer adapter registry — the SPI's plug point (design §5: "禅道只是一
 *  个 Importer，可换"). Swapping Chandao for Jira means implementing the
 *  `Importer` SPI and adding ONE line here; neither the runner, the scheduler,
 *  the daemon, nor the web routes change. Registration is static composition:
 *  adapters live in this package and fail at startup/tests, never at 3am. */
export const IMPORTER_ADAPTERS: Record<string, (config: ChandaoConfig) => ChandaoImporter> = {
  chandao: (config) => new ChandaoImporter(config),
};

/** Build the importer instance for a stored config's single configured
 *  source. Throws on an unknown source id (a config written by a future
 *  adapter that this build doesn't know). */
export function buildImporterForConfig(source: string, config: ChandaoConfig): ChandaoImporter {
  const factory = IMPORTER_ADAPTERS[source];
  if (!factory) throw new Error(`Unknown importer source: ${source}`);
  return factory(config);
}
