import { describe, expect, it } from "vitest";
import type { CapabilityReport, HostAdapter } from "../src/lib/host/contract.js";
import { hasExactCapabilityCoverage } from "../src/lib/host/contract.js";
import {
  CLAUDE_HOST_ADAPTER,
  V1_CAPABILITIES,
} from "../src/lib/host/claude-adapter.js";

describe("HostAdapter contract", () => {
  it("accepts exact capability coverage only", () => {
    const exact: CapabilityReport[] = [
      { capability: "a", state: "SUPPORTED", evidence: "runtime probe" },
      { capability: "b", state: "UNKNOWN", evidence: "not observable" },
    ];

    expect(hasExactCapabilityCoverage(["a", "b"], exact)).toBe(true);
    expect(hasExactCapabilityCoverage(["a", "b"], exact.slice(0, 1))).toBe(false);
    expect(
      hasExactCapabilityCoverage(["a", "b"], [
        ...exact,
        { capability: "invented", state: "SUPPORTED", evidence: "none" },
      ])
    ).toBe(false);
    expect(
      hasExactCapabilityCoverage(["a", "b"], [exact[0]!, exact[0]!, exact[1]!])
    ).toBe(false);
  });

  it("keeps the existing Claude implementation behind the shared contract", () => {
    const adapter: HostAdapter<Parameters<typeof CLAUDE_HOST_ADAPTER.probe>[0]> =
      CLAUDE_HOST_ADAPTER;

    expect(adapter.hostIdentity).toBe("claude-code");
    expect(adapter.capabilities).toEqual(V1_CAPABILITIES);
    expect(adapter.lifecycleBindings.map((binding) => binding.hostEvent)).toEqual([
      "SessionStart",
    ]);
  });
});
