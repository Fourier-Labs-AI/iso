import crypto from "node:crypto";
import { CreateDBClusterCommand, CreateDBInstanceCommand, DescribeDBClustersCommand, DescribeDBInstancesCommand, DescribeDBEngineVersionsCommand, DeleteDBClusterParameterGroupCommand, CreateDBClusterParameterGroupCommand, ModifyDBClusterParameterGroupCommand, DescribeDBClusterParameterGroupsCommand, DeleteDBClusterCommand, DeleteDBInstanceCommand } from "@aws-sdk/client-rds";
import { EC2Client, DescribeSecurityGroupsCommand, CreateSecurityGroupCommand, AuthorizeSecurityGroupIngressCommand, DescribeVpcsCommand, DeleteSecurityGroupCommand } from "@aws-sdk/client-ec2";
import { type AwsCtx, isNotFound, sleep } from "./clients.js";
import { names } from "../config.js";
import { ui } from "../ui.js";

export interface ClusterInfo { id: string; status: string; endpoint?: string; port?: number; capacity?: number }

export async function describeCluster(ctx: AwsCtx, project: string): Promise<ClusterInfo | null> {
  try {
    const r = await ctx.rds.send(new DescribeDBClustersCommand({ DBClusterIdentifier: names.cluster(project) }));
    const c = r.DBClusters?.[0];
    if (!c) return null;
    return { id: c.DBClusterIdentifier!, status: c.Status ?? "unknown", endpoint: c.Endpoint, port: c.Port, capacity: c.ServerlessV2ScalingConfiguration?.MinCapacity };
  } catch (e) { if (isNotFound(e) || (e as any)?.name === "DBClusterNotFoundFault") return null; throw e; }
}

export function generatePassword(): string {
  const alphabet = "ABCDEFGHJKLMNPQRSTUVWXYZabcdefghijkmnopqrstuvwxyz23456789";
  return Array.from(crypto.randomBytes(32)).map((b) => alphabet[b % alphabet.length]).join("");
}

/** Aurora Serverless v2 PostgreSQL: min 0 ACU, max N, auto-pause, public endpoint, TLS forced. */
export async function createCluster(ctx: AwsCtx, project: string, opts: { maxCapacity: number; password: string }): Promise<ClusterInfo> {
  const id = names.cluster(project);
  const ec2 = new EC2Client({ region: ctx.region });
  // default engine version decides the parameter-group family (aurora-postgresql16, 17, …)
  const ev = (await ctx.rds.send(new DescribeDBEngineVersionsCommand({ Engine: "aurora-postgresql", DefaultOnly: true }))).DBEngineVersions?.[0];
  if (!ev?.EngineVersion || !ev.DBParameterGroupFamily) throw new Error("could not determine the default aurora-postgresql engine version");
  const pgName = `${id}-${ev.DBParameterGroupFamily}`;
  try { await ctx.rds.send(new DescribeDBClusterParameterGroupsCommand({ DBClusterParameterGroupName: pgName })); }
  catch {
    await ctx.rds.send(new CreateDBClusterParameterGroupCommand({ DBClusterParameterGroupName: pgName, DBParameterGroupFamily: ev.DBParameterGroupFamily, Description: "iso: force TLS" }));
    await ctx.rds.send(new ModifyDBClusterParameterGroupCommand({ DBClusterParameterGroupName: pgName, Parameters: [{ ParameterName: "rds.force_ssl", ParameterValue: "1", ApplyMethod: "immediate" }] }));
  }
  const vpc = (await ec2.send(new DescribeVpcsCommand({ Filters: [{ Name: "is-default", Values: ["true"] }] }))).Vpcs?.[0];
  if (!vpc) throw new Error("no default VPC in this region; Aurora public endpoint needs one (or use `database.kind: external`)");
  let sg = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [`${id}-sg`] }, { Name: "vpc-id", Values: [vpc.VpcId!] }] }))).SecurityGroups?.[0]?.GroupId;
  if (!sg) {
    sg = (await ec2.send(new CreateSecurityGroupCommand({ GroupName: `${id}-sg`, Description: "iso: Postgres 5432, TLS forced, generated password", VpcId: vpc.VpcId }))).GroupId!;
    await ec2.send(new AuthorizeSecurityGroupIngressCommand({ GroupId: sg, IpPermissions: [{ IpProtocol: "tcp", FromPort: 5432, ToPort: 5432, IpRanges: [{ CidrIp: "0.0.0.0/0", Description: "Lambda egress IPs are not stable; TLS + 32-char password" }] }] }));
  }
  await ctx.rds.send(new CreateDBClusterCommand({
    DBClusterIdentifier: id, Engine: "aurora-postgresql", EngineVersion: ev.EngineVersion, EngineMode: "provisioned",
    MasterUsername: "iso", MasterUserPassword: opts.password, DatabaseName: "postgres",
    DBClusterParameterGroupName: pgName, VpcSecurityGroupIds: [sg], StorageEncrypted: true,
    ServerlessV2ScalingConfiguration: { MinCapacity: 0, MaxCapacity: opts.maxCapacity, SecondsUntilAutoPause: 300 },
    Tags: [{ Key: "iso:project", Value: project }],
  }));
  await ctx.rds.send(new CreateDBInstanceCommand({ DBInstanceIdentifier: `${id}-1`, DBClusterIdentifier: id, DBInstanceClass: "db.serverless", Engine: "aurora-postgresql", PubliclyAccessible: true, Tags: [{ Key: "iso:project", Value: project }] }));
  // the cluster reports "available" before its writer instance exists; the endpoint only resolves once the instance is up
  for (let i = 0; i < 200; i++) {
    await sleep(6000);
    const c = await describeCluster(ctx, project);
    const inst = (await ctx.rds.send(new DescribeDBInstancesCommand({ DBInstanceIdentifier: `${id}-1` })).catch(() => null))?.DBInstances?.[0];
    if (c?.status === "available" && c.endpoint && inst?.DBInstanceStatus === "available") return c;
    if (i % 10 === 0) ui.step(`cluster ${c?.status ?? "creating"} · instance ${inst?.DBInstanceStatus ?? "creating"}…`);
  }
  throw new Error("timed out waiting for the Aurora cluster");
}

export async function deleteCluster(ctx: AwsCtx, project: string) {
  const id = names.cluster(project);
  try { await ctx.rds.send(new DeleteDBInstanceCommand({ DBInstanceIdentifier: `${id}-1`, SkipFinalSnapshot: true })); } catch {}
  try { await ctx.rds.send(new DeleteDBClusterCommand({ DBClusterIdentifier: id, SkipFinalSnapshot: true })); } catch (e) { if (!isNotFound(e)) throw e; }
  // parameter group and security group can only go once the cluster is gone (instance deletion takes ~10 min)
  ui.step("waiting for the cluster to finish deleting (up to 20 min; ctrl-c leaves the $0 parameter group and security group behind)");
  for (let i = 0; i < 240; i++) { await sleep(5000); if (!(await describeCluster(ctx, project))) break; }
  for (const fam of ["aurora-postgresql15", "aurora-postgresql16", "aurora-postgresql17", "aurora-postgresql18"]) { try { await ctx.rds.send(new DeleteDBClusterParameterGroupCommand({ DBClusterParameterGroupName: `${id}-${fam}` })); } catch {} }
  try {
    const ec2 = new EC2Client({ region: ctx.region });
    const sg = (await ec2.send(new DescribeSecurityGroupsCommand({ Filters: [{ Name: "group-name", Values: [`${id}-sg`] }] }))).SecurityGroups?.[0]?.GroupId;
    if (sg) for (let i = 0; i < 12; i++) { try { await ec2.send(new DeleteSecurityGroupCommand({ GroupId: sg })); break; } catch { await sleep(10000); } }
  } catch {}
}

export function databaseUrl(c: ClusterInfo, user: string, password: string, db: string): string {
  return `postgresql://${encodeURIComponent(user)}:${encodeURIComponent(password)}@${c.endpoint}:${c.port ?? 5432}/${db}?sslmode=require`;
}
