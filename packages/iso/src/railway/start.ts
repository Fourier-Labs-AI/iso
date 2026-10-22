import fs from "node:fs";
import path from "node:path";

export interface StartResolution {
  command: string;
  entryFile?: string;
  via: "startCommand" | "package.json:start" | "package.json:main" | "default";
  reason?: string;
}

/**
 * Resolve the file the function should import. Railway's `startCommand` wins,
 * then `npm start`, then package.json `main`, then index.js.
 */
export function resolveStart(dir: string, startCommand?: string): StartResolution {
  const pkg = readPkg(dir);
  if (startCommand) {
    const entry = entryFromCommand(dir, startCommand, pkg);
    if (entry) return { command: startCommand, entryFile: entry.file, via: "startCommand", reason: entry.reason };
    return { command: startCommand, via: "startCommand", reason: `could not find an entry file in "${startCommand}"` };
  }
  const start = pkg?.scripts?.start;
  if (start) {
    const entry = entryFromCommand(dir, start, pkg);
    if (entry) return { command: start, entryFile: entry.file, via: "package.json:start", reason: entry.reason };
    return { command: start, via: "package.json:start", reason: `could not find an entry file in "${start}"` };
  }
  if (pkg?.main && fs.existsSync(path.join(dir, pkg.main))) return { command: `node ${pkg.main}`, entryFile: pkg.main, via: "package.json:main" };
  for (const c of ["index.js", "index.mjs", "server.js", "app.js", "src/index.js", "src/server.js", "dist/index.js", "dist/server.js"]) {
    if (fs.existsSync(path.join(dir, c))) return { command: `node ${c}`, entryFile: c, via: "default" };
  }
  return { command: "node index.js", via: "default", reason: "no entry file found" };
}

function readPkg(dir: string): any | null {
  const p = path.join(dir, "package.json");
  if (!fs.existsSync(p)) return null;
  try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; }
}

function entryFromCommand(dir: string, cmd: string, pkg: any, depth = 0): { file: string; reason?: string } | null {
  if (depth > 4) return null;
  const tokens = cmd.trim().split(/\s+/);
  // npm start / npm run x / yarn x / pnpm x
  if (/^(npm|yarn|pnpm|bun)$/.test(tokens[0])) {
    let script = tokens[1];
    if (script === "run" || script === "run-script") script = tokens[2];
    if (script === "start" || tokens[1] === "start") script = "start";
    const s = pkg?.scripts?.[script];
    if (s) return entryFromCommand(dir, s, pkg, depth + 1);
    return null;
  }
  // node [flags] file  |  tsx file  |  ts-node file
  if (/^(node|tsx|ts-node|bun)$/.test(tokens[0]) || /\/node$/.test(tokens[0])) {
    const file = tokens.slice(1).find((t) => !t.startsWith("-") && /\.(m?js|cjs|ts|mts)$/.test(t));
    if (file) {
      const exists = fs.existsSync(path.join(dir, file));
      const isTs = /\.(ts|mts)$/.test(file);
      return { file, reason: !exists ? `${file} does not exist yet (built by buildCommand?)` : isTs ? "TypeScript entry: make sure buildCommand compiles it, or use tsx" : undefined };
    }
    return null;
  }
  // "next start" and friends
  if (tokens[0] === "next") return { file: ".next/standalone/server.js", reason: "Next.js: requires output: 'standalone'" };
  // bare file
  if (/\.(m?js|cjs)$/.test(tokens[0])) return { file: tokens[0] };
  return null;
}
