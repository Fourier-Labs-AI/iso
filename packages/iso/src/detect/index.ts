import fs from "node:fs";
import path from "node:path";
import type { DetectResult, Finding } from "../types.js";
import { readRailwayConfig } from "../railway/parse.js";
import { resolveStart } from "../railway/start.js";
import { discoverEnvNames, walk } from "../railway/envnames.js";

export const SUPPORTED_FRAMEWORKS: Record<string, string> = {
  express: "Express",
  hono: "Hono",
  fastify: "Fastify",
  "@nestjs/core": "NestJS",
  koa: "Koa",
  next: "Next.js (standalone output)",
};
export const UNSUPPORTED_V1 = [
  "Python, Go, Rust, Ruby, PHP services (Web Functions are Node-only at launch)",
  "Background workers, queue consumers, long-running processes",
  "Cron jobs (deploy.cronSchedule) — week 1 via EventBridge Scheduler",
  "Websockets (Lambda strips upgrade headers)",
  "Volumes, Redis/MySQL/Mongo templates, private networking between services",
  "Dockerfile builds (Web Functions take zips)",
];

export function detectService(service: string, dir: string): DetectResult {
  const findings: Finding[] = [];
  const pkgPath = path.join(dir, "package.json");
  const pkg = fs.existsSync(pkgPath) ? safeJson(pkgPath) : null;
  const railway = readRailwayConfig(dir);

  // Language
  if (!pkg) {
    const lang = detectNonNode(dir);
    findings.push({ severity: "block", code: "not-node", message: lang ? `${lang} service: Web Functions are Node.js-only at launch` : "no package.json: only Node.js services are supported in v1", fix: "Keep this service where it is; Node services can still migrate." });
    return finish(service, dir, "unknown", findings, undefined, undefined, undefined, { names: [] });
  }
  if (railway.build.builder === "DOCKERFILE" && !pkg.scripts?.start && !railway.deploy.startCommand) {
    findings.push({ severity: "block", code: "dockerfile-only", message: "build.builder is DOCKERFILE and there is no start script: Web Functions take zips, not images", file: railway.source, fix: "Add a `start` script or deploy.startCommand so we can zip the app." });
  } else if (railway.build.builder === "DOCKERFILE") {
    findings.push({ severity: "warn", code: "dockerfile-ignored", message: "build.builder is DOCKERFILE; the Dockerfile is ignored and the app is zipped from the start command", file: railway.source });
  }

  // Node version
  const nodeVersion = readNodeVersion(dir, pkg);
  if (nodeVersion) {
    const major = parseInt(nodeVersion.replace(/[^\d.]/g, "").split(".")[0] || "0", 10);
    if (major && major < 20) findings.push({ severity: "warn", code: "node-old", message: `Node ${nodeVersion} requested; the function runs Node 24`, fix: "Test locally on Node 24 (`nvm use 24`)." });
  }

  // Framework
  const deps = { ...(pkg.dependencies ?? {}), ...(pkg.devDependencies ?? {}) };
  let framework = "plain http";
  for (const [dep, label] of Object.entries(SUPPORTED_FRAMEWORKS)) if (deps[dep]) { framework = label; break; }
  if (deps.next) {
    const nextCfg = ["next.config.js", "next.config.mjs", "next.config.ts"].map((f) => path.join(dir, f)).find((f) => fs.existsSync(f));
    const src = nextCfg ? fs.readFileSync(nextCfg, "utf8") : "";
    if (!/output\s*:\s*["']standalone["']/.test(src)) findings.push({ severity: "block", code: "next-not-standalone", message: "Next.js needs output: 'standalone' in next.config", file: nextCfg ? path.relative(dir, nextCfg) : "next.config.js", fix: "Add `output: 'standalone'` to next.config and rebuild." });
    else findings.push({ severity: "warn", code: "next-experimental", message: "Next.js support is experimental: ISR, image optimisation and middleware are untested on Web Functions" });
  }
  if (deps.ws || deps["socket.io"]) findings.push({ severity: "block", code: "websockets", message: `${deps.ws ? "ws" : "socket.io"} in dependencies: Web Functions do not support WebSocket upgrades`, file: "package.json", fix: "Use server-sent events, or keep this service elsewhere." });
  if (deps.bullmq || deps.bull || deps["bee-queue"]) findings.push({ severity: "warn", code: "queue-lib", message: `${deps.bullmq ? "bullmq" : deps.bull ? "bull" : "bee-queue"} in dependencies: queue consumers will not run on a request-driven function`, fix: "Move workers elsewhere; producers are fine." });

  // Native deps
  const native = ["sharp", "bcrypt", "better-sqlite3", "canvas", "argon2", "@prisma/client", "prisma", "node-gyp", "sqlite3", "re2"].filter((d) => deps[d]);
  if (native.length) findings.push({ severity: "warn", code: "native-deps", message: `native dependencies (${native.join(", ")}) must be built for arm64 Linux`, fix: "Use `iso up --build-in-docker` if the deploy fails at runtime." });

  // Entry + port scan
  const start = resolveStart(dir, railway.deploy.startCommand);
  let entryFile = start.entryFile;
  if (!entryFile) findings.push({ severity: "block", code: "no-entry", message: `cannot find the entry file (${start.reason ?? start.command})`, file: "package.json", fix: 'Add a `start` script like "node server.js".' });
  else if (start.reason && !/does not exist yet/.test(start.reason) && !/TypeScript/.test(start.reason)) findings.push({ severity: "warn", code: "entry-note", message: start.reason });
  else if (start.reason) findings.push({ severity: "warn", code: "entry-built", message: `${entryFile}: ${start.reason}` });

  const entryAbs = entryFile ? path.join(dir, entryFile) : undefined;
  if (entryAbs && fs.existsSync(entryAbs)) findings.push(...scanEntry(dir, entryAbs));
  else if (entryAbs && !deps.next) {
    const srcFiles = walk(dir, 60);
    const listens = srcFiles.some((f) => /\.listen\s*\(/.test(fs.readFileSync(f, "utf8")));
    if (!listens && srcFiles.length) findings.push({ severity: "block", code: "no-listen", message: "no `.listen(` found in source: this looks like a worker, not an HTTP server", fix: "Web Functions only serve HTTP. Keep workers elsewhere." });
  }

  // cron
  if (railway.deploy.cronSchedule) findings.push({ severity: "block", code: "cron", message: `deploy.cronSchedule (${railway.deploy.cronSchedule}) is not supported in v1`, file: railway.source, fix: "Week 1: EventBridge Scheduler → HTTP route. Remove the schedule to deploy as a web service." });
  for (const ig of railway.ignored) findings.push({ severity: "ok", code: "ignored", message: `${ig}: no longer needed on serverless` });

  const env = discoverEnvNames(dir, entryFile);
  return finish(service, dir, framework, findings, nodeVersion, entryFile, start.command, env);
}

function finish(service: string, dir: string, framework: string, findings: Finding[], nodeVersion?: string, entryFile?: string, startCommand?: string, env?: { names: string[] }): DetectResult {
  const envNames = env?.names ?? [];
  return {
    service, dir, framework, nodeVersion, entryFile, startCommand,
    verdict: findings.some((f) => f.severity === "block") ? "unsupported" : "serverless",
    findings, envNames,
    databaseReferenced: envNames.includes("DATABASE_URL") || envNames.includes("POSTGRES_URL") || envNames.includes("PG_CONNECTION_STRING"),
  };
}

export function scanEntry(dir: string, entryAbs: string): Finding[] {
  const out: Finding[] = [];
  const src = fs.readFileSync(entryAbs, "utf8");
  const rel = path.relative(dir, entryAbs);
  const lines = src.split(/\r?\n/);
  const lineOf = (idx: number) => src.slice(0, idx).split("\n").length;
  const listen = src.match(/\.listen\s*\(/);
  if (!listen) {
    const loops = src.match(/while\s*\(\s*true\s*\)|setInterval\s*\(/);
    if (loops) out.push({ severity: "block", code: "worker", message: `long-running process (no .listen, has ${loops[0].trim()})`, file: rel, line: lineOf(loops.index!), fix: "Web Functions only serve HTTP. Keep workers elsewhere." });
    else if (!/require\(|import /.test(src)) out.push({ severity: "block", code: "no-listen", message: "no `.listen(` in entry file", file: rel });
    else out.push({ severity: "warn", code: "listen-indirect", message: "no `.listen(` in the entry file; assuming it is called from an imported module", file: rel });
  } else {
    const m = src.match(/\.listen\s*\(\s*(\d{2,5})\b/);
    if (m) out.push({ severity: "warn", code: "fixed-port", message: `listens on a fixed port ${m[1]}; the generated entry sets PORT, but your code ignores it`, file: rel, line: lineOf(m.index!), fix: `Change to app.listen(process.env.PORT || ${m[1]}).` });
    const host = src.match(/\.listen\s*\([^)]*["'](127\.0\.0\.1|localhost)["']/);
    if (host) out.push({ severity: "block", code: "loopback-bind", message: `binds to ${host[1]}; the runtime connects on 0.0.0.0`, file: rel, line: lineOf(host.index!), fix: "Remove the host argument or bind to 0.0.0.0." });
  }
  if (/\.on\s*\(\s*["']upgrade["']/.test(src) || /new\s+WebSocket(Server)?\s*\(/.test(src)) out.push({ severity: "block", code: "websockets", message: "handles HTTP upgrade / WebSockets", file: rel, line: lineOf(src.search(/upgrade|WebSocket/)), fix: "Web Functions remove upgrade headers." });
  const fsw = src.match(/fs\.(write|append|mkdir|createWriteStream)[A-Za-z]*\s*\(\s*["'](?!\/tmp)([^"']+)["']/);
  if (fsw) out.push({ severity: "warn", code: "fs-write", message: `writes to "${fsw[2]}": only /tmp is writable at runtime`, file: rel, line: lineOf(fsw.index!) });
  void lines;
  return out;
}

function readNodeVersion(dir: string, pkg: any): string | undefined {
  if (pkg?.engines?.node) return String(pkg.engines.node);
  for (const f of [".nvmrc", ".node-version"]) {
    const p = path.join(dir, f);
    if (fs.existsSync(p)) return fs.readFileSync(p, "utf8").trim();
  }
  return undefined;
}

function detectNonNode(dir: string): string | undefined {
  const checks: [string, string][] = [["requirements.txt", "Python"], ["pyproject.toml", "Python"], ["go.mod", "Go"], ["Cargo.toml", "Rust"], ["Gemfile", "Ruby"], ["composer.json", "PHP"], ["pom.xml", "Java"], ["build.gradle", "Java"]];
  for (const [f, lang] of checks) if (fs.existsSync(path.join(dir, f))) return lang;
  return undefined;
}

function safeJson(p: string): any { try { return JSON.parse(fs.readFileSync(p, "utf8")); } catch { return null; } }
