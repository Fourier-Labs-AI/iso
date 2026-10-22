import { CreateLogGroupCommand, DescribeLogGroupsCommand, FilterLogEventsCommand, PutRetentionPolicyCommand, StartLiveTailCommand } from "@aws-sdk/client-cloudwatch-logs";
import { type AwsCtx, sleep } from "./clients.js";
import { LOG_RETENTION_DAYS } from "../config.js";

export async function ensureLogGroup(ctx: AwsCtx, name: string): Promise<{ created: boolean; arn: string }> {
  const d = await ctx.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
  const g = d.logGroups?.find((x) => x.logGroupName === name);
  if (g) return { created: false, arn: g.arn!.replace(/:\*$/, "") };
  await ctx.logs.send(new CreateLogGroupCommand({ logGroupName: name, tags: { "iso:managed": "true" } }));
  await ctx.logs.send(new PutRetentionPolicyCommand({ logGroupName: name, retentionInDays: LOG_RETENTION_DAYS }));
  const d2 = await ctx.logs.send(new DescribeLogGroupsCommand({ logGroupNamePrefix: name }));
  return { created: true, arn: d2.logGroups!.find((x) => x.logGroupName === name)!.arn!.replace(/:\*$/, "") };
}

export interface LogLine { ts: number; msg: string; stream?: string }

export async function recentLogs(ctx: AwsCtx, group: string, opts: { since?: number; limit?: number; filter?: string }): Promise<LogLine[]> {
  const out: LogLine[] = [];
  let next: string | undefined;
  do {
    const r = await ctx.logs.send(new FilterLogEventsCommand({ logGroupName: group, startTime: opts.since, filterPattern: opts.filter, limit: opts.limit ?? 200, nextToken: next, interleaved: true }));
    for (const e of r.events ?? []) out.push({ ts: e.timestamp!, msg: e.message ?? "", stream: e.logStreamName });
    next = r.nextToken;
  } while (next && out.length < (opts.limit ?? 200));
  return out;
}

/** Live tail via StartLiveTail; falls back to polling if the stream API is unavailable. */
export async function tailLogs(ctx: AwsCtx, groupArn: string, group: string, onLine: (l: LogLine) => void, filter?: string): Promise<void> {
  try {
    const r = await ctx.logs.send(new StartLiveTailCommand({ logGroupIdentifiers: [groupArn], logEventFilterPattern: filter }));
    for await (const ev of r.responseStream ?? []) {
      for (const e of ev.sessionUpdate?.sessionResults ?? []) onLine({ ts: e.timestamp!, msg: e.message ?? "", stream: e.logStreamName });
    }
  } catch {
    let since = Date.now() - 10_000;
    for (;;) {
      const lines = await recentLogs(ctx, group, { since });
      for (const l of lines) { onLine(l); since = Math.max(since, l.ts + 1); }
      await sleep(2000);
    }
  }
}

export function formatLog(l: LogLine): string {
  let msg = l.msg.trim();
  try {
    const j = JSON.parse(msg);
    if (j && typeof j === "object" && "message" in j) msg = `${j.level ? `[${j.level}] ` : ""}${typeof j.message === "string" ? j.message : JSON.stringify(j.message)}`;
    else if (j?.type?.startsWith("platform.")) msg = `[${j.type}] ${JSON.stringify(j.record ?? j)}`;
  } catch {}
  return `${new Date(l.ts).toISOString().replace("T", " ").slice(0, 19)}  ${msg}`;
}
