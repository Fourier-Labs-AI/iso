import { AttachRolePolicyCommand, CreateRoleCommand, GetRoleCommand, PutRolePolicyCommand, CreateOpenIDConnectProviderCommand, ListOpenIDConnectProvidersCommand } from "@aws-sdk/client-iam";
import { type AwsCtx, isNotFound, sleep } from "./clients.js";
import { names } from "../config.js";

/** One execution role per project: logs + GetSecretValue on the project's own secrets. Nothing else. */
export async function ensureExecutionRole(ctx: AwsCtx, project: string): Promise<{ arn: string; created: boolean }> {
  const roleName = names.role(project);
  try {
    const r = await ctx.iam.send(new GetRoleCommand({ RoleName: roleName }));
    return { arn: r.Role!.Arn!, created: false };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Service: "lambda.amazonaws.com" }, Action: "sts:AssumeRole" }] };
  const r = await ctx.iam.send(new CreateRoleCommand({
    RoleName: roleName,
    AssumeRolePolicyDocument: JSON.stringify(trust),
    Description: `iso execution role for project ${project}`,
    Tags: [{ Key: "iso:project", Value: project }],
  }));
  await ctx.iam.send(new PutRolePolicyCommand({
    RoleName: roleName,
    PolicyName: "iso-least-privilege",
    PolicyDocument: JSON.stringify({
      Version: "2012-10-17",
      Statement: [
        { Effect: "Allow", Action: ["logs:CreateLogGroup", "logs:CreateLogStream", "logs:PutLogEvents"], Resource: `arn:aws:logs:${ctx.region}:${ctx.accountId}:log-group:/aws/lambda/web/${project}-*` },
        { Effect: "Allow", Action: ["secretsmanager:GetSecretValue"], Resource: `arn:aws:secretsmanager:${ctx.region}:${ctx.accountId}:secret:iso/${project}/*` },
      ],
    }),
  }));
  // IAM is eventually consistent; Lambda may reject the role for a few seconds.
  await sleep(8000);
  return { arn: r.Role!.Arn!, created: true };
}

/** GitHub OIDC deploy role for `iso aws connect --ci`. */
export async function ensureDeployRole(ctx: AwsCtx, repo: string): Promise<string> {
  const roleName = "iso-deploy";
  const providerArn = `arn:aws:iam::${ctx.accountId}:oidc-provider/token.actions.githubusercontent.com`;
  const list = await ctx.iam.send(new ListOpenIDConnectProvidersCommand({}));
  if (!list.OpenIDConnectProviderList?.some((p) => p.Arn === providerArn)) {
    await ctx.iam.send(new CreateOpenIDConnectProviderCommand({ Url: "https://token.actions.githubusercontent.com", ClientIDList: ["sts.amazonaws.com"], ThumbprintList: ["6938fd4d98bab03faadb97b34396831e3780aea1"] }));
  }
  const trust = { Version: "2012-10-17", Statement: [{ Effect: "Allow", Principal: { Federated: providerArn }, Action: "sts:AssumeRoleWithWebIdentity", Condition: { StringEquals: { "token.actions.githubusercontent.com:aud": "sts.amazonaws.com" }, StringLike: { "token.actions.githubusercontent.com:sub": `repo:${repo}:*` } } }] };
  try {
    const r = await ctx.iam.send(new GetRoleCommand({ RoleName: roleName }));
    return r.Role!.Arn!;
  } catch (e) { if (!isNotFound(e)) throw e; }
  const r = await ctx.iam.send(new CreateRoleCommand({ RoleName: roleName, AssumeRolePolicyDocument: JSON.stringify(trust), Description: "iso CI deploy role (GitHub OIDC)" }));
  await ctx.iam.send(new PutRolePolicyCommand({ RoleName: roleName, PolicyName: "iso-deploy", PolicyDocument: JSON.stringify(deployPolicy(ctx)) }));
  return r.Role!.Arn!;
}

export function deployPolicy(ctx: AwsCtx) {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["lambda:*WebFunction*", "lambda:ListTags", "lambda:TagResource", "lambda:GetWebAccountSettings"], Resource: "*" },
      { Effect: "Allow", Action: ["s3:PutObject", "s3:GetObject", "s3:GetObjectVersion", "s3:ListBucket", "s3:GetBucketVersioning"], Resource: [`arn:aws:s3:::iso-deploy-${ctx.accountId}-*`, `arn:aws:s3:::iso-deploy-${ctx.accountId}-*/*`] },
      { Effect: "Allow", Action: ["secretsmanager:*"], Resource: `arn:aws:secretsmanager:*:${ctx.accountId}:secret:iso/*` },
      { Effect: "Allow", Action: ["iam:PassRole", "iam:GetRole", "iam:CreateRole", "iam:PutRolePolicy"], Resource: `arn:aws:iam::${ctx.accountId}:role/iso-*` },
      { Effect: "Allow", Action: ["logs:*"], Resource: `arn:aws:logs:*:${ctx.accountId}:log-group:/aws/lambda/web/*` },
      { Effect: "Allow", Action: ["cloudformation:DescribeStacks"], Resource: "*" },
      { Effect: "Allow", Action: ["sts:GetCallerIdentity"], Resource: "*" },
    ],
  };
}

/** The admin policy we ask a brand-new user to attach: everything iso uses, nothing else. */
export function adminPolicy(accountId: string) {
  return {
    Version: "2012-10-17",
    Statement: [
      { Effect: "Allow", Action: ["lambda:*"], Resource: "*" },
      { Effect: "Allow", Action: ["s3:*"], Resource: [`arn:aws:s3:::iso-deploy-${accountId}-*`, `arn:aws:s3:::iso-deploy-${accountId}-*/*`] },
      { Effect: "Allow", Action: ["secretsmanager:*"], Resource: `arn:aws:secretsmanager:*:${accountId}:secret:iso/*` },
      { Effect: "Allow", Action: ["iam:*Role*", "iam:*OpenIDConnectProvider*", "iam:PassRole"], Resource: "*" },
      { Effect: "Allow", Action: ["cloudformation:*"], Resource: `arn:aws:cloudformation:*:${accountId}:stack/iso-*/*` },
      { Effect: "Allow", Action: ["logs:*", "rds:*", "ec2:Describe*", "ec2:*SecurityGroup*", "acm:*", "cloudfront:*", "ce:GetCostAndUsage", "sts:GetCallerIdentity"], Resource: "*" },
    ],
  };
}
