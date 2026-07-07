# BOB Provider Integration Feasibility

## Summary

BOB Shell can plausibly be integrated as a first-class T3 Code provider.

Best path: add a `bob` provider driver that wraps the local `bob` CLI through its `stream-json`
output mode, normalizes BOB events into T3's `ProviderRuntimeEvent` model, and exposes BOB as a
normal provider in the existing model picker/session flow.

Feasibility: medium-high, with one blocking unknown: the exact `--output-format stream-json` event
schema. Local CLI help confirms the flag exists, but the public docs currently emphasize text-based
interactive/non-interactive usage rather than documenting the JSON stream schema.

## Inputs Checked

- Internal docs URL:
  `https://internal.bob.ibm.com/docs/shell/getting-started/install-and-setup`
  - Result: redirects to login. No doc content visible from this environment.
- Public docs:
  - Shell overview: `https://bob.ibm.com/docs/shell`
  - Install/setup: `https://bob.ibm.com/docs/shell/getting-started/install-and-setup`
  - Interactive sessions: `https://bob.ibm.com/docs/shell/getting-started/start-bobshell-interactive`
  - Non-interactive sessions: `https://bob.ibm.com/docs/shell/getting-started/start-bobshell-non-interactive`
  - Configuration: `https://bob.ibm.com/docs/shell/configuration/configuring`
  - Tools: `https://bob.ibm.com/docs/shell/core-concepts/tools`
  - Checkpointing: `https://bob.ibm.com/docs/shell/features/checkpointing`
  - Instance command: `https://bob.ibm.com/docs/shell/features/instance-command`
  - Security: `https://bob.ibm.com/docs/shell/security/bob-security-guidance`
  - Sandboxing: `https://bob.ibm.com/docs/shell/security/sandboxing`
  - Trusted folders: `https://bob.ibm.com/docs/shell/security/trusted-folders`
- Local CLI:
  - `bob --version` => `1.0.4`
  - `bob --help`
  - `bob shell --help`
  - `bob mcp --help`
  - `bob extensions --help`
  - `bob --list-sessions --output-format json`
- Relevant T3 Code areas:
  - Provider driver SPI: `apps/server/src/provider/ProviderDriver.ts`
  - Built-in driver registration: `apps/server/src/provider/builtInDrivers.ts`
  - Provider settings schemas: `packages/contracts/src/settings.ts`
  - Provider model defaults/display labels: `packages/contracts/src/model.ts`
  - Provider snapshot shape: `packages/contracts/src/server.ts`
  - Provider adapter contract: `apps/server/src/provider/Services/ProviderAdapter.ts`
  - Existing CLI/SDK adapters:
    - `apps/server/src/provider/Layers/CodexAdapter.ts`
    - `apps/server/src/provider/Layers/ClaudeAdapter.ts`
    - `apps/server/src/provider/Layers/OpenCodeAdapter.ts`

## Verified BOB CLI Surface

BOB CLI supports:

- one-shot prompt through positional query or deprecated `-p, --prompt`
- interactive continuation via `-i, --prompt-interactive`
- session resume via `-r, --resume`
- session listing/deletion via `--list-sessions` / `--delete-session`
- model selection via `-m, --model`
- chat modes: `plan`, `code`, `advanced`, `ask`
- approval modes: `default`, `auto_edit`, `yolo`
- sandbox toggle: `-s, --sandbox`
- trusted workspace flag: `--trust`
- MCP allowlist: `--allowed-mcp-server-names`
- tool allowlist: `--allowed-tools`
- output formats: `text`, `json`, `stream-json`
- IBM-specific routing: `--instance-id`, `--team-id`
- license flow: `--accept-license`, `--show-license`
- auth reset: `--logout`
- MCP management: `bob mcp add/remove/list`
- extension management: install/list/update/enable/disable/link/new/validate

Public docs add:

- supported OS: macOS, Linux, Windows
- Node.js requirement: 22.15.0 or later
- install script: `curl -fsSL https://bob.ibm.com/download/bobshell.sh | bash`
- default auth: browser IBMid
- automation auth: API key through `BOBSHELL_API_KEY` plus `--auth-method api-key`
- first-run license acceptance is required; non-interactive can use `--accept-license`
- non-interactive sessions are intended for scripts/batch work
- non-interactive sessions default to non-destructive/read-style tools; writes require `--yolo`
- interactive sessions prompt before file reads, writes, and command execution
- config precedence: CLI args, env vars, system settings, project `.bob/settings.json`, user
  `~/.bob/settings.json`, system defaults, hardcoded defaults
- context files include `AGENTS.md`
- trusted folder decisions are stored in `~/.bob/trustedFolders.json`
- non-interactive mode does not show trust dialogs and defaults to trusted if no trust decision
  exists
- untrusted folders disable project settings, env loading, MCP, custom commands, and auto-approval
- sandboxing supports `--sandbox`, `BOB_SHELL_SANDBOX`, and settings-based configuration

`bob --list-sessions --output-format json` printed:

```text
No previous sessions found for this project.
```

It also emitted import errors from files under this repo's `.repos/alchemy-effect`, likely because
BOB scans workspace instructions/imports during startup. Integration should account for startup
stderr that is diagnostic noise rather than provider failure.

## T3 Provider Architecture Fit

T3 has the right extension points already:

- `ProviderDriver` creates one materialized provider instance with:
  - `snapshot`: availability/auth/model status
  - `adapter`: session lifecycle, turns, approvals, event stream
  - `textGeneration`: title/branch/commit/PR helper generation
- `providerInstances` already supports arbitrary driver slugs and per-instance config envelopes.
- UI provider selection is instance-aware.
- Runtime events are canonicalized, so BOB-specific output can stay server-side.
- `OpenCodeAdapter` is the closest structural reference if BOB's `stream-json` is rich enough.
- `ClaudeAdapter` is the closest reference if BOB behaves like one long interactive CLI process.
- `CodexAdapter` is closest only if BOB has a persistent JSON-RPC/app-server mode later.

## Recommended Integration Shape

Add BOB as a first-class provider:

- driver kind: `bob`
- display name: `BOB`
- settings schema: `BobSettings`
- server driver: `BobDriver`
- server adapter: `BobAdapter`
- server snapshot probe: `BobProvider`
- optional text generation: `BobTextGeneration`

Initial `BobSettings` should likely include:

- `enabled`
- `binaryPath`, default `bob`
- `authMethod`, likely `default` or `api-key`
- `teamId`
- `instanceId`
- `launchArgs`
- `customModels`
- `acceptLicense`
- maybe `trustWorkspace`
- maybe `apiKeyEnvironmentVariable`, default `BOBSHELL_API_KEY`, but not the key value itself

Avoid persisting auth secrets in T3. For automation, pass through `BOBSHELL_API_KEY` from the
provider instance environment or inherited process environment. Let BOB own browser auth/session
storage for IBMid flows.

## Session Strategy

Preferred v1:

1. Start one BOB process per T3 provider thread.
2. Use `bob --output-format stream-json --chat-mode <mode> --model <model>`.
3. For first turn, pass the prompt as positional args or stdin.
4. For follow-up turns, prefer BOB native resume if possible:
   - keep BOB process alive if interactive stdin is stable, or
   - stop process after turn and use `--resume <id>` when BOB emits a durable session id.
5. Normalize stream events into T3 events:
   - assistant text deltas
   - reasoning/intermediate output
   - command execution lifecycle
   - file change lifecycle
   - approval requests
   - errors
   - turn completion

Fallback v1 if `stream-json` is too thin:

- use one-shot JSON/text output
- emit coarse events: `turn.started`, final `assistant_message`, `turn.completed`
- mark approvals as unsupported or map T3 approval policy to BOB `--approval-mode`
- require `--auth-method api-key` for non-interactive execution unless interactive IBMid state is
  already established and BOB confirms it works without browser prompts

This would be usable but less native. It would lose rich tool/file/progress UI.

## Approval Mapping

T3 runtime modes and BOB approval flags can map cleanly enough:

- T3 default approval policy -> BOB `--approval-mode default`
- T3 auto-edit style behavior -> BOB `--approval-mode auto_edit`
- T3 dangerous/no-prompt mode -> BOB `--approval-mode yolo`
- T3 sandbox mode -> BOB `--sandbox`
- T3 workspace trust -> BOB `--trust`

Need confirm whether BOB emits machine-readable approval requests in `stream-json`. If not, T3 can
only preconfigure approval policy before process start.

Important security note: public docs say untrusted non-interactive sessions force approval mode back
to default and limit available tools. T3 should surface this as provider status/warning instead of
pretending `--approval-mode yolo` or `auto_edit` will always be honored.

## Model Handling

BOB help exposes `--model`, but no model inventory command was visible in help.

Recommended v1:

- use `DEFAULT_MODEL_BY_PROVIDER[bob] = "default"` or IBM's preferred default if docs confirm it
- allow `customModels` in settings
- pass selected model through `--model`
- show models from settings only

Recommended v2:

- add model inventory if BOB has a hidden/documented command or stream metadata.

## Snapshot Probe

Probe should be cheap and tolerant:

- run `bob --version` for installed/version
- avoid network/auth-heavy calls in the 5-minute refresh path
- optionally run a JSON/auth probe only if BOB documents one
- mark auth as `unknown` unless a cheap authenticated status exists
- handle startup stderr warnings without marking provider broken
- detect missing API key when `authMethod === "api-key"` and `BOBSHELL_API_KEY` is absent from the
  effective environment
- detect possible first-run setup gaps from process output: license not accepted, IBMid login
  needed, instance/team selection needed

Status examples:

- command missing -> `installed: false`, `status: error`
- version available -> `installed: true`, `status: ready`, `auth: unknown`
- license not accepted -> `status: warning`, message instructing setup
- auth required -> `status: warning`, message instructing `bob` setup/login

## MCP Handling

BOB has native `bob mcp add/remove/list`.

T3 already injects an MCP provider session into OpenCode when local server process ownership allows
it. Similar integration is possible only if BOB supports temporary per-session MCP config. If BOB MCP
config is global, avoid mutating it automatically. Safer v1: do not auto-register T3 MCP.

Public docs show BOB supports both settings-file MCP config and CLI MCP management. They do not
confirm per-process MCP injection. Treat automatic MCP wiring as v2.

## Text Generation

T3 provider instances also expose `textGeneration` for branch/title/commit/PR helpers.

Options:

- v1 simple: implement `BobTextGeneration` by running one-shot `bob --output-format json/text` with a
  short prompt and timeout.
- conservative: reuse existing default provider for git text generation until BOB session provider is
  proven stable.

Recommendation: implement after session adapter works. It is not required for chat feasibility.

## Files Likely Needed

Contracts:

- `packages/contracts/src/settings.ts`
  - add `BobSettings`
  - add `providers.bob`
  - add settings patch support if needed
- `packages/contracts/src/model.ts`
  - add BOB display name
  - add default model
  - add aliases only if useful

Server:

- `apps/server/src/provider/Drivers/BobDriver.ts`
- `apps/server/src/provider/Layers/BobAdapter.ts`
- `apps/server/src/provider/Layers/BobProvider.ts`
- `apps/server/src/provider/Services/BobAdapter.ts`
- `apps/server/src/provider/builtInDrivers.ts`
- maybe `apps/server/src/textGeneration/BobTextGeneration.ts`

Web:

- likely minimal changes because driver kind is open and display names can come from snapshots
- add hard-coded picker label only where static provider lists still exist
- add icon/color if desired:
  - `apps/web/src/components/chat/ProviderInstanceIcon.tsx`
  - `apps/web/src/components/chat/providerIconUtils.ts`
  - mobile equivalents if mobile should show BOB

Tests:

- settings decode/default tests
- driver registration test
- provider snapshot probe tests with fake `bob`
- adapter stream parser tests from recorded `stream-json` fixtures
- approval mapping tests
- session lifecycle tests: start, turn, interrupt, stop, resume

## Main Risks

- `stream-json` schema may not expose enough events for T3's rich timeline.
- BOB may not support durable resume ids in machine-readable output.
- BOB may require interactive TTY for auth/license/setup.
- Non-interactive mode needs API key auth for first-class automation per public docs.
- BOB may write non-JSON logs to stdout even under `stream-json`; parser must tolerate stderr/stdout
  noise or fail with clear diagnostics.
- Workspace instruction scanning can emit unrelated import errors before any session work.
- BOB MCP config may be global, making automatic T3 MCP registration risky.
- IBM-internal auth/team/instance concepts may need UI and environment handling beyond generic
  provider settings.
- BOB checkpointing writes shadow history under `~/.bob/history/<project_hash>` and
  `~/.bob/tmp/<project_hash>/checkpoints`; this can overlap conceptually with T3 checkpoints but
  does not modify the project Git repo.
- Non-interactive trust defaults to trusted if no explicit trust decision exists. T3 should not
  silently pass `--yolo` for fresh workspaces without clear user intent.

## Open Questions

- What is the exact `--output-format stream-json` schema?
- Does BOB emit stable session ids for `--resume`?
- Can BOB accept follow-up prompts on stdin while running interactively?
- Are approval prompts emitted as structured JSON?
- Is there a cheap auth/status command?
- Is there a model list command?
- Can MCP servers be supplied per process/session without mutating global BOB config?
- Does `--accept-license` need to run once globally, or can it be passed every start?
- Does `--auth-method api-key` exist in the installed `bob --help` output for every supported
  version? Public docs mention it, local `bob 1.0.4` help did not show it.
- Can `--trust` set trust non-interactively, or does it only declare a current workspace trust
  level for one run?

## Implementation Plan

1. Capture fixtures from `bob --output-format stream-json` for:
   - plain answer
   - command/tool call
   - file edit
   - approval prompt
   - error/auth-required
   - resume
   - untrusted workspace
   - missing `BOBSHELL_API_KEY`
   - license not accepted
2. Build pure parser module for BOB stream events.
3. Add `BobSettings` and provider model/display defaults.
4. Add `BobProvider` snapshot probe using `bob --version`.
5. Add `BobAdapter` with fake process tests around parser fixtures.
6. Add `BobDriver` and register it in `BUILT_IN_DRIVERS`.
7. Wire UI labels/icons only where generic snapshot behavior is insufficient.
8. Add docs for setup and known limitations.
9. Run `vp check` and `vp run typecheck`.

## Verdict

Integrating BOB is feasible without major architecture change. Current T3 provider abstraction was
built for this shape.

Scope depends entirely on BOB's stream protocol:

- rich `stream-json`: normal first-class provider, similar quality to OpenCode/Claude
- final-only JSON/text: basic provider, useful but limited timeline/approval fidelity
- TTY-only interactive behavior: not a good fit without a PTY adapter, and should be treated as
  terminal integration rather than provider integration

Recommended next step: collect sanitized `stream-json` fixtures from an authenticated BOB setup.
