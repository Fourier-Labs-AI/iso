import { describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import path from "node:path";
import fs from "node:fs";
import { tmpProject, pkg, express } from "./helpers.js";

const bin = path.resolve(__dirname, "../dist/iso.mjs");
const run = (args: string[], cwd: string, env: Record<string, string> = {}) => execFileSync(process.execPath, [bin, ...args], { cwd, env: { ...process.env, ...env, AWS_ACCESS_KEY_ID: "x", AWS_SECRET_ACCESS_KEY: "y", AWS_PROFILE: "", AWS_EC2_METADATA_DISABLED: "true", NO_COLOR: "1", FORCE_COLOR: "0" }, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });

describe("cli (bundled)", () => {
  it("--version and --help", () => { expect(run(["--version"], process.cwd())).toMatch(/^\d+\.\d+/); expect(run(["--help"], process.cwd())).toContain("migrate"); });
  it("init writes iso.json and nothing else", () => {
    const dir = tmpProject({ "package.json": pkg(), "server.js": express });
    run(["init", "--project", "acme", "--region", "us-east-1", "--yes"], dir);
    const cfg = JSON.parse(fs.readFileSync(path.join(dir, "iso.json"), "utf8"));
    expect(cfg).toMatchObject({ project: "acme", region: "us-east-1", environment: "production", services: { app: { path: "." } } });
    expect(fs.readdirSync(dir).sort()).toEqual(["iso.json", "package.json", "server.js"]);
  });
  it("detect --json gives verdicts; unsupported exits 1", () => {
    const ok = JSON.parse(run(["detect", "--json"], tmpProject({ "package.json": pkg(), "server.js": express })));
    expect(ok[0].verdict).toBe("serverless");
    expect(() => run(["detect"], tmpProject({ "package.json": pkg({ dependencies: { ws: "8" } }), "server.js": express }))).toThrow();
  });
  it("migrate --dry-run touches nothing and exits fast on an unsupported service", () => {
    const dir = tmpProject({ "requirements.txt": "flask", "package.json": JSON.stringify({ name: "py" }) });
    const t = Date.now();
    let err = "";
    try { run(["migrate", "--dry-run", "--yes"], dir); } catch (e: any) { err = e.stderr + e.stdout; }
    expect(Date.now() - t).toBeLessThan(15000);
    expect(err).toMatch(/Nothing was created/);
    expect(fs.existsSync(path.join(dir, "iso.json"))).toBe(false);
  });
  it("cost prints every line item with a fixed total", () => {
    const out = run(["cost"], tmpProject({ "package.json": pkg(), "server.js": express }));
    expect(out).toContain("Secrets Manager");
    expect(out).toMatch(/Fixed monthly cost: \$0\.40/);
  });
  it("unsupported railway verbs print a one-liner", () => {
    expect(() => run(["volume"], process.cwd())).toThrow(/not supported on serverless/);
  });
  it("environment switch", () => {
    const dir = tmpProject({ "package.json": pkg(), "server.js": express });
    run(["init", "--project", "acme", "--yes"], dir);
    run(["environment", "staging"], dir);
    expect(JSON.parse(fs.readFileSync(path.join(dir, "iso.json"), "utf8")).environment).toBe("staging");
  });
});
