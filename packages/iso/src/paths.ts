import path from "node:path";
import fs from "node:fs";
import { fileURLToPath } from "node:url";

/** Package root works both from dist/iso.mjs (bundled) and src/ (tsx). */
export function packageRoot(): string {
  const here = path.dirname(fileURLToPath(import.meta.url));
  for (const c of [here, path.join(here, ".."), path.join(here, "..", "..")]) {
    if (fs.existsSync(path.join(c, "templates", "iso-entry.mjs"))) return c;
  }
  return path.join(here, "..");
}
export function templatePath(name: string): string { return path.join(packageRoot(), "templates", name); }
export function pluginsPath(...p: string[]): string {
  const inPkg = path.join(packageRoot(), "plugins", ...p);
  if (fs.existsSync(inPkg)) return inPkg;
  return path.join(packageRoot(), "..", "..", "plugins", ...p);
}
