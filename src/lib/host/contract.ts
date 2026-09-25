/**
 * Host Adapter contract — hosts translate and expose facts; they do not govern.
 *
 * The Kernel owns project identity, state, capability selection and authority.
 * A host adapter owns only host identity, lifecycle translation and measurement
 * of the runtime in front of it.
 */

export type CapabilityState = "SUPPORTED" | "UNSUPPORTED" | "UNKNOWN";

export interface CapabilityReport {
  readonly capability: string;
  readonly state: CapabilityState;
  readonly evidence: string;
}

export interface HostLifecycleBinding {
  /** Stable NexOS-side identifier for the binding. */
  readonly id: string;
  /** Event name as exposed by the host. Never enters the Kernel vocabulary. */
  readonly hostEvent: string;
  readonly direction: "host-to-nexos" | "nexos-to-host" | "bidirectional";
}

export interface HostAdapter<ProbeOptions = undefined> {
  readonly hostIdentity: string;
  readonly capabilities: readonly string[];
  readonly lifecycleBindings: readonly HostLifecycleBinding[];
  probe(options?: ProbeOptions): Promise<readonly CapabilityReport[]>;
}

/** Exact coverage: missing and invented capabilities both fail the contract. */
export function hasExactCapabilityCoverage(
  expected: readonly string[],
  reports: readonly CapabilityReport[]
): boolean {
  const observed = new Set(reports.map((report) => report.capability));
  return (
    reports.length === expected.length &&
    expected.every((capability) => observed.has(capability)) &&
    observed.size === expected.length
  );
}
