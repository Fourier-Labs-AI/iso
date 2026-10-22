import fs from "node:fs";
import path from "node:path";

/** Secret NAMES only: from .env.example, .env.sample, .env.template, and process.env.X reads in source. Never from .env. */
export function discoverEnvNames(dir: string, entryFile?: string): { names: string[]; sources: Record<string, string> } {
  const sources: Record<string, string> = {};
  const add = (n: string, src: string) => { if (!/^[A-Z][A-Z0-9_]*$/.test(n)) return; if (!sources[n]) sources[n] = src; };
  for (const f of [".env.example", ".env.sample", ".env.template", ".env.dist"]) {
    const p = path.join(dir, f);
    if (!fs.existsSync(p)) continue;
    for (const line of fs.readFileSync(p, "utf8").split(/\r?\n/)) {
      const m = line.match(/^\s*(?:export\s+)?([A-Z][A-Z0-9_]*)\s*=/);
      if (m) add(m[1], f);
    }
  }
  // process.env.X in source files (shallow scan, skips node_modules)
  const files = walk(dir, 400);
  for (const f of files) {
    let src: string;
    try { src = fs.readFileSync(f, "utf8"); } catch { continue; }
    for (const m of src.matchAll(/process\.env(?:\.([A-Z][A-Z0-9_]*)|\[["']([A-Z][A-Z0-9_]*)["']\])/g)) add(m[1] ?? m[2], path.relative(dir, f));
  }
  const skip = new Set(["PORT", "NODE_ENV", "HOME", "PATH", "PWD", "CI", "TZ"]);
  const names = Object.keys(sources).filter((n) => !skip.has(n) && !n.startsWith("AWS_") && !n.startsWith("RAILWAY_")).sort();
  return { names, sources };
}

export function walk(dir: string, limit: number): string[] {
  const out: string[] = [];
  const stack = [dir];
  while (stack.length && out.length < limit) {
    const d = stack.pop()!;
    let ents: fs.Dirent[];
    try { ents = fs.readdirSync(d, { withFileTypes: true }); } catch { continue; }
    for (const e of ents) {
      if (e.name === "node_modules" || e.name === ".git" || e.name === "dist" || e.name === ".next" || e.name === "coverage" || e.name === ".iso-build") continue;
      const p = path.join(d, e.name);
      if (e.isDirectory()) stack.push(p);
      else if (/\.(m?js|cjs|ts|mts|tsx|jsx)$/.test(e.name) && !/\.(test|spec)\./.test(e.name)) out.push(p);
    }
  }
  return out;
}
