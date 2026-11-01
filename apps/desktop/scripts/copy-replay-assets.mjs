/**
 * Puts the replaywebpage viewer bundles next to the committed index.html that pond://replay serves.
 */
import { copyFileSync, existsSync, mkdirSync } from "node:fs";
import { createRequire } from "node:module";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const require = createRequire(import.meta.url);

const pkgDir = dirname(require.resolve("replaywebpage/index.html"));
const outDir = join(here, "..", "resources", "replay");
mkdirSync(outDir, { recursive: true });

for (const name of ["ui.js", "sw.js"]) {
  const src = join(pkgDir, name);
  if (!existsSync(src)) {
    console.error(`[pond] replaywebpage asset missing: ${src}`);
    process.exit(1);
  }
  copyFileSync(src, join(outDir, name));
}
console.log("[pond] replay viewer assets copied");
