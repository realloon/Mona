# LLM Discord Gateway

A lightweight Discord agent gateway built with Bun + OpenAI SDK.

## Features

- Discord chat interaction (guild channels and DMs)
- Slash commands: `/clear`, `/skills`, `/mcp list`, `/mcp enable`, `/mcp disable`
- MCP tool calling (HTTP MCP + stdio MCP)
- Built-in local tools (run/read/write/patch files and commands)

## Quick Start

1. Install dependencies:
```bash
bun install
```

2. Create env file:
```bash
cp .env.example .env
```

3. Set required variables:
- `OPENAI_API_KEY`
- `DISCORD_BOT_TOKEN`

4. Start:
```bash
bun run start
```

## Common Environment Variables

- `OPENAI_BASE_URL` (default: `https://api.openai.com/v1`)
- `OPENAI_MODEL` (default: `gpt-4o-mini`)
- `MAX_HISTORY_MESSAGES` (default: `20`)
- `DISCORD_GUILD_ID` (optional, faster slash command registration)
- `DISCORD_REQUIRE_MENTION` (default: `true`)
- `DISCORD_ALLOWED_CHANNEL_IDS` (comma-separated channel IDs)
- `TERMINAL_TOOL_TIMEOUT_MS` (default: `15000`)
- `TERMINAL_TOOL_MAX_OUTPUT_CHARS` (default: `12000`)
- `TERMINAL_APPROVAL_TIMEOUT_MS` (default: `30000`)

## Discord Prerequisites

- Invite the bot to your server
- Enable **MESSAGE CONTENT INTENT**
- Grant the bot read/write permissions in target channels
- Ensure system prompt file exists: `.agents/system.xml`

## Usage

- In guild channels, if `DISCORD_REQUIRE_MENTION=true`, users must mention the bot
- If `DISCORD_REQUIRE_MENTION=false`, normal messages also trigger the bot
- In DMs: messages trigger directly
- `/clear` clears the current channel conversation context

## MCP Configuration

- MCP config file: `.agents/mcp.json`
- Dynamic MCP state file: `.agents/mcp.state.json`

Example:

```json
{
  "mcpServers": {
    "rimsage": {
      "url": "https://mcp.rimsage.com/mcp"
    },
    "filesystem": {
      "command": "npx",
      "args": [
        "-y",
        "@modelcontextprotocol/server-filesystem",
        "/Users/lizhen/Documents"
      ]
    }
  }
}
```

`/mcp disable <server>` persists a disabled state; `/mcp enable <server>` removes it. State is restored after restart.

## Built-in Function Tools

- `builtin__read`: read text files
- `builtin__write`: write/append text files
- `builtin__patch`: patch by line operations
- `builtin__run`: run shell commands in project scope

Notes:

- Supports absolute and relative paths (relative to process working directory)
- `builtin__run` supports per-call timeout via `timeout_ms`
- High-risk commands (for example `rm`, `mkfs`, `dd`, `sudo`) require Discord Yes/No approval from the original requester

## Skills

Skills are loaded from `.agents/skills`, one directory per skill, each containing `SKILL.md`.

Example:

```text
.agents/skills/
  test-skill/
    SKILL.md
```

Optional frontmatter in `SKILL.md`:

```md
---
name: test-skill
description: test skill
---
```

Trigger a skill by:

- Explicit name, e.g. `$test-skill`
- Intent phrase, e.g. `use test-skill`

## Troubleshooting

If you get `400 status code (no body)`:

- Verify `OPENAI_BASE_URL`
- Verify your model name is supported by your gateway
