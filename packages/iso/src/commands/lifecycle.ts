import { Command } from "commander";
import { loadCtx, fnName } from "../context.js";
import { previousRevision } from "../deploy.js";
import { deleteFunction, pinEndpoint } from "../aws/lambdaweb.js";
import { deleteVars } from "../aws/secrets.js";
import { deleteCluster, describeCluster } from "../aws/rds.js";
import { names, readIsoConfig, writeIsoConfig, findProjectRoot, UserError } from "../config.js";
import { ui, flags } from "../ui.js";

export function rollbackCommand(): Command {
  return new Command("rollback")
    .description("Shift the endpoint to the previous revision (one call)")
    .option("-e, --env <env>").option("-s, --service <name>")
    .option("--to <revisionId>", "a specific revision")
    .action(async (o) => {
      const c = await loadCtx(o);
      const { current, previous, all } = await previousRevision(c);
      const target = o.to ?? previous;
      if (!target) throw new UserError("no previous active revision to roll back to", "`iso status` lists revisions; `iso up` creates one.");
      if (!all.some((r) => r.id === target)) throw new UserError(`revision ${target} not found`);
      await pinEndpoint(c.aws, fnName(c), target);
      ui.ok(`endpoint pinned to revision ${target} (was ${current}). The next \`iso up\` resumes auto-deploy.`);
      if (flags.json) ui.json({ from: current, to: target });
    });
}

export function downCommand(): Command {
  return new Command("down")
    .description("Delete the environment's functions and secret; asks before the database")
    .option("-e, --env <env>")
    .option("--database", "also delete the Aurora cluster (project-wide!)")
    .action(async (o) => {
      const c = await loadCtx(o);
      const services = Object.keys(c.cfg.services);
      ui.info(`This deletes in ${c.aws.region}:`);
      for (const s of services) ui.info(`  web function ${names.fn(c.cfg.project, c.env, s)}`);
      ui.info(`  secret ${names.secret(c.cfg.project, c.env)}`);
      if (!(await ui.confirm(`Delete environment "${c.env}"?`, false))) return;
      for (const s of services) {
        const ok = await deleteFunction(c.aws, names.fn(c.cfg.project, c.env, s));
        ui.ok(`${names.fn(c.cfg.project, c.env, s)} ${ok ? "deleted" : "not found"}`);
      }
      await deleteVars(c.aws, c.cfg.project, c.env);
      ui.ok("secret deleted");
      if (c.cfg.database?.kind === "aurora") {
        const db = await describeCluster(c.aws, c.cfg.project);
        if (db && (o.database || (await ui.confirm(`Also delete the Aurora cluster ${db.id}? (shared by ALL environments of ${c.cfg.project}; no snapshot)`, false)))) {
          await deleteCluster(c.aws, c.cfg.project);
          ui.ok("cluster deletion started");
        }
      }
      ui.info(ui.dim("The iso-core bucket and execution role stay ($0). Delete the `iso-core` stack in CloudFormation to remove everything."));
    });
}

export function environmentCommand(): Command {
  return new Command("environment").alias("env")
    .description("Show or switch the environment in iso.json; created on first `iso up`")
    .argument("[name]")
    .action(async (name?: string) => {
      const root = findProjectRoot();
      const cfg = readIsoConfig(root);
      if (!cfg) throw new UserError("no iso.json", "Run `iso init`.");
      if (!name) { ui.info(cfg.environment); return; }
      if (!/^[a-z0-9-]{1,30}$/.test(name)) throw new UserError("environment names: lowercase letters, digits, dashes");
      cfg.environment = name;
      writeIsoConfig(root, cfg);
      ui.ok(`environment → ${name} · \`iso up\` now deploys ${name}`);
    });
}

export function serviceCommand(): Command {
  return new Command("service")
    .description("List services, or add/select one in a multi-service repo")
    .argument("[name]")
    .option("--path <dir>", "service directory (adds the service)")
    .action(async (name: string | undefined, o) => {
      const root = findProjectRoot();
      const cfg = readIsoConfig(root);
      if (!cfg) throw new UserError("no iso.json", "Run `iso init`.");
      if (!name) { for (const [n, s] of Object.entries(cfg.services)) ui.info(`${n}  ${ui.dim(s.path)}`); return; }
      if (o.path) { cfg.services[name] = { path: o.path, runtime: "serverless", timeoutSeconds: 60, maxConcurrencyPerEnvironment: 128 }; writeIsoConfig(root, cfg); ui.ok(`service ${name} → ${o.path}`); return; }
      if (!cfg.services[name]) throw new UserError(`unknown service ${name}`, "`iso service <name> --path <dir>` adds one.");
      ui.info(`export ISO_SERVICE=${name}   # or pass -s ${name}`);
    });
}

export function linkCommand(): Command {
  return new Command("link")
    .description("Point this directory at an existing project + environment (reads tags from AWS)")
    .option("--project <name>").option("--env <env>").option("--region <region>")
    .action(async (o) => {
      const { awsCtx } = await import("../aws/clients.js");
      const { listFunctions } = await import("../aws/lambdaweb.js");
      const { buildConfig } = await import("./init.js");
      const region = o.region ?? readIsoConfig()?.region ?? "us-east-1";
      const ctx = await awsCtx(region);
      const fns = await listFunctions(ctx, o.project ? `${o.project}-` : "");
      const projects = [...new Set(fns.map((f) => f.tags["iso:project"]).filter(Boolean))];
      if (!projects.length) throw new UserError(`no iso projects found in ${region}`, "Run `iso init` to start a new one.");
      const project = o.project ?? (await ui.choose("Project", projects.map((p) => ({ name: p, value: p }))));
      const envs = [...new Set(fns.filter((f) => f.tags["iso:project"] === project).map((f) => f.tags["iso:env"]).filter(Boolean))];
      const env = o.env ?? (await ui.choose("Environment", envs.map((e) => ({ name: e, value: e }))));
      const services = fns.filter((f) => f.tags["iso:project"] === project && f.tags["iso:env"] === env).map((f) => f.tags["iso:service"]);
      const cfg = await buildConfig(process.cwd(), { project, region });
      cfg.environment = env;
      if (services.length && !Object.keys(cfg.services).every((s) => services.includes(s))) cfg.services = Object.fromEntries(services.map((s) => [s, { path: ".", runtime: "serverless" as const }]));
      writeIsoConfig(process.cwd(), cfg);
      ui.ok(`linked to ${project}/${env} (${services.join(", ") || "no services yet"})`);
    });
}

export function openCommand(): Command {
  return new Command("open").description("Open the live URL").option("-e, --env <env>").option("-s, --service <name>").action(async (o) => {
    const c = await loadCtx(o);
    const { getEndpoint } = await import("../aws/lambdaweb.js");
    const ep = await getEndpoint(c.aws, fnName(c));
    if (!ep) throw new UserError("not deployed", "Run `iso up`.");
    const url = `https://${ep.domainName}`;
    ui.info(url);
    const { spawn } = await import("node:child_process");
    const opener = process.platform === "darwin" ? "open" : process.platform === "win32" ? "start" : "xdg-open";
    try { spawn(opener, [url], { stdio: "ignore", detached: true }).unref(); } catch {}
  });
}

export function unsupportedCommand(name: string, reason: string): Command {
  return new Command(name).description(`(not on serverless) ${reason}`).allowUnknownOption().action(() => {
    ui.err(`\`iso ${name}\` is not supported on serverless: ${reason}`);
    ui.info(ui.dim("  → tracking: https://github.com/isomorph/iso/issues"));
    process.exit(2);
  });
}
