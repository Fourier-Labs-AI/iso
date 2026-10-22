import { Command } from "commander";
import { loadCtx } from "../context.js";
import { up, previousRevision } from "../deploy.js";
import { getRevision } from "../aws/lambdaweb.js";
import { fnName } from "../context.js";
import { ui, flags } from "../ui.js";
import { UserError } from "../config.js";

export function upCommand(): Command {
  return new Command("up")
    .description("Deploy the current directory: zip → S3 → revision → smoke test → live")
    .option("-e, --env <env>", "environment (default: iso.json)")
    .option("-s, --service <name>", "service (multi-service repos)")
    .option("--skip-detect", "skip blocker detection")
    .option("--skip-install", "do not run npm ci (use existing node_modules)")
    .option("--build-in-docker", "run install/build in an arm64 Node 24 container (native deps)")
    .option("--no-smoke", "skip the post-deploy health check")
    .action(async (o) => {
      const c = await loadCtx(o);
      const r = await up(c, { skipDetect: o.skipDetect, skipInstall: o.skipInstall, buildInDocker: o.buildInDocker, noSmoke: o.smoke === false });
      if (flags.json) ui.json(r);
    });
}

export function redeployCommand(): Command {
  return new Command("redeploy")
    .description("New revision from the same S3 object as the live one (no rebuild)")
    .option("-e, --env <env>").option("-s, --service <name>")
    .action(async (o) => {
      const c = await loadCtx(o);
      const { current } = await previousRevision(c);
      if (!current) throw new UserError("nothing is deployed yet", "Run `iso up`.");
      const rev = await getRevision(c.aws, fnName(c), current);
      const s3 = rev.buildConfig!.codeConfig!.s3Object!;
      const r = await up(c, { skipDetect: true, reuse: { bucket: s3.bucket!, key: s3.key!, versionId: s3.versionId! } });
      if (flags.json) ui.json(r);
    });
}
