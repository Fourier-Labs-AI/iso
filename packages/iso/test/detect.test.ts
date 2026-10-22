import { describe, expect, it } from "vitest";
import { detectService } from "../src/detect/index.js";
import { tmpProject, pkg, express } from "./helpers.js";

const codes = (r: ReturnType<typeof detectService>, sev?: string) => r.findings.filter((f) => !sev || f.severity === sev).map((f) => f.code);

describe("detection", () => {
  it("express app → serverless", () => {
    const r = detectService("api", tmpProject({ "package.json": pkg(), "server.js": express, "railway.json": JSON.stringify({ deploy: { startCommand: "npm start", numReplicas: 1 } }) }));
    expect(r.verdict).toBe("serverless");
    expect(r.framework).toBe("Express");
    expect(r.entryFile).toBe("server.js");
    expect(codes(r, "block")).toEqual([]);
    expect(codes(r, "ok")).toContain("ignored");
  });
  it("python → unsupported, named reason", () => {
    const r = detectService("worker", tmpProject({ "requirements.txt": "flask" }));
    expect(r.verdict).toBe("unsupported");
    expect(r.findings[0].message).toMatch(/Python/);
  });
  it("worker without listen → unsupported with line number", () => {
    const r = detectService("worker", tmpProject({ "package.json": JSON.stringify({ scripts: { start: "node worker.js" } }), "worker.js": `const q = require("x");\n\nsetInterval(() => poll(), 1000);\n` }));
    expect(r.verdict).toBe("unsupported");
    const f = r.findings.find((f) => f.code === "worker")!;
    expect(f.file).toBe("worker.js");
    expect(f.line).toBe(3);
  });
  it("websockets → unsupported", () => {
    expect(detectService("ws", tmpProject({ "package.json": pkg({ dependencies: { express: "4", "socket.io": "4" } }), "server.js": express })).verdict).toBe("unsupported");
  });
  it("fixed port → warn with line, still serverless", () => {
    const r = detectService("api", tmpProject({ "package.json": pkg(), "server.js": `const http=require("http");\nhttp.createServer((q,s)=>s.end("x")).listen(8080);\n` }));
    expect(r.verdict).toBe("serverless");
    expect(r.findings.find((f) => f.code === "fixed-port")).toMatchObject({ severity: "warn", line: 2 });
  });
  it("loopback bind → block", () => {
    const r = detectService("api", tmpProject({ "package.json": pkg(), "server.js": `require("express")().listen(3000, "127.0.0.1");` }));
    expect(codes(r, "block")).toContain("loopback-bind");
  });
  it("cron schedule → block; dockerfile only → block", () => {
    expect(codes(detectService("c", tmpProject({ "package.json": pkg(), "server.js": express, "railway.json": JSON.stringify({ deploy: { cronSchedule: "0 0 * * *" } }) })), "block")).toContain("cron");
    expect(codes(detectService("d", tmpProject({ "package.json": JSON.stringify({ name: "x" }), "Dockerfile": "FROM node", "railway.json": JSON.stringify({ build: { builder: "DOCKERFILE" } }) })), "block")).toContain("dockerfile-only");
  });
  it("next without standalone → block; with standalone → warn", () => {
    expect(codes(detectService("web", tmpProject({ "package.json": pkg({ dependencies: { next: "15" }, scripts: { start: "next start" } }), "next.config.js": "module.exports={}" })), "block")).toContain("next-not-standalone");
    const ok = detectService("web", tmpProject({ "package.json": pkg({ dependencies: { next: "15" }, scripts: { start: "next start" } }), "next.config.js": "module.exports={output:'standalone'}" }));
    expect(ok.verdict).toBe("serverless");
  });
  it("native deps + old node → warnings", () => {
    const r = detectService("api", tmpProject({ "package.json": pkg({ dependencies: { express: "4", sharp: "0.33" }, engines: { node: "18.x" } }), "server.js": express }));
    expect(codes(r, "warn")).toEqual(expect.arrayContaining(["native-deps", "node-old"]));
  });
  it("finds env names and DATABASE_URL", () => {
    const r = detectService("api", tmpProject({ "package.json": pkg(), "server.js": express + `const u=process.env.DATABASE_URL;`, ".env.example": "STRIPE_KEY=\n" }));
    expect(r.envNames).toEqual(["DATABASE_URL", "STRIPE_KEY"]);
    expect(r.databaseReferenced).toBe(true);
  });
});
