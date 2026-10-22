import crypto from "node:crypto";
import { Command } from "commander";
import { ACMClient, RequestCertificateCommand, DescribeCertificateCommand } from "@aws-sdk/client-acm";
import { CloudFrontClient, CreateDistributionCommand, ListDistributionsCommand, GetDistributionConfigCommand, UpdateDistributionCommand, DeleteDistributionCommand } from "@aws-sdk/client-cloudfront";
import { loadCtx, fnName } from "../context.js";
import { getEndpoint } from "../aws/lambdaweb.js";
import { readVars, writeVars } from "../aws/secrets.js";
import { up } from "../deploy.js";
import { writeIsoConfig, UserError } from "../config.js";
import { sleep } from "../aws/clients.js";
import { ui, flags } from "../ui.js";

const ALL_VIEWER_EXCEPT_HOST = "b689b0a8-53d0-40ab-baf2-68738e2966ac"; // managed origin request policy
const CACHING_DISABLED = "4135ea2d-6df8-44a3-9df3-4b5a84be39ad";

export function domainCommand(): Command {
  const d = new Command("domain").description("Custom domains via CloudFront + ACM (free tier)");
  d.command("add <host>").description("Request a cert, create a CloudFront distribution in front of the endpoint, print the CNAMEs")
    .option("-e, --env <env>").option("-s, --service <name>")
    .action(async (host: string, o) => {
      const c = await loadCtx(o);
      const ep = await getEndpoint(c.aws, fnName(c));
      if (!ep) throw new UserError("deploy first", "iso up");
      const acm = new ACMClient({ region: "us-east-1" });
      const cf = new CloudFrontClient({ region: "us-east-1" });
      ui.info("About to create: ACM certificate (free) + CloudFront distribution (free tier: 1 TB, 10M req/mo). Fixed cost $0.");
      if (!(await ui.confirm("Continue?"))) return;
      const cert = await acm.send(new RequestCertificateCommand({ DomainName: host, ValidationMethod: "DNS", Tags: [{ Key: "iso:project", Value: c.cfg.project }] }));
      let rec;
      for (let i = 0; i < 30 && !rec; i++) { await sleep(3000); rec = (await acm.send(new DescribeCertificateCommand({ CertificateArn: cert.CertificateArn }))).Certificate?.DomainValidationOptions?.[0]?.ResourceRecord; }
      if (!rec) throw new Error("ACM did not return a validation record");
      ui.info("");
      ui.info(ui.bold("1. Add this DNS record to validate the certificate:"));
      ui.info(`   ${rec.Name}  CNAME  ${rec.Value}`);
      ui.step("waiting for the certificate to be issued (can take a few minutes after the record is live)…");
      for (;;) {
        await sleep(15000);
        const s = (await acm.send(new DescribeCertificateCommand({ CertificateArn: cert.CertificateArn }))).Certificate?.Status;
        if (s === "ISSUED") break;
        if (s === "FAILED" || s === "VALIDATION_TIMED_OUT") throw new UserError(`certificate ${s}`, "Check the CNAME and run `iso domain add` again.");
      }
      ui.ok("certificate issued");
      // origin secret so direct hits on the lambda domain are rejected by the generated entry
      const vars = (await readVars(c.aws, c.cfg.project, c.env)) ?? {};
      if (!vars.ISO_ORIGIN_SECRET) { vars.ISO_ORIGIN_SECRET = crypto.randomBytes(24).toString("hex"); await writeVars(c.aws, c.cfg.project, c.env, vars); }
      const dist = await cf.send(new CreateDistributionCommand({ DistributionConfig: {
        CallerReference: `iso-${host}-${Date.now()}`, Comment: `iso ${c.cfg.project}/${c.env}/${c.service}`, Enabled: true, Aliases: { Quantity: 1, Items: [host] },
        Origins: { Quantity: 1, Items: [{ Id: "lambda-web", DomainName: ep.domainName!, CustomOriginConfig: { HTTPPort: 80, HTTPSPort: 443, OriginProtocolPolicy: "https-only", OriginSslProtocols: { Quantity: 1, Items: ["TLSv1.2"] }, OriginReadTimeout: 60 }, CustomHeaders: { Quantity: 1, Items: [{ HeaderName: "x-iso-origin-secret", HeaderValue: vars.ISO_ORIGIN_SECRET }] } }] },
        DefaultCacheBehavior: { TargetOriginId: "lambda-web", ViewerProtocolPolicy: "redirect-to-https", AllowedMethods: { Quantity: 7, Items: ["GET", "HEAD", "OPTIONS", "PUT", "POST", "PATCH", "DELETE"], CachedMethods: { Quantity: 2, Items: ["GET", "HEAD"] } }, CachePolicyId: CACHING_DISABLED, OriginRequestPolicyId: ALL_VIEWER_EXCEPT_HOST, Compress: true },
        ViewerCertificate: { ACMCertificateArn: cert.CertificateArn, SSLSupportMethod: "sni-only", MinimumProtocolVersion: "TLSv1.2_2021" },
        HttpVersion: "http2and3", PriceClass: "PriceClass_100",
      } }));
      const cfDomain = dist.Distribution!.DomainName!;
      c.cfg.domains = { ...(c.cfg.domains ?? {}), [c.env]: [...new Set([...(c.cfg.domains?.[c.env] ?? []), host])] };
      writeIsoConfig(c.root, c.cfg);
      ui.step("redeploying so the origin secret is enforced");
      await up(c, { skipDetect: true });
      ui.info("");
      ui.info(ui.bold("2. Point your domain at CloudFront:"));
      ui.info(`   ${host}  CNAME  ${cfDomain}`);
      ui.info(ui.dim("   (apex domains: use an ALIAS/ANAME record, or Route 53)"));
      if (flags.json) ui.json({ host, cloudfront: cfDomain, certificate: cert.CertificateArn, validation: rec });
    });
  d.command("list").description("Domains for this project").action(async () => {
    const c = await loadCtx({});
    const cf = new CloudFrontClient({ region: "us-east-1" });
    const l = await cf.send(new ListDistributionsCommand({}));
    const mine = (l.DistributionList?.Items ?? []).filter((d) => d.Comment?.startsWith(`iso ${c.cfg.project}/`));
    if (flags.json) return ui.json(mine.map((d) => ({ id: d.Id, domain: d.DomainName, aliases: d.Aliases?.Items, status: d.Status })));
    for (const d of mine) ui.info(`${(d.Aliases?.Items ?? []).join(", ")}  →  ${d.DomainName}  (${d.Status})`);
    if (!mine.length) ui.info("(none)");
  });
  d.command("remove <host>").description("Disable and delete the distribution").action(async (host: string) => {
    const c = await loadCtx({});
    const cf = new CloudFrontClient({ region: "us-east-1" });
    const l = await cf.send(new ListDistributionsCommand({}));
    const d = (l.DistributionList?.Items ?? []).find((x) => x.Aliases?.Items?.includes(host));
    if (!d) throw new UserError(`no distribution for ${host}`);
    const cfg = await cf.send(new GetDistributionConfigCommand({ Id: d.Id }));
    if (cfg.DistributionConfig!.Enabled) { cfg.DistributionConfig!.Enabled = false; await cf.send(new UpdateDistributionCommand({ Id: d.Id, IfMatch: cfg.ETag, DistributionConfig: cfg.DistributionConfig })); ui.ok("distribution disabled; it can be deleted once CloudFront reports Deployed (run again)"); return; }
    await cf.send(new DeleteDistributionCommand({ Id: d.Id, IfMatch: cfg.ETag }));
    for (const env of Object.keys(c.cfg.domains ?? {})) c.cfg.domains![env] = c.cfg.domains![env].filter((h) => h !== host);
    writeIsoConfig(c.root, c.cfg);
    ui.ok("distribution deleted");
  });
  return d;
}
