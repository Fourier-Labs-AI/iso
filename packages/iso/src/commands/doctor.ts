import { Command } from "commander";
import { awsCtx } from "../aws/clients.js";
import { coreStackStatus } from "../aws/cfn.js";
import { HeadBucketCommand, GetBucketVersioningCommand, GetBucketPolicyCommand } from "@aws-sdk/client-s3";
import { GetRoleCommand } from "@aws-sdk/client-iam";
import { getEndpoint, getFunction, listRevisions } from "../aws/lambdaweb.js";
import { readVars } from "../aws/secrets.js";
import { readIsoConfig, findProjectRoot, names, SUPPORTED_REGIONS, DEFAULT_REGION } from "../config.js";
import { detectService } from "../detect/index.js";
import { probe } from "../deploy.js";
import { ui, flags } from "../ui.js";
import path from "node:path";

interface Check { name: string; ok: boolean; detail: string; fix?: string }

export function doctorCommand(): Command {
  return new Command("doctor").description("Check credentials, region, core stack, bucket, role, function, last revision; one fix per failure")
    .option("-e, --env <env>").option("-s, --service <name>")
    .action(async (o) => {
      const checks: Check[] = [];
      const root = findProjectRoot();
      const cfg = readIsoConfig(root);
      const region = cfg?.region ?? DEFAULT_REGION;
      checks.push({ name: "iso.json", ok: !!cfg, detail: cfg ? `${cfg.project} · ${cfg.environment} · ${region}` : "missing", fix: "iso init" });
      checks.push({ name: "region", ok: SUPPORTED_REGIONS.includes(region), detail: region, fix: `use one of ${SUPPORTED_REGIONS.join(", ")}` });
      let ctx;
      try { ctx = await awsCtx(region, cfg?.profile); checks.push({ name: "credentials", ok: true, detail: ctx.arn }); }
      catch (e: any) { checks.push({ name: "credentials", ok: false, detail: e.message, fix: "iso aws connect" }); return report(checks); }
      const core = await coreStackStatus(ctx);
      checks.push({ name: "iso-core stack", ok: !!core && /COMPLETE$/.test(core.status) && !/ROLLBACK/.test(core.status), detail: core?.status ?? "missing", fix: "iso aws connect" });
      const bucket = `iso-deploy-${ctx.accountId}-${region}`;
      try {
        await ctx.s3.send(new HeadBucketCommand({ Bucket: bucket }));
        const v = await ctx.s3.send(new GetBucketVersioningCommand({ Bucket: bucket }));
        checks.push({ name: "deploy bucket", ok: v.Status === "Enabled", detail: `${bucket} versioning ${v.Status ?? "off"}`, fix: "iso aws connect (re-applies the stack)" });
        const p = await ctx.s3.send(new GetBucketPolicyCommand({ Bucket: bucket }));
        checks.push({ name: "bucket policy", ok: /lambda\.amazonaws\.com/.test(p.Policy ?? ""), detail: "lambda.amazonaws.com read", fix: "iso aws connect" });
      } catch (e: any) { checks.push({ name: "deploy bucket", ok: false, detail: `${bucket}: ${e.name}`, fix: "iso aws connect" }); }
      if (!cfg) return report(checks);
      try { await ctx.iam.send(new GetRoleCommand({ RoleName: names.role(cfg.project) })); checks.push({ name: "execution role", ok: true, detail: names.role(cfg.project) }); }
      catch { checks.push({ name: "execution role", ok: false, detail: "missing (created on first iso up)", fix: "iso up" }); }
      const env = o.env ?? cfg.environment;
      const vars = await readVars(ctx, cfg.project, env);
      checks.push({ name: "secret", ok: vars !== null, detail: vars ? `${Object.keys(vars).length} variables` : "missing (created on first iso up)", fix: "iso up" });
      for (const [svc, s] of Object.entries(cfg.services)) {
        if (o.service && o.service !== svc) continue;
        const d = detectService(svc, path.resolve(root, s.path));
        const blocks = d.findings.filter((f) => f.severity === "block");
        checks.push({ name: `detect ${svc}`, ok: d.verdict === "serverless", detail: d.verdict === "serverless" ? `${d.framework}, entry ${d.entryFile}` : blocks.map((b) => b.message).join("; "), fix: blocks[0]?.fix });
        const fn = names.fn(cfg.project, env, svc);
        const f = await getFunction(ctx, fn);
        checks.push({ name: `function ${svc}`, ok: f?.state === "Active", detail: f ? `${f.state}: ${f.stateReason}` : "not deployed", fix: "iso up" });
        if (!f) continue;
        const revs = await listRevisions(ctx, fn);
        const last = revs[0];
        checks.push({ name: `last revision ${svc}`, ok: last?.state === "Active", detail: last ? `${last.revisionId} ${last.state}: ${last.stateReason}` : "none", fix: "iso up" });
        const ep = await getEndpoint(ctx, fn);
        checks.push({ name: `endpoint ${svc}`, ok: ep?.state === "Active", detail: ep ? `${ep.domainName} ${ep.state} (${ep.autoDeploymentMode})` : "missing", fix: "iso up" });
        if (ep?.domainName) { const p = await probe(`https://${ep.domainName}/`, 20000); checks.push({ name: `health ${svc}`, ok: p.ok, detail: `GET / → ${p.status ?? p.error} in ${p.ms}ms`, fix: "iso logs" }); }
      }
      report(checks);
    });
}

function report(checks: Check[]) {
  if (flags.json) { ui.json(checks); if (checks.some((c) => !c.ok)) process.exit(1); return; }
  for (const c of checks) {
    (c.ok ? ui.ok : ui.err)(`${c.name.padEnd(22)} ${c.detail}`);
    if (!c.ok && c.fix) ui.info(ui.dim(`  → ${c.fix}`));
  }
  if (checks.some((c) => !c.ok)) process.exit(1);
}
