import fs from "node:fs";
import path from "node:path";

/**
 * The API server reads demo content (docs archive, curated catalogs) straight
 * from the repo at runtime, so both dev and the bundled build resolve paths
 * from the workspace root.
 */
export function findRepoRoot(): string {
  let dir = process.cwd();
  for (;;) {
    if (fs.existsSync(path.join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) {
      throw new Error("Could not locate repo root (pnpm-workspace.yaml not found)");
    }
    dir = parent;
  }
}

export const repoRoot = findRepoRoot();
