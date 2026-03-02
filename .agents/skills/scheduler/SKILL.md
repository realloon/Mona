---
name: scheduler
description: Create, list, pause, and resume scheduled reminders and timed jobs via builtin task tools. Use when users ask for reminders or schedules, including phrases like 五分钟后, 一小时后, 每天早上6点, 每天 HH:MM.
---

# Scheduler

Use builtin task tools to manage scheduled tasks. Route create requests through `builtin__task_create`, which performs schedule validation and runtime button confirmation.

## Core Workflow

1. Identify intent:

- `create`: add a new timed task.
- `list`: show existing tasks.
- `pause`: disable an existing task.
- `resume`: re-enable an existing task.

2. For `create`, collect required fields:

- `name`: short task name.
- `schedule_text` or structured `schedule`.
- `action`:
  - `message` for fixed reminder text.
  - `llm` for model-generated output.

3. Once fields are clear, call `builtin__task_create` immediately.

4. Let runtime present approval buttons (`Yes/No`) before persistence.

5. After tool returns, report key creation results:

- `id`
- `next_run_at`
- `schedule`
- `action`

## Tool Usage Rules

- Prefer `schedule_text` when user already gave natural language time.
- Use structured `schedule` only when the user gave exact fields.
- Create and update task state through builtin task tools.
- Use `builtin__task_create` as the validation step for create requests.
- If schedule is unsupported, ask the user to restate with supported examples and then call the create tool.

## Intent-to-Tool Mapping

- Create task: `builtin__task_create`
- List tasks: `builtin__task_list`
- Pause task: `builtin__task_pause`
- Resume task: `builtin__task_resume`

## Create Task Guidance

- If user asks for a simple reminder sentence, default to:
  - `action.type = "message"`
  - `action.content = reminder text`
- If user asks for generated summaries/reports, default to:
  - `action.type = "llm"`
  - `action.prompt = user goal`
- If user did not provide a task name, create a short, descriptive name from the request.

## Clarification Rules

Ask a follow-up question when required fields are missing or ambiguous, then continue to tool call:

- missing schedule
- unclear action content/prompt
- unclear target behavior

## Response Style

- Be concise and operational.
- Mention exact task id when pause/resume succeeds.
- When listing tasks, highlight `enabled`, `next_run_at`, and action type.
