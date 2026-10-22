import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { awsCtx } from "../aws/clients.js";
import { coreStackStatus, ensureCoreStack } from "../aws/cfn.js";
import { detectService } from "../detect/index.js";
import { readRailwayConfig } from "../railway/parse.js";
import { readVars, writeVars } from "../aws/secrets.js";
import { estimate, fixedMonthly, money, P } from "../cost.js";
import { buildConfig, writeCi } from "./init.js";
import { loadCtx } from "../context.js";
import { up } from "../deploy.js";
import { addPostgres } from "./add.js";
import { writeIsoConfig, UserError, names } from "../config.js";
import { ui, flags } from "../ui.js";
import type { DetectResult, IsoConfig } from "../types.js";

export function migrateCommand(): Command {
  return new Command("migrate")
    .description("Railway project → live on your AWS: detect, cost, secrets, database, deploy, cutover checklist")
    .option("--project <name>").option("--region <region>").option("--profile <profile>")
    .option("--db <kind>", "aurora | external | none (skips the prompt)")
    .option("--database-url <url>", "external DATABASE_URL (implies --db external)")
    .option("--ci", "also write the GitHub Actions workflow")
    .option("--skip-secrets", "do not prompt for secret values")
    .option("--dry-run", "detect + plan only; touch nothing")
    .action(async (o) => {
      const root = process.cwd();
      // 1. detection, before any AWS call
      const cfg = await buildConfig(root, o);
      const railway = readRailwayConfig(root);
      const results: DetectResult[] = Object.entries(cfg.services).map(([name, s]) => detectService(name, path.resolve(root, s.path)));
      const d0 = results[0];
      ui.info(`Found ${railway.source === "none" ? "no railway config (defaults)" : railway.source} · ${results.length} service${results.length > 1 ? "s" : ""} (${results.map((r) => r.service).join(", ")}) · ${d0.framework}${d0.nodeVersion ? ` · Node ${d0.nodeVersion}` : ""}${d0.databaseReferenced ? " · Postgres referenced via DATABASE_URL" : ""}`);
      ui.info("");
      printVerdicts(results);
      const deployable = results.filter((r) => r.verdict === "serverless");
      if (!deployable.length) throw new UserError("No service can run on serverless. Nothing was created in AWS.", "See the reasons above; `iso frameworks` lists what is supported.");
      for (const r of results.filter((x) => x.verdict !== "serverless")) delete cfg.services[r.service];

      // 2. cost estimate
      const dbChoice: IsoConfig["database"] = o.databaseUrl ? { kind: "external" } : o.db ? { kind: o.db } : (cfg.database ?? { kind: "none" });
      cfg.database = dbChoice;
      ui.info("");
      printCost(cfg);
      if (o.dryRun) { if (flags.json) ui.json({ cfg, results }); return; }

      // 3. AWS connect
      ui.info("");
      let aws;
      try { aws = await awsCtx(cfg.region, cfg.profile); }
      catch { throw new UserError("No AWS credentials.", "Run `iso aws connect` first, then `iso migrate` again."); }
      ui.ok(`AWS ${aws.accountId} · ${aws.region}`);
      const core = await coreStackStatus(aws);
      if (!core || !/COMPLETE$/.test(core.status)) {
        ui.info("iso-core stack (versioned S3 bucket + Lambda read policy) · fixed cost $0/month");
        if (!(await ui.confirm("Create it?"))) return;
        await ensureCoreStack(aws);
      }
      writeIsoConfig(root, cfg);
      ui.ok("wrote iso.json");

      // 4. secrets: names from railway.json + .env.example + source; values typed here, straight to Secrets Manager
      const existing = (await readVars(aws, cfg.project, cfg.environment)) ?? {};
      const namesFound = [...new Set(deployable.flatMap((r) => r.envNames))].filter((n) => n !== "DATABASE_URL");
      if (namesFound.length && !o.skipSecrets) {
        ui.info("");
        ui.info(`Variables found (names only; nothing is read from Railway — its tokens are revoked and old values should be rotated):`);
        for (const n of namesFound) ui.info(`  ${n}${existing[n] !== undefined ? ui.dim("  (already set)") : ""}`);
        if (process.stdin.isTTY && !flags.yes) {
          for (const n of namesFound) {
            if (existing[n] !== undefined && !(await ui.confirm(`${n} is set; replace it?`, false))) continue;
            const v = await ui.secret(`Enter new value for ${n} (rotated? leave empty to skip)`);
            if (v) existing[n] = v;
          }
        } else ui.warn("non-interactive: set values with `iso variables set KEY=value`");
      }

      // 5. database
      if (d0.databaseReferenced || dbChoice.kind !== "none") {
        ui.info("");
        const a = P.aurora;
        const kind = o.db ?? (o.databaseUrl ? "external" : await ui.choose("Database", [
          { name: `Aurora Serverless Postgres ($0 compute idle, ~$${(a.minAcu * a.perAcuHour).toFixed(2)}/hr while awake, +$${a.publicIpv4PerMonth}/mo public IPv4, ~${a.resumeSeconds}s resume)`, value: "aurora" as const },
          { name: "Paste an existing DATABASE_URL ($0; Neon, Supabase, RDS…)", value: "external" as const },
          { name: "Keep my current database for now ($0; set DATABASE_URL later)", value: "none" as const },
        ], "external"));
        cfg.database = { kind, ...(kind === "aurora" ? { network: "public" as const, maxCapacity: 2 } : {}) };
        writeIsoConfig(root, cfg);
        if (kind === "external") {
          const url = o.databaseUrl ?? existing.DATABASE_URL ?? (await ui.secret("DATABASE_URL"));
          if (url) existing.DATABASE_URL = url;
        } else if (kind === "aurora") {
          await writeVars(aws, cfg.project, cfg.environment, existing);
          const c = await loadCtx({});
          const url = await addPostgres(c, { maxCapacity: 2, yes: true });
          existing.DATABASE_URL = url;
          if (process.stdin.isTTY && !flags.yes && (await ui.confirm("Copy data from your old database now (pg_dump | pg_restore, runs on this machine, old URL never stored)?", false))) {
            const old = await ui.secret("Old DATABASE_URL");
            if (old) dumpRestore(old, url);
          }
        }
      }
      await writeVars(aws, cfg.project, cfg.environment, existing);
      ui.ok(`${Object.keys(existing).length} variable(s) in ${names.secret(cfg.project, cfg.environment)}`);

      // 6. deploy each service
      const urls: Record<string, string> = {};
      for (const r of deployable) {
        ui.info("");
        const c = await loadCtx({ service: r.service });
        const res = await up(c, { skipDetect: true });
        urls[r.service] = res.url;
      }
      if (o.ci) await writeCi(root, cfg);

      // 7. cutover checklist
      ui.info("");
      ui.info(ui.bold("Cutover checklist"));
      ui.info(`  1. Point your DNS/custom domain at the new URL${Object.keys(urls).length > 1 ? "s" : ""}: iso domain add <host>`);
      ui.info("  2. Update webhook URLs (Stripe, GitHub, …) to " + Object.values(urls).join(", "));
      ui.info("  3. Rotate any secret you did not enter above: iso variables set KEY");
      ui.info("  4. Watch it: iso logs --tail · iso status");
      ui.info("  5. Delete the Railway service once traffic has moved.");
      if (flags.json) ui.json({ urls, cfg });
    });
}

export function printVerdicts(results: DetectResult[]) {
  for (const r of results) {
    if (r.verdict === "serverless") ui.ok(`${r.service} → serverless ✓ ${ui.dim(`(${r.framework}${r.entryFile ? ", entry " + r.entryFile : ""})`)}`);
    else {
      const b = r.findings.filter((f) => f.severity === "block");
      ui.err(`${r.service} → unsupported: ${b.map((f) => `${f.message}${f.file ? ` (${f.file}${f.line ? ":" + f.line : ""})` : ""}`).join("; ")}. Skipping.`);
      for (const f of b) if (f.fix) ui.info(ui.dim(`    → ${f.fix}`));
    }
    for (const f of r.findings.filter((f) => f.severity === "warn")) ui.warn(`  ${f.message}${f.file ? ui.dim(` (${f.file}${f.line ? ":" + f.line : ""})`) : ""}${f.fix ? ui.dim(" → " + f.fix) : ""}`);
    const ig = r.findings.filter((f) => f.severity === "ok" && f.code === "ignored");
    if (ig.length) ui.info(ui.dim(`  no longer needed: ${ig.map((f) => f.message.split(":")[0]).join(", ")}`));
  }
}

export function printCost(cfg: IsoConfig) {
  const lines = estimate(cfg);
  ui.info(ui.bold("Cost estimate") + ui.dim(`  (${P.measured ? "measured" : "list prices, approximate"}; printed before anything is created)`));
  ui.table([["  item", "idle /mo", "~100k req /mo", ""], ...lines.map((l) => [`  ${l.item}`, money(l.idle), money(l.small), ui.dim(l.note)])]);
  ui.info(`  Fixed monthly cost: ${ui.bold(money(fixedMonthly(lines)))}`);
}

export function dumpRestore(oldUrl: string, newUrl: string) {
  ui.step("pg_dump | pg_restore (this machine)");
  const r = spawnSync(`pg_dump --no-owner --no-acl -Fc "$OLD_URL" | pg_restore --no-owner --no-acl -d "$NEW_URL"`, { shell: true, stdio: "inherit", env: { ...process.env, OLD_URL: oldUrl, NEW_URL: newUrl } });
  if (r.status !== 0) ui.warn("pg_dump/pg_restore exited non-zero; check that both tools are installed (brew install libpq) and the old URL is reachable");
  else ui.ok("data copied");
}
export { fs };
