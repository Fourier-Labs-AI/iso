import pricing from "./pricing.json" with { type: "json" };
import type { IsoConfig } from "./types.js";

export interface CostLine { item: string; idle: number | string; small: number | string; note: string; optional?: boolean }

export const P = pricing;

export function money(n: number | string): string {
  if (typeof n === "string") return n;
  if (n === 0) return "$0";
  if (n < 0.01) return "~$0";
  return `$${n.toFixed(2)}`;
}

/** Cost per service at idle and at ~100k req/month. Every line item named. */
export function estimate(cfg: Pick<IsoConfig, "database" | "services" | "domains">, envCount = 1): CostLine[] {
  const lw = P.lambdaWeb;
  const reqs = 100_000;
  const cpuSec = (reqs * lw.assumedCpuMsPerRequest) / 1000;
  const compute = (reqs / 1e6) * lw.perMillionRequests + cpuSec * lw.vcpus * lw.perVcpuSecond + lw.assumedEnvHoursPer100k * 3600 * lw.memoryGb * lw.perGbSecond;
  const lines: CostLine[] = [];
  for (const name of Object.keys(cfg.services)) {
    lines.push({ item: `Lambda Web Function (${name})`, idle: 0, small: compute, note: "CPU time while code runs + memory per environment-hour; scale to zero" });
  }
  lines.push({ item: "Built-in HTTPS endpoint", idle: 0, small: 0, note: "no API Gateway, no load balancer" });
  lines.push({ item: "S3 deploy bucket", idle: 0.001, small: 0.001, note: "last 10 object versions kept" });
  lines.push({ item: `Secrets Manager (${envCount} env)`, idle: P.secretsManager.perSecretMonth * envCount, small: P.secretsManager.perSecretMonth * envCount, note: "one secret per environment; values baked into the revision, no runtime reads" });
  lines.push({ item: "CloudWatch Logs", idle: 0, small: 0.05, note: "14-day retention" });
  lines.push({ item: "IAM, CloudFormation", idle: 0, small: 0, note: "" });
  const db = cfg.database?.kind ?? "none";
  if (db === "aurora") {
    const a = P.aurora;
    lines.push({ item: "Aurora Serverless v2 PostgreSQL", idle: a.publicIpv4PerMonth, small: a.minAcu * a.perAcuHour * 20 + a.publicIpv4PerMonth + a.perGbStorageMonth, note: `$0 compute idle; ~$${(a.minAcu * a.perAcuHour).toFixed(2)}/hr awake (0.5 ACU); +$${a.publicIpv4PerMonth}/mo public IPv4; ~15s resume` , optional: true });
    if (cfg.database?.network === "private") lines.push({ item: "VPC + NAT gateway (--private)", idle: P.nat.perMonth, small: P.nat.perMonth + 1, note: "fixed monthly cost; opt-in only", optional: true });
  } else if (db === "external") {
    lines.push({ item: "External Postgres", idle: 0, small: 0, note: "billed by your provider", optional: true });
  }
  const domains = Object.values(cfg.domains ?? {}).flat();
  if (domains.length) lines.push({ item: `CloudFront + ACM (${domains.length} domain)`, idle: 0, small: 0, note: "free tier: 1 TB + 10M requests/month", optional: true });
  return lines;
}

export function fixedMonthly(lines: CostLine[]): number {
  return lines.reduce((s, l) => s + (typeof l.idle === "number" ? l.idle : 0), 0);
}
