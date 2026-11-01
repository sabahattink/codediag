# AI agents and editors

CodeDiag runs inside coding agents three ways: as a Claude Code plugin, as an
MCP server for any MCP client, and as an Agent Skill. Each one lets an agent
answer "which of my API routes can anyone call?" with CodeDiag's analysis
instead of guessing from the files it happened to read.

Everything runs locally. The server reads the project from disk, sends
nothing anywhere, and stays offline unless a tool call asks for a dependency
audit.

## Claude Code plugin

The plugin adds the CodeDiag skill and starts the MCP server. In Claude Code:

```text
/plugin marketplace add sabahattink/codediag
/plugin install codediag@codediag
```

Claude Code 2.1.275 and later can do both in one step:

```text
/plugin install codediag --marketplace sabahattink/codediag
```

## MCP server

`codediag mcp` serves the [Model Context Protocol](https://modelcontextprotocol.io)
over stdio. It is listed in the MCP Registry as
`io.github.sabahattink/codediag`.

| Tool | What it returns |
|---|---|
| `find_unprotected_routes` | Routes, form actions, and procedures with no recognizable auth check or input validation. `check` narrows to `auth` or `validation`; `maxResults` caps the list (default 100). Always offline. |
| `scan_project` | The 0–100 score, analyzer scores, and findings at or above `minSeverity` (default `warning`), most severe first, up to `maxFindings` (default 50). `audit: true` adds the package manager audit, which needs network access. |
| `explain_rule` | What a rule ID detects, its severity, CWE and OWASP mapping, documentation link, and the comment that suppresses it. |

The scanning tools take a `path`. Agents should pass the project's absolute
path, because a client may start the server in another directory; a relative
path resolves against the server's working directory. Each result names the
`directory` it scanned and how many entries it `omitted`. Results come back as
structured content that matches each tool's output schema, with the same data
as JSON text.

### Claude Code

```bash
claude mcp add codediag -- npx -y @sabahattink/codediag mcp
```

On native Windows, where `npx` is a batch file, wrap it:

```bash
claude mcp add codediag -- cmd /c npx -y @sabahattink/codediag mcp
```

### Cursor, Claude Desktop, and other clients

Most clients read an `mcpServers` map, for example `.cursor/mcp.json` or
`claude_desktop_config.json`:

```json
{
  "mcpServers": {
    "codediag": {
      "command": "npx",
      "args": ["-y", "@sabahattink/codediag", "mcp"]
    }
  }
}
```

### VS Code

`.vscode/mcp.json` uses a `servers` map:

```json
{
  "servers": {
    "codediag": {
      "type": "stdio",
      "command": "npx",
      "args": ["-y", "@sabahattink/codediag", "mcp"]
    }
  }
}
```

### Protocol support

The server implements the tools part of MCP: `initialize`, `ping`,
`tools/list`, and `tools/call`, for protocol versions 2025-11-25, 2025-06-18,
2025-03-26, and 2024-11-05. It is written without the MCP SDK, whose server
brings Express, Hono, and an OAuth stack into every install for transports
CodeDiag does not offer; a CLI test checks it against the SDK's client.

## Agent Skill

[`skills/codediag/SKILL.md`](../skills/codediag/SKILL.md) follows the
[Agent Skills](https://agentskills.io) format. It tells an agent when to use
CodeDiag, how to run it with or without the MCP server, how to check a finding
before reporting it, and where each framework runs auth. Install it with the
[skills CLI](https://github.com/vercel-labs/skills):

```bash
npx skills add sabahattink/codediag
```

Or copy the `skills/codediag` directory into `.claude/skills/` in a project,
or `~/.claude/skills/` for every project.

## Findings are a starting point

CodeDiag is static analysis. "No recognizable auth check" means it could not
see one. The server's instructions and the skill both tell the agent to open
the cited file and check where auth runs before calling a route vulnerable.
Routes that are public on purpose can be suppressed with a reason; see
[suppressions and baselines](suppressions-and-baselines.md).
