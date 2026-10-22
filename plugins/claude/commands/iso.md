---
description: Run an iso command (up, logs, status, variables, rollback, doctor…) for this project
argument-hint: <command> [args]
---
Run `npx @isomorph/iso $ARGUMENTS --json` in the current directory and summarise the result. If it fails, run `npx @isomorph/iso doctor --json` and explain the first failing check and its fix. Never pass secret values on the command line; for `variables set`, tell the user to run it themselves (it prompts with masking).
