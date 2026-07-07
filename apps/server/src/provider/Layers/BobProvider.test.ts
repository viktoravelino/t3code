import * as NodeServices from "@effect/platform-node/NodeServices";
import { describe, expect, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";

import { BobSettings } from "@t3tools/contracts";

import {
  buildInitialBobProviderSnapshot,
  checkBobProviderStatus,
  bobModelsFromSettings,
} from "./BobProvider.ts";

const decodeBobSettings = Schema.decodeSync(BobSettings);

describe("buildInitialBobProviderSnapshot", () => {
  it.effect("returns a disabled snapshot when settings.enabled is false", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialBobProviderSnapshot(
        decodeBobSettings({ enabled: false }),
      );

      expect(snapshot.enabled).toBe(false);
      expect(snapshot.status).toBe("disabled");
      expect(snapshot.installed).toBe(false);
      expect(snapshot.message).toContain("disabled");
    }),
  );

  it.effect("returns a pending snapshot by default", () =>
    Effect.gen(function* () {
      const snapshot = yield* buildInitialBobProviderSnapshot(decodeBobSettings({}));

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("warning");
      expect(snapshot.version).toBeNull();
      expect(snapshot.message).toContain("Checking BOB");
      expect(snapshot.requiresNewThreadForModelChange).toBe(true);
      expect(snapshot.showInteractionModeToggle).toBe(true);
    }),
  );
});

describe("bobModelsFromSettings", () => {
  it("includes built-in premium model plus custom models", () => {
    const models = bobModelsFromSettings(["internal-special"]);

    expect(models.map((model) => model.slug)).toEqual(["premium", "internal-special"]);
    expect(models[0]?.isCustom).toBe(false);
    expect(models[1]?.isCustom).toBe(true);
  });
});

it.layer(NodeServices.layer)("checkBobProviderStatus", (it) => {
  it.effect("reports the binary as missing when the binary path does not resolve", () =>
    Effect.gen(function* () {
      const snapshot = yield* checkBobProviderStatus(
        decodeBobSettings({
          enabled: true,
          binaryPath: "/definitely/not/installed/bob-binary",
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(false);
      expect(snapshot.status).toBe("error");
      expect(snapshot.message).toContain("not installed");
    }),
  );

  it.effect("reports missing API key as a warning without blocking installed status", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-version-" });
          const bobPath = path.join(dir, "bob");
          yield* fs.writeFileString(
            bobPath,
            ["#!/bin/sh", 'printf "bob-shell 1.0.4\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(bobPath, 0o755);

          return yield* checkBobProviderStatus(
            decodeBobSettings({
              enabled: true,
              binaryPath: bobPath,
              authMethod: "api-key",
              apiKeyEnvironmentVariable: "T3_TEST_BOB_API_KEY",
            }),
            {},
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.version).toBe("1.0.4");
      expect(snapshot.status).toBe("warning");
      expect(snapshot.auth.status).toBe("unauthenticated");
      expect(snapshot.message).toContain("T3_TEST_BOB_API_KEY");
    }),
  );

  it.effect("reports ready when the version probe succeeds", () =>
    Effect.gen(function* () {
      const snapshot = yield* Effect.scoped(
        Effect.gen(function* () {
          const fs = yield* FileSystem.FileSystem;
          const path = yield* Path.Path;
          const dir = yield* fs.makeTempDirectoryScoped({ prefix: "t3code-bob-ready-" });
          const bobPath = path.join(dir, "bob");
          yield* fs.writeFileString(
            bobPath,
            ["#!/bin/sh", 'printf "bob-shell 1.2.3\\n"', "exit 0", ""].join("\n"),
          );
          yield* fs.chmod(bobPath, 0o755);

          return yield* checkBobProviderStatus(
            decodeBobSettings({ enabled: true, binaryPath: bobPath }),
            {},
          );
        }),
      );

      expect(snapshot.enabled).toBe(true);
      expect(snapshot.installed).toBe(true);
      expect(snapshot.status).toBe("ready");
      expect(snapshot.version).toBe("1.2.3");
      expect(snapshot.models.map((model) => model.slug)).toEqual(["premium"]);
    }),
  );
});
