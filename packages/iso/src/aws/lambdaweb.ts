import {
  CreateWebFunctionCommand, CreateWebFunctionRevisionCommand, GetWebFunctionCommand, GetWebFunctionEndpointCommand,
  GetWebFunctionRevisionCommand, ListWebFunctionRevisionsCommand, ListWebFunctionsCommand, UpdateWebFunctionEndpointCommand,
  DeleteWebFunctionCommand, DeleteWebFunctionRevisionCommand, ListTagsCommand, TagResourceCommand, ListWebFunctionEndpointsCommand,
  type ServiceConfig, type GetWebFunctionRevisionResponse, type GetWebFunctionEndpointResponse,
} from "@aws-sdk/client-lambda-web";
import { type AwsCtx, isNotFound, sleep } from "./clients.js";
import { RUNTIME, names } from "../config.js";

export interface RevisionInput {
  functionName: string;
  bucket: string; key: string; versionId: string;
  executionRoleArn: string;
  timeoutSeconds: number;
  maxConcurrencyPerEnvironment: number;
  env: Record<string, string>;
  description: string;
  tags: Record<string, string>;
  logGroup: string;
}

export async function getFunction(ctx: AwsCtx, fn: string) {
  try { return await ctx.lambdaWeb.send(new GetWebFunctionCommand({ functionName: fn })); }
  catch (e) { if (isNotFound(e)) return null; throw e; }
}

export async function getEndpoint(ctx: AwsCtx, fn: string): Promise<GetWebFunctionEndpointResponse | null> {
  try { return await ctx.lambdaWeb.send(new GetWebFunctionEndpointCommand({ functionName: fn, endpointName: names.endpoint() })); }
  catch (e) { if (isNotFound(e)) return null; throw e; }
}

function serviceConfig(i: RevisionInput): ServiceConfig {
  return {
    executionRoleArn: i.executionRoleArn,
    timeoutSeconds: i.timeoutSeconds,
    maxConcurrencyPerEnvironment: i.maxConcurrencyPerEnvironment,
    environmentVariables: i.env,
    telemetryConfig: { loggingConfig: { logGroup: i.logGroup, applicationLogLevel: "INFO", systemLogLevel: "INFO" } },
  };
}

/** First deploy: function + revision + endpoint in one call. Later deploys: a new revision; the endpoint auto-deploys LatestRevision. */
export async function deployRevision(ctx: AwsCtx, i: RevisionInput): Promise<{ created: boolean; revisionId: string; revisionArn: string; functionArn: string }> {
  const buildConfig = { codeConfig: { s3Object: { bucket: i.bucket, key: i.key, versionId: i.versionId } }, runtimeConfig: { runtime: RUNTIME } };
  const existing = await getFunction(ctx, i.functionName);
  if (!existing) {
    const r = await ctx.lambdaWeb.send(new CreateWebFunctionCommand({
      functionName: i.functionName,
      revisionConfig: { description: i.description, buildConfig, serviceConfig: serviceConfig(i) },
      endpointConfig: { endpointName: names.endpoint(), endpointType: "HomeRegion", authType: "ApplicationManaged", autoDeploymentMode: "LatestRevision" },
      tags: i.tags,
    }));
    const rev = r.revision;
    return { created: true, revisionId: rev?.revisionId ?? "", revisionArn: rev?.revisionArn ?? "", functionArn: r.functionArn! };
  }
  const r = await ctx.lambdaWeb.send(new CreateWebFunctionRevisionCommand({ functionName: i.functionName, description: i.description, buildConfig, serviceConfig: serviceConfig(i) }));
  try { await ctx.lambdaWeb.send(new TagResourceCommand({ resource: existing.functionArn!, tags: i.tags })); } catch {}
  return { created: false, revisionId: r.revisionId!, revisionArn: r.revisionArn!, functionArn: r.functionArn! };
}

export async function waitRevisionActive(ctx: AwsCtx, fn: string, revisionId: string, timeoutMs = 180_000): Promise<GetWebFunctionRevisionResponse> {
  const start = Date.now();
  for (;;) {
    const r = await ctx.lambdaWeb.send(new GetWebFunctionRevisionCommand({ functionName: fn, revisionId }));
    if (r.state === "Active") return r;
    if (r.state === "Failed") throw new Error(`revision ${revisionId} failed: ${r.stateReason}${r.errors?.length ? "\n  " + r.errors.map((e) => `${e.attribute}: ${e.errorMessage}`).join("\n  ") : ""}`);
    if (Date.now() - start > timeoutMs) throw new Error(`timed out waiting for revision ${revisionId} (state ${r.state}: ${r.stateReason})`);
    await sleep(2000);
  }
}

export async function waitEndpointServing(ctx: AwsCtx, fn: string, revisionId: string, timeoutMs = 180_000): Promise<GetWebFunctionEndpointResponse> {
  const start = Date.now();
  for (;;) {
    const ep = await getEndpoint(ctx, fn);
    if (ep && ep.state === "Active" && ep.updateStatus !== "InProgress" && ep.revisionWeights?.some((w) => w.revisionId === revisionId && (w.weight ?? 0) > 0)) return ep;
    if (ep?.state === "Failed") throw new Error(`endpoint failed: ${ep.stateReason}`);
    if (Date.now() - start > timeoutMs) return ep!;
    await sleep(2000);
  }
}

export async function listRevisions(ctx: AwsCtx, fn: string) {
  const r = await ctx.lambdaWeb.send(new ListWebFunctionRevisionsCommand({ functionName: fn, maxResults: 50 }));
  return (r.revisions ?? []).sort((a, b) => (b.createdAt?.getTime() ?? 0) - (a.createdAt?.getTime() ?? 0));
}

export async function getRevision(ctx: AwsCtx, fn: string, revisionId: string) {
  return ctx.lambdaWeb.send(new GetWebFunctionRevisionCommand({ functionName: fn, revisionId }));
}

/** Rollback = weighted mode pinned 100% to `revisionId`. `iso up` switches back to LatestRevision. */
export async function pinEndpoint(ctx: AwsCtx, fn: string, revisionId: string) {
  await ctx.lambdaWeb.send(new UpdateWebFunctionEndpointCommand({ functionName: fn, endpointName: names.endpoint(), autoDeploymentMode: "Disabled", revisionWeights: [{ revisionId, weight: 100 }] }));
}
export async function unpinEndpoint(ctx: AwsCtx, fn: string) {
  await ctx.lambdaWeb.send(new UpdateWebFunctionEndpointCommand({ functionName: fn, endpointName: names.endpoint(), autoDeploymentMode: "LatestRevision" }));
}

export async function listFunctions(ctx: AwsCtx, prefix: string) {
  const out: { name: string; arn: string; state?: string; tags: Record<string, string> }[] = [];
  let next: string | undefined;
  do {
    const r = await ctx.lambdaWeb.send(new ListWebFunctionsCommand({ maxResults: 50, nextToken: next }));
    for (const f of r.functions ?? []) {
      if (!f.functionName?.startsWith(prefix)) continue;
      let tags: Record<string, string> = {};
      try { tags = (await ctx.lambdaWeb.send(new ListTagsCommand({ resource: f.functionArn! }))).tags ?? {}; } catch {}
      out.push({ name: f.functionName!, arn: f.functionArn!, state: f.state as string, tags });
    }
    next = r.nextToken;
  } while (next);
  return out;
}

export async function deleteFunction(ctx: AwsCtx, fn: string) {
  const existing = await getFunction(ctx, fn);
  if (!existing) return false;
  await ctx.lambdaWeb.send(new DeleteWebFunctionCommand({ functionName: fn }));
  for (let i = 0; i < 60; i++) { await sleep(2000); if (!(await getFunction(ctx, fn))) break; }
  return true;
}

export async function pruneRevisions(ctx: AwsCtx, fn: string, keep = 10) {
  const revs = await listRevisions(ctx, fn);
  const ep = await getEndpoint(ctx, fn);
  const live = new Set((ep?.revisionWeights ?? []).map((w) => w.revisionId));
  for (const r of revs.slice(keep)) {
    if (live.has(r.revisionId)) continue;
    try { await ctx.lambdaWeb.send(new DeleteWebFunctionRevisionCommand({ functionName: fn, revisionId: r.revisionId! })); } catch {}
  }
}

export { ListWebFunctionEndpointsCommand };
