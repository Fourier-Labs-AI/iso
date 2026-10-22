import fs from "node:fs";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { type Ctx, fnName } from "./context.js";
import { names, UserError } from "./config.js";
import { readRailwayConfig } from "./railway/parse.js";
import { resolveStart } from "./railway/start.js";
import { resolveMap } from "./railway/refs.js";
import { detectService } from "./detect/index.js";
import { pack, gitSha, gitBranch, mb } from "./pack/zip.js";
import { ensureBucket, uploadZip } from "./aws/s3.js";
import { ensureExecutionRole } from "./aws/iam.js";
import { ensureLogGroup } from "./aws/logs.js";
import { readVars, writeVars } from "./aws/secrets.js";
import { deployRevision, getEndpoint, listRevisions, pinEndpoint, unpinEndpoint, waitEndpointServing, waitRevisionActive, pruneRevisions } from "./aws/lambdaweb.js";
import { estimate, fixedMonthly, money } from "./cost.js";
import { ui, ms, flags } from "./ui.js";

export interface UpOptions { skipDetect?: boolean; skipInstall?: boolean; buildInDocker?: boolean; reuse?: { bucket: string; key: string; versionId: string } ; noSmoke?: boolean }
export interface UpResult { url: string; functionName: string; revisionId: string; coldMs?: number; warmMs?: number; status?: number; fixedMonthly: number; created: boolean }

/**
 * iso up: detect → pack → S3 → revision → wait Active → smoke test → live.
 * Nothing in AWS changes until the zip is in S3. A failed smoke test pins the endpoint back to the previous revision.
 */
export async function up(c: Ctx, o: UpOptions = {}): Promise<UpResult> {
  const fn = fnName(c);
  const railway = readRailwayConfig(c.serviceDir);
  const svc = c.cfg.services[c.service];

  // 1. detect (before any AWS call)
  if (!o.skipDetect) {
    const d = detectService(c.service, c.serviceDir);
    for (const f of d.findings.filter((x) => x.severity !== "ok")) ui[f.severity === "block" ? "err" : "warn"](`${f.message}${f.file ? ui.dim(` (${f.file}${f.line ? ":" + f.line : ""})`) : ""}`);
    if (d.verdict === "unsupported") throw new UserError(`${c.service} is not deployable on serverless (see above). Nothing was created.`, "Fix the blockers, or run `iso frameworks` for what is supported.");
  }
  const start = resolveStart(c.serviceDir, railway.deploy.startCommand);
  if (!start.entryFile) throw new UserError(`cannot resolve the entry file from "${start.command}"`, 'Set deploy.startCommand in railway.json, e.g. "node server.js".');

  // 2. previous revision for rollback
  const prevEp = await getEndpoint(c.aws, fn);
  const prevRevision = prevEp?.revisionWeights?.find((w) => (w.weight ?? 0) > 0)?.revisionId;

  // 3. pack + upload
  let s3obj = o.reuse;
  let sha = gitSha(c.serviceDir) ?? "nogit";
  if (!s3obj) {
    ui.step(`packaging ${c.service} (entry ${start.entryFile})`);
    const p = await pack({ dir: c.serviceDir, entryFile: start.entryFile, buildCommand: railway.build.buildCommand, skipInstall: o.skipInstall, buildInDocker: o.buildInDocker, includeRdsCa: c.cfg.database?.kind === "aurora" });
    sha = p.sha;
    ui.ok(`zip ${mb(p.bytes)} (${p.files} files, ${mb(p.unzippedBytes)} unzipped)`);
    await ensureBucket(c.aws);
    ui.step("uploading to S3");
    const key = names.s3Key(c.cfg.project, c.env, c.service, `${sha}-${Date.now().toString(36)}`);
    const u = await uploadZip(c.aws, key, p.zipPath, { "iso:project": c.cfg.project, "iso:env": c.env, "iso:service": c.service, "iso:git-sha": sha });
    s3obj = { bucket: u.bucket, key: u.key, versionId: u.versionId };
    fs.rmSync(path.join(c.serviceDir, ".iso-build"), { recursive: true, force: true });
  }

  // 4. role, log group, secrets → env map
  const role = await ensureExecutionRole(c.aws, c.cfg.project);
  if (role.created) ui.ok(`execution role ${names.role(c.cfg.project)} (logs + GetSecretValue on iso/${c.cfg.project}/*)`);
  const lg = await ensureLogGroup(c.aws, names.logGroup(fn));
  if (lg.created) ui.ok(`log group ${names.logGroup(fn)} (14-day retention)`);
  let vars = await readVars(c.aws, c.cfg.project, c.env);
  if (vars === null) { await writeVars(c.aws, c.cfg.project, c.env, {}); vars = {}; ui.ok(`secret ${names.secret(c.cfg.project, c.env)} created ($0.40/month)`); }
  const resolved = resolveMap(vars, { env: c.env, endpointHost: prevEp?.domainName, gitSha: sha, gitBranch: gitBranch(c.serviceDir) });
  for (const w of resolved.warnings) ui.warn(w);
  for (const [k, refs] of Object.entries(resolved.unresolved)) ui.warn(`${k}: could not resolve ${refs.map((r) => "${{" + r + "}}").join(", ")} (set it with \`iso variables set\`)`);
  const env: Record<string, string> = {
    ...resolved.vars,
    AWS_LAMBDA_NODEJS_ENTRYPOINT: "iso-entry.mjs",
    NODE_ENV: resolved.vars.NODE_ENV ?? "production",
    ISO_ENV: c.env, ISO_SERVICE: c.service, ISO_PROJECT: c.cfg.project,
  };
  delete env.PORT; // the runtime decides the port

  // 5. pre-deploy command (migrations) runs locally with the env injected
  if (railway.deploy.preDeployCommand) {
    const cmds = Array.isArray(railway.deploy.preDeployCommand) ? railway.deploy.preDeployCommand : [railway.deploy.preDeployCommand];
    for (const cmd of cmds) {
      ui.step(`preDeployCommand: ${cmd}`);
      const r = spawnSync(cmd, { cwd: c.serviceDir, shell: true, stdio: "inherit", env: { ...process.env, ...resolved.vars } });
      if (r.status !== 0) throw new UserError(`preDeployCommand failed (exit ${r.status}); the new revision was not created`, "Fix the command and run `iso up` again.");
    }
  }

  // 6. revision
  ui.step(`creating revision for ${fn}`);
  const rev = await deployRevision(c.aws, {
    functionName: fn, ...s3obj, executionRoleArn: role.arn,
    timeoutSeconds: svc.timeoutSeconds ?? Math.max(30, Math.min(900, Math.ceil((railway.deploy.healthcheckTimeout ?? 60)))),
    maxConcurrencyPerEnvironment: svc.maxConcurrencyPerEnvironment ?? 128,
    env, description: `${sha} ${new Date().toISOString()}`,
    tags: { "iso:project": c.cfg.project, "iso:env": c.env, "iso:service": c.service, "iso:git-sha": sha, "iso:git-branch": gitBranch(c.serviceDir) ?? "" },
    logGroup: names.logGroup(fn),
  });
  if (rev.created) ui.ok(`web function ${fn} created (HomeRegion endpoint, ApplicationManaged auth)`);
  await waitRevisionActive(c.aws, fn, rev.revisionId);
  ui.ok(`revision ${rev.revisionId} active`);
  if (prevEp && prevEp.autoDeploymentMode === "Disabled") await unpinEndpoint(c.aws, fn); // leaving rollback mode
  const ep = await waitEndpointServing(c.aws, fn, rev.revisionId);
  const url = `https://${ep.domainName}`;

  // 7. smoke test against healthcheckPath
  const hc = railway.deploy.healthcheckPath ?? "/";
  let coldMs: number | undefined, warmMs: number | undefined, status: number | undefined;
  if (!o.noSmoke) {
    ui.step(`smoke test GET ${url}${hc}`);
    const r1 = await probe(url + hc, (railway.deploy.healthcheckTimeout ?? 60) * 1000);
    status = r1.status; coldMs = r1.ms;
    if (r1.ok) { const r2 = await probe(url + hc, 15000); warmMs = r2.ms; }
    else {
      ui.err(`smoke test failed: ${r1.status ?? r1.error} after ${ms(r1.ms)}`);
      if (prevRevision && prevRevision !== rev.revisionId) {
        await pinEndpoint(c.aws, fn, prevRevision);
        ui.warn(`endpoint rolled back to revision ${prevRevision}`);
      }
      throw new UserError(`${c.service} did not answer ${hc} with a 2xx/3xx.`, `Run \`iso logs\` to see why, then \`iso up\` again.`);
    }
  }
  pruneRevisions(c.aws, fn, 10).catch(() => {});

  const lines = estimate(c.cfg);
  const fixed = fixedMonthly(lines);
  if (resolved.vars.RAILWAY_PUBLIC_DOMAIN !== ep.domainName && vars.RAILWAY_PUBLIC_DOMAIN === undefined && Object.values(vars).some((v) => /RAILWAY_PUBLIC_DOMAIN/.test(v))) ui.warn("RAILWAY_PUBLIC_DOMAIN resolved for the first time; run `iso up` once more so references pick up the endpoint host");
  ui.ok(`${ui.bold(c.service)} live at ${ui.bold(url)}${coldMs !== undefined ? ` (${ms(coldMs)} cold, ${warmMs !== undefined ? ms(warmMs) : "?"} warm)` : ""} · fixed cost ${money(fixed)}/mo`);
  return { url, functionName: fn, revisionId: rev.revisionId, coldMs, warmMs, status, fixedMonthly: fixed, created: rev.created };
}

export async function probe(url: string, timeoutMs: number): Promise<{ ok: boolean; status?: number; ms: number; error?: string }> {
  const t = Date.now();
  try {
    const r = await fetch(url, { redirect: "manual", signal: AbortSignal.timeout(timeoutMs), headers: { "user-agent": "iso-smoke-test" } });
    await r.arrayBuffer().catch(() => {});
    return { ok: r.status < 400, status: r.status, ms: Date.now() - t };
  } catch (e: any) {
    return { ok: false, ms: Date.now() - t, error: e?.cause?.code ?? e?.name ?? String(e) };
  }
}

export async function previousRevision(c: Ctx): Promise<{ current?: string; previous?: string; all: { id: string; createdAt?: Date; description?: string; state?: string }[] }> {
  const fn = fnName(c);
  const ep = await getEndpoint(c.aws, fn);
  const current = ep?.revisionWeights?.find((w) => (w.weight ?? 0) > 0)?.revisionId;
  const revs = (await listRevisions(c.aws, fn)).map((r) => ({ id: r.revisionId!, createdAt: r.createdAt, description: r.description, state: r.state as string }));
  const idx = revs.findIndex((r) => r.id === current);
  const previous = revs.slice(idx + 1).find((r) => r.state === "Active")?.id;
  return { current, previous, all: revs };
}

export { flags };
