import { Command } from "commander";
import { createRequire } from "node:module";
import { flags, ui } from "./ui.js";
import { awsCommand } from "./commands/aws.js";
import { initCommand } from "./commands/init.js";
import { upCommand, redeployCommand } from "./commands/up.js";
import { variablesCommand } from "./commands/variables.js";
import { runCommand, shellCommand } from "./commands/run.js";
import { logsCommand } from "./commands/logs.js";
import { statusCommand } from "./commands/status.js";
import { rollbackCommand, downCommand, environmentCommand, serviceCommand, linkCommand, openCommand, unsupportedCommand } from "./commands/lifecycle.js";
import { migrateCommand } from "./commands/migrate.js";
import { addCommand, connectCommand } from "./commands/add.js";
import { doctorCommand } from "./commands/doctor.js";
import { frameworksCommand, costCommand, detectCommand } from "./commands/info.js";
import { domainCommand } from "./commands/domain.js";
import { pluginCommand } from "./commands/plugin.js";

const version: string = (() => { try { return createRequire(import.meta.url)("../package.json").version; } catch { return "0.1.0"; } })();

const program = new Command("iso")
  .description("Railway-shaped deploys to your own AWS on Lambda Web Functions. No account, no backend, your secrets stay with you.")
  .version(version)
  .option("--json", "machine-readable output (for agents)")
  .option("-y, --yes", "answer yes to every prompt (for CI)")
  .hook("preAction", (cmd) => {
    const o = cmd.optsWithGlobals();
    flags.json = !!o.json || process.env.ISO_JSON === "1";
    flags.yes = !!o.yes || process.env.ISO_YES === "1";
  });

program.addCommand(awsCommand());
program.addCommand(migrateCommand());
program.addCommand(initCommand());
program.addCommand(linkCommand());
program.addCommand(upCommand());
program.addCommand(redeployCommand());
program.addCommand(downCommand());
program.addCommand(logsCommand());
program.addCommand(variablesCommand());
program.addCommand(runCommand());
program.addCommand(shellCommand());
program.addCommand(domainCommand());
program.addCommand(environmentCommand());
program.addCommand(serviceCommand());
program.addCommand(statusCommand());
program.addCommand(addCommand());
program.addCommand(connectCommand());
program.addCommand(openCommand());
program.addCommand(doctorCommand());
program.addCommand(rollbackCommand());
program.addCommand(frameworksCommand());
program.addCommand(costCommand());
program.addCommand(detectCommand());
program.addCommand(pluginCommand());
program.command("mcp").description("Run the MCP server (stdio) for Claude Code / Codex").action(async () => { const { serveMcp } = await import("./mcp/server.js"); await serveMcp(); });
program.addCommand(unsupportedCommand("volume", "no persistent volumes on Lambda; use S3"));
program.addCommand(unsupportedCommand("ssh", "no shell into a Web Function; use `iso logs` and `iso run`"));
program.addCommand(unsupportedCommand("deploy", "Railway templates are not supported; `iso up` deploys this repo"));
program.addCommand(unsupportedCommand("completion", "coming in week 1"));
program.addCommand(unsupportedCommand("login", "not needed: AWS credentials are the login (`iso aws connect`)"));

program.parseAsync(process.argv).catch(ui.fail);
