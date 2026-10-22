Codex plugin layout for iso. The manifest spec has changed this year; if `plugin.json` is not picked up, add the MCP server manually to `~/.codex/config.toml`:

    [mcp_servers.iso]
    command = "npx"
    args = ["-y", "@isomorph/iso", "mcp"]
