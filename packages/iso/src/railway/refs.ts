/**
 * Railway variable references: ${{Postgres.DATABASE_URL}}, ${{shared.API_KEY}}, ${{service.VAR}}.
 * We resolve them from the project's own resources at deploy time.
 */
export interface RefContext {
  env: string;
  endpointHost?: string;
  gitSha?: string;
  gitBranch?: string;
  databaseUrl?: string;
  /** All variables already known (secret map), used for ${{shared.X}} and ${{self.X}}. */
  vars: Record<string, string>;
}

const REF = /\$\{\{\s*([A-Za-z0-9_.-]+)\s*\}\}/g;

export function listRefs(value: string): string[] {
  return [...value.matchAll(REF)].map((m) => m[1]);
}

export function resolveRefs(value: string, ctx: RefContext): { value: string; unresolved: string[] } {
  const unresolved: string[] = [];
  const out = value.replace(REF, (_m, ref: string) => {
    const r = resolveOne(ref, ctx);
    if (r === undefined) { unresolved.push(ref); return ""; }
    return r;
  });
  return { value: out, unresolved };
}

function resolveOne(ref: string, ctx: RefContext): string | undefined {
  const [scope, ...rest] = ref.split(".");
  const key = rest.join(".");
  if (!key) return railwayVar(scope, ctx) ?? ctx.vars[scope];
  const s = scope.toLowerCase();
  if (s === "postgres" || s === "database" || s === "db") {
    if (key === "DATABASE_URL" || key === "DATABASE_PRIVATE_URL") return ctx.databaseUrl ?? ctx.vars.DATABASE_URL;
    return ctx.vars[key];
  }
  if (s === "shared" || s === "self" || s === "service") return railwayVar(key, ctx) ?? ctx.vars[key];
  return railwayVar(key, ctx) ?? ctx.vars[key];
}

/** RAILWAY_* variables Railway injected; we map the ones that have a meaning on AWS. */
export function railwayVar(name: string, ctx: RefContext): string | undefined {
  switch (name) {
    case "RAILWAY_PUBLIC_DOMAIN":
    case "RAILWAY_STATIC_URL":
      return ctx.endpointHost;
    case "RAILWAY_ENVIRONMENT":
    case "RAILWAY_ENVIRONMENT_NAME":
      return ctx.env;
    case "RAILWAY_GIT_COMMIT_SHA":
      return ctx.gitSha;
    case "RAILWAY_GIT_BRANCH":
      return ctx.gitBranch;
    case "PORT":
      return "3000";
    default:
      return undefined;
  }
}

export const KNOWN_RAILWAY_VARS = ["RAILWAY_PUBLIC_DOMAIN", "RAILWAY_STATIC_URL", "RAILWAY_ENVIRONMENT", "RAILWAY_ENVIRONMENT_NAME", "RAILWAY_GIT_COMMIT_SHA", "RAILWAY_GIT_BRANCH", "PORT"];

export function isUnknownRailwayVar(name: string): boolean {
  return name.startsWith("RAILWAY_") && !KNOWN_RAILWAY_VARS.includes(name);
}

/** Resolve a whole map; values referencing other keys are resolved after literal ones. */
export function resolveMap(input: Record<string, string>, ctx: Omit<RefContext, "vars">): { vars: Record<string, string>; unresolved: Record<string, string[]>; warnings: string[] } {
  const vars: Record<string, string> = {};
  const unresolved: Record<string, string[]> = {};
  const warnings: string[] = [];
  const full: RefContext = { ...ctx, vars };
  for (const [k, v] of Object.entries(input)) if (listRefs(v).length === 0) vars[k] = v;
  for (const [k, v] of Object.entries(input)) {
    if (listRefs(v).length === 0) continue;
    const r = resolveRefs(v, full);
    vars[k] = r.value;
    if (r.unresolved.length) unresolved[k] = r.unresolved;
  }
  for (const k of ["RAILWAY_PUBLIC_DOMAIN", "RAILWAY_ENVIRONMENT", "RAILWAY_GIT_COMMIT_SHA"]) {
    const v = railwayVar(k, full);
    if (v && vars[k] === undefined) vars[k] = v;
  }
  for (const k of Object.keys(input)) if (isUnknownRailwayVar(k)) warnings.push(`${k} is a Railway-injected variable with no AWS equivalent; it will be passed through as-is.`);
  return { vars, unresolved, warnings };
}
