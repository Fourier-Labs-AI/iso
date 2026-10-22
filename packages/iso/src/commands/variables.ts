import { Command } from "commander";
import { loadCtx } from "../context.js";
import { readVars, writeVars } from "../aws/secrets.js";
import { up } from "../deploy.js";
import { names, UserError } from "../config.js";
import { ui, flags } from "../ui.js";

export function variablesCommand(): Command {
  const v = new Command("variables").alias("vars").description("Environment variables (Secrets Manager, one secret per environment)");
  const envOpt = (c: Command) => c.option("-e, --env <env>").option("-s, --service <name>");
  envOpt(v.command("list", { isDefault: true }).description("List variable names (values never printed unless --values)"))
    .option("--values", "print values too")
    .action(async (o) => {
      const c = await loadCtx(o);
      const vars = (await readVars(c.aws, c.cfg.project, c.env)) ?? {};
      if (flags.json) return ui.json(o.values ? vars : Object.keys(vars));
      ui.info(ui.dim(`${names.secret(c.cfg.project, c.env)}`));
      for (const k of Object.keys(vars).sort()) ui.info(`  ${k}${o.values ? "=" + vars[k] : ""}`);
      if (!Object.keys(vars).length) ui.info("  (none)");
    });
  envOpt(v.command("set <KEY=value...>").description("Set variables and deploy a new revision"))
    .option("--no-deploy", "update the secret only")
    .option("--prompt", "prompt for each value instead of passing it on the command line")
    .action(async (pairs: string[], o) => {
      const c = await loadCtx(o);
      const vars = (await readVars(c.aws, c.cfg.project, c.env)) ?? {};
      for (const p of pairs) {
        const i = p.indexOf("=");
        const key = i === -1 ? p : p.slice(0, i);
        if (!/^[A-Za-z_][A-Za-z0-9_]*$/.test(key)) throw new UserError(`invalid variable name "${key}"`);
        vars[key] = i === -1 || o.prompt ? await ui.secret(`Value for ${key}`) : p.slice(i + 1);
      }
      await writeVars(c.aws, c.cfg.project, c.env, vars);
      ui.ok(`${pairs.length} variable(s) saved to ${names.secret(c.cfg.project, c.env)}`);
      if (o.deploy !== false) await up(c, { skipDetect: true });
    });
  envOpt(v.command("delete <KEY...>").alias("unset").description("Delete variables and deploy a new revision"))
    .option("--no-deploy")
    .action(async (keys: string[], o) => {
      const c = await loadCtx(o);
      const vars = (await readVars(c.aws, c.cfg.project, c.env)) ?? {};
      for (const k of keys) delete vars[k];
      await writeVars(c.aws, c.cfg.project, c.env, vars);
      ui.ok(`deleted ${keys.join(", ")}`);
      if (o.deploy !== false) await up(c, { skipDetect: true });
    });
  return v;
}
