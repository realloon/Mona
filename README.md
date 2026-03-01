# LLM Discord Gateway

A minimal Discord agent gateway built with Bun + OpenAI SDK.

## Quick Start

```bash
bun install
cp mona.config.example.ts mona.config.ts
bun run start
```

## What It Does

- Replies in Discord channels and DMs
- Supports slash commands: `/clear`, `/skills`, `/mcp list`, `/mcp enable`, `/mcp disable`
- Supports MCP tools (`.agents/mcp.json`)
- Includes built-in local tools: `builtin__run`, `builtin__read`, `builtin__write`, `builtin__patch`, `builtin__search`

## Discord Setup

- Invite the bot to your server
- Enable **MESSAGE CONTENT INTENT**
- Grant channel read/write permissions
- Ensure `.agents/system.xml` exists

## Behavior

- If `discord.requireMention=true`, the bot only responds when mentioned
- If `discord.requireMention=false`, it responds to regular channel messages
- In DMs, it responds directly
- `/clear` resets conversation context for the current channel

## Notes

- MCP enabled/disabled state is saved in `.agents/mcp.state.json`
- High-risk shell commands require explicit Discord approval by the requester
- If you see `400 status code (no body)`, check `openai.baseURL` and model compatibility
