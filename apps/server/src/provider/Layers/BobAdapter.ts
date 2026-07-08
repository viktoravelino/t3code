import {
  EventId,
  type BobSettings,
  type CanonicalItemType,
  type ProviderApprovalDecision,
  type ProviderRuntimeEvent,
  type ProviderSession,
  type ProviderUserInputAnswers,
  ProviderDriverKind,
  ProviderInstanceId,
  RuntimeItemId,
  ThreadId,
  TurnId,
} from "@t3tools/contracts";
import { parseCliArgs } from "@t3tools/shared/cliArgs";
import { fromJsonStringPretty } from "@t3tools/shared/schemaJson";
import { resolveSpawnCommand } from "@t3tools/shared/shell";
import * as Crypto from "effect/Crypto";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Exit from "effect/Exit";
import * as FileSystem from "effect/FileSystem";
import * as Fiber from "effect/Fiber";
import * as Path from "effect/Path";
import * as PubSub from "effect/PubSub";
import * as Ref from "effect/Ref";
import * as Schema from "effect/Schema";
import * as Scope from "effect/Scope";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";

import { ServerConfig } from "../../config.ts";
import * as McpProviderSession from "../../mcp/McpProviderSession.ts";
import {
  ProviderAdapterRequestError,
  ProviderAdapterSessionClosedError,
  ProviderAdapterSessionNotFoundError,
  ProviderAdapterValidationError,
} from "../Errors.ts";
import type { BobAdapterShape } from "../Services/BobAdapter.ts";
import {
  isBobInitEvent,
  isBobMessageEvent,
  isBobResultEvent,
  isBobToolResultEvent,
  isBobToolUseEvent,
  type BobKnownEvent,
  type BobToolUseEvent,
} from "../bob/BobStreamEvents.ts";
import { parseBobStreamLine } from "../bob/BobStreamParser.ts";

const PROVIDER = ProviderDriverKind.make("bob");
const BOB_RESUME_VERSION = 1 as const;
const T3_MCP_SERVER_NAME = "t3-code";
const T3_MCP_ALWAYS_ALLOW_TOOLS = [
  "preview_status",
  "preview_open",
  "preview_navigate",
  "preview_resize",
  "preview_snapshot",
  "preview_click",
  "preview_type",
  "preview_press",
  "preview_scroll",
  "preview_evaluate",
  "preview_wait_for",
  "preview_recording_start",
  "preview_recording_stop",
] as const;

const T3_CODE_BROWSER_TOOL_INSTRUCTIONS = `# T3 Code collaborative browser

You are running inside T3 Code. The \`t3-code\` MCP server is the product-native collaborative browser shared with the user. When it exposes \`preview_*\` tools, prefer those tools for browser navigation, inspection, interaction, screenshots, and recordings.

For browser work, first call \`preview_status\`. If no automation-capable preview is attached, call \`preview_open\` before concluding that the browser is unavailable. Then use \`preview_navigate\`, \`preview_snapshot\`, and the focused interaction tools. Prefer snapshot-provided locators over coordinates.

Do not switch to global browser tools, Chrome, Node REPL browser automation, standalone Playwright, or agent-browser merely because the preview is initially closed or a first call fails. Use an alternative browser system only when the T3 preview tools are absent, the user explicitly requests another browser, or \`preview_open\` returns an explicit unsupported/unavailable error. A failed T3 preview tool call should be inspected and retried with corrected arguments when the error is actionable.
`;

const decodeUnknownJsonString = Schema.decodeUnknownEffect(Schema.UnknownFromJsonString);
const encodeUnknownJsonString = Schema.encodeEffect(fromJsonStringPretty(Schema.Unknown));

export interface BobAdapterLiveOptions {
  readonly instanceId?: ProviderInstanceId;
  readonly environment?: NodeJS.ProcessEnv;
}

interface BobTurnSnapshot {
  readonly id: TurnId;
  readonly items: Array<unknown>;
}

interface BobSessionContext {
  session: ProviderSession;
  readonly sessionScope: Scope.Closeable;
  readonly turns: Array<BobTurnSnapshot>;
  readonly activeTools: Map<
    string,
    {
      readonly itemType: CanonicalItemType;
      readonly title: string;
      readonly toolName: string;
    }
  >;
  activeTurnId: TurnId | undefined;
  activeFiber: Fiber.Fiber<void, never> | undefined;
  bobSessionId: string | undefined;
  stopped: boolean;
}

interface EventBaseInput {
  readonly threadId: ThreadId;
  readonly turnId?: TurnId | undefined;
  readonly itemId?: string | undefined;
  readonly createdAt?: string | undefined;
  readonly raw?: unknown;
}

function parseBobResume(raw: unknown): { readonly sessionId: string } | undefined {
  if (!raw || typeof raw !== "object" || Array.isArray(raw)) return undefined;
  const record = raw as Record<string, unknown>;
  if (record.schemaVersion !== BOB_RESUME_VERSION) return undefined;
  const sessionId = typeof record.sessionId === "string" ? record.sessionId.trim() : "";
  return sessionId.length > 0 ? { sessionId } : undefined;
}

function toMessage(cause: unknown, fallback: string): string {
  return cause instanceof Error && cause.message.trim().length > 0 ? cause.message : fallback;
}

function getStringParam(event: BobToolUseEvent, key: string): string | undefined {
  const value = event.parameters[key];
  return typeof value === "string" && value.trim().length > 0 ? value : undefined;
}

function itemTypeForTool(toolName: string): CanonicalItemType {
  const normalized = toolName.toLowerCase();
  if (
    normalized.includes("command") ||
    normalized.includes("bash") ||
    normalized.includes("shell")
  ) {
    return "command_execution";
  }
  if (
    normalized.includes("edit") ||
    normalized.includes("write") ||
    normalized.includes("delete") ||
    normalized.includes("file")
  ) {
    return "file_change";
  }
  if (normalized.includes("web")) return "web_search";
  if (normalized.includes("mcp")) return "mcp_tool_call";
  return "dynamic_tool_call";
}

function titleForToolUse(event: BobToolUseEvent): string {
  if (event.tool_name === "execute_command") {
    return getStringParam(event, "command") ?? "Command";
  }
  if (event.tool_name === "read_file") {
    return (
      getStringParam(event, "file_path") ?? getStringParam(event, "absolute_path") ?? "Read file"
    );
  }
  return event.tool_name;
}

function isUnknownRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function t3McpServerConfig(input: {
  readonly endpoint: string;
  readonly authorizationHeader: string;
}) {
  return {
    httpUrl: input.endpoint,
    headers: {
      Authorization: input.authorizationHeader,
    },
    alwaysAllow: [...T3_MCP_ALWAYS_ALLOW_TOOLS],
    disabled: false,
  };
}

function mergeBobMcpConfig(
  existing: unknown,
  input: {
    readonly endpoint: string;
    readonly authorizationHeader: string;
  },
): unknown {
  const root = isUnknownRecord(existing) ? { ...existing } : {};
  const existingServers = root.mcpServers;
  const mcpServers = isUnknownRecord(existingServers) ? { ...existingServers } : {};
  mcpServers[T3_MCP_SERVER_NAME] = t3McpServerConfig(input);
  return {
    ...root,
    mcpServers,
  };
}

function promptWithT3McpInstructions(prompt: string): string {
  return `${T3_CODE_BROWSER_TOOL_INSTRUCTIONS}

${prompt}`;
}

function buildBobArgs(input: {
  readonly settings: BobSettings;
  readonly prompt: string;
  readonly model: string | undefined;
  readonly interactionMode: "default" | "plan" | undefined;
  readonly runtimeMode: ProviderSession["runtimeMode"];
  readonly sandboxMode?: string | undefined;
  readonly resumeSessionId?: string | undefined;
  readonly includeDirectories?: ReadonlyArray<string> | undefined;
  readonly t3McpEnabled?: boolean | undefined;
}): ReadonlyArray<string> {
  const args: string[] = ["--output-format", "stream-json"];
  args.push("--chat-mode", input.interactionMode === "plan" ? "plan" : "code");
  if (input.model?.trim()) args.push("--model", input.model.trim());
  if (input.settings.authMethod === "api-key") args.push("--auth-method", "api-key");
  if (input.settings.acceptLicense) args.push("--accept-license");
  if (input.settings.trustWorkspace) args.push("--trust");
  if (input.settings.teamId.trim()) args.push("--team-id", input.settings.teamId.trim());
  if (input.settings.instanceId.trim())
    args.push("--instance-id", input.settings.instanceId.trim());
  for (const directory of input.includeDirectories ?? []) {
    if (directory.trim().length > 0) args.push("--include-directories", directory);
  }
  if (input.t3McpEnabled) args.push("--allowed-mcp-server-names", T3_MCP_SERVER_NAME);
  if (input.sandboxMode && input.sandboxMode !== "danger-full-access") args.push("--sandbox");
  switch (input.runtimeMode) {
    case "full-access":
      args.push("--approval-mode", "yolo");
      break;
    case "auto-accept-edits":
      args.push("--approval-mode", "auto_edit");
      break;
    case "approval-required":
    default:
      args.push("--approval-mode", "default");
      break;
  }
  const parsedExtraArgs = parseCliArgs(input.settings.launchArgs);
  const extraArgs = [
    ...Object.entries(parsedExtraArgs.flags).flatMap(([key, value]) =>
      value === null ? [`--${key}`] : [`--${key}`, value],
    ),
    ...parsedExtraArgs.positionals,
  ];
  args.push(...extraArgs);
  if (input.resumeSessionId) {
    args.push("--resume", input.resumeSessionId, "--prompt", input.prompt);
  } else {
    args.push(input.prompt);
  }
  return args;
}

export function makeBobAdapter(bobSettings: BobSettings, options?: BobAdapterLiveOptions) {
  return Effect.gen(function* () {
    const boundInstanceId = options?.instanceId ?? ProviderInstanceId.make("bob");
    const environment = options?.environment ?? process.env;
    const serverConfig = yield* ServerConfig;
    const crypto = yield* Crypto.Crypto;
    const fs = yield* FileSystem.FileSystem;
    const path = yield* Path.Path;
    const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
    const runtimeEvents = yield* PubSub.unbounded<ProviderRuntimeEvent>();
    const sessions = new Map<ThreadId, BobSessionContext>();

    const nowIso = Effect.map(DateTime.now, DateTime.formatIso);
    const randomUUIDv4 = crypto.randomUUIDv4.pipe(
      Effect.mapError(
        (cause) =>
          new ProviderAdapterRequestError({
            provider: PROVIDER,
            method: "crypto/randomUUIDv4",
            detail: "Failed to generate BOB runtime identifier.",
            cause,
          }),
      ),
    );
    const nextEventId = crypto.randomUUIDv4.pipe(Effect.orDie, Effect.map(EventId.make));
    const buildEventBase = (input: EventBaseInput) =>
      Effect.gen(function* () {
        return {
          eventId: yield* nextEventId,
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          threadId: input.threadId,
          ...(input.turnId ? { turnId: input.turnId } : {}),
          ...(input.itemId ? { itemId: RuntimeItemId.make(input.itemId) } : {}),
          createdAt: input.createdAt ?? (yield* nowIso),
          ...(input.raw
            ? {
                raw: {
                  source: "bob.stream-json" as const,
                  payload: input.raw,
                },
              }
            : {}),
        };
      });
    const emit = (event: ProviderRuntimeEvent) =>
      PubSub.publish(runtimeEvents, event).pipe(Effect.asVoid);

    const updateSession = (
      context: BobSessionContext,
      patch: Partial<ProviderSession>,
    ): Effect.Effect<void> =>
      Effect.gen(function* () {
        context.session = {
          ...context.session,
          ...patch,
          updatedAt: yield* nowIso,
        };
      });

    const ensureSession = (
      threadId: ThreadId,
    ): Effect.Effect<
      BobSessionContext,
      ProviderAdapterSessionNotFoundError | ProviderAdapterSessionClosedError
    > =>
      Effect.gen(function* () {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        if (context.stopped) {
          return yield* new ProviderAdapterSessionClosedError({ provider: PROVIDER, threadId });
        }
        return context;
      });

    const prepareBobProjectMcpConfig = Effect.fn("prepareBobProjectMcpConfig")(function* (
      context: BobSessionContext,
    ) {
      const mcpSession = McpProviderSession.readMcpProviderSession(context.session.threadId);
      if (!mcpSession) {
        return undefined;
      }
      const cwd = context.session.cwd ?? serverConfig.cwd;
      const bobDir = path.join(cwd, ".bob");
      const mcpConfigPath = path.join(bobDir, "mcp.json");
      const previousContent = (yield* fs
        .exists(mcpConfigPath)
        .pipe(Effect.orElseSucceed(() => false)))
        ? yield* fs.readFileString(mcpConfigPath)
        : undefined;
      const existingConfig = previousContent
        ? yield* decodeUnknownJsonString(previousContent).pipe(Effect.orElseSucceed(() => ({})))
        : {};
      const mcpConfig = yield* encodeUnknownJsonString(
        mergeBobMcpConfig(existingConfig, {
          endpoint: mcpSession.endpoint,
          authorizationHeader: mcpSession.authorizationHeader,
        }),
      );
      yield* fs.makeDirectory(bobDir, { recursive: true });
      yield* fs.writeFileString(mcpConfigPath, `${mcpConfig}\n`);
      return {
        cwd,
        restore:
          previousContent === undefined
            ? fs.remove(mcpConfigPath, { force: true })
            : fs.writeFileString(mcpConfigPath, previousContent),
      } as const;
    });

    const appendTurnItem = (context: BobSessionContext, turnId: TurnId, item: unknown) => {
      let turn = context.turns.find((candidate) => candidate.id === turnId);
      if (!turn) {
        turn = { id: turnId, items: [] };
        context.turns.push(turn);
      }
      turn.items.push(item);
    };

    const handleBobEvent = Effect.fn("handleBobEvent")(function* (
      context: BobSessionContext,
      turnId: TurnId,
      event: BobKnownEvent,
    ) {
      appendTurnItem(context, turnId, event);
      if (isBobInitEvent(event)) {
        context.bobSessionId = event.session_id;
        yield* updateSession(context, {
          resumeCursor: {
            schemaVersion: BOB_RESUME_VERSION,
            sessionId: event.session_id,
          },
          ...(event.model ? { model: event.model } : {}),
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.session.threadId, turnId, raw: event })),
          type: "thread.started",
          payload: { providerThreadId: event.session_id },
        });
        return;
      }

      if (isBobMessageEvent(event)) {
        // BOB streams internal reasoning, deprecation notices, and tool-status
        // text as assistant message deltas. The stable user-facing answer is
        // the attempt_completion tool payload, handled below.
        return;
      }

      if (isBobToolUseEvent(event)) {
        if (event.tool_name === "attempt_completion") {
          const result = getStringParam(event, "result");
          if (result) {
            yield* emit({
              ...(yield* buildEventBase({
                threadId: context.session.threadId,
                turnId,
                raw: event,
              })),
              type: "content.delta",
              payload: {
                streamKind: "assistant_text",
                delta: result.trim(),
              },
            });
          }
          return;
        }
        const itemType = itemTypeForTool(event.tool_name);
        const title = titleForToolUse(event);
        context.activeTools.set(event.tool_id, {
          itemType,
          title,
          toolName: event.tool_name,
        });
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: event.tool_id,
            raw: event,
          })),
          type: "item.started",
          payload: {
            itemType,
            status: "inProgress",
            title,
            data: {
              toolName: event.tool_name,
              parameters: event.parameters,
            },
          },
        });
        return;
      }

      if (isBobToolResultEvent(event)) {
        const activeTool = context.activeTools.get(event.tool_id);
        if (!activeTool) return;
        context.activeTools.delete(event.tool_id);
        yield* emit({
          ...(yield* buildEventBase({
            threadId: context.session.threadId,
            turnId,
            itemId: event.tool_id,
            raw: event,
          })),
          type: "item.completed",
          payload: {
            itemType: activeTool.itemType,
            status: event.status === "success" ? "completed" : "failed",
            title: activeTool.title,
            ...(event.output && event.output.length > 0 ? { detail: event.output } : {}),
            data: {
              toolName: activeTool.toolName,
              result: event,
            },
          },
        });
        return;
      }

      if (isBobResultEvent(event)) {
        const state = event.status === "success" ? "completed" : "failed";
        yield* emit({
          ...(yield* buildEventBase({ threadId: context.session.threadId, turnId, raw: event })),
          type: "turn.completed",
          payload: {
            state,
            usage: event.stats,
          },
        });
        yield* updateSession(context, { status: "ready", activeTurnId: undefined });
        context.activeTurnId = undefined;
      }
    });

    const runBobTurn = Effect.fn("runBobTurn")(function* (
      context: BobSessionContext,
      turnId: TurnId,
      input: {
        readonly prompt: string;
        readonly model: string | undefined;
        readonly interactionMode: "default" | "plan" | undefined;
        readonly sandboxMode?: string | undefined;
      },
    ) {
      const resume =
        parseBobResume(context.session.resumeCursor) ??
        (context.bobSessionId ? { sessionId: context.bobSessionId } : undefined);
      const mcpProject = yield* prepareBobProjectMcpConfig(context);
      yield* Effect.gen(function* () {
        const args = buildBobArgs({
          settings: bobSettings,
          prompt: mcpProject ? promptWithT3McpInstructions(input.prompt) : input.prompt,
          model: input.model,
          interactionMode: input.interactionMode,
          runtimeMode: context.session.runtimeMode,
          sandboxMode: input.sandboxMode,
          resumeSessionId: resume?.sessionId,
          ...(mcpProject ? { t3McpEnabled: true } : {}),
        });
        const spawnCommand = yield* resolveSpawnCommand(bobSettings.binaryPath || "bob", args, {
          env: environment,
        });
        const child = yield* spawner.spawn(
          ChildProcess.make(spawnCommand.command, spawnCommand.args, {
            cwd: mcpProject?.cwd ?? context.session.cwd ?? serverConfig.cwd,
            env: environment,
            shell: spawnCommand.shell,
          }),
        );
        const stderrRef = yield* Ref.make("");
        const stdoutFiber = yield* child.stdout.pipe(
          Stream.decodeText(),
          Stream.splitLines,
          Stream.runForEach((line) => {
            const parsed = parseBobStreamLine(line);
            if (parsed === null) return Effect.void;
            if (parsed.type === "known") return handleBobEvent(context, turnId, parsed.event);
            if (parsed.type === "warning") {
              return buildEventBase({ threadId: context.session.threadId, turnId }).pipe(
                Effect.flatMap((base) =>
                  emit({
                    ...base,
                    type: "runtime.warning",
                    payload: {
                      message: "BOB emitted a non-JSON stream line.",
                      detail: parsed,
                    },
                  }),
                ),
              );
            }
            return buildEventBase({
              threadId: context.session.threadId,
              turnId,
              raw: parsed.payload,
            }).pipe(
              Effect.flatMap((base) =>
                emit({
                  ...base,
                  type: "runtime.warning",
                  payload: {
                    message: `BOB emitted unknown stream event '${parsed.eventType}'.`,
                    detail: parsed.payload,
                  },
                }),
              ),
            );
          }),
          Effect.forkChild,
        );
        const stderrFiber = yield* child.stderr.pipe(
          Stream.decodeText(),
          Stream.runForEach((chunk) => Ref.update(stderrRef, (current) => current + chunk)),
          Effect.forkChild,
        );
        const exitCode = yield* child.exitCode;
        yield* Fiber.join(stdoutFiber).pipe(Effect.ignore);
        yield* Fiber.join(stderrFiber).pipe(Effect.ignore);
        if (Number(exitCode) !== 0) {
          const stderr = (yield* Ref.get(stderrRef)).trim();
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
            type: "runtime.error",
            payload: {
              message: stderr || `BOB exited with code ${Number(exitCode)}.`,
              class: "provider_error",
            },
          });
          yield* emit({
            ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
            type: "turn.completed",
            payload: {
              state: "failed",
              errorMessage: stderr || `BOB exited with code ${Number(exitCode)}.`,
            },
          });
          yield* updateSession(context, {
            status: "error",
            lastError: stderr || `BOB exited with code ${Number(exitCode)}.`,
            activeTurnId: undefined,
          });
          context.activeTurnId = undefined;
        }
      }).pipe(Effect.ensuring(mcpProject?.restore.pipe(Effect.ignore) ?? Effect.void));
    });

    const runBobTurnSafely = (
      context: BobSessionContext,
      turnId: TurnId,
      input: {
        readonly prompt: string;
        readonly model: string | undefined;
        readonly interactionMode: "default" | "plan" | undefined;
        readonly sandboxMode?: string | undefined;
      },
    ) =>
      runBobTurn(context, turnId, input).pipe(
        Effect.scoped,
        Effect.catchCause((cause) =>
          Effect.gen(function* () {
            const message = toMessage(cause, "BOB turn failed.");
            yield* emit({
              ...(yield* buildEventBase({ threadId: context.session.threadId, turnId })),
              type: "runtime.error",
              payload: {
                message,
                class: "provider_error",
              },
            });
            yield* updateSession(context, {
              status: "error",
              lastError: message,
              activeTurnId: undefined,
            });
            context.activeTurnId = undefined;
          }),
        ),
      );

    const startSession: BobAdapterShape["startSession"] = Effect.fn("startSession")(
      function* (input) {
        const existing = sessions.get(input.threadId);
        if (existing) {
          yield* Scope.close(existing.sessionScope, Exit.void).pipe(Effect.ignore);
          sessions.delete(input.threadId);
        }
        const sessionScope = yield* Scope.make();
        const createdAt = yield* nowIso;
        const session: ProviderSession = {
          provider: PROVIDER,
          providerInstanceId: boundInstanceId,
          status: "ready",
          runtimeMode: input.runtimeMode,
          cwd: input.cwd ?? serverConfig.cwd,
          ...(input.modelSelection ? { model: input.modelSelection.model } : {}),
          ...(input.resumeCursor !== undefined ? { resumeCursor: input.resumeCursor } : {}),
          threadId: input.threadId,
          createdAt,
          updatedAt: createdAt,
        };
        sessions.set(input.threadId, {
          session,
          sessionScope,
          turns: [],
          activeTools: new Map(),
          activeTurnId: undefined,
          activeFiber: undefined,
          bobSessionId: parseBobResume(input.resumeCursor)?.sessionId,
          stopped: false,
        });
        yield* emit({
          ...(yield* buildEventBase({ threadId: input.threadId })),
          type: "session.started",
          payload: { message: "BOB session started", resume: input.resumeCursor },
        });
        return session;
      },
    );

    const sendTurn: BobAdapterShape["sendTurn"] = Effect.fn("sendTurn")(function* (input) {
      const context = yield* ensureSession(input.threadId);
      if (context.activeTurnId) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "BOB does not support steering while a turn is running.",
        });
      }
      const prompt = input.input?.trim();
      if (!prompt) {
        return yield* new ProviderAdapterValidationError({
          provider: PROVIDER,
          operation: "sendTurn",
          issue: "BOB turns require text input.",
        });
      }
      const turnId = TurnId.make(`bob-turn-${yield* randomUUIDv4}`);
      context.activeTurnId = turnId;
      yield* updateSession(context, {
        status: "running",
        activeTurnId: turnId,
        model: input.modelSelection?.model ?? context.session.model,
      });
      yield* emit({
        ...(yield* buildEventBase({ threadId: input.threadId, turnId })),
        type: "turn.started",
        payload: { model: input.modelSelection?.model ?? context.session.model },
      });
      const fiber = yield* runBobTurnSafely(context, turnId, {
        prompt,
        model: input.modelSelection?.model ?? context.session.model,
        interactionMode: input.interactionMode,
      }).pipe(Effect.forkIn(context.sessionScope));
      context.activeFiber = fiber;
      return { threadId: input.threadId, turnId };
    });

    const interruptTurn: BobAdapterShape["interruptTurn"] = Effect.fn("interruptTurn")(
      function* (threadId, turnId) {
        const context = yield* ensureSession(threadId);
        if (context.activeFiber) {
          yield* Fiber.interrupt(context.activeFiber).pipe(Effect.ignore);
        }
        const activeTurnId = turnId ?? context.activeTurnId;
        context.activeTurnId = undefined;
        yield* updateSession(context, { status: "ready", activeTurnId: undefined });
        if (activeTurnId) {
          yield* emit({
            ...(yield* buildEventBase({ threadId, turnId: activeTurnId })),
            type: "turn.aborted",
            payload: { reason: "Interrupted by user." },
          });
        }
      },
    );

    const unsupportedRequest = (method: string) =>
      Effect.fail(
        new ProviderAdapterRequestError({
          provider: PROVIDER,
          method,
          detail: "BOB structured approval responses are not supported yet.",
        }),
      );

    const respondToRequest: BobAdapterShape["respondToRequest"] = (
      _threadId: ThreadId,
      _requestId,
      _decision: ProviderApprovalDecision,
    ) => unsupportedRequest("respondToRequest");

    const respondToUserInput: BobAdapterShape["respondToUserInput"] = (
      _threadId: ThreadId,
      _requestId,
      _answers: ProviderUserInputAnswers,
    ) => unsupportedRequest("respondToUserInput");

    const stopSession: BobAdapterShape["stopSession"] = Effect.fn("stopSession")(
      function* (threadId) {
        const context = sessions.get(threadId);
        if (!context) {
          return yield* new ProviderAdapterSessionNotFoundError({ provider: PROVIDER, threadId });
        }
        context.stopped = true;
        sessions.delete(threadId);
        yield* Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore);
        yield* emit({
          ...(yield* buildEventBase({ threadId })),
          type: "session.exited",
          payload: {
            reason: "Session stopped.",
            recoverable: false,
            exitKind: "graceful",
          },
        });
      },
    );

    const readThread: BobAdapterShape["readThread"] = Effect.fn("readThread")(function* (threadId) {
      const context = yield* ensureSession(threadId);
      return {
        threadId,
        turns: context.turns,
      };
    });

    const rollbackThread: BobAdapterShape["rollbackThread"] = Effect.fn("rollbackThread")(
      function* (threadId) {
        return yield* readThread(threadId);
      },
    );

    return {
      provider: PROVIDER,
      capabilities: { sessionModelSwitch: "unsupported" },
      startSession,
      sendTurn,
      interruptTurn,
      respondToRequest,
      respondToUserInput,
      stopSession,
      listSessions: () =>
        Effect.sync(() => [...sessions.values()].map((context) => context.session)),
      hasSession: (threadId) => Effect.sync(() => sessions.has(threadId)),
      readThread,
      rollbackThread,
      stopAll: () =>
        Effect.gen(function* () {
          const contexts = [...sessions.values()];
          sessions.clear();
          yield* Effect.forEach(
            contexts,
            (context) => Scope.close(context.sessionScope, Exit.void).pipe(Effect.ignore),
            { discard: true, concurrency: "unbounded" },
          );
        }),
      get streamEvents() {
        return Stream.fromPubSub(runtimeEvents);
      },
    } satisfies BobAdapterShape;
  });
}
