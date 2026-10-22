export type DatabaseKind = "aurora" | "external" | "none";
export type DatabaseNetwork = "public" | "private";

export interface IsoServiceConfig {
  path: string;
  runtime?: "serverless";
  timeoutSeconds?: number;
  maxConcurrencyPerEnvironment?: number;
}

export interface IsoConfig {
  project: string;
  region: string;
  profile?: string;
  environment: string;
  services: Record<string, IsoServiceConfig>;
  database?: { kind: DatabaseKind; network?: DatabaseNetwork; maxCapacity?: number };
  domains?: Record<string, string[]>;
}

export interface RailwayConfig {
  source: "railway.json" | "railway.toml" | "none";
  build: {
    builder?: string;
    buildCommand?: string;
    watchPatterns?: string[];
  };
  deploy: {
    startCommand?: string;
    healthcheckPath?: string;
    healthcheckTimeout?: number;
    preDeployCommand?: string | string[];
    cronSchedule?: string;
    numReplicas?: number;
    sleepApplication?: boolean;
    restartPolicyType?: string;
    restartPolicyMaxRetries?: number;
  };
  /** Fields present in railway config that serverless ignores. */
  ignored: string[];
}

export type Severity = "ok" | "warn" | "block";

export interface Finding {
  severity: Severity;
  code: string;
  message: string;
  file?: string;
  line?: number;
  fix?: string;
}

export interface DetectResult {
  service: string;
  dir: string;
  framework: string;
  nodeVersion?: string;
  entryFile?: string;
  startCommand?: string;
  verdict: "serverless" | "unsupported";
  findings: Finding[];
  envNames: string[];
  databaseReferenced: boolean;
}
