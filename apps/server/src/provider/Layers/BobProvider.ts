import {
  type BobSettings,
  type ModelCapabilities,
  ProviderDriverKind,
  type ServerProviderModel,
} from "@t3tools/contracts";
import * as DateTime from "effect/DateTime";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Result from "effect/Result";
import { ChildProcess, ChildProcessSpawner } from "effect/unstable/process";
import { createModelCapabilities } from "@t3tools/shared/model";
import { resolveSpawnCommand } from "@t3tools/shared/shell";

import {
  buildServerProvider,
  isCommandMissingCause,
  parseGenericCliVersion,
  providerModelsFromSettings,
  spawnAndCollect,
  type ServerProviderDraft,
} from "../providerSnapshot.ts";

const PROVIDER = ProviderDriverKind.make("bob");
const VERSION_PROBE_TIMEOUT_MS = 4_000;
const BOB_PRESENTATION = {
  displayName: "BOB",
  badgeLabel: "Experimental",
  showInteractionModeToggle: true,
  requiresNewThreadForModelChange: true,
} as const;

const EMPTY_CAPABILITIES: ModelCapabilities = createModelCapabilities({
  optionDescriptors: [],
});

const BOB_BUILT_IN_MODELS: ReadonlyArray<ServerProviderModel> = [
  {
    slug: "premium",
    name: "Premium",
    isCustom: false,
    capabilities: EMPTY_CAPABILITIES,
  },
];

export function bobModelsFromSettings(
  customModels: ReadonlyArray<string> | undefined,
): ReadonlyArray<ServerProviderModel> {
  return providerModelsFromSettings(
    BOB_BUILT_IN_MODELS,
    PROVIDER,
    customModels ?? [],
    EMPTY_CAPABILITIES,
  );
}

export function buildInitialBobProviderSnapshot(
  bobSettings: BobSettings,
): Effect.Effect<ServerProviderDraft> {
  return Effect.gen(function* () {
    const checkedAt = yield* Effect.map(DateTime.now, DateTime.formatIso);
    const models = bobModelsFromSettings(bobSettings.customModels);
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: bobSettings.enabled,
      checkedAt,
      models,
      probe: {
        installed: bobSettings.enabled,
        version: null,
        status: bobSettings.enabled ? "warning" : "warning",
        auth: { status: "unknown" },
        message: bobSettings.enabled
          ? "Checking BOB CLI availability..."
          : "BOB is disabled in T3 Code settings.",
      },
    });
  });
}

const runBobVersionCommand = (
  bobSettings: BobSettings,
  environment: NodeJS.ProcessEnv = process.env,
) =>
  Effect.gen(function* () {
    const command = bobSettings.binaryPath || "bob";
    const spawnCommand = yield* resolveSpawnCommand(command, ["--version"], {
      env: environment,
    });
    return yield* spawnAndCollect(
      command,
      ChildProcess.make(spawnCommand.command, spawnCommand.args, {
        env: environment,
        shell: spawnCommand.shell,
      }),
    );
  });

export const checkBobProviderStatus = Effect.fn("checkBobProviderStatus")(function* (
  bobSettings: BobSettings,
  environment: NodeJS.ProcessEnv = process.env,
): Effect.fn.Return<ServerProviderDraft, never, ChildProcessSpawner.ChildProcessSpawner> {
  const checkedAt = DateTime.formatIso(yield* DateTime.now);
  const models = bobModelsFromSettings(bobSettings.customModels);

  if (!bobSettings.enabled) {
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: false,
      checkedAt,
      models,
      probe: {
        installed: false,
        version: null,
        status: "warning",
        auth: { status: "unknown" },
        message: "BOB is disabled in T3 Code settings.",
      },
    });
  }

  const apiKeyName = bobSettings.apiKeyEnvironmentVariable.trim() || "BOBSHELL_API_KEY";
  const apiKeyMissing = bobSettings.authMethod === "api-key" && !environment[apiKeyName];

  const versionResult = yield* runBobVersionCommand(bobSettings, environment).pipe(
    Effect.timeoutOption(VERSION_PROBE_TIMEOUT_MS),
    Effect.result,
  );

  if (Result.isFailure(versionResult)) {
    const error = versionResult.failure;
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: !isCommandMissingCause(error),
        version: null,
        status: "error",
        auth: { status: apiKeyMissing ? "unauthenticated" : "unknown" },
        message: isCommandMissingCause(error)
          ? "BOB CLI (`bob`) is not installed or not on PATH."
          : "Failed to execute BOB CLI health check.",
      },
    });
  }

  if (Option.isNone(versionResult.success)) {
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version: null,
        status: "error",
        auth: { status: apiKeyMissing ? "unauthenticated" : "unknown" },
        message: "BOB CLI is installed but timed out while running `bob --version`.",
      },
    });
  }

  const versionOutput = versionResult.success.value;
  const version = parseGenericCliVersion(`${versionOutput.stdout}\n${versionOutput.stderr}`);
  if (versionOutput.code !== 0) {
    return buildServerProvider({
      presentation: BOB_PRESENTATION,
      enabled: true,
      checkedAt,
      models,
      probe: {
        installed: true,
        version,
        status: "error",
        auth: { status: apiKeyMissing ? "unauthenticated" : "unknown" },
        message: "BOB CLI version probe exited with a non-zero status.",
      },
    });
  }

  return buildServerProvider({
    presentation: BOB_PRESENTATION,
    enabled: true,
    checkedAt,
    models,
    probe: {
      installed: true,
      version,
      status: apiKeyMissing ? "warning" : "ready",
      auth: { status: apiKeyMissing ? "unauthenticated" : "unknown" },
      ...(apiKeyMissing
        ? {
            message: `BOB API-key auth is selected, but ${apiKeyName} is not set in the provider environment.`,
          }
        : {}),
    },
  });
});
