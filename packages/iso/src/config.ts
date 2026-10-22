import fs from "node:fs";
import path from "node:path";
import type { IsoConfig } from "./types.js";

export const ISO_FILE = "iso.json";
export const DEFAULT_REGION = "us-east-1";
export const SUPPORTED_REGIONS = ["us-east-1", "us-east-2", "us-west-2", "ap-northeast-1", "eu-west-1"];
export const RUNTIME = "nodejs24.x";
export const CORE_STACK = "iso-core";
export const LOG_RETENTION_DAYS = 14;

export function findProjectRoot(start = process.cwd()): string {
  let dir = path.resolve(start);
  for (;;) {
    if (fs.existsSync(path.join(dir, ISO_FILE))) return dir;
    const parent = path.dirname(dir);
    if (parent === dir) return path.resolve(start);
    dir = parent;
  }
}

export function readIsoConfig(root = findProjectRoot()): IsoConfig | null {
  const p = path.join(root, ISO_FILE);
  if (!fs.existsSync(p)) return null;
  const cfg = JSON.parse(fs.readFileSync(p, "utf8")) as IsoConfig;
  if (!cfg.services || Object.keys(cfg.services).length === 0) cfg.services = { [defaultServiceName(root)]: { path: "." } };
  if (!cfg.environment) cfg.environment = "production";
  if (!cfg.region) cfg.region = DEFAULT_REGION;
  return cfg;
}

export function requireIsoConfig(root = findProjectRoot()): { root: string; cfg: IsoConfig } {
  const cfg = readIsoConfig(root);
  if (!cfg) {
    throw new UserError(`No ${ISO_FILE} found.`, "Run `iso init` (or `iso migrate` to do everything at once).");
  }
  return { root, cfg };
}

export function writeIsoConfig(root: string, cfg: IsoConfig): void {
  fs.writeFileSync(path.join(root, ISO_FILE), JSON.stringify(cfg, null, 2) + "\n");
}

export function defaultServiceName(root: string): string {
  const pkgPath = path.join(root, "package.json");
  if (fs.existsSync(pkgPath)) {
    try {
      const name = JSON.parse(fs.readFileSync(pkgPath, "utf8")).name as string | undefined;
      if (name) return slug(name.replace(/^@[^/]+\//, ""));
    } catch {}
  }
  return slug(path.basename(root));
}

export function slug(s: string): string {
  return s.toLowerCase().replace(/[^a-z0-9-]+/g, "-").replace(/^-+|-+$/g, "").slice(0, 40) || "app";
}

/** Deterministic names: no state file, AWS is the state. */
export const names = {
  fn: (project: string, env: string, service: string) => `${project}-${env}-${service}`,
  secret: (project: string, env: string) => `iso/${project}/${env}`,
  role: (project: string) => `iso-${project}-exec`,
  cluster: (project: string) => `iso-${project}`,
  endpoint: () => "default",
  logGroup: (fn: string) => `/aws/lambda/web/${fn}`,
  s3Key: (project: string, env: string, service: string, sha: string) => `${project}/${env}/${service}/${sha}.zip`,
};

export class UserError extends Error {
  constructor(message: string, public next?: string) {
    super(message);
  }
}
