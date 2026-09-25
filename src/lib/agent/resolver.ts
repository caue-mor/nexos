/**
 * AGENT RESOLVER — papel → agente, pelo registry.
 *
 *   ROSTER HARDCODED = ROSTER STALE
 *
 * Traduz um PAPEL (`role`, vocabulário NexOS, ex. "dev", "verifier") para o
 * agente registrado que o atende. Não decide SE o agente pode executar uma
 * operação — isso saiu com a camada de autorização
 * (nexos://decision/p1-0-remover-authorization-layer): quem executa é
 * decidido pelo Claude Code (tools/sandbox/permissões nativas), nunca por
 * este módulo.
 */
import type { AgentDefinition } from "./contract.js";
import type { RegistryEntry } from "./registry.js";

export interface ResolveRequest {
  /** Papel necessário, no vocabulário do NexOS (ex.: "security", "database"). */
  readonly role: string;
}

export type ResolveResult =
  | { readonly ok: true; readonly agent: AgentDefinition; readonly why: string }
  | { readonly ok: false; readonly why: string; readonly candidates: readonly string[] };

/** O papel que um agente atende, derivado do nome canônico `nexos-<role>`. */
export function roleOf(a: AgentDefinition): string {
  return a.name.replace(/^nexos-/, "");
}

export function resolveAgent(
  registry: readonly RegistryEntry[],
  req: ResolveRequest
): ResolveResult {
  const porPapel = registry.filter((e) => roleOf(e.definition) === req.role);

  if (porPapel.length === 0) {
    return {
      ok: false,
      why: `nenhum agente registrado para o papel "${req.role}"`,
      candidates: registry.map((e) => roleOf(e.definition)).sort(),
    };
  }

  if (porPapel.length > 1) {
    return {
      ok: false,
      why: `papel "${req.role}" tem ${porPapel.length} agentes — ambiguidade de roteamento`,
      candidates: porPapel.map((e) => e.definition.name),
    };
  }

  const agent = porPapel[0]!.definition;

  return {
    ok: true,
    agent,
    why: `${agent.name} atende "${req.role}"`,
  };
}
