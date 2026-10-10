/** Writes the diet library seed migration from the catalog. Run from the api-server package: pnpm exec tsx ../../lib/diet-programs/scripts/render-seed.ts */
import { writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { DIET_LIBRARY_SEED_MIGRATION, renderDietLibrarySeedMigration } from "../src/seed-sql";

const here = path.dirname(fileURLToPath(import.meta.url));
const target = path.resolve(here, "../../../supabase/migrations", DIET_LIBRARY_SEED_MIGRATION);
writeFileSync(target, renderDietLibrarySeedMigration());
console.log(`wrote ${target}`);
