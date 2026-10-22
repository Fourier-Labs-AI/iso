import fs from "node:fs";
import path from "node:path";
import { parse as parseToml } from "smol-toml";
import type { RailwayConfig } from "../types.js";

const IGNORED_DEPLOY = ["numReplicas", "sleepApplication", "restartPolicyType", "restartPolicyMaxRetries", "region", "multiRegionConfig", "overlapSeconds", "drainingSeconds"];

export function readRailwayConfig(dir: string): RailwayConfig {
  const json = path.join(dir, "railway.json");
  const toml = path.join(dir, "railway.toml");
  if (fs.existsSync(json)) return normalize(JSON.parse(fs.readFileSync(json, "utf8")), "railway.json");
  if (fs.existsSync(toml)) return normalize(parseToml(fs.readFileSync(toml, "utf8")), "railway.toml");
  return normalize({}, "none");
}

export function normalize(raw: any, source: RailwayConfig["source"]): RailwayConfig {
  const build = raw.build ?? {};
  const deploy = raw.deploy ?? {};
  const ignored: string[] = [];
  for (const k of IGNORED_DEPLOY) if (deploy[k] !== undefined) ignored.push(`deploy.${k}`);
  if (raw.environments) ignored.push("environments (per-env overrides: set them with `iso variables set` per environment)");
  return {
    source,
    build: {
      builder: build.builder,
      buildCommand: build.buildCommand,
      watchPatterns: build.watchPatterns,
    },
    deploy: {
      startCommand: deploy.startCommand,
      healthcheckPath: deploy.healthcheckPath,
      healthcheckTimeout: deploy.healthcheckTimeout,
      preDeployCommand: deploy.preDeployCommand,
      cronSchedule: deploy.cronSchedule,
      numReplicas: deploy.numReplicas,
      sleepApplication: deploy.sleepApplication,
      restartPolicyType: deploy.restartPolicyType,
      restartPolicyMaxRetries: deploy.restartPolicyMaxRetries,
    },
    ignored,
  };
}
