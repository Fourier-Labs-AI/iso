import { Command } from "commander";
import { execSync } from "node:child_process";
import { awsCtx } from "../aws/clients.js";
import { ensureCoreStack } from "../aws/cfn.js";
import { adminPolicy, ensureDeployRole } from "../aws/iam.js";
import { DEFAULT_REGION, SUPPORTED_REGIONS, readIsoConfig, UserError } from "../config.js";
import { ui, flags } from "../ui.js";

export function awsCommand(): Command {
  const aws = new Command("aws").description("AWS account setup");
  aws.command("connect")
    .description("Detect credentials, verify with STS, create the $0 iso-core stack (bucket + policy)")
    .option("--region <region>", "AWS region", process.env.AWS_REGION ?? readIsoConfig()?.region ?? DEFAULT_REGION)
    .option("--profile <profile>", "AWS profile")
    .option("--ci <owner/repo>", "also create the GitHub OIDC deploy role for this repo")
    .action(async (o) => {
      if (!SUPPORTED_REGIONS.includes(o.region)) ui.warn(`${o.region} is not a Lambda Web Functions launch region (${SUPPORTED_REGIONS.join(", ")}); trying anyway`);
      let ctx;
      try {
        ctx = await awsCtx(o.region, o.profile);
      } catch (e) {
        ui.err("No AWS credentials found.");
        ui.info("");
        ui.info("Three ways to get them:");
        ui.info("  1. AWS SSO:        aws configure sso   (then: iso aws connect --profile <name>)");
        ui.info("  2. Existing keys:  aws configure");
        ui.info("  3. Nothing yet:    create an IAM user with this policy, then `aws configure`:");
        ui.info("     https://console.aws.amazon.com/iam/home#/users/create");
        ui.info(JSON.stringify(adminPolicy("<your-account-id>"), null, 2).split("\n").map((l) => "     " + l).join("\n"));
        throw new UserError("Credentials are the login; iso has no account of its own.", "Run `iso aws connect` again once `aws sts get-caller-identity` works.");
      }
      ui.ok(`AWS account ${ctx.accountId} (${ctx.arn}) · region ${ctx.region}`);
      ui.info("");
      ui.info("About to create (CloudFormation stack `iso-core`):");
      ui.table([["  S3 bucket", `iso-deploy-${ctx.accountId}-${ctx.region}`, "versioned, last 10 versions kept", "~$0/mo"], ["  Bucket policy", "lambda.amazonaws.com read", "scoped to this account's web functions", "$0"]]);
      ui.info("  No VPC, no NAT, no network connector. Fixed cost: $0/month.");
      if (!(await ui.confirm("Create it?"))) return;
      const bucket = await ensureCoreStack(ctx);
      ui.ok(`iso-core ready · bucket ${bucket}`);
      if (o.ci) {
        const arn = await ensureDeployRole(ctx, o.ci);
        ui.ok(`deploy role ${arn} trusts GitHub repo ${o.ci} via OIDC`);
      }
      if (flags.json) ui.json({ accountId: ctx.accountId, region: ctx.region, bucket });
      else ui.info(ui.dim("\nNext: cd your-app && iso migrate   (or iso init && iso up)"));
    });
  aws.command("whoami").description("Print the AWS identity iso will use").action(async (o, cmd) => {
    const cfg = readIsoConfig();
    const ctx = await awsCtx(cfg?.region ?? DEFAULT_REGION, cfg?.profile);
    if (flags.json) ui.json({ accountId: ctx.accountId, arn: ctx.arn, region: ctx.region });
    else ui.info(`${ctx.arn} · ${ctx.region}`);
  });
  return aws;
}
export { execSync };
