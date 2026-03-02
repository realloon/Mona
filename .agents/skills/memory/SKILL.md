---
name: memory
description: Store, list, and delete persistent user/project memory in .agents/memory.json via builtin memory tools. Use when users ask to remember facts/preferences, inspect saved memory, or forget/delete memory.
---

# Memory

Use builtin memory tools to manage persistent memory entries.

## Intent Mapping

- Remember or update memory: `builtin__memory_set`
- List memory: `builtin__memory_list`
- Forget or delete memory: `builtin__memory_delete`

## Workflow

1. Identify user intent: save, view, or delete memory.
2. For save, extract:
   - `key`: short stable key in kebab-case (for example `user-name`, `timezone`, `writing-style`).
   - `value`: the fact or preference to store.
3. Call the matching builtin memory tool directly.
4. Reply with tool result (key, status, and any relevant value preview).

## Rules

- Persist memory only when user clearly asks to remember/save/update.
- Prefer updating an existing key instead of creating near-duplicate keys.
- When user asks to forget/delete memory, call delete tool instead of overwriting with empty text.
- If key is missing or ambiguous, ask one short clarification question before tool call.
