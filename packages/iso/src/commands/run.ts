import { spawn } from "node:child_process";
import { Command } from "commander";
import { loadCtx } from "../context.js";
import { readVars } from "../aws/secrets.js";
import { resolveMap } from "../railway/refs.js";
import { getEndpoint } from "../aws/lambdaweb.js";
import { fnName } from "../context.js";
import { ui } from "../ui.js";

async function envFor(o: any): Promise<NodeJS.ProcessEnv> {
  const c = await loadCtx(o);
  const vars = (await readVars(c.aws, c.cfg.project, c.env)) ?? {};
  const ep = await getEndpoint(c.aws, fnName(c)).catch(() => null);
  const r = resolveMap(vars, { env: c.env, endpointHost: ep?.domainName ?? undefined });
  return { ...process.env, ...r.vars, ISO_ENV: c.env, PORT: process.env.PORT ?? "3000" };
}

export function runCommand(): Command {
  return new Command("run")
    .description("Run a command locally with the environment's variables injected (values never written to disk)")
    .option("--env <env>").option("--service <name>")
    .argument("<cmd...>", "command to run (use `--` before flags: iso run -- node -e ...)")
    .allowUnknownOption().allowExcessArguments()
    .action(async (cmd: string[], o) => {
      const env = await envFor(o);
      const child = spawn(cmd[0], cmd.slice(1), { stdio: "inherit", env, shell: process.platform === "win32" });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}

export function shellCommand(): Command {
  return new Command("shell")
    .description("Open $SHELL with the environment's variables injected")
    .option("-e, --env <env>").option("-s, --service <name>")
    .action(async (o) => {
      const env = await envFor(o);
      const sh = process.env.SHELL || "/bin/sh";
      ui.info(ui.dim(`iso shell (${env.ISO_ENV}) · exit to leave`));
      const child = spawn(sh, [], { stdio: "inherit", env });
      child.on("exit", (code) => process.exit(code ?? 0));
    });
}
