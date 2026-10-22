# iso — Railway's workflow, on your own AWS

**Railway's deploys are paused. Your Node app can be on your own AWS in 10 minutes: same commands, zero code changes, your secrets stay in your account.**

```bash
npx @isomorph/iso aws connect     # once per machine: finds your AWS creds, creates a $0 core stack
npx @isomorph/iso migrate         # in your Railway repo: detect → cost → secrets → deploy → live URL
```

Measured on launch day (Express sample, us-east-1, fresh account): `migrate` to live URL in **25 s**; a re-deploy in **29 s**; function init **271–372 ms**; fixed cost **$0.40/month** (one Secrets Manager secret). No Isomorph account, no Isomorph API, no telemetry. The CLI works with isomorph.com unreachable.

## What it is

`iso` deploys a Node HTTP server to **AWS Lambda Web Functions** (launched 12 Oct 2026): your app listens on `process.env.PORT` like it does on Railway; there is no handler, no adapter, and it scales to zero. `railway.json` / `railway.toml` is read as-is. The only file written into your repo is `iso.json` (and `.github/workflows/iso.yml` if you ask).

Three things, every time:
- **zero code changes** — if it listens on `PORT`, it runs
- **nothing orchestrated by us** — every AWS call is made from your laptop or CI with your credentials
- **we never see a secret value** — values are typed into your terminal and go straight to Secrets Manager in your account

## Supported today

| | |
|---|---|
| Frameworks | Express, Hono, Fastify, NestJS, Koa, plain `node:http`. Next.js only with `output: 'standalone'` (experimental) |
| Runtime | Node.js 24, arm64, 2 vCPU / 2 GB, scale to zero, 128 concurrent requests per environment |
| Database | Aurora Serverless v2 PostgreSQL 17 (min 0 ACU, public endpoint, TLS forced; the RDS CA bundle ships in the zip so `pg` verifies it with no code change) · an external `DATABASE_URL` (Neon, Supabase, RDS) · or keep your current DB |
| Secrets | Secrets Manager, one secret per environment, injected as env vars at deploy |
| Ingress | The function's built-in HTTPS endpoint (free); custom domains via CloudFront + ACM (`iso domain add`) |
| Environments | `production` plus any name (`staging`, `pr-123`), each its own function + secret |
| Regions | us-east-1, us-east-2, us-west-2, ap-northeast-1, eu-west-1 |
| CI | `iso init --ci` writes a GitHub Actions workflow using OIDC; `iso aws connect --ci owner/repo` creates the role. No AWS keys in GitHub |

## Not supported (v1) — the CLI says so before touching AWS

- Python, Go, Rust, Ruby, PHP services (Web Functions are Node-only at launch)
- Background workers, queue consumers, long-running processes (only HTTP is served)
- Cron jobs (`deploy.cronSchedule`) — week 1 via EventBridge Scheduler
- WebSockets (Lambda strips upgrade headers), volumes, Redis/MySQL/Mongo, private networking between services
- Dockerfile builds (Web Functions take zips)
- Importing secret **values** from Railway: tokens are revoked and old values should be rotated. We import names only and ask you for new values.

`iso detect` prints the verdict per service with the file and line of every blocker, and exits before any AWS call.

## The Railway verbs

```bash
iso up                        # deploy current directory (zip → S3 → revision → smoke test → live)
iso logs --tail               # CloudWatch, live
iso variables set KEY=val     # Secrets Manager, then a new revision (or `iso variables set KEY` to be prompted)
iso run -- node scripts/x.js  # local process with the env injected
iso shell                     # $SHELL with the env injected
iso domain add api.me.com     # ACM + CloudFront, prints the CNAMEs
iso environment staging       # switch; iso up now deploys staging
iso status [--all] [--cost]   # what is deployed, where, health, fixed cost
iso rollback                  # endpoint back to the previous revision, one call
iso redeploy                  # new revision from the same zip
iso down                      # delete the env's functions + secret; asks before the database
iso add postgres              # Aurora Serverless v2, DATABASE_URL into the env secret
iso doctor                    # one fix per failure
```

Every command accepts `--json` (for agents) and `--yes` (for CI). `railway login`, `volume`, `ssh`, `deploy` print a one-line "not supported on serverless".

## Cost, every line item

Printed before anything is created. `~` means a list price that still needs a measured replacement; all numbers live in `packages/iso/src/pricing.json` and can be corrected without a release.

| Line item | Default | Monthly idle | Small API (~100k req, DB awake ~20 h) |
|---|---|---|---|
| Lambda Web Function | always | $0 | ~$0.72 (CPU time while code runs + memory per environment-hour) |
| Built-in HTTPS endpoint | always | $0 | $0 |
| S3 deploy bucket | always | ~$0 | ~$0 (last 10 versions kept) |
| Secrets Manager | always | $0.40 / environment | $0.40 / environment |
| CloudWatch Logs | always | $0 | cents (14-day retention) |
| IAM, CloudFormation, ACM | always | $0 | $0 |
| Aurora Serverless v2 | optional | $0 compute + $3.65 public IPv4 + ~$0.10/GB | ~$1.20 compute (0.5 ACU × ~$0.06/h) + the above. Creation ~10 min; connect from the function 16–18 ms warm |
| CloudFront + ACM (custom domain) | optional | $0 | $0 inside the free tier |
| VPC + NAT (`--private`) | opt-in | ~$33 | ~$33 + data — never created by default |

A steadily-used Aurora cluster (~$0.06/h awake) costs more than a $5 Railway Postgres. `iso migrate` shows the three database choices with numbers next to each, and an external Postgres URL is $0.

## We never hold a secret

- There is no Isomorph login, API or backend. Credentials are your AWS credentials (`AWS_PROFILE`, SSO, env vars).
- Secret values are typed into your terminal (masked) or passed to `iso variables set`; they go to Secrets Manager in your account and are copied into the function revision's environment variables (encrypted at rest by Lambda). They are never written to disk by `iso`, never read from Railway, never sent anywhere else. Who can read them is decided by your IAM: anyone with `secretsmanager:GetSecretValue` on `iso/*` or `lambda:GetWebFunctionRevision` in your account.
- The Claude Code / Codex plugin's MCP server exposes variable **names** only; `iso_variables_set` tells the agent to hand you to the terminal.
- `iso` never reads `.env`; it reads `.env.example` and your source for **names** only.

## Agents

```bash
npx @isomorph/iso plugin install claude   # or: codex
```

This registers the repo as a plugin marketplace and installs `iso` with the agent's own CLI. By hand:

```bash
# Claude Code
/plugin marketplace add Fourier-Labs-AI/iso
/plugin install iso@isomorph
# Codex
codex plugin marketplace add Fourier-Labs-AI/iso
codex plugin add iso@isomorph
```

Then `/migrate-railway` in Claude Code (the `migrate-railway` skill in Codex): the agent runs detect, explains each verdict, proposes trivial fixes as diffs (hardcoded port, missing `start` script, Next.js standalone), shows the plan and cost, hands you to the terminal for `aws connect` and secret entry, deploys, verifies, and prints the cutover checklist.

## How it works

Per account: one `iso-core` CloudFormation stack (a versioned S3 bucket + a bucket policy letting Lambda read it). Per project: one least-privilege execution role (logs + `GetSecretValue` on `iso/<project>/*`). Per environment and service: one Web Function (`<project>-<env>-<service>`), one secret (`iso/<project>/<env>`), one log group. State is the AWS resources themselves (names + tags); there is no state file.

`iso up`: detect → `npm ci --omit=dev` for arm64 → generate a 20-line `iso-entry.mjs` that sets `PORT` from `AWS_LAMBDA_HTTP_ENDPOINT` and imports your entry file → zip → S3 (versioned) → `CreateWebFunctionRevision` pinned to the object version → wait `Active` → GET `healthcheckPath`. A failed health check pins the endpoint back to the previous revision automatically; `iso rollback` does the same by hand.

## Repo layout

```
packages/iso/            the CLI (TypeScript, one bundled ESM file, zero native deps)
  src/commands/          one file per verb
  src/railway/           railway.json/toml parser, ${{ref}} resolver, RAILWAY_* mapping
  src/detect/            framework + blocker detection
  src/aws/               thin wrappers over the AWS SDK v3 clients
  src/mcp/               MCP server for agents
  templates/             iso-core.yaml, iso-entry.mjs, GitHub workflow
plugins/claude, plugins/codex
examples/express-api     the launch-day smoke-test app
```

```bash
npm install && npm run build && npm test     # 34 unit tests; AWS smoke test: see examples/express-api
```

## Status

Tested on a real AWS account on launch day: `aws connect`, `migrate`, `up`, `redeploy`, `variables`, `logs --tail`, `status`, `doctor`, `run`, `rollback`, auto-rollback on a failed health check, `down`, `add postgres` (Aurora Serverless v2 17.x, public endpoint, TLS verified from the function), `aws connect --ci` (OIDC role), and the whole flow again under the least-privilege `iso-admin` policy. Both plugins install through their agent's marketplace CLI and the MCP server answers `iso_detect`/`iso_plan`.

Not yet exercised end to end: `iso domain add` (needs a real domain for ACM validation), Next.js standalone, and the `--private` database path (prints its cost and is not built). Numbers in the cost table marked `~` are list prices. The CLI is free.
