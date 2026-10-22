import fs from "node:fs";
import { CreateStackCommand, DescribeStacksCommand, UpdateStackCommand } from "@aws-sdk/client-cloudformation";
import { type AwsCtx, isNotFound, sleep } from "./clients.js";
import { templatePath } from "../paths.js";
import { CORE_STACK } from "../config.js";
import { ui } from "../ui.js";

export async function coreStackStatus(ctx: AwsCtx): Promise<{ status: string; bucket?: string } | null> {
  try {
    const r = await ctx.cfn.send(new DescribeStacksCommand({ StackName: CORE_STACK }));
    const s = r.Stacks?.[0];
    if (!s) return null;
    return { status: s.StackStatus ?? "UNKNOWN", bucket: s.Outputs?.find((o) => o.OutputKey === "BucketName")?.OutputValue };
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

export async function ensureCoreStack(ctx: AwsCtx): Promise<string> {
  const existing = await coreStackStatus(ctx);
  const body = fs.readFileSync(templatePath("iso-core.yaml"), "utf8");
  if (existing && /COMPLETE$/.test(existing.status) && !/ROLLBACK|DELETE/.test(existing.status)) {
    try {
      await ctx.cfn.send(new UpdateStackCommand({ StackName: CORE_STACK, TemplateBody: body, Tags: [{ Key: "iso:managed", Value: "true" }] }));
      ui.step("updating iso-core stack");
    } catch (e: any) {
      if (!/No updates are to be performed/.test(e?.message ?? "")) throw e;
      return existing.bucket!;
    }
  } else if (!existing) {
    ui.step("creating iso-core stack (versioned S3 bucket + Lambda read policy) · fixed cost $0/month");
    await ctx.cfn.send(new CreateStackCommand({ StackName: CORE_STACK, TemplateBody: body, Tags: [{ Key: "iso:managed", Value: "true" }] }));
  } else if (/IN_PROGRESS/.test(existing.status)) {
    ui.step(`iso-core stack is ${existing.status}; waiting`);
  } else {
    throw new Error(`iso-core stack is in state ${existing.status}. Delete it in CloudFormation and run \`iso aws connect\` again.`);
  }
  for (let i = 0; i < 120; i++) {
    await sleep(3000);
    const s = await coreStackStatus(ctx);
    if (!s) continue;
    if (/COMPLETE$/.test(s.status) && !/ROLLBACK/.test(s.status)) return s.bucket!;
    if (/FAILED|ROLLBACK_COMPLETE/.test(s.status)) throw new Error(`iso-core stack ${s.status}. Check CloudFormation events in the console.`);
  }
  throw new Error("timed out waiting for iso-core stack");
}
