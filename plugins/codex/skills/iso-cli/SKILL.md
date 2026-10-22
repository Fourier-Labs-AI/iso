---
name: iso-cli
description: Run iso CLI commands (up, logs, status, variables, rollback, doctor, cost, detect) for a project deployed to AWS with @isomorph.ai/iso. Use when the user asks to deploy, check logs or status, roll back, or diagnose an iso project.
---

# iso CLI

Run `npx @isomorph.ai/iso <command> --json` in the project directory and summarise the result. Commands: `up`, `logs [--tail]`, `status`, `variables list`, `rollback`, `doctor`, `cost`, `detect`, `down`, `environment <name>`.

If a command fails, run `npx @isomorph.ai/iso doctor --json` and explain the first failing check and its fix.

Never pass secret values on the command line or read `.env` files. For `variables set`, tell the user to run `npx @isomorph.ai/iso variables set NAME` themselves; it prompts with masking and redeploys.
