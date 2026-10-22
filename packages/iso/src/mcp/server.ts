import path from "node:path";
import { spawn } from "node:child_process";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { detectService } from "../detect/index.js";
import { readIsoConfig, findProjectRoot } from "../config.js";
import { buildConfig } from "../commands/init.js";
import { estimate, fixedMonthly } from "../cost.js";
import { flags } from "../ui.js";

/**
 * Small, safe tool set for agents. Secret VALUES never pass through here:
 * variables_list returns names only; variables_set opens the interactive prompt in the user's terminal.
 */
export async function serveMcp() {
  flags.json = true;
  const server = new McpServer({ name: "iso", version: "0.1.0" });
  const text = (o: unknown) => ({ content: [{ type: "text" as const, text: typeof o === "string" ? o : JSON.stringify(o, null, 2) }] });

  server.tool("iso_detect", "Per-service verdicts (serverless / unsupported) with reasons and line numbers. Touches nothing.", { path: z.string().describe("project directory") }, async ({ path: p }) => {
    const root = path.resolve(p);
    const cfg = readIsoConfig(root) ?? (await buildConfig(root, {}));
    return text(Object.entries(cfg.services).map(([n, s]) => detectService(n, path.resolve(root, s.path))));
  });
  server.tool("iso_plan", "Resources that would be created and the line-item cost estimate. Touches nothing.", { path: z.string() }, async ({ path: p }) => {
    const root = path.resolve(p);
    const cfg = readIsoConfig(root) ?? (await buildConfig(root, {}));
    const lines = estimate(cfg);
    return text({ config: cfg, resources: [`iso-core stack (S3 bucket + policy)`, ...Object.keys(cfg.services).map((s) => `web function ${cfg.project}-${cfg.environment}-${s}`), `secret iso/${cfg.project}/${cfg.environment}`, `execution role iso-${cfg.project}-exec`, ...(cfg.database?.kind === "aurora" ? [`Aurora cluster iso-${cfg.project}`] : [])], cost: lines, fixedMonthly: fixedMonthly(lines) });
  });
  server.tool("iso_deploy", "Run `iso up` for a service/environment. Streams progress as text; returns the URL.", { path: z.string(), service: z.string().optional(), env: z.string().optional() }, async ({ path: p, service, env }) => text(await cli(p, ["up", "--yes", "--json", ...(service ? ["-s", service] : []), ...(env ? ["-e", env] : [])])));
  server.tool("iso_status", "What is deployed, URL, revision, health.", { path: z.string(), env: z.string().optional() }, async ({ path: p, env }) => text(await cli(p, ["status", "--json", ...(env ? ["-e", env] : [])])));
  server.tool("iso_logs", "Recent CloudWatch log lines.", { path: z.string(), env: z.string().optional(), minutes: z.number().optional() }, async ({ path: p, env, minutes }) => text(await cli(p, ["logs", "--json", "--since", String(minutes ?? 30), ...(env ? ["-e", env] : [])])));
  server.tool("iso_variables_list", "Variable NAMES for an environment. Values are never returned.", { path: z.string(), env: z.string().optional() }, async ({ path: p, env }) => text(await cli(p, ["variables", "list", "--json", ...(env ? ["-e", env] : [])])));
  server.tool("iso_variables_set", "Ask the user to enter a secret value in THEIR terminal. The value never passes through the agent.", { path: z.string(), name: z.string(), env: z.string().optional() }, async ({ path: p, name, env }) => text({ instruction: `The agent must not handle secret values. Ask the user to run in their terminal:\n  cd ${p} && iso variables set ${name}${env ? ` -e ${env}` : ""}\n(it prompts for the value with masking and deploys).` }));
  server.tool("iso_doctor", "Diagnostics with one fix per failure.", { path: z.string() }, async ({ path: p }) => text(await cli(p, ["doctor", "--json"])));

  await server.connect(new StdioServerTransport());
}

function cli(cwd: string, args: string[]): Promise<string> {
  return new Promise((resolve) => {
    const child = spawn(process.execPath, [process.argv[1], ...args], { cwd: path.resolve(cwd), env: { ...process.env, CI: "1" }, stdio: ["ignore", "pipe", "pipe"] });
    let out = "", err = "";
    child.stdout.on("data", (d) => (out += d));
    child.stderr.on("data", (d) => (err += d));
    child.on("close", (code) => resolve(code === 0 ? out : `exit ${code}\n${out}\n${err}`));
  });
}
