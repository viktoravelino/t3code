# BOB Provider Action Plan

## Goal

Add BOB Shell as a first-class T3 Code provider.

Target outcome:

- user can select BOB in T3 Code
- T3 starts BOB-backed threads
- BOB responses stream into timeline
- BOB tool calls map to T3 runtime events
- BOB sessions resume through BOB session ids
- BOB setup/auth failures show clear provider status

## Current Evidence

Inputs:

- `docs/integrations/bob-provider-feasibility.md`
- `docs/integrations/bob-stream-json-fixtures.md`

Confirmed:

- `bob --output-format stream-json` emits newline-delimited JSON.
- event types seen:
  - `init`
  - `message`
  - `tool_use`
  - `tool_result`
  - `result`
- `init.session_id` is stable enough to use as resume cursor.
- `message` assistant deltas stream with `delta: true`.
- `tool_use` / `tool_result` pair through `tool_id`.
- `execute_command` exposes command, timeout, background fields.
- `read_file` exposes file path fields.
- `result.stats` includes token/cost/duration/budget/tool-count data.
- `--auth-method api-key` works though local `bob --help` does not list it.
- `--list-sessions --output-format json` is not structured in BOB `1.0.4`.

High-risk unknowns:

- approval request event schema
- file edit event schema
- failed tool event schema
- interruption behavior
- non-deprecated resume prompt delivery
- model inventory
- per-process MCP injection

## Design Decision

Implement as a provider driver, not a terminal embed.

Reason:

- T3 already has provider-instance routing, session lifecycle, event streams, approvals, settings,
  snapshots, model picker, and text generation hooks.
- BOB `stream-json` already maps well enough to T3 canonical runtime events.
- Terminal embed would bypass core T3 chat/session UX and produce weaker history/resume behavior.

## Phase 0: Remaining Fixtures

Capture before code changes that depend on unknown schemas.

### 0.1 Explicit Resume

Command:

```sh
printf '%s\n' 'Reply exactly: T3_BOB_STDIN_RESUME_OK' | \
  bob --output-format stream-json --resume <session_id> --max-coins 1
```

Need answer:

- does prompt via stdin work with `--resume`
- does explicit UUID work, not only `latest`
- does stdout remain NDJSON-only

How to test:

1. Run a first BOB prompt and copy `init.session_id` from stdout.
2. Run the stdin resume command above with that exact session id.
3. Confirm stdout is parseable NDJSON and includes the same `session_id`.
4. Confirm no deprecated `--prompt` warning appears.
5. Record exit code, stdout sample, stderr sample, and whether the response used prior session
   context.

### 0.2 Failed Tool

Command:

```sh
bob --output-format stream-json --chat-mode code --approval-mode yolo --max-coins 1 \
  "Run a command that exits with code 7: sh -c 'exit 7'. Then report the failure."
```

Need answer:

- `tool_result.status` values
- where exit code appears
- whether final `result.status` is success or failed

How to test:

1. Run the failed-tool command above.
2. Confirm whether a `tool_use` event appears for `execute_command`.
3. Confirm whether `tool_result` includes `status`, `output`, `exit_code`, or error detail.
4. Confirm final `result.status`.
5. Save one sanitized event sample for `tool_use`, `tool_result`, and `result`.

### 0.3 File Edit

Safe temp-file command:

```sh
bob --output-format stream-json --chat-mode code --approval-mode yolo --max-coins 1 \
  "Create /tmp/t3-bob-fixture.txt containing T3_BOB_FILE_EDIT_OK, read it back, then delete it."
```

Need answer:

- file edit tool names
- parameters shape
- result shape
- whether line stats appear in `result.stats.files`

How to test:

1. Run the temp-file command above.
2. Confirm `/tmp/t3-bob-fixture.txt` does not remain after completion.
3. Capture all `tool_use` and `tool_result` events whose names mention write, edit, delete, shell,
   or file.
4. Confirm whether `result.stats.files.totalLinesAdded` / `totalLinesRemoved` changed.
5. Save sanitized samples into the fixture doc.

### 0.4 Approval Request

Run without `--approval-mode yolo` in a throwaway temp directory.

Need answer:

- whether BOB emits structured approval request events
- whether stdin can answer approvals
- whether process waits forever without TTY

Decision after 0.4:

- if structured approvals exist: implement `respondToRequest`
- if not: map T3 approval policy to BOB startup flags only, and mark runtime approval prompts as
  unsupported

How to test:

1. Create a temporary directory outside this repo.
2. Run BOB without `--approval-mode yolo` and ask for a harmless command such as `pwd`.
3. Watch whether stdout emits a structured approval event before waiting.
4. If it waits for terminal input, stop the process and record the last stdout/stderr lines.
5. Do not approve file writes in this test.

## Phase 1: Pure Parser

Status: implemented with tests in `apps/server/src/provider/bob/BobStreamParser.test.ts`.

Create parser before provider wiring.

Likely files:

- `apps/server/src/provider/bob/BobStreamEvents.ts`
- `apps/server/src/provider/bob/BobStreamParser.ts`
- `apps/server/src/provider/bob/BobStreamParser.test.ts`

Parser responsibilities:

- parse NDJSON line-by-line
- preserve raw event payload for diagnostics
- validate known event shapes with Effect Schema
- tolerate unknown event types
- tolerate non-JSON lines as warnings, not defects
- pair `tool_use` and `tool_result` by `tool_id`
- classify known tools:
  - `attempt_completion`
  - `execute_command`
  - `read_file`
  - file edit tools after fixture capture
- expose normalized internal events for adapter mapping

Minimum test fixtures:

- plain answer
- command execution
- read file
- resume with warning delta
- missing API key failure stderr
- malformed JSON line
- unknown event type

Acceptance criteria:

- parser has no process-spawning behavior
- parser tests use saved fixtures
- parser never throws on unknown valid JSON event

How to test:

1. Run parser unit tests after implementation:

   ```sh
   vp test apps/server/src/provider/bob/BobStreamParser.test.ts
   ```

2. Manually feed one saved fixture through a small parser/debug command if provided by the
   implementation.
3. Confirm malformed lines produce warnings, not crashes.
4. Confirm unknown JSON events are preserved or ignored without failing.
5. Confirm `tool_use` and `tool_result` pair by `tool_id`.

## Phase 2: Contracts And Settings

Status: implemented with settings tests in `packages/contracts/src/settings.test.ts`.

Add BOB settings.

Files:

- `packages/contracts/src/settings.ts`
- `packages/contracts/src/model.ts`
- tests in `packages/contracts/src/settings.test.ts`

Proposed settings:

- `enabled`, default `true`
- `binaryPath`, default `bob`
- `authMethod`, default `default`, options `default | api-key`
- `apiKeyEnvironmentVariable`, default `BOBSHELL_API_KEY`
- `teamId`, optional string
- `instanceId`, optional string
- `launchArgs`, optional string
- `acceptLicense`, default `false`
- `trustWorkspace`, default `false`
- `customModels`, hidden

Model defaults:

- `DEFAULT_MODEL_BY_PROVIDER[bob] = "premium"` until model inventory exists
- `PROVIDER_DISPLAY_NAMES[bob] = "BOB"`

Acceptance criteria:

- old settings still decode
- unknown provider instances still round-trip
- BOB default instance can be represented by `providerInstances.bob`

How to test:

1. Run settings tests:

   ```sh
   vp test packages/contracts/src/settings.test.ts
   ```

2. Start T3 with no BOB settings and confirm defaults decode.
3. Add a `providerInstances.bob` entry in local settings with `driver: "bob"` and minimal config.
4. Restart server and confirm settings persist without dropping unknown fields.
5. Set `authMethod: "api-key"` and confirm missing key does not break settings decode.

## Phase 3: Snapshot Probe

Status: implemented with tests in `apps/server/src/provider/Layers/BobProvider.test.ts`.

Add cheap provider status.

Files:

- `apps/server/src/provider/Layers/BobProvider.ts`
- `apps/server/src/provider/Layers/BobProvider.test.ts`

Probe rules:

- run `bob --version` for installed/version
- do not run workspace-scanning commands in periodic probe
- if binary missing: `installed: false`, `status: error`
- if `authMethod === "api-key"` and env var missing: `status: warning`, auth unauthenticated
- otherwise: `installed: true`, `status: ready`, auth unknown
- build models from `customModels` plus default `premium`

Acceptance criteria:

- no network/auth prompt in probe
- import errors from workspace scanning cannot fail probe because probe uses only `--version`
- provider status gives clear missing API-key message

How to test:

1. Run snapshot probe tests:

   ```sh
   vp test apps/server/src/provider/Layers/BobProvider.test.ts
   ```

2. Temporarily configure `binaryPath` to a missing executable and confirm provider status says BOB
   is not installed.
3. Configure `authMethod: "api-key"` without `BOBSHELL_API_KEY` and confirm warning status.
4. Configure `binaryPath: "bob"` and confirm provider status uses version `1.0.4` or current local
   version.
5. Confirm no browser login or license prompt appears during status refresh.

## Phase 4: Adapter V1

Status: implemented for V1 chat/tool/resume mapping with tests in
`apps/server/src/provider/Layers/BobAdapter.test.ts`.

Implement session runtime through child processes.

Files:

- `apps/server/src/provider/Services/BobAdapter.ts`
- `apps/server/src/provider/Layers/BobAdapter.ts`
- `apps/server/src/provider/Layers/BobAdapter.test.ts`

Session model:

- one BOB process per turn, not one long-lived process
- first turn:
  - `bob --output-format stream-json --chat-mode code ... <prompt>`
- follow-up turn:
  - `bob --output-format stream-json --resume <session_id> --prompt <prompt> ...`
  - stdin resume failed locally on BOB `1.0.4`; keep deprecated `--prompt` until BOB fixes or
    documents a working replacement
- store BOB `session_id` in `ProviderSession.resumeCursor`
- keep in-memory T3 session context per `ThreadId`

Argument mapping:

- `binaryPath` -> executable
- `modelSelection.model` -> `--model`
- plan interaction -> `--chat-mode plan`
- code/default interaction -> `--chat-mode code`
- ask-only mode if needed -> `--chat-mode ask`
- T3 approval policy -> `--approval-mode`
- T3 sandbox mode -> `--sandbox`
- `teamId` -> `--team-id`
- `instanceId` -> `--instance-id`
- `acceptLicense` -> `--accept-license`
- `trustWorkspace` -> `--trust`
- `launchArgs` parsed with shared CLI arg parser

Event mapping:

- `init`:
  - set resume cursor
  - emit `thread.started` payload with BOB session id
- user `message`:
  - suppress by default
- assistant `message`:
  - suppress in V1 because observed content includes deprecation notices, internal reasoning, and
    tool-status text
- `tool_use execute_command`:
  - emit command item started
- `tool_result execute_command`:
  - emit command output/completed
- `tool_use read_file`:
  - emit file read/generic tool item started
- `tool_use attempt_completion`:
  - emit final assistant text from `parameters.result`
- `result status=success`:
  - emit turn completed
- process exit non-zero:
  - emit turn failed/session error with stderr detail

V1 unsupported:

- in-session model switch; use `sessionModelSwitch: "unsupported"` unless resume with new model is
  proven stable
- rollback; return not supported or empty snapshot until BOB has API for it
- runtime approval response if Phase 0 finds no structured approval event

Acceptance criteria:

- start session succeeds with fake BOB fixture process
- send turn streams assistant text
- command/read_file tool events appear in timeline
- failed process surfaces useful error
- stderr import noise does not fail successful turns
- stop/interrupt kills running child process

How to test:

1. Run adapter tests:

   ```sh
   vp test apps/server/src/provider/Layers/BobAdapter.test.ts
   ```

2. Start T3, select BOB, send:

   ```text
   Reply exactly: T3_BOB_ADAPTER_OK
   ```

3. Confirm assistant text streams incrementally.
4. Send a command prompt:

   ```text
   Run pwd and report the current working directory. Do not modify files.
   ```

5. Confirm timeline shows command execution and output.
6. Send a file-read prompt:

   ```text
   Read package.json name field and answer with only the package name. Do not modify files.
   ```

7. Confirm timeline shows file/tool event and final answer.
8. Start a long-running prompt, click interrupt, and confirm the BOB child process exits.
9. Restart T3 server, reopen the thread, send a follow-up, and confirm BOB resumes the same
   `session_id`.

## Phase 5: Driver Registration

Status: implemented with registration tests in `apps/server/src/provider/Drivers/BobDriver.test.ts`.

Files:

- `apps/server/src/provider/Drivers/BobDriver.ts`
- `apps/server/src/provider/builtInDrivers.ts`
- `apps/server/src/provider/Drivers/BobDriver.test.ts`

Driver creates:

- snapshot from `BobProvider`
- adapter from `BobAdapter`
- text generation fallback or BOB text generation stub

Continuation identity:

- `driverKind: bob`
- continuation key should include provider instance id and maybe BOB account/team config

Maintenance:

- no native updater in v1
- if install source is npm later, add package maintenance resolver

Acceptance criteria:

- `BUILT_IN_DRIVERS` includes `BobDriver`
- disabled config yields disabled snapshot
- driver instance teardown stops adapter sessions

How to test:

1. Run driver tests:

   ```sh
   vp test apps/server/src/provider/Drivers/BobDriver.test.ts
   ```

2. Start server and confirm BOB appears in provider snapshots.
3. Disable BOB in settings and confirm picker/status shows disabled.
4. Re-enable BOB and confirm snapshot refresh recovers.
5. Stop server during an active BOB turn and confirm no lingering `bob` process remains.

## Phase 6: UI Integration

Generic provider UI should mostly work from snapshots.

Likely files:

- `apps/web/src/session-logic.ts`
- `apps/web/src/providerModels.ts`
- `apps/web/src/components/chat/ProviderInstanceIcon.tsx`
- `apps/web/src/components/chat/providerIconUtils.ts`
- mobile provider option files if mobile should expose BOB

Tasks:

- add static picker option only where current code still uses hard-coded provider list
- add label/icon/accent if snapshot label is not enough
- ensure BOB status warnings render:
  - missing binary
  - missing API key
  - license/setup required
  - unsupported approvals

Acceptance criteria:

- BOB appears in model/provider picker when enabled
- unavailable BOB has clear status message
- custom model entries can be selected

How to test:

1. Start the web app.
2. Open provider/model picker and confirm BOB appears with expected label/icon.
3. Select BOB and send a plain prompt.
4. Configure BOB `binaryPath` to a bad value and confirm UI shows a clear unavailable state.
5. Add a custom model in settings and confirm it appears/selects in the model picker.
6. Confirm provider status warning does not overlap or break composer layout.

## Phase 7: Text Generation

Optional after chat provider works.

Files:

- `apps/server/src/textGeneration/BobTextGeneration.ts`
- tests beside existing text generation tests

Approach:

- use one-shot `bob --output-format stream-json --chat-mode ask`
- parse `attempt_completion.parameters.result`
- short timeout
- no tools if BOB supports tool allowlist restricting to completion

Acceptance criteria:

- branch/title/commit helpers can use BOB instance
- failure falls back cleanly or returns `TextGenerationError`

How to test:

1. Run text-generation tests:

   ```sh
   vp test apps/server/src/textGeneration/BobTextGeneration.test.ts
   ```

2. Configure git text generation provider/model to BOB.
3. Trigger thread title generation and confirm a title appears.
4. Trigger branch/commit helper flow if available.
5. Temporarily break `binaryPath` and confirm error is shown cleanly, without crashing server.

## Phase 8: Docs

Add user docs.

Files:

- `docs/providers/bob.md`
- update provider index if present

Must cover:

- BOB install
- `BOBSHELL_API_KEY`
- browser auth vs API-key auth
- license acceptance
- trusted folders
- sandboxing
- model configuration
- known limitations:
  - no model inventory in v1
  - no automatic MCP injection in v1
  - approvals depend on BOB stream support

How to test:

1. Follow the docs from a clean shell with `bob --version` available.
2. Confirm setup explains both browser auth and `BOBSHELL_API_KEY`.
3. Confirm docs mention `--accept-license`, trusted folders, and sandboxing.
4. Confirm known limitations match implemented behavior.
5. Ask another developer to follow only the doc and start one BOB-backed T3 thread.

## Test Plan

Required before completion:

```sh
vp check
vp run typecheck
```

Targeted tests:

```sh
vp test apps/server/src/provider/bob/BobStreamParser.test.ts
vp test apps/server/src/provider/Layers/BobAdapter.test.ts
vp test apps/server/src/provider/Layers/BobProvider.test.ts
vp test packages/contracts/src/settings.test.ts
```

Manual smoke:

```sh
bob --version
bob --output-format stream-json --chat-mode ask --max-coins 1 "Reply exactly: OK"
```

Then in T3 UI:

- select BOB provider
- send plain prompt
- send prompt requiring `read_file`
- send prompt requiring `execute_command`
- interrupt long-running prompt
- restart server and resume same thread

## Rollout Plan

Recommended rollout:

1. parser + fixtures merged first
2. provider behind disabled-by-default setting if needed
3. enable in local builds
4. collect more BOB event schemas
5. enable by default after approval/file-edit behavior is known

Feature gate option:

- `T3_ENABLE_BOB_PROVIDER=1`

Use gate if approval/file-edit fixtures remain unknown at implementation time.

## Acceptance Criteria For V1

V1 is complete when:

- BOB provider appears in picker
- plain BOB turn streams assistant text
- BOB command execution maps to T3 command event
- BOB file read maps to T3 tool/file event
- BOB turn completion maps to T3 completed status
- non-zero BOB process exits map to T3 failed status
- missing binary and missing API key show clear provider status
- BOB session id persists as resume cursor
- follow-up prompt resumes explicit BOB session
- `vp check` passes
- `vp run typecheck` passes

## Non-Goals For V1

- BOB MCP auto-injection
- model inventory
- full rollback support
- native BOB update management
- mobile-specific polish
- complex approval response UI if BOB does not emit structured approval requests

## Recommended Next Engineering Task

Start with Phase 1 parser.

Reason:

- highest certainty
- no UI churn
- no settings migration risk
- establishes stable contract for adapter tests
- unknown event types can be added fixture-by-fixture
