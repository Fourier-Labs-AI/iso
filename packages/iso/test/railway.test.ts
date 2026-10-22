import { describe, expect, it } from "vitest";
import { readRailwayConfig } from "../src/railway/parse.js";
import { resolveStart } from "../src/railway/start.js";
import { resolveMap, resolveRefs, listRefs, isUnknownRailwayVar } from "../src/railway/refs.js";
import { discoverEnvNames } from "../src/railway/envnames.js";
import { tmpProject, pkg, express } from "./helpers.js";

describe("railway.json / railway.toml", () => {
  it("reads railway.json as-is and lists ignored fields", () => {
    const dir = tmpProject({ "railway.json": JSON.stringify({ build: { builder: "NIXPACKS", buildCommand: "npm run build" }, deploy: { startCommand: "node dist/server.js", healthcheckPath: "/health", numReplicas: 2, sleepApplication: true, restartPolicyType: "ON_FAILURE" } }) });
    const c = readRailwayConfig(dir);
    expect(c.source).toBe("railway.json");
    expect(c.build.buildCommand).toBe("npm run build");
    expect(c.deploy.startCommand).toBe("node dist/server.js");
    expect(c.deploy.healthcheckPath).toBe("/health");
    expect(c.ignored).toEqual(["deploy.numReplicas", "deploy.sleepApplication", "deploy.restartPolicyType"]);
  });
  it("reads railway.toml", () => {
    const dir = tmpProject({ "railway.toml": `[build]\nbuilder = "RAILPACK"\n[deploy]\nstartCommand = "npm start"\nhealthcheckPath = "/"\ncronSchedule = "0 * * * *"\n` });
    const c = readRailwayConfig(dir);
    expect(c.source).toBe("railway.toml");
    expect(c.build.builder).toBe("RAILPACK");
    expect(c.deploy.cronSchedule).toBe("0 * * * *");
  });
  it("defaults when there is no config", () => {
    expect(readRailwayConfig(tmpProject({})).source).toBe("none");
  });
});

describe("start command → entry file", () => {
  it("resolves node file", () => {
    const dir = tmpProject({ "package.json": pkg(), "server.js": express });
    expect(resolveStart(dir, "node server.js")).toMatchObject({ entryFile: "server.js", via: "startCommand" });
  });
  it("resolves npm start through package.json", () => {
    const dir = tmpProject({ "package.json": pkg(), "server.js": express });
    expect(resolveStart(dir, "npm start")).toMatchObject({ entryFile: "server.js" });
    expect(resolveStart(dir)).toMatchObject({ entryFile: "server.js", via: "package.json:start" });
  });
  it("resolves npm run <script> chains and node flags", () => {
    const dir = tmpProject({ "package.json": JSON.stringify({ scripts: { start: "npm run serve", serve: "node --enable-source-maps dist/index.js" } }) });
    const r = resolveStart(dir, "npm start");
    expect(r.entryFile).toBe("dist/index.js");
    expect(r.reason).toMatch(/does not exist yet/);
  });
  it("falls back to main, then index.js", () => {
    expect(resolveStart(tmpProject({ "package.json": JSON.stringify({ main: "app.js" }), "app.js": express })).entryFile).toBe("app.js");
    expect(resolveStart(tmpProject({ "package.json": "{}", "index.js": express })).entryFile).toBe("index.js");
  });
  it("flags next start", () => {
    expect(resolveStart(tmpProject({ "package.json": "{}" }), "next start").reason).toMatch(/standalone/);
  });
});

describe("${{ref}} resolution and RAILWAY_* mapping", () => {
  it("lists refs", () => expect(listRefs("${{Postgres.DATABASE_URL}}/x${{ shared.KEY }}")).toEqual(["Postgres.DATABASE_URL", "shared.KEY"]));
  it("resolves database, shared, and RAILWAY_* refs", () => {
    const r = resolveMap({ DATABASE_URL: "${{Postgres.DATABASE_URL}}", API: "https://${{RAILWAY_PUBLIC_DOMAIN}}/api", KEY: "${{shared.SECRET}}", SECRET: "s3", RAILWAY_FOO: "x", ENV: "${{RAILWAY_ENVIRONMENT}}" }, { env: "staging", endpointHost: "abc.lambda-web.us-east-1.on.aws", databaseUrl: "postgres://db" });
    expect(r.vars.DATABASE_URL).toBe("postgres://db");
    expect(r.vars.API).toBe("https://abc.lambda-web.us-east-1.on.aws/api");
    expect(r.vars.KEY).toBe("s3");
    expect(r.vars.ENV).toBe("staging");
    expect(r.vars.RAILWAY_ENVIRONMENT).toBe("staging");
    expect(r.warnings[0]).toMatch(/RAILWAY_FOO/);
    expect(r.unresolved).toEqual({});
  });
  it("reports unresolved refs", () => {
    const r = resolveRefs("${{Redis.URL}}", { env: "p", vars: {} });
    expect(r.unresolved).toEqual(["Redis.URL"]);
    expect(isUnknownRailwayVar("RAILWAY_VOLUME_MOUNT_PATH")).toBe(true);
    expect(isUnknownRailwayVar("RAILWAY_PUBLIC_DOMAIN")).toBe(false);
  });
});

describe("env name discovery (names only, never .env)", () => {
  it("collects from .env.example and process.env reads, skips .env values", () => {
    const dir = tmpProject({ ".env.example": "STRIPE_SECRET_KEY=\nDATABASE_URL=postgres://x\nPORT=3000\n", ".env": "REAL_SECRET=hunter2\n", "server.js": `const k = process.env.API_KEY; const z = process.env["ZED"]; const aws = process.env.AWS_REGION;` });
    const { names, sources } = discoverEnvNames(dir);
    expect(names).toEqual(["API_KEY", "DATABASE_URL", "STRIPE_SECRET_KEY", "ZED"]);
    expect(names).not.toContain("REAL_SECRET");
    expect(sources.STRIPE_SECRET_KEY).toBe(".env.example");
  });
});
