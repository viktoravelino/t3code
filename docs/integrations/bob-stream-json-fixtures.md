# BOB Stream JSON Fixture Results

Captured on 2026-06-23 from repo root:

```text
/Users/viktoravelino/projects/t3code
```

Local BOB version:

```text
1.0.4
```

Purpose: execute the recommended next step from
`docs/integrations/bob-provider-feasibility.md`: collect sanitized `stream-json` fixtures and
integration findings.

## Harness

Commands were run through a small Node child-process harness with fixed timeouts so BOB could not
hang the shell. Prompts were read-only or answer-only. No repo files were modified.

Common command shape:

```sh
bob --output-format stream-json --chat-mode <mode> --max-coins 1 "<prompt>"
```

For tool execution tests:

```sh
bob --output-format stream-json --chat-mode code --approval-mode yolo --max-coins 1 "<prompt>"
```

## Fixture: Plain Answer

Command:

```sh
bob --output-format stream-json --chat-mode ask --max-coins 1 "Reply exactly: T3_BOB_FIXTURE_OK"
```

Result:

- exit code: `0`
- timed out: `false`
- stdout format: newline-delimited JSON
- stderr contained repeated workspace import errors from `.repos/alchemy-effect/processes/AWS.md`

Representative events:

```json
{"type":"init","timestamp":"2026-06-23T18:56:30.478Z","session_id":"1fd74ee7-b50e-4bf4-a073-b214b731949f","model":"premium"}
{"type":"message","timestamp":"2026-06-23T18:56:30.478Z","role":"user","content":"Reply exactly: T3_BOB_FIXTURE_OK"}
{"type":"message","timestamp":"2026-06-23T18:56:33.855Z","role":"assistant","content":"T","delta":true}
{"type":"message","timestamp":"2026-06-23T18:56:33.856Z","role":"assistant","content":"3_BOB_FIXTURE_","delta":true}
{"type":"message","timestamp":"2026-06-23T18:56:33.857Z","role":"assistant","content":"OK","delta":true}
{"type":"tool_use","timestamp":"2026-06-23T18:56:36.669Z","tool_name":"attempt_completion","tool_id":"tool-1","parameters":{"result":"\nT3_BOB_FIXTURE_OK\n"}}
{"type":"tool_result","timestamp":"2026-06-23T18:56:36.671Z","tool_id":"tool-1","status":"success","output":"\nT3_BOB_FIXTURE_OK\n"}
{"type":"result","timestamp":"2026-06-23T18:56:36.671Z","status":"success","stats":{"total_tokens":60433,"input_tokens":60387,"output_tokens":46,"duration_ms":6193,"session_costs":0.151082,"max_budget":250,"budget_spend":0.2,"tool_calls":1}}
```

Parser implications:

- `stream-json` is NDJSON.
- `message` events carry both full user messages and assistant deltas.
- Assistant deltas use `delta: true`.
- Final completion is also modeled as `tool_use` / `tool_result` for `attempt_completion`.
- `result.stats` has token, cost, budget, duration, and tool-call counts.

## Fixture: JSON Output Mode

Command:

```sh
bob --output-format json --chat-mode ask --max-coins 1 "Reply exactly: T3_BOB_JSON_OK"
```

Result:

- exit code: `0`
- stdout was not pure JSON; it wrapped text with `---output---` markers before a JSON stats object.
- This mode is less suitable for strict machine parsing than `stream-json`.

Observed shape:

```text
---output---

T3_BOB_JSON_OK

---output---
{
  "response": "",
  "stats": {
    "models": { "...": "..." },
    "tools": { "...": "..." },
    "files": { "totalLinesAdded": 0, "totalLinesRemoved": 0 },
    "budgetSpend": 0.36,
    "maxBudget": 250,
    "sessionCost": 0.151062
  }
}
```

Parser implication: prefer `stream-json` for T3 provider integration.

## Fixture: Session Listing

Command:

```sh
bob --list-sessions --output-format json
```

Result after earlier fixture runs:

- exit code: `0`
- stdout length: `0`
- sessions were printed to stderr, not stdout
- output was not JSON despite `--output-format json`

Observed stderr:

```text
Available sessions for this project (2):

  1. Reply exactly: T3_BOB_FIXTURE_OK (Just now) [1fd74ee7-b50e-4bf4-a073-b214b731949f]
  2. Reply exactly: T3_BOB_JSON_OK (Just now) [bc6a6ca9-e3d1-4da0-a951-a5be07c60846]
```

Parser implication:

- Do not rely on `--list-sessions --output-format json` for structured session discovery in BOB
  `1.0.4`.
- Prefer session ids from `stream-json` `init.session_id`.

## Fixture: Resume

Command that failed:

```sh
bob --output-format stream-json --resume latest --max-coins 1 "Reply exactly: T3_BOB_RESUME_OK"
```

Result:

- exit code: `1`
- stderr said resume requires message via `--prompt` or stdin
- positional prompt is not accepted with `--resume` in BOB `1.0.4`

Working command:

```sh
bob --output-format stream-json --resume latest --max-coins 1 --prompt "Reply exactly: T3_BOB_RESUME_OK"
```

Result:

- exit code: `0`
- emitted `init.session_id` matching the latest prior session
- emitted a deprecation warning as an assistant `message` delta

Representative events:

```json
{"type":"init","timestamp":"2026-06-23T18:57:32.706Z","session_id":"9df0b929-50e2-41a8-8a23-021ac0869b04","model":"premium"}
{"type":"message","timestamp":"2026-06-23T18:57:32.706Z","role":"user","content":"Reply exactly: T3_BOB_RESUME_OK"}
{"type":"message","timestamp":"2026-06-23T18:57:32.706Z","role":"assistant","content":"The --prompt (-p) flag has been deprecated and will be removed in a future version. Please use a positional argument for your prompt. See bob-shell --help for more information.\n","delta":true}
{"type":"tool_use","timestamp":"2026-06-23T18:57:39.502Z","tool_name":"attempt_completion","tool_id":"tool-1","parameters":{"result":"/Users/viktoravelino/projects/t3code"}}
{"type":"result","timestamp":"2026-06-23T18:57:39.504Z","status":"success","stats":{"total_tokens":51768,"input_tokens":51663,"output_tokens":105,"duration_ms":6823,"session_costs":0.129419,"max_budget":250,"budget_spend":0.7,"tool_calls":1}}
```

Integration implications:

- Follow-up local testing with explicit `--resume <session_id>` plus stdin failed in BOB `1.0.4`;
  despite the error text, resumed turns currently need deprecated `--prompt` for reliable prompt
  delivery.
- `--resume latest` is dangerous for provider routing. Use explicit `session_id` from the original
  `init` event.
- Resume output can include historical context, deprecation warnings, reasoning text, and
  tool-status text in assistant `message` deltas. The T3 adapter should suppress raw BOB `message`
  deltas and surface `attempt_completion.parameters.result` as the stable user-facing answer.

## Fixture: Missing API Key

Command:

```sh
env -u BOBSHELL_API_KEY bob --output-format stream-json --auth-method api-key --max-coins 1 "Reply exactly: T3_BOB_API_KEY_OK"
```

Result:

- exit code: `1`
- stdout length: `0`
- stderr had setup noise plus clear auth error

Observed auth error:

```text
API key required. Set BOBSHELL_API_KEY via environment variable or .env file.
```

Integration implications:

- `--auth-method api-key` works in local BOB `1.0.4` even though it is absent from `bob --help`.
- `BobProvider` snapshot can detect missing API key before spawning a session if configured for
  API-key auth.
- Error parser should scan stderr, not stdout only.

## Fixture: Read File Tool

Command:

```sh
bob --output-format stream-json --chat-mode code --approval-mode yolo --max-coins 1 "Read package.json name field and answer with only the package name. Do not modify files."
```

Result:

- exit code: `0`
- structured `read_file` tool event emitted
- `tool_result.output` for `read_file` was empty in stream output, but assistant continued with
  derived answer

Representative events:

```json
{"type":"tool_use","timestamp":"2026-06-23T18:58:14.175Z","tool_name":"read_file","tool_id":"tool-1","parameters":{"file_path":"/Users/viktoravelino/projects/t3code/package.json","absolute_path":"/Users/viktoravelino/projects/t3code/package.json"}}
{"type":"tool_result","timestamp":"2026-06-23T18:58:14.177Z","tool_id":"tool-1","status":"success","output":""}
```

Integration implications:

- File read lifecycle maps naturally to T3 `file_read` or generic tool-call events.
- Empty `tool_result.output` does not mean tool produced no useful internal result.

## Fixture: Execute Command Tool

Command:

```sh
bob --output-format stream-json --chat-mode code --approval-mode yolo --max-coins 1 "Run pwd and report the current working directory. Do not modify files."
```

Result:

- exit code: `0`
- structured `execute_command` tool event emitted
- command output was present in `tool_result.output`

Representative events:

```json
{"type":"init","timestamp":"2026-06-23T18:58:33.235Z","session_id":"b4f7744e-9a56-4571-9171-da5f9aeadfd9","model":"premium"}
{"type":"tool_use","timestamp":"2026-06-23T18:58:37.830Z","tool_name":"execute_command","tool_id":"tool-1","parameters":{"command":"pwd","timeout":5,"background":false}}
{"type":"tool_result","timestamp":"2026-06-23T18:58:37.879Z","tool_id":"tool-1","status":"success","output":"/Users/viktoravelino/projects/t3code"}
{"type":"tool_use","timestamp":"2026-06-23T18:58:42.017Z","tool_name":"attempt_completion","tool_id":"tool-2","parameters":{"result":"\nCurrent working directory: /Users/viktoravelino/projects/t3code\n"}}
{"type":"tool_result","timestamp":"2026-06-23T18:58:42.018Z","tool_id":"tool-2","status":"success","output":"\nCurrent working directory: /Users/viktoravelino/projects/t3code\n"}
{"type":"result","timestamp":"2026-06-23T18:58:42.018Z","status":"success","stats":{"total_tokens":56315,"input_tokens":56026,"output_tokens":289,"duration_ms":8783,"session_costs":0.140787,"max_budget":250,"budget_spend":1.13,"tool_calls":2}}
```

Integration implications:

- `execute_command` maps cleanly to T3 `command_execution` lifecycle.
- `parameters.timeout` and `parameters.background` are useful details for T3 event payloads.
- `tool_result.status` currently seen as `success`; parser should allow non-success values.

## Fixture: Ask Mode Tool Prompt

Command:

```sh
bob --output-format stream-json --chat-mode ask --max-coins 1 "Use a shell command to print the current working directory. Do not modify files. Then answer with only the directory."
```

Result:

- exit code: `0`
- BOB streamed pseudo-XML `<execute_command>` markup as assistant text
- no structured `execute_command` `tool_use` was emitted
- it completed via `attempt_completion`

Integration implication:

- T3 should not infer tool execution from assistant text markup in `ask` mode.
- Use `code` mode for tool-capable provider sessions.

## Common Stderr Noise

Most invocations emitted:

```text
[ERROR] [ImportProcessor] Failed to import processes/AWS.md: ENOENT: no such file or directory, access '/Users/viktoravelino/projects/t3code/.repos/alchemy-effect/processes/AWS.md'
```

This happened even when commands succeeded.

Integration implications:

- Adapter must treat stderr as diagnostic stream, not fatal by default.
- Fatality should be based on exit code, structured `result.status`, or known setup/auth error
  patterns.
- Snapshot probe should avoid running commands that trigger heavy workspace import processing when
  possible; `bob --version` is clean.

## Observed Event Types

Seen event types:

- `init`
- `message`
- `tool_use`
- `tool_result`
- `result`

Seen tool names:

- `attempt_completion`
- `read_file`
- `execute_command`

Likely T3 mappings:

- `init.session_id` -> provider resume cursor
- `init.model` -> provider session model if no model override exists
- `message.role=user` -> user echo; probably suppress in T3 because T3 already stores user message
- `message.role=assistant && delta=true` -> suppress in T3 V1; observed content includes
  deprecation warnings, internal reasoning, and tool-status text
- `tool_use.tool_name=execute_command` -> `command_execution` item started
- `tool_result` for execute command -> command output/completed
- `tool_use.tool_name=read_file` -> file read item started
- `tool_use.tool_name=attempt_completion` -> final assistant answer candidate
- `result.status=success` -> turn completed
- `result.stats` -> token/cost metadata payload

## Updated Feasibility

Feasibility improves from medium-high to high for a first-class provider adapter.

Reason:

- `stream-json` is real NDJSON.
- It exposes stable session ids.
- It exposes structured tool use/results for at least file reads and command execution.
- It exposes final result/status/stats.
- Resume works with explicit session ids when the message is supplied through deprecated `--prompt`.
  Stdin resume did not work in local BOB `1.0.4`.

Remaining unknowns:

- structured approval request events
- file edit event shape
- failed tool event shape
- interrupted turn behavior
- non-deprecated resume prompt delivery
- model inventory command
- per-process MCP injection

## Recommended Adapter Direction

Build a `BobAdapter` around line-oriented JSON parsing:

1. spawn `bob --output-format stream-json --chat-mode code`
2. pass first prompt as positional arg
3. persist `init.session_id`
4. on follow-up turn, spawn `bob --output-format stream-json --resume <session_id> --prompt <prompt>`
   until BOB stdin resume works
5. map `tool_use` / `tool_result` pairs by `tool_id`
6. classify known tool names:
   - `execute_command`
   - `read_file`
   - future file edit tools after fixture capture
   - `attempt_completion`
7. treat non-JSON stdout lines as parser warnings
8. treat stderr as non-fatal unless exit code fails or known auth/setup patterns match

Next fixture still needed before implementation:

```sh
bob --output-format stream-json --chat-mode code --approval-mode yolo --max-coins 1 \
  "Create /tmp/t3-bob-fixture.txt containing T3_BOB_FILE_EDIT_OK, then read it back, then delete it."
```

That should be run only if temporary file writes are acceptable.
