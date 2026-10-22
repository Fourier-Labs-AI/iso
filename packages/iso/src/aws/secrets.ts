import { CreateSecretCommand, DeleteSecretCommand, GetSecretValueCommand, PutSecretValueCommand, TagResourceCommand } from "@aws-sdk/client-secrets-manager";
import { type AwsCtx, isNotFound } from "./clients.js";
import { names } from "../config.js";

export type VarMap = Record<string, string>;

export async function readVars(ctx: AwsCtx, project: string, env: string): Promise<VarMap | null> {
  try {
    const r = await ctx.secrets.send(new GetSecretValueCommand({ SecretId: names.secret(project, env) }));
    return r.SecretString ? (JSON.parse(r.SecretString) as VarMap) : {};
  } catch (e) {
    if (isNotFound(e)) return null;
    throw e;
  }
}

/** Values go straight from the terminal into Secrets Manager. Never to disk. */
export async function writeVars(ctx: AwsCtx, project: string, env: string, vars: VarMap): Promise<{ created: boolean }> {
  const id = names.secret(project, env);
  const SecretString = JSON.stringify(vars);
  try {
    await ctx.secrets.send(new PutSecretValueCommand({ SecretId: id, SecretString }));
    return { created: false };
  } catch (e) {
    if (!isNotFound(e)) throw e;
  }
  await ctx.secrets.send(new CreateSecretCommand({ Name: id, SecretString, Description: `iso variables for ${project}/${env}`, Tags: [{ Key: "iso:project", Value: project }, { Key: "iso:env", Value: env }] }));
  return { created: true };
}

export async function deleteVars(ctx: AwsCtx, project: string, env: string): Promise<boolean> {
  try { await ctx.secrets.send(new DeleteSecretCommand({ SecretId: names.secret(project, env), ForceDeleteWithoutRecovery: true })); return true; }
  catch (e) { if (isNotFound(e)) return false; throw e; }
}
export { TagResourceCommand };
