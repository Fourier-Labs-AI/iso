import { Command } from "commander";
import { loadCtx, fnName } from "../context.js";
import { names } from "../config.js";
import { ensureLogGroup, formatLog, recentLogs, tailLogs } from "../aws/logs.js";
import { ui, flags } from "../ui.js";

export function logsCommand(): Command {
  return new Command("logs")
    .description("CloudWatch logs for the service")
    .option("-e, --env <env>").option("-s, --service <name>")
    .option("-t, --tail", "follow (live tail)")
    .option("-n, --lines <n>", "number of lines", "100")
    .option("--since <minutes>", "look back N minutes", "60")
    .option("--filter <pattern>", "CloudWatch filter pattern")
    .action(async (o) => {
      const c = await loadCtx(o);
      const group = names.logGroup(fnName(c));
      const since = Date.now() - parseInt(o.since, 10) * 60_000;
      const lines = await recentLogs(c.aws, group, { since, limit: parseInt(o.lines, 10), filter: o.filter });
      if (flags.json) ui.json(lines);
      else for (const l of lines) console.log(formatLog(l));
      if (!o.tail) { if (!lines.length && !flags.json) ui.info(ui.dim(`no log events in the last ${o.since} min (${group})`)); return; }
      const { arn } = await ensureLogGroup(c.aws, group);
      ui.info(ui.dim(`tailing ${group} · ctrl-c to stop`));
      await tailLogs(c.aws, arn, group, (l) => console.log(flags.json ? JSON.stringify(l) : formatLog(l)), o.filter);
    });
}
