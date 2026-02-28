# LLM Discord Gateway

一个基于 Bun + OpenAI SDK 的 Discord Agent 网关，支持：

- Discord 消息对话
- 原生 Slash 命令 `/clear`
- MCP tools（LLM 后台调用，支持 HTTP MCP 和 stdio MCP）
- 本地 function calling 工具：执行终端命令

## 1. 安装依赖

```bash
bun install
```

## 2. 配置环境变量

```bash
cp .env.example .env
```

必填：

- `OPENAI_API_KEY`
- `DISCORD_BOT_TOKEN`

常用可选：

- `OPENAI_BASE_URL` 默认 `https://api.openai.com/v1`
- `OPENAI_MODEL` 默认 `gpt-4o-mini`
- `SYSTEM_PROMPT` 默认 `You are a helpful assistant.`
- `MAX_HISTORY_MESSAGES` 默认 `20`
- `DISCORD_GUILD_ID` 可选，填服务器 ID 时 Slash 命令注册更快
- `DISCORD_REQUIRE_MENTION` 默认 `true`
- `DISCORD_ALLOWED_CHANNEL_IDS` 逗号分隔，限制响应频道
- `TERMINAL_TOOL_TIMEOUT_MS` 默认 `15000`
- `TERMINAL_TOOL_MAX_OUTPUT_CHARS` 默认 `12000`
- `TERMINAL_APPROVAL_TIMEOUT_MS` 默认 `30000`（高风险命令确认按钮超时）

## 3. 启动

```bash
bun run start
```

Discord 侧前置条件：

- Bot 已邀请到服务器
- 开启 `MESSAGE CONTENT INTENT`
- Bot 有目标频道读写权限

## 4. 使用说明

- 群聊：
  - `DISCORD_REQUIRE_MENTION=true` 时需要 `@Bot` 才触发
  - `false` 时普通消息也会触发
- 私聊（DM）默认直接触发
- Slash 命令 `/clear` 会清空当前频道会话上下文
- Slash 命令 `/skills` 查看当前已加载 skills
- Slash 命令 `/mcp list` 查看 MCP 服务器运行状态
- Slash 命令 `/mcp enable <server>` 动态启用某个 MCP 服务器
- Slash 命令 `/mcp disable <server>` 动态停用某个 MCP 服务器

## 5. MCP 配置

系统已支持 MCP tool calling（通过 Chat Completions 工具调用环路执行）。

- MCP 配置文件固定为 `.agents/mcp.json`

示例：

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

启动后终端会显示已加载 MCP tools 数量。

MCP 动态开关状态会持久化到 `.agents/mcp.state.json`：

- `/mcp disable <server>` 会将该 server 记为禁用
- `/mcp enable <server>` 会移除禁用标记
- Bot 重启后会按该文件恢复启停状态

## 6. 终端命令工具（Function Calling）

系统默认暴露 `builtin__run` 工具（非 MCP）。

- 用途：在项目目录内执行命令，并把 stdout/stderr 返回给模型
- 执行方式：`/bin/sh -lc "<command>"`
- `cwd` 只能在当前项目根目录内，避免越界执行
- 可通过 `timeout_ms` 控制单次执行超时
- 高风险命令（如含 `rm`/`mkfs`/`dd`/`sudo` 等）会在 Discord 弹出 `Yes/No` 按钮确认，只有原请求用户可批准执行
## 7. Skills 配置

Skills 目录固定为 `.agents/skills`，每个 skill 放在独立子目录并包含 `SKILL.md`。

示例：

```text
.agents/skills/
  test-skill/
    SKILL.md
```

`SKILL.md` 支持 frontmatter：

```md
---
name: test-skill
description: test skill
---

say 'Hi~'.
```

触发方式：

- 消息中显式写 `$test-skill`
- 或写出意图短语（例如 `use test-skill` / `using test-skill`）

## 8. 常见错误

- `400 status code (no body)`：
  - 检查 `OPENAI_BASE_URL` 是否正确
  - 检查模型名是否被网关支持
