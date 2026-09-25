/**
 * TOOL CLASSIFICATION — does the HOST have this tool, in any plane?
 *
 *   NOT_REQUESTED IS NEVER UNAVAILABLE
 *   UNKNOWN IS NEVER UNAVAILABLE, AND NEVER SILENTLY BECOMES DELIVERED
 *
 * `classify()` (formerly `scripts/host-tool-catalog.mts`) answered ONE
 * question with ONE flat catalog: does this tool name appear somewhere in the
 * catalog? A missing host capability is unfixable here.
 *
 * Per-agent delivery classification (`classifyAgentDelivery`, composing this
 * catalog with an agent's `tools`/`disallowedTools` declaration) was removed
 * with the authorization layer (nexos://decision/p1-0-remover-authorization-layer):
 * agents no longer declare a tools allowlist, so there is nothing left to
 * compose against. What survives is the host-level question, agent-independent.
 */
import { z } from "zod";

/**
 * PROVENANCE — per-claim measurement log backing the four presence arrays.
 *
 *   SELF-REPORT != INSTRUMENTED
 *
 * `instrumented` means the HOST answered (here: a `PostToolUse` hook payload
 * captured the literal `ToolSearch` result, not the model's retelling of it).
 * `self_report` means the MODEL was asked to enumerate its own tools — usable
 * (native/eagerly-loaded tools have no host-answered enumeration primitive),
 * but weaker, and never allowed to produce the same confidence as the other
 * kind. A record's `kind` is the only thing that lets a consumer tell them
 * apart instead of trusting both equally.
 */
export type ProbeKind = "instrumented" | "self_report";

/** The four representative agent surfaces probed alongside an unrestricted baseline. */
export type ProbeSurface = "BASELINE" | "MAIN" | "BUILDER" | "READ_ONLY";

export interface HostCapabilityProbe {
  readonly surface: ProbeSurface;
  /** `null` for BASELINE — no `--agents` restriction was applied. */
  readonly agent: string | null;
  readonly kind: ProbeKind;
  readonly host: string;
  readonly at: string;
  /** `claude -p --output-format json`'s `session_id`, when the call completed. */
  readonly session_id: string | null;
  /** The literal query/probe performed (e.g. `select:Grep,Glob,...`), or a description for self-report. */
  readonly query: string;
  readonly found: readonly string[];
  readonly absent: readonly string[];
  /** Candidates this probe could not resolve either way — stays HOST_UNKNOWN, never guessed. */
  readonly unresolved: readonly string[];
  readonly note: string;
}

export interface HostToolCatalogProvenance {
  readonly probe_count: number;
  /** Anchor from a measured run, not a live billing figure — see scripts/host-tool-catalog.mts. */
  readonly estimated_cost_usd_per_probe: number;
  readonly probes: readonly HostCapabilityProbe[];
}

export interface HostToolCatalog {
  readonly host: string;
  readonly generated_at: string;
  readonly derivation: string;
  readonly native: readonly string[];
  readonly deferred: readonly string[];
  readonly mcp_prefixes: readonly string[];
  readonly virtual: readonly string[];
  /**
   * Tools explicitly probed and confirmed absent from every plane — NOT the
   * complement of the other four arrays. This is what makes `HOST_UNKNOWN`
   * possible instead of fake: a name that is simply missing from this JSON
   * was never measured either way, and only a name that IS in `unavailable`
   * was actively checked (native listing + `ToolSearch` query) and came back
   * negative. Collapsing "never checked" into "checked and absent" is exactly
   * the defect this split exists to remove — see `classifyHostCapability`.
   */
  readonly unavailable: readonly string[];
  /** Optional: absent on catalogs written before this field existed. */
  readonly provenance?: HostToolCatalogProvenance;
}

/**
 * Runtime shape-check for a CANDIDATE catalog before it is allowed to
 * replace the tracked file (`scripts/host-tool-catalog.mts --generate`).
 * Structurally mirrors `HostToolCatalog` above — kept a schema apart from
 * the interface (not `z.infer`) so the extensively-commented interface stays
 * the readable contract and this stays a pure validation concern.
 */
const HostCapabilityProbeSchema = z.object({
  surface: z.enum(["BASELINE", "MAIN", "BUILDER", "READ_ONLY"]),
  agent: z.string().min(1).nullable(),
  kind: z.enum(["instrumented", "self_report"]),
  host: z.string().min(1),
  at: z.string().datetime(),
  session_id: z.string().min(1).nullable(),
  query: z.string().min(1),
  found: z.array(z.string()),
  absent: z.array(z.string()),
  unresolved: z.array(z.string()),
  note: z.string(),
});

export const HostToolCatalogSchema = z.object({
  host: z.string().min(1),
  generated_at: z.string().datetime(),
  derivation: z.string().min(1),
  native: z.array(z.string()),
  deferred: z.array(z.string()),
  mcp_prefixes: z.array(z.string()),
  virtual: z.array(z.string()),
  unavailable: z.array(z.string()),
  provenance: z
    .object({
      probe_count: z.number().int().nonnegative(),
      estimated_cost_usd_per_probe: z.number().nonnegative(),
      probes: z.array(HostCapabilityProbeSchema),
    })
    .optional(),
});

export type HostCapabilityState =
  | "HOST_NATIVE_TOOL"
  | "HOST_DEFERRED_TOOL"
  | "HOST_MCP_TOOL"
  | "HOST_VIRTUAL_CAPABILITY"
  | "HOST_UNAVAILABLE"
  | "HOST_UNKNOWN";

/** Does the HOST have this tool, in any plane? Agent-independent. */
export function classifyHostCapability(tool: string, cat: HostToolCatalog): HostCapabilityState {
  if (cat.mcp_prefixes.some((p) => tool.startsWith(p))) return "HOST_MCP_TOOL";
  if (cat.native.includes(tool)) return "HOST_NATIVE_TOOL";
  if (cat.deferred.includes(tool)) return "HOST_DEFERRED_TOOL";
  if (cat.virtual.includes(tool)) return "HOST_VIRTUAL_CAPABILITY";
  if (cat.unavailable.includes(tool)) return "HOST_UNAVAILABLE";
  return "HOST_UNKNOWN";
}

