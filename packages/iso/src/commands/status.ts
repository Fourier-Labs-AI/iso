import { Command } from "commander";
import { loadCtx, fnName } from "../context.js";
import { getEndpoint, getRevision, listFunctions } from "../aws/lambdaweb.js";
import { previousRevision, probe } from "../deploy.js";
import { describeCluster } from "../aws/rds.js";
import { estimate, fixedMonthly, money, P } from "../cost.js";
import { ui, flags, ms } from "../ui.js";

export function statusCommand(): Command {
  return new Command("status")
    .description("What is deployed, where, since when")
    .option("-e, --env <env>").option("-s, --service <name>")
    .option("--all", "list every iso function in the account/region")
    .option("--cost", `month-to-date cost from Cost Explorer ($${P.costExplorer.perCall}/call)`)
    .action(async (o) => {
      const c = await loadCtx(o);
      if (o.all) {
        const fns = await listFunctions(c.aws, `${c.cfg.project}-`);
        if (flags.json) return ui.json(fns);
        ui.table([["function", "state", "env", "service", "git"], ...fns.map((f) => [f.name, f.state ?? "", f.tags["iso:env"] ?? "", f.tags["iso:service"] ?? "", f.tags["iso:git-sha"] ?? ""])]);
        return;
      }
      const fn = fnName(c);
      const ep = await getEndpoint(c.aws, fn);
      const out: any = { project: c.cfg.project, env: c.env, service: c.service, function: fn, region: c.aws.region };
      if (!ep) { out.deployed = false; if (flags.json) return ui.json(out); ui.info(`${fn}: not deployed (run \`iso up\`)`); return; }
      const { current, all } = await previousRevision(c);
      const rev = current ? await getRevision(c.aws, fn, current) : null;
      const url = `https://${ep.domainName}`;
      const p = await probe(url + "/", 15000);
      out.url = url; out.revision = current; out.deployedAt = rev?.createdAt; out.description = rev?.description; out.endpointState = ep.state; out.mode = ep.autoDeploymentMode; out.health = p.status ?? p.error; out.latencyMs = p.ms; out.revisions = all.length;
      if (c.cfg.database?.kind === "aurora") { const db = await describeCluster(c.aws, c.cfg.project); out.db = db ? (db.status === "available" ? "active" : db.status) : "missing"; }
      const lines = estimate(c.cfg); out.fixedMonthly = fixedMonthly(lines);
      if (o.cost) out.monthToDate = await mtd(c.aws.region, c.cfg.project);
      if (flags.json) return ui.json(out);
      ui.table([
        ["url", url], ["revision", `${current ?? "?"} ${ui.dim(rev?.description ?? "")}`], ["deployed", rev?.createdAt?.toISOString() ?? "?"],
        ["endpoint", `${ep.state} · ${ep.autoDeploymentMode === "Disabled" ? "pinned (rollback)" : "auto LatestRevision"}`],
        ["health", `GET / → ${p.status ?? p.error} in ${ms(p.ms)}`],
        ...(out.db ? [["db", String(out.db)]] : []),
        ["fixed cost", `${money(out.fixedMonthly)}/mo`],
        ...(o.cost ? [["month to date", out.monthToDate === undefined ? "unavailable" : `$${out.monthToDate.toFixed(2)} (whole account, Lambda+S3+SecretsManager+RDS)`]] : []),
      ]);
    });
}

async function mtd(region: string, project: string): Promise<number | undefined> {
  try {
    const { CostExplorerClient, GetCostAndUsageCommand } = await import("@aws-sdk/client-cost-explorer");
    const ce = new CostExplorerClient({ region: "us-east-1" });
    const now = new Date();
    const start = `${now.getUTCFullYear()}-${String(now.getUTCMonth() + 1).padStart(2, "0")}-01`;
    const end = now.toISOString().slice(0, 10);
    if (start === end) return 0;
    const r = await ce.send(new GetCostAndUsageCommand({ TimePeriod: { Start: start, End: end }, Granularity: "MONTHLY", Metrics: ["UnblendedCost"], Filter: { Dimensions: { Key: "SERVICE", Values: ["AWS Lambda", "Amazon Simple Storage Service", "AWS Secrets Manager", "Amazon Relational Database Service", "AmazonCloudWatch"] } } }));
    return parseFloat(r.ResultsByTime?.[0]?.Total?.UnblendedCost?.Amount ?? "0");
  } catch { return undefined; }
}
