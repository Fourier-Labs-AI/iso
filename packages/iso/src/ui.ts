import pc from "picocolors";
import { confirm, input, password, select } from "@inquirer/prompts";
import { UserError } from "./config.js";

export const flags = { json: false, yes: false };

export const ui = {
  info: (s: string) => { if (!flags.json) console.log(s); },
  step: (s: string) => { if (!flags.json) console.log(pc.cyan("›") + " " + s); },
  ok: (s: string) => { if (!flags.json) console.log(pc.green("✓") + " " + s); },
  warn: (s: string) => { if (!flags.json) console.log(pc.yellow("!") + " " + s); },
  err: (s: string) => console.error(pc.red("✗") + " " + s),
  dim: (s: string) => pc.dim(s),
  bold: (s: string) => pc.bold(s),
  json: (o: unknown) => console.log(JSON.stringify(o, null, 2)),
  table(rows: string[][]) {
    if (flags.json) return;
    const w = rows[0].map((_, i) => Math.max(...rows.map((r) => (r[i] ?? "").length)));
    for (const r of rows) console.log("  " + r.map((c, i) => (c ?? "").padEnd(w[i])).join("  "));
  },
  async confirm(message: string, def = true): Promise<boolean> {
    if (flags.yes) return true;
    if (!process.stdin.isTTY) return def;
    return confirm({ message, default: def });
  },
  async ask(message: string, def?: string): Promise<string> {
    if (!process.stdin.isTTY) { if (def !== undefined) return def; throw new UserError(`"${message}" needs a terminal.`, "Pass the value as a flag or run interactively."); }
    return input({ message, default: def });
  },
  async secret(message: string): Promise<string> {
    if (!process.stdin.isTTY) throw new UserError(`"${message}" needs a terminal (secret values are never read from files).`, "Run interactively, or `iso variables set KEY=value`.");
    return password({ message, mask: "•" });
  },
  async choose<T extends string>(message: string, choices: { name: string; value: T; description?: string }[], def?: T): Promise<T> {
    if (flags.yes || !process.stdin.isTTY) return def ?? choices[0].value;
    return select({ message, choices, default: def });
  },
  fail(e: unknown): never {
    if (e instanceof UserError) {
      ui.err(e.message);
      if (e.next) console.error(pc.dim("  → " + e.next));
    } else if (e && typeof e === "object" && "name" in e && (e as any).name === "ExitPromptError") {
      process.exit(130);
    } else {
      const err = e as any;
      ui.err(err?.message ?? String(e));
      if (err?.name) console.error(pc.dim(`  (${err.name}) → run \`iso doctor\``));
    }
    process.exit(1);
  },
};

export function ms(n: number): string { return n < 1000 ? `${Math.round(n)}ms` : `${(n / 1000).toFixed(1)}s`; }
