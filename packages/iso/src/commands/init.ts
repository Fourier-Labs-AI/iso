import fs from "node:fs";
import path from "node:path";
import { Command } from "commander";
import { DEFAULT_REGION, ISO_FILE, defaultServiceName, readIsoConfig, writeIsoConfig, slug } from "../config.js";
import { readRailwayConfig } from "../railway/parse.js";
import { templatePath } from "../paths.js";
import { ui, flags } from "../ui.js";
import type { IsoConfig } from "../types.js";
import { awsCtx } from "../aws/clients.js";

export function initCommand(): Command {
  return new Command("init")
    .description("Write iso.json (creates nothing in AWS)")
    .option("--project <name>")
    .option("--region <region>")
    .option("--profile <profile>")
    .option("--ci", "also write .github/workflows/iso.yml (GitHub OIDC)")
    .action(async (o) => {
      const root = process.cwd();
      const cfg = await buildConfig(root, o);
      writeIsoConfig(root, cfg);
      ui.ok(`wrote ${ISO_FILE} (project ${cfg.project}, region ${cfg.region}, env ${cfg.environment})`);
      if (o.ci) await writeCi(root, cfg);
      if (flags.json) ui.json(cfg);
    });
}

export async function buildConfig(root: string, o: { project?: string; region?: string; profile?: string }): Promise<IsoConfig> {
  const existing = readIsoConfig(root);
  const railway = readRailwayConfig(root);
  if (railway.source !== "none") ui.ok(`found ${railway.source}; it stays as-is`);
  const name = o.project ?? existing?.project ?? (process.stdin.isTTY && !flags.yes ? slug(await ui.ask("Project name", defaultServiceName(root))) : defaultServiceName(root));
  return {
    project: name,
    region: o.region ?? existing?.region ?? process.env.AWS_REGION ?? DEFAULT_REGION,
    ...(o.profile ?? existing?.profile ? { profile: o.profile ?? existing?.profile } : {}),
    environment: existing?.environment ?? "production",
    services: existing?.services ?? { [defaultServiceName(root)]: { path: ".", runtime: "serverless", timeoutSeconds: 60, maxConcurrencyPerEnvironment: 128 } },
    database: existing?.database ?? { kind: "none" },
    ...(existing?.domains ? { domains: existing.domains } : {}),
  };
}

export async function writeCi(root: string, cfg: IsoConfig) {
  let account = "<account-id>";
  try { account = (await awsCtx(cfg.region, cfg.profile)).accountId; } catch {}
  const dir = path.join(root, ".github", "workflows");
  fs.mkdirSync(dir, { recursive: true });
  const body = fs.readFileSync(templatePath("iso.yml"), "utf8").replace("__ACCOUNT__", account).replace("__REGION__", cfg.region);
  fs.writeFileSync(path.join(dir, "iso.yml"), body);
  ui.ok("wrote .github/workflows/iso.yml · run `iso aws connect --ci owner/repo` to create the OIDC role");
}
