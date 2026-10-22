import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawnSync } from "node:child_process";
import { Command } from "commander";
import { pluginsPath } from "../paths.js";
import { ui } from "../ui.js";
import { UserError } from "../config.js";

const MARKETPLACE = "Fourier-Labs-AI/iso";

/**
 * Both agents install plugins from a "marketplace" (a git repo with a manifest). This repo is one.
 * We drive the agent's own CLI so the plugin is registered properly; if the CLI is missing we copy the files.
 */
export function pluginCommand(): Command {
  const p = new Command("plugin").description("Install the Claude Code / Codex plugin");
  p.command("install <agent>").description("claude | codex").option("--dir <dir>", "copy the files here instead of using the agent's CLI").option("--local", "register this checkout instead of GitHub (development)").action((agent: string, o) => {
    if (agent !== "claude" && agent !== "codex") throw new UserError(`unknown agent "${agent}"`, "Use claude or codex.");
    const src = pluginsPath(agent);
    if (!fs.existsSync(src)) throw new UserError(`plugin files for ${agent} are missing from this install`);
    const source = o.local ? path.resolve(src, "..", "..") : MARKETPLACE;
    if (o.dir) { copy(src, o.dir); ui.ok(`copied ${agent} plugin files to ${o.dir}`); return; }
    const bin = agent === "claude" ? "claude" : "codex";
    const has = spawnSync(bin, ["--version"], { stdio: "ignore" }).status === 0;
    if (!has) {
      const target = agent === "claude" ? path.join(os.homedir(), ".claude", "plugins", "iso") : path.join(os.homedir(), ".codex", "plugins", "iso");
      copy(src, target);
      ui.warn(`${bin} CLI not found; copied the plugin files to ${target}`);
      ui.info(ui.dim(agent === "claude" ? `In Claude Code: /plugin marketplace add ${MARKETPLACE} then /plugin install railway-to-aws@isomorph` : `In Codex: codex plugin marketplace add ${MARKETPLACE} && codex plugin add railway-to-aws@isomorph`));
      return;
    }
    const steps: string[][] = agent === "claude"
      ? [["plugin", "marketplace", "add", source], ["plugin", "install", "railway-to-aws@isomorph"]]
      : [["plugin", "marketplace", "add", source], ["plugin", "add", "railway-to-aws@isomorph"]];
    for (const args of steps) {
      ui.step(`${bin} ${args.join(" ")}`);
      const r = spawnSync(bin, args, { stdio: "inherit" });
      if (r.status !== 0 && !/marketplace/.test(args.join(" "))) throw new UserError(`${bin} ${args.join(" ")} failed`, "Run the command above by hand to see the error.");
    }
    ui.ok(`${agent} plugin installed · ${agent === "claude" ? "/migrate-railway" : "the migrate-railway skill"} is available in new sessions`);
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
