import fs from "node:fs";
import path from "node:path";
import os from "node:os";
import { execSync } from "node:child_process";
import yazl from "yazl";
import { templatePath } from "../paths.js";
import { ui } from "../ui.js";
import { UserError } from "../config.js";

export interface PackInput { dir: string; entryFile: string; buildCommand?: string; skipInstall?: boolean; buildInDocker?: boolean; includeRdsCa?: boolean }
export interface PackResult { zipPath: string; bytes: number; files: number; unzippedBytes: number; sha: string }

const EXCLUDE_DIRS = new Set([".git", ".github", ".iso-build", "coverage", ".vscode", ".idea", "test", "tests", "__tests__", "node_modules/.cache", ".next/cache"]);
const EXCLUDE_FILES = /^(\.env(\..*)?|\.DS_Store|.*\.(test|spec)\.[cm]?[jt]s|.*\.map|railway\.(json|toml)|iso\.json|\.npmrc)$/;

export async function pack(i: PackInput): Promise<PackResult> {
  const build = path.join(i.dir, ".iso-build");
  fs.rmSync(build, { recursive: true, force: true });
  fs.mkdirSync(build, { recursive: true });
  const stage = path.join(build, "stage");
  fs.mkdirSync(stage);

  // 1. copy source (excluding node_modules, .git, env files)
  // with --skip-install the local node_modules is shipped as-is (must already be linux/arm64-compatible)
  copyTree(i.dir, stage, (rel) => (i.skipInstall || !rel.startsWith("node_modules")) && !excluded(rel));
  // 2. install production deps for arm64 linux
  const pkgPath = path.join(stage, "package.json");
  if (!fs.existsSync(pkgPath)) throw new UserError("no package.json in service directory");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8"));
  const hasDeps = pkg.dependencies && Object.keys(pkg.dependencies).length > 0;
  if (i.buildCommand) {
    ui.step(`build: ${i.buildCommand}`);
    if (!i.skipInstall) run("npm install --no-audit --no-fund --loglevel=error", stage, i.buildInDocker);
    run(i.buildCommand, stage, i.buildInDocker);
    fs.rmSync(path.join(stage, "node_modules"), { recursive: true, force: true });
  }
  if (hasDeps && !i.skipInstall) {
    ui.step("npm ci --omit=dev (arm64 linux)");
    const lock = fs.existsSync(path.join(stage, "package-lock.json"));
    run(`npm ${lock ? "ci" : "install"} --omit=dev --no-audit --no-fund --loglevel=error --os=linux --cpu=arm64`, stage, i.buildInDocker);
  }
  // 3. generated entry
  const entryTpl = fs.readFileSync(templatePath("iso-entry.mjs"), "utf8");
  fs.writeFileSync(path.join(stage, "iso-entry.mjs"), entryTpl.replace("__ENTRY__", i.entryFile.replace(/\\/g, "/")));
  if (i.includeRdsCa) fs.copyFileSync(templatePath("rds-global-bundle.pem"), path.join(stage, "iso-rds-ca.pem"));
  // 4. zip (deterministic timestamps)
  const zipPath = path.join(build, "app.zip");
  const { files, unzippedBytes } = await zipDir(stage, zipPath);
  const bytes = fs.statSync(zipPath).size;
  if (unzippedBytes > 512 * 1024 * 1024) throw new UserError(`package is ${mb(unzippedBytes)} unzipped; the limit is 512 MB`, "Trim dependencies or move assets to S3.");
  if (unzippedBytes > 100 * 1024 * 1024) ui.warn(`package is ${mb(unzippedBytes)} unzipped; cold starts will be slow above ~100 MB`);
  const sha = gitSha(i.dir) ?? Date.now().toString(36);
  return { zipPath, bytes, files, unzippedBytes, sha };
}

export function gitSha(dir: string): string | undefined { try { return execSync("git rev-parse --short HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return undefined; } }
export function gitBranch(dir: string): string | undefined { try { return execSync("git rev-parse --abbrev-ref HEAD", { cwd: dir, stdio: ["ignore", "pipe", "ignore"] }).toString().trim(); } catch { return undefined; } }

function run(cmd: string, cwd: string, docker?: boolean) {
  if (docker) {
    const img = "public.ecr.aws/docker/library/node:24-bookworm-slim";
    cmd = `docker run --rm --platform linux/arm64 -v "${cwd}:/app" -w /app ${img} sh -c ${JSON.stringify(cmd)}`;
  }
  try { execSync(cmd, { cwd, stdio: ["ignore", "inherit", "inherit"], env: { ...process.env, NODE_ENV: "production", CI: "1" } }); }
  catch (e: any) { throw new UserError(`command failed: ${cmd}`, "Fix the build locally, then run `iso up` again."); }
}

function excluded(rel: string): boolean {
  const parts = rel.split(path.sep);
  for (let i = 1; i <= parts.length; i++) if (EXCLUDE_DIRS.has(parts.slice(0, i).join("/"))) return true;
  return EXCLUDE_FILES.test(parts[parts.length - 1]);
}

function copyTree(src: string, dst: string, keep: (rel: string) => boolean, rel = "") {
  for (const e of fs.readdirSync(path.join(src, rel), { withFileTypes: true })) {
    const r = rel ? path.join(rel, e.name) : e.name;
    if (!keep(r)) continue;
    const from = path.join(src, r), to = path.join(dst, r);
    if (e.isDirectory()) { fs.mkdirSync(to, { recursive: true }); copyTree(src, dst, keep, r); }
    else if (e.isSymbolicLink()) { try { fs.copyFileSync(from, to); } catch {} }
    else fs.copyFileSync(from, to);
  }
}

function zipDir(dir: string, out: string): Promise<{ files: number; unzippedBytes: number }> {
  return new Promise((resolve, reject) => {
    const zip = new yazl.ZipFile();
    let files = 0, unzippedBytes = 0;
    const walk = (rel: string) => {
      for (const e of fs.readdirSync(path.join(dir, rel), { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        const abs = path.join(dir, r);
        if (e.isDirectory()) walk(r);
        else { const st = fs.statSync(abs); files++; unzippedBytes += st.size; zip.addFile(abs, r, { mtime: new Date(0), mode: st.mode | 0o444 }); }
      }
    };
    walk("");
    zip.outputStream.pipe(fs.createWriteStream(out)).on("close", () => resolve({ files, unzippedBytes })).on("error", reject);
    zip.end();
  });
}

export function mb(n: number): string { return `${(n / 1024 / 1024).toFixed(1)} MB`; }
export const tmpdir = os.tmpdir;
