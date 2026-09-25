/**
 * AGENT CONTRACT — o que um agente NexOS declara, validado contra o que o host
 * realmente lê.
 *
 *   AGENT FILE EXISTS != REGISTERED != RESOLVABLE != DISPATCHED != MEASURED
 *   AGENT OWNS ROLE · SKILL OWNS PROCEDURE · PROVIDER OWNS IMPLEMENTATION
 *   PROMPT CLAIM != HOST CAPABILITY
 *
 * O schema espelha 1:1 o frontmatter documentado de subagente do Claude Code
 * 2.1.233 (`docs/en/sub-agents.md`), porque inventar um schema paralelo criaria
 * uma segunda autoridade sobre a mesma coisa: o host lê o frontmatter, não o
 * nosso registry.
 *
 * A camada de AUTORIDADE (authority/permissionMode/disallowedTools/human_gates
 * e os invariantes de enforcement que os validavam) saiu por inteiro
 * (nexos://decision/p1-0-remover-authorization-layer): Claude Code decide
 * tools, sandbox e permissões; o NexOS não recria isso. O que sobra aqui é só
 * INFORMAÇÃO — persona, papel, quando usar, handoff, quem revisa — sem
 * enforcement nenhum embutido.
 */
import { z } from "zod";

/** Ferramentas do host. Lista aberta de propósito. */
export const TOOL = z.string().min(1);

/**
 * `name` não pode conter `:` — reservado a identificador de plugin. O host não
 * carrega o arquivo e registra erro no debug log (doc: sub-agents.md; aceito
 * antes da v2.1.218). Um agente que não carrega é indistinguível de um agente
 * que não existe.
 */
export const AGENT_NAME = z
  .string()
  .regex(/^[a-z][a-z0-9-]*$/, "name: minúsculas e hífens, sem ':' (reservado a plugin)");

/** Valores aceitos pelo host. `inherit` é o default documentado. */
export const MODEL = z.enum(["sonnet", "opus", "haiku", "fable", "inherit"]);
export const EFFORT = z.enum(["low", "medium", "high", "xhigh", "max"]);

export const AgentDefinitionSchema = z.object({
  // ── identidade ────────────────────────────────────────────────────────────
  name: AGENT_NAME,
  /**
   * `persona`/`role` e o resto do bloco abaixo vivem tipicamente em
   * `assets/policies/agent-registry.yaml` (não no frontmatter que o host lê)
   * — um agente sem entrada lá ainda REGISTRA (registro não é mais
   * obrigatório: nexos://decision/p1-0-remover-authorization-layer), só com
   * menos informação de papel. Default cai para `name` quando ausente.
   */
  persona: z.string().min(1).optional(),
  role: z.string().min(1).optional(),
  /**
   * A `description` É o roteador: é dela que o host decide o disparo. Teto de
   * tamanho mínimo é qualidade de roteamento, não autorização — o audit mediu
   * 31 pares de description colidindo por serem curtas/genéricas demais.
   */
  description: z.string().min(40),
  when_to_use: z.array(z.string().min(1)).default([]),
  when_not_to_use: z.array(z.string().min(1)).default([]),

  // ── contrato de execução ──────────────────────────────────────────────────
  inputs: z.array(z.string().min(1)).default([]),
  outputs: z.array(z.string().min(1)).default([]),

  // ── mapeamento direto ao host ─────────────────────────────────────────────
  model: MODEL.default("inherit"),
  effort: EFFORT.optional(),
  /**
   * Sem allowlist: um agente moderno herda as tools da sessão pai — este
   * campo só sobrevive para agentes legados que ainda declaram `tools:` no
   * frontmatter e para os probes manuais de `scripts/host-tool-catalog.mts`.
   * Nenhum caminho de runtime nega ferramenta a partir dele.
   */
  tools: z.array(TOOL).default([]),
  maxTurns: z.number().int().positive().optional(),
  /**
   * `skills` injeta o CONTEÚDO INTEIRO no startup do subagente (doc:
   * sub-agents.md). Teto de 3 é política, não gosto: preload de tudo é
   * desperdício de contexto em toda invocação.
   */
  skills: z.array(z.string().min(1)).max(3).default([]),
  memory: z.enum(["user", "project", "local"]).optional(),
  isolation: z.literal("worktree").optional(),

  // ── informação NexOS (sem enforcement) ────────────────────────────────────
  /** Texto livre, lido por humanos — nunca validado contra tools/authority. */
  forbidden: z.array(z.string().min(1)).default([]),
  /** Papéis para os quais este agente pode PEDIR handoff (Nova resolve). */
  handoff_targets: z.array(z.string().min(1)).default([]),
  /** Quem revisa o trabalho deste agente. Informativo — separação de contexto, não de permissão. */
  verifier: z.string().min(1).optional(),
  version: z.number().int().positive().default(1),
});

export type AgentDefinition = z.infer<typeof AgentDefinitionSchema>;

export type ValidationResult<T> =
  | { ok: true; value: T }
  | { ok: false; errors: string[] };

function formatIssues(e: z.ZodError): string[] {
  return e.issues.map((i) => `${i.path.join(".") || "(raiz)"}: ${i.message}`);
}

export function validateAgent(input: unknown): ValidationResult<AgentDefinition> {
  const parsed = AgentDefinitionSchema.safeParse(input);
  if (!parsed.success) return { ok: false, errors: formatIssues(parsed.error) };
  return { ok: true, value: parsed.data };
}
