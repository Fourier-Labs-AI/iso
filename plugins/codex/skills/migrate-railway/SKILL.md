---
name: migrate-railway
description: Move a Railway Node.js service (Express, Hono, Fastify, NestJS, Koa, plain http, Next.js standalone) to the user's own AWS account on Lambda Web Functions with zero code changes, using the `iso` CLI. Use when the user mentions Railway, wants off Railway, wants to deploy a Node app serverless on their AWS, or runs /migrate-railway.
---

# Migrate a Railway service to AWS with `iso`

`iso` is a Railway-shaped CLI that deploys to the user's own AWS. There is no Isomorph account, API or backend. Secrets live only in the user's Secrets Manager.

## Workflow (in this order)

1. **Detect** — call `iso_detect(path)` (or run `npx @isomorph.ai/iso detect --json`). Explain each service's verdict in one sentence, with the file and line for every blocker.
2. **Fix trivial blockers only**, each as a diff the user approves first:
   - a hardcoded port → `app.listen(process.env.PORT || 3000)`
   - a missing `start` script → add `"start": "node <entry>"` to package.json
   - Next.js without standalone → `output: 'standalone'` in next.config
   - binding to `127.0.0.1` → remove the host argument
   Anything else (workers, websockets, cron, non-Node) is out of scope: say so and move on.
3. **Plan** — call `iso_plan(path)`; show the resources and the cost table. Say the fixed monthly cost. Say which numbers are approximate.
4. **Hand the user to the terminal** for the two things the agent must not do:
   - `npx @isomorph.ai/iso aws connect` (credentials)
   - secret values: `npx @isomorph.ai/iso migrate` prompts for each variable name it found, or `iso variables set NAME` (masked prompt). Tell the user to enter rotated values; nothing is imported from Railway.
5. **Deploy** — `iso_deploy(path)` (or `npx @isomorph.ai/iso up`). It runs the smoke test against `healthcheckPath` and rolls back automatically on failure.
6. **Verify** — `iso_status(path)`; if unhealthy, `iso_logs(path)` and explain the first error.
7. **Cutover checklist** — DNS (`iso domain add`), webhook URLs, rotate remaining secrets, delete the Railway service after traffic moves.

## Never

- Read `.env`, `.env.local`, `.env.production` or any file that may contain secret values.
- Call Railway's API or ask for a Railway token (they were revoked after the Oct 2026 incident).
- Paste, log, or echo a secret value anywhere. `iso_variables_list` returns names only; `iso_variables_set` only tells the user what to type in their terminal.
- Create AWS resources outside `iso` (no raw CloudFormation, no console steps) — `iso` prints every cost line before creating anything.
