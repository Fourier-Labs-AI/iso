import { describe, expect, it } from "vitest";
import fs from "node:fs";
import path from "node:path";
import { execSync } from "node:child_process";
import { pack } from "../src/pack/zip.js";
import { tmpProject, express } from "./helpers.js";

describe("packager", () => {
  it("zips source + generated entry, excludes .env/tests/.git, sets entry", async () => {
    const dir = tmpProject({
      "package.json": JSON.stringify({ name: "a", scripts: { start: "node server.js" } }),
      "server.js": express, ".env": "SECRET=1", "server.test.js": "x", ".git/HEAD": "ref", "railway.json": "{}", "lib/util.js": "module.exports=1",
    });
    const r = await pack({ dir, entryFile: "server.js", skipInstall: true });
    expect(fs.existsSync(r.zipPath)).toBe(true);
    const list = execSync(`unzip -Z1 "${r.zipPath}"`).toString().trim().split("\n").sort();
    expect(list).toEqual(["iso-entry.mjs", "lib/util.js", "package.json", "server.js"]);
    const entry = execSync(`unzip -p "${r.zipPath}" iso-entry.mjs`).toString();
    expect(entry).toContain('const entry = "server.js"');
    expect(entry).toContain("AWS_LAMBDA_HTTP_ENDPOINT");
  });
  it("generated entry sets PORT from AWS_LAMBDA_HTTP_ENDPOINT and boots the app", async () => {
    const dir = tmpProject({ "package.json": JSON.stringify({ name: "a" }), "server.js": `const http=require("http");http.createServer((q,s)=>s.end("pong:"+process.env.PORT)).listen(process.env.PORT, ()=>{ console.log("LISTENING " + process.env.PORT); });` });
    const r = await pack({ dir, entryFile: "server.js", skipInstall: true });
    const out = path.join(dir, "unz"); fs.mkdirSync(out);
    execSync(`unzip -q "${r.zipPath}" -d "${out}"`);
    const log = execSync(`node -e '
      process.env.AWS_LAMBDA_HTTP_ENDPOINT="0.0.0.0:3456";
      import("${out}/iso-entry.mjs").then(async()=>{ await new Promise(r=>setTimeout(r,200)); const t=await (await fetch("http://127.0.0.1:3456/")).text(); console.log(t); process.exit(0); });'`, { cwd: out }).toString();
    expect(log).toContain("LISTENING 3456");
    expect(log).toContain("pong:3456");
  });
});
