# iso for Claude Code

Move a Railway Node.js service to your own AWS account on Lambda Web Functions with zero code changes.

```
/plugin marketplace add Fourier-Labs-AI/iso
/plugin install iso@isomorph
/migrate-railway
```

`/migrate-railway` reads the repo, explains which services run serverless and why, proposes trivial fixes as diffs, shows every cost line, hands you to the terminal for `iso aws connect` and secret entry, deploys, verifies, and prints a cutover checklist. `/iso <command>` runs any `iso` verb.

The bundled MCP server (`npx -y @isomorph.ai/iso mcp`) exposes detect, plan, deploy, status, logs, doctor, and variable **names** only. Secret values never pass through the model.

CLI: https://www.npmjs.com/package/@isomorph.ai/iso · Source: https://github.com/Fourier-Labs-AI/iso · MIT
