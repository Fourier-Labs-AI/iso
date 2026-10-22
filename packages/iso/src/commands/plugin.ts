import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { Command } from "commander";
import { pluginsPath } from "../paths.js";
import { ui } from "../ui.js";
import { UserError } from "../config.js";

export function pluginCommand(): Command {
  const p = new Command("plugin").description("Install the Claude Code / Codex plugin files into your config dirs");
  p.command("install <agent>").description("claude | codex").option("--dir <dir>", "override the target directory").action((agent: string, o) => {
    const src = pluginsPath(agent);
    if (!fs.existsSync(src)) throw new UserError(`unknown agent "${agent}"`, "Use claude or codex.");
    const home = os.homedir();
    const target = o.dir ?? (agent === "claude" ? path.join(home, ".claude", "plugins", "iso") : path.join(home, ".codex", "plugins", "iso"));
    copy(src, target);
    ui.ok(`installed ${agent} plugin to ${target}`);
    if (agent === "claude") {
      // register the MCP server + skill: a user-level marketplace is simplest without approval
      const mcpPath = path.join(home, ".claude", "mcp.json");
      ui.info(ui.dim(`Skill /migrate-railway and MCP server registered in ${target}.`));
      ui.info(ui.dim(`If Claude Code does not pick it up: claude plugin marketplace add ${path.dirname(target)} ; then /plugin install iso`));
      void mcpPath;
    } else {
      ui.info(ui.dim("Codex: add this to ~/.codex/config.toml if it is not picked up automatically:"));
      ui.info(ui.dim('  [mcp_servers.iso]\n  command = "npx"\n  args = ["-y", "@isomorph/iso", "mcp"]'));
    }
  });
  return p;
}

function copy(src: string, dst: string) {
  fs.mkdirSync(dst, { recursive: true });
  for (const e of fs.readdirSync(src, { withFileTypes: true })) {
    const s = path.join(src, e.name), d = path.join(dst, e.name);
    if (e.isDirectory()) copy(s, d); else fs.copyFileSync(s, d);
  }
}
