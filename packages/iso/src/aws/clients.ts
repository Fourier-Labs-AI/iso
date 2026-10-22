import { fromNodeProviderChain } from "@aws-sdk/credential-providers";
import { LambdaWebClient } from "@aws-sdk/client-lambda-web";
import { S3Client } from "@aws-sdk/client-s3";
import { SecretsManagerClient } from "@aws-sdk/client-secrets-manager";
import { CloudFormationClient } from "@aws-sdk/client-cloudformation";
import { CloudWatchLogsClient } from "@aws-sdk/client-cloudwatch-logs";
import { STSClient, GetCallerIdentityCommand } from "@aws-sdk/client-sts";
import { IAMClient } from "@aws-sdk/client-iam";
import { RDSClient } from "@aws-sdk/client-rds";
import { UserError } from "../config.js";

export interface AwsCtx {
  region: string;
  profile?: string;
  accountId: string;
  arn: string;
  lambdaWeb: LambdaWebClient;
  s3: S3Client;
  secrets: SecretsManagerClient;
  cfn: CloudFormationClient;
  logs: CloudWatchLogsClient;
  iam: IAMClient;
  rds: RDSClient;
  sts: STSClient;
}

const cache = new Map<string, Promise<AwsCtx>>();

export function awsCtx(region: string, profile?: string): Promise<AwsCtx> {
  const key = `${region}|${profile ?? ""}`;
  if (!cache.has(key)) cache.set(key, build(region, profile));
  return cache.get(key)!;
}

async function build(region: string, profile?: string): Promise<AwsCtx> {
  if (profile) process.env.AWS_PROFILE = profile;
  const credentials = fromNodeProviderChain({ profile });
  const base = { region, credentials, maxAttempts: 5 };
  const sts = new STSClient(base);
  let id;
  try {
    id = await sts.send(new GetCallerIdentityCommand({}));
  } catch (e: any) {
    throw new UserError(`AWS credentials not found or invalid (${e?.name ?? "error"}: ${e?.message ?? e}).`, "Run `iso aws connect`.");
  }
  return {
    region, profile, accountId: id.Account!, arn: id.Arn!,
    lambdaWeb: new LambdaWebClient(base),
    s3: new S3Client(base),
    secrets: new SecretsManagerClient(base),
    cfn: new CloudFormationClient(base),
    logs: new CloudWatchLogsClient(base),
    iam: new IAMClient(base),
    rds: new RDSClient(base),
    sts,
  };
}

export function bucketName(ctx: AwsCtx): string { return `iso-deploy-${ctx.accountId}-${ctx.region}`; }

export function isNotFound(e: any): boolean {
  const n = e?.name ?? "";
  return /NotFound|NoSuchEntity|ResourceNotFound|NoSuchKey|NoSuchBucket|ValidationError/.test(n) || e?.$metadata?.httpStatusCode === 404;
}

export const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
