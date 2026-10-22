import path from "node:path";
import { awsCtx, type AwsCtx } from "./aws/clients.js";
import { findProjectRoot, requireIsoConfig, UserError } from "./config.js";
import type { IsoConfig } from "./types.js";

export interface Ctx {
  root: string;
  cfg: IsoConfig;
  env: string;
  service: string;
  serviceDir: string;
  aws: AwsCtx;
}

export interface GlobalOpts { env?: string; service?: string; region?: string; profile?: string }

/** Resolve project + env + service from iso.json and flags, and connect to AWS. */
export async function loadCtx(opts: GlobalOpts = {}): Promise<Ctx> {
  const { root, cfg } = requireIsoConfig(findProjectRoot());
  const env = opts.env ?? process.env.ISO_ENV ?? cfg.environment;
  const serviceNames = Object.keys(cfg.services);
  let service = opts.service ?? process.env.ISO_SERVICE;
  if (!service) {
    if (serviceNames.length === 1) service = serviceNames[0];
    else {
      const cwdRel = path.relative(root, process.cwd());
      service = serviceNames.find((s) => path.normalize(cfg.services[s].path) === path.normalize(cwdRel || ".")) ?? serviceNames[0];
    }
  }
  if (!cfg.services[service]) throw new UserError(`service "${service}" is not in iso.json (have: ${serviceNames.join(", ")})`, "Run `iso service <name>`.");
  const aws = await awsCtx(opts.region ?? cfg.region, opts.profile ?? cfg.profile);
  return { root, cfg, env, service, serviceDir: path.resolve(root, cfg.services[service].path), aws };
}

export function fnName(c: Ctx): string { return `${c.cfg.project}-${c.env}-${c.service}`; }
