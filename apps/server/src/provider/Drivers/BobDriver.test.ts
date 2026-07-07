import { describe, expect, it } from "vite-plus/test";

import { BUILT_IN_DRIVERS } from "../builtInDrivers.ts";
import { BobDriver } from "./BobDriver.ts";

describe("BobDriver", () => {
  it("is registered as a built-in provider driver", () => {
    expect(BUILT_IN_DRIVERS.map((driver) => driver.driverKind)).toContain("bob");
  });

  it("exposes BOB metadata and default config", () => {
    const config = BobDriver.defaultConfig();

    expect(BobDriver.driverKind).toBe("bob");
    expect(BobDriver.metadata.displayName).toBe("BOB");
    expect(BobDriver.metadata.supportsMultipleInstances).toBe(true);
    expect(config.enabled).toBe(true);
    expect(config.binaryPath).toBe("bob");
    expect(config.authMethod).toBe("default");
  });
});
