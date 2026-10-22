import { Command } from "commander";
import { loadCtx, type Ctx } from "../context.js";
import { createCluster, databaseUrl, describeCluster, generatePassword } from "../aws/rds.js";
import { readVars, writeVars } from "../aws/secrets.js";
import { writeIsoConfig, UserError } from "../config.js";
import { P } from "../cost.js";
import { ui, flags } from "../ui.js";

export async function addPostgres(c: Ctx, o: { maxCapacity: number; yes?: boolean; private?: boolean }): Promise<string> {
  if (o.private) {
    ui.warn(`--private (VPC + network connector + NAT) costs ~$${P.nat.perMonth}/month fixed and is coming this week. Using the public endpoint (TLS forced) instead.`);
  }
  const a = P.aurora;
  const vars = (await readVars(c.aws, c.cfg.project, c.env)) ?? {};
  let cluster = await describeCluster(c.aws, c.cfg.project);
  let password: string | undefined;
  if (!cluster) {
    ui.info("About to create:");
    ui.table([
      ["  Aurora Serverless v2 PostgreSQL", `iso-${c.cfg.project}`, `min 0 ACU · max ${o.maxCapacity} ACU · auto-pause 5 min`, `$0 idle · ~$${(a.minAcu * a.perAcuHour).toFixed(2)}/hr awake`],
      ["  Public IPv4", "", "public endpoint, rds.force_ssl=1, 32-char password", `$${a.publicIpv4PerMonth}/mo`],
      ["  Storage", "", "", `$${a.perGbStorageMonth}/GB/mo`],
    ]);
    ui.info(`  No VPC changes to the function. First connection after idle takes ~${a.resumeSeconds}s.`);
    if (!o.yes && !(await ui.confirm("Create it?"))) throw new UserError("cancelled");
    password = generatePassword();
    ui.step("creating cluster (this takes 5–10 minutes)");
    cluster = await createCluster(c.aws, c.cfg.project, { maxCapacity: o.maxCapacity, password });
    vars.ISO_DB_MASTER_PASSWORD = password;
    ui.ok(`cluster ${cluster.id} available at ${cluster.endpoint}`);
  } else {
    password = vars.ISO_DB_MASTER_PASSWORD;
    if (!password) throw new UserError(`cluster ${cluster.id} exists but its password is not in this environment's secret`, "Copy ISO_DB_MASTER_PASSWORD from the environment that created it: iso variables set ISO_DB_MASTER_PASSWORD");
    ui.ok(`using existing cluster ${cluster.id}`);
  }
  // one database per environment (created on first connect by the app or via iso connect); user shared in v1
  const dbName = c.env === "production" ? "postgres" : c.env.replace(/-/g, "_");
  const url = databaseUrl(cluster, "iso", password!, dbName);
  if (dbName !== "postgres") await ensureDatabase(url.replace(`/${dbName}?`, "/postgres?"), dbName);
  vars.DATABASE_URL = url;
  await writeVars(c.aws, c.cfg.project, c.env, vars);
  c.cfg.database = { kind: "aurora", network: "public", maxCapacity: o.maxCapacity };
  writeIsoConfig(c.root, c.cfg);
  ui.ok(`DATABASE_URL (sslmode=require) saved to the ${c.env} secret`);
  return url;
}

async function ensureDatabase(adminUrl: string, dbName: string) {
  try {
    const { spawnSync } = await import("node:child_process");
    const r = spawnSync("psql", [adminUrl, "-tAc", `SELECT 1 FROM pg_database WHERE datname='${dbName}'`], { encoding: "utf8" });
    if (r.status === 0 && !r.stdout.trim()) spawnSync("psql", [adminUrl, "-c", `CREATE DATABASE "${dbName}"`], { stdio: "inherit" });
    else if (r.status !== 0) ui.warn(`could not create database ${dbName} (psql missing?); create it with: iso connect -e production → CREATE DATABASE "${dbName}";`);
  } catch { ui.warn(`create database ${dbName} manually (psql not found)`); }
}

export function addCommand(): Command {
  const add = new Command("add").description("Add a database");
  add.command("postgres")
    .description("Aurora Serverless v2 PostgreSQL ($0 idle) + DATABASE_URL in the env secret")
    .option("-e, --env <env>")
    .option("--max-capacity <acu>", "max ACU (cap surprise bills)", "2")
    .option("--private", "VPC + connector + NAT (prints cost; coming this week)")
    .action(async (o) => {
      const c = await loadCtx(o);
      const url = await addPostgres(c, { maxCapacity: parseFloat(o.maxCapacity), private: o.private });
      if (flags.json) ui.json({ databaseUrl: url });
      ui.info(ui.dim("Run `iso up` to deploy with the new DATABASE_URL."));
    });
  return add;
}

export function connectCommand(): Command {
  return new Command("connect").description("Open psql with the environment's DATABASE_URL").option("-e, --env <env>").action(async (o) => {
    const c = await loadCtx(o);
    const vars = (await readVars(c.aws, c.cfg.project, c.env)) ?? {};
    if (!vars.DATABASE_URL) throw new UserError("no DATABASE_URL in this environment", "`iso add postgres` or `iso variables set DATABASE_URL`.");
    const { spawn } = await import("node:child_process");
    const child = spawn("psql", [vars.DATABASE_URL], { stdio: "inherit" });
    child.on("error", () => ui.fail(new UserError("psql not found", "brew install libpq (macOS) or apt install postgresql-client.")));
    child.on("exit", (code) => process.exit(code ?? 0));
  });
}
