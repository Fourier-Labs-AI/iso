import fs from "node:fs";
import os from "node:os";
import path from "node:path";

export function tmpProject(files: Record<string, string>): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "iso-test-"));
  for (const [f, body] of Object.entries(files)) {
    fs.mkdirSync(path.dirname(path.join(dir, f)), { recursive: true });
    fs.writeFileSync(path.join(dir, f), body);
  }
  return dir;
}
export const pkg = (extra: object = {}) => JSON.stringify({ name: "app", scripts: { start: "node server.js" }, dependencies: { express: "^4" }, ...extra });
export const express = `const express=require("express");const app=express();app.get("/",(q,s)=>s.send("hi"));app.listen(process.env.PORT||3000);`;
