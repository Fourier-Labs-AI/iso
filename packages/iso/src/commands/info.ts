import { Command } from "commander";
import { SUPPORTED_FRAMEWORKS, UNSUPPORTED_V1, detectService } from "../detect/index.js";
import { readIsoConfig, findProjectRoot } from "../config.js";
import { printCost, printVerdicts } from "./migrate.js";
import { buildConfig } from "./init.js";
import { estimate } from "../cost.js";
import { ui, flags } from "../ui.js";
import path from "node:path";

export function frameworksCommand(): Command {
  return new Command("frameworks").description("What runs on serverless today, and what does not").action(() => {
    if (flags.json) return ui.json({ supported: Object.values(SUPPORTED_FRAMEWORKS).concat("plain node:http"), unsupported: UNSUPPORTED_V1 });
    ui.info(ui.bold("Supported (Node.js 24, arm64, Lambda Web Functions)"));
    for (const f of Object.values(SUPPORTED_FRAMEWORKS)) ui.info(`  ✓ ${f}`);
    ui.info("  ✓ plain node:http server");
    ui.info("");
    ui.info(ui.bold("Not in v1"));
    for (const u of UNSUPPORTED_V1) ui.info(`  ✗ ${u}`);
  });
}

export function costCommand(): Command {
  return new Command("cost").description("Line-item cost estimate for this project").action(async () => {
    const cfg = readIsoConfig(findProjectRoot()) ?? (await buildConfig(process.cwd(), {}));
    if (flags.json) return ui.json(estimate(cfg));
    printCost(cfg);
  });
}

export function detectCommand(): Command {
  return new Command("detect").description("Per-service verdicts with line numbers; touches nothing").action(async () => {
    const root = findProjectRoot();
    const cfg = readIsoConfig(root) ?? (await buildConfig(process.cwd(), {}));
    const results = Object.entries(cfg.services).map(([n, s]) => detectService(n, path.resolve(root, s.path)));
    if (flags.json) return ui.json(results);
    printVerdicts(results);
    if (results.some((r) => r.verdict !== "serverless")) process.exit(1);
  });
}
