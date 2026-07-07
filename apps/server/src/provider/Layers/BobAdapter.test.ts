// @effect-diagnostics nodeBuiltinImport:off
import * as NodeFSP from "node:fs/promises";
import * as NodeOS from "node:os";
import * as NodePath from "node:path";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, it } from "@effect/vitest";
import * as Deferred from "effect/Deferred";
import * as Effect from "effect/Effect";
import * as Fiber from "effect/Fiber";
import * as Layer from "effect/Layer";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";

import {
  BobSettings,
  ProviderDriverKind,
  ProviderInstanceId,
  type ProviderRuntimeEvent,
  ThreadId,
} from "@t3tools/contracts";

import { ServerConfig } from "../../config.ts";
import { makeBobAdapter } from "./BobAdapter.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

const bobAdapterTestLayer = ServerConfig.layerTest(process.cwd(), {
  prefix: "t3code-bob-adapter-test-",
}).pipe(Layer.provideMerge(NodeServices.layer));

async function makeMockBobWrapper(options?: { argvLogPath?: string }) {
  const dir = await NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-mock-"));
  const wrapperPath = NodePath.join(dir, "fake-bob.sh");
  const argvLog = options?.argvLogPath
    ? `printf '%s\\t' "$@" >> ${JSON.stringify(options.argvLogPath)}
printf '\\n' >> ${JSON.stringify(options.argvLogPath)}
`
    : "";
  const script = `#!/bin/sh
${argvLog}
cat <<'BOB_NDJSON'
{"type":"init","timestamp":"2026-06-23T18:56:30.478Z","session_id":"mock-bob-session","model":"premium"}
{"type":"message","timestamp":"2026-06-23T18:56:31.000Z","role":"assistant","content":"The --prompt (-p) flag has been deprecated and will be removed.","delta":true}
{"type":"message","timestamp":"2026-06-23T18:56:32.000Z","role":"assistant","content":"I should think internally and not leak this.","delta":true}
{"type":"tool_use","timestamp":"2026-06-23T18:56:33.000Z","tool_name":"execute_command","tool_id":"tool-command","parameters":{"command":"pwd","timeout":5,"background":false}}
{"type":"tool_result","timestamp":"2026-06-23T18:56:34.000Z","tool_id":"tool-command","status":"success","output":"/tmp/mock-workspace"}
{"type":"tool_use","timestamp":"2026-06-23T18:56:35.000Z","tool_name":"attempt_completion","tool_id":"tool-final","parameters":{"result":"\\nT3_BOB_ADAPTER_OK\\n"}}
{"type":"tool_result","timestamp":"2026-06-23T18:56:36.000Z","tool_id":"tool-final","status":"success","output":"\\nT3_BOB_ADAPTER_OK\\n"}
{"type":"result","timestamp":"2026-06-23T18:56:37.000Z","status":"success","stats":{"total_tokens":10,"tool_calls":2}}
BOB_NDJSON
`;
  await NodeFSP.writeFile(wrapperPath, script, "utf8");
  await NodeFSP.chmod(wrapperPath, 0o755);
  return wrapperPath;
}

async function readArgvLog(filePath: string) {
  const raw = await NodeFSP.readFile(filePath, "utf8");
  return raw
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .map((line) => line.split("\t").filter((token) => token.length > 0));
}

it.layer(bobAdapterTestLayer)("BobAdapterLive", (it) => {
  it.effect("maps BOB stream events without leaking raw assistant message deltas", () =>
    Effect.gen(function* () {
      const threadId = ThreadId.make("bob-mock-thread");
      const wrapperPath = yield* Effect.promise(() => makeMockBobWrapper());
      const adapter = yield* makeBobAdapter(decodeBobSettings({ binaryPath: wrapperPath })).pipe(
        Effect.orDie,
      );

      const runtimeEvents: ProviderRuntimeEvent[] = [];
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        Effect.sync(() => {
          runtimeEvents.push(event);
        }).pipe(
          Effect.andThen(
            event.type === "turn.completed"
              ? Deferred.succeed(turnCompleted, undefined)
              : Effect.void,
          ),
        ),
      ).pipe(Effect.forkChild);

      const session = yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        modelSelection: { instanceId: ProviderInstanceId.make("bob"), model: "premium" },
      });
      assert.equal(session.provider, "bob");

      yield* adapter.sendTurn({
        threadId,
        input: "Reply exactly: T3_BOB_ADAPTER_OK",
        attachments: [],
      });

      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      const deltas = runtimeEvents.filter((event) => event.type === "content.delta");
      assert.lengthOf(deltas, 1);
      assert.equal(deltas[0]?.type, "content.delta");
      if (deltas[0]?.type === "content.delta") {
        assert.equal(deltas[0].payload.delta, "T3_BOB_ADAPTER_OK");
      }

      const deltaText = deltas
        .map((event) => (event.type === "content.delta" ? event.payload.delta : ""))
        .join("\n");
      assert.notInclude(deltaText, "--prompt");
      assert.notInclude(deltaText, "think internally");

      const commandStarted = runtimeEvents.find(
        (event) => event.type === "item.started" && String(event.itemId) === "tool-command",
      );
      assert.equal(commandStarted?.type, "item.started");
      if (commandStarted?.type === "item.started") {
        assert.equal(commandStarted.payload.itemType, "command_execution");
        assert.equal(commandStarted.payload.title, "pwd");
      }

      const commandCompleted = runtimeEvents.find(
        (event) => event.type === "item.completed" && String(event.itemId) === "tool-command",
      );
      assert.equal(commandCompleted?.type, "item.completed");
      if (commandCompleted?.type === "item.completed") {
        assert.equal(commandCompleted.payload.status, "completed");
        assert.equal(commandCompleted.payload.detail, "/tmp/mock-workspace");
      }

      const sessions = yield* adapter.listSessions();
      assert.deepEqual(sessions[0]?.resumeCursor, {
        schemaVersion: 1,
        sessionId: "mock-bob-session",
      });

      yield* adapter.stopSession(threadId);
    }),
  );

  it.effect("passes explicit BOB session id from resume cursor", () =>
    Effect.gen(function* () {
      const tempDir = yield* Effect.promise(() =>
        NodeFSP.mkdtemp(NodePath.join(NodeOS.tmpdir(), "bob-argv-")),
      );
      const argvLogPath = NodePath.join(tempDir, "argv.log");
      const wrapperPath = yield* Effect.promise(() => makeMockBobWrapper({ argvLogPath }));
      const adapter = yield* makeBobAdapter(decodeBobSettings({ binaryPath: wrapperPath })).pipe(
        Effect.orDie,
      );
      const threadId = ThreadId.make("bob-resume-thread");
      const turnCompleted = yield* Deferred.make<void>();
      const eventsFiber = yield* Stream.runForEach(adapter.streamEvents, (event) =>
        event.type === "turn.completed" ? Deferred.succeed(turnCompleted, undefined) : Effect.void,
      ).pipe(Effect.forkChild);

      yield* adapter.startSession({
        threadId,
        provider: ProviderDriverKind.make("bob"),
        cwd: process.cwd(),
        runtimeMode: "full-access",
        resumeCursor: {
          schemaVersion: 1,
          sessionId: "restored-bob-session",
        },
      });
      yield* adapter.sendTurn({ threadId, input: "resumed prompt", attachments: [] });
      yield* Deferred.await(turnCompleted);
      yield* Fiber.interrupt(eventsFiber);

      const argv = yield* Effect.promise(() => readArgvLog(argvLogPath));
      assert.lengthOf(argv, 1);
      assert.includeMembers(argv[0] ?? [], [
        "--resume",
        "restored-bob-session",
        "--prompt",
        "resumed prompt",
      ]);

      yield* adapter.stopSession(threadId);
    }),
  );
});
