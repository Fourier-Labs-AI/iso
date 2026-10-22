import fs from "node:fs";
import { PutObjectCommand, HeadBucketCommand } from "@aws-sdk/client-s3";
import { type AwsCtx, bucketName } from "./clients.js";
import { UserError } from "../config.js";

export async function ensureBucket(ctx: AwsCtx): Promise<string> {
  const b = bucketName(ctx);
  try { await ctx.s3.send(new HeadBucketCommand({ Bucket: b })); return b; }
  catch { throw new UserError(`Deploy bucket ${b} not found in ${ctx.region}.`, "Run `iso aws connect` first."); }
}

export async function uploadZip(ctx: AwsCtx, key: string, zipPath: string, tags: Record<string, string>): Promise<{ bucket: string; key: string; versionId: string; bytes: number }> {
  const bucket = bucketName(ctx);
  const body = fs.readFileSync(zipPath);
  const r = await ctx.s3.send(new PutObjectCommand({
    Bucket: bucket, Key: key, Body: body, ContentType: "application/zip",
    Tagging: Object.entries(tags).map(([k, v]) => `${encodeURIComponent(k)}=${encodeURIComponent(v)}`).join("&"),
  }));
  if (!r.VersionId) throw new Error(`bucket ${bucket} returned no versionId: versioning must be enabled`);
  return { bucket, key, versionId: r.VersionId, bytes: body.length };
}
