/**
 * `nexos capabilities` — vocabulário compartilhado.
 *
 *   OBSERVED SURFACE != REGISTRY
 *
 * Este módulo declara só TIPOS. O leitor (`scan.ts`) e a análise
 * (`analyze.ts`) produzem `CapabilityItem`s — fatos OBSERVADOS nas
 * superfícies nativas do host (skills, agents, commands, plugins, MCP, LSP),
 * nunca um registry/resolver/política proprietária
 * (nexos://decision/nexos-project-intelligence-os).
 */

export type CapabilityKind = "skill" | "agent" | "command" | "plugin" | "mcp" | "lsp";

/** Onde o item mora: pessoal (`~/.claude`), do projeto (`<root>/.claude`) ou trazido por um plugin. */
export type CapabilitySource = "personal" | "project" | "plugin";

/** Vocabulário nativo de `skillOverrides` (settings.md #skill-overrides). */
export type OverrideValue = "on" | "off" | "name-only" | "user-invocable-only";

export type CapabilityHealth = "connected" | "missing-binary" | "not-installed" | "unknown";

/**
 * Forma ÚNICA para as seis superfícies (A1.2) — um consumidor não deveria
 * precisar de seis shapes diferentes para imprimir uma tabela.
 *
 * Presença por campo, exata (correção pós-review — a versão anterior deste
 * comentário dizia "sempre presentes" para campos que o próprio tipo já
 * declara opcionais, o que era falso e nunca foi verificado contra o tipo):
 *
 *   - SEMPRE presentes, em todo `kind`: `kind`, `id`, `name`, `source`,
 *     `invocation`, `listing_chars`, `enabled`.
 *   - PRESENTES QUANDO DECLARADOS na fonte, `undefined` quando a fonte não
 *     declara (nunca omitidos do TIPO — só do valor): `plugin_id` (só
 *     `source === "plugin"`), `file`, `description`, `paths` (só skill,
 *     frontmatter `paths`), `compatibility` (só skill, frontmatter
 *     `compatibility`), `override` (só skill pessoal/projeto com entrada em
 *     `skillOverrides`), `content_hash` (só item com `file`), `health` (só
 *     plugin/lsp), `metadata` (só quando o frontmatter declara `metadata`).
 */
export interface CapabilityItem {
  readonly kind: CapabilityKind;
  /** Estável dentro de UMA varredura: `${kind}:${source}:${plugin_id ?? ""}:${name}`. */
  readonly id: string;
  readonly name: string;
  readonly source: CapabilitySource;
  /** `"<nome>@<marketplace>"` — só quando `source === "plugin"`. */
  readonly plugin_id?: string;
  /** Rótulo humano de como isto é invocado (Skill tool, Task tool, `/comando`, servidor MCP, language server). */
  readonly invocation: string;
  readonly file?: string;
  readonly description?: string;
  /** Frontmatter `paths` (glob de ativação) — só skills. */
  readonly paths?: readonly string[];
  /** Frontmatter `compatibility` (≤500 chars, spec Agent Skills) — só skills. */
  readonly compatibility?: string;
  /** Resolvido de `skillOverrides` (user + project, project vence) — só skills pessoais/projeto. */
  readonly override?: OverrideValue;
  /** Custo de contexto: `name.length + description.length` (aproximação do que a listagem nativa carrega). */
  readonly listing_chars: number;
  /**
   * Frontmatter malformado, quando estava — `UNTERMINATED` (abertura sem
   * fechamento) ou `INVALID_YAML` (o parser lançou). Ausente = íntegro.
   *
   *   PARSE FAILURE != ABSENT FIELD
   *
   * Existe porque `description: ""` respondia por QUATRO problemas com ações
   * opostas: sem frontmatter, frontmatter truncado, YAML inválido, e campo
   * genuinamente ausente. Medido neste host: dos 199 itens reportados "sem
   * description", 1 era o caso que o rótulo descrevia.
   */
  readonly frontmatter_issue?: "UNTERMINATED" | "INVALID_YAML";
  /** sha256 do arquivo bruto — só itens com `file` (skill/agent/command); base da detecção de duplicata exata. */
  readonly content_hash?: string;
  /** `false` quando plugin desabilitado (`enabledPlugins`) ou override `off`. */
  readonly enabled: boolean;
  /** Só quando aplicável (plugin/lsp) — binário/servidor observável. */
  readonly health?: CapabilityHealth;
  /** Mapa livre do frontmatter (`metadata.stacks`, `metadata.port_ref`, …) — nunca um schema proprietário. */
  readonly metadata?: Readonly<Record<string, unknown>>;
}

/** Um grupo de itens com o MESMO hash de conteúdo — duplicata exata, nunca aproximada (onda 2). */
export interface DuplicateGroup {
  readonly content_hash: string;
  readonly items: readonly { readonly id: string; readonly file: string; readonly source: CapabilitySource }[];
}

/**
 * Review pós-A1.3 — o exemplo original do contrato (`docs/pos-mvp-matriz-
 * capabilities.md` A1.3: `superpowers:systematic-debugging` ×
 * `development--systematic-debugging` → DUPLICATE) estava errado: medido
 * que os dois NÃO são byte-idênticos (o pessoal é superset editado do
 * donor, 209 linhas em comum, não as mesmas). Em 2026-09-22 a cópia do
 * pacote saiu e o par deixou de existir no host — o exemplo é histórico. `DuplicateGroup` continua
 * hash EXATO, sem mudança — o que faltava era um sinal BARATO para
 * justamente esse caso real: mesmo nome final (`último segmento` — o nome
 * sem o prefixo de namespace `plugin:`), hash DIFERENTE, em fontes
 * distintas. Isso é "provável cópia divergente", não duplicata — daí um
 * tipo separado, nunca misturado com `DuplicateGroup`.
 */
export interface VariantGroup {
  readonly name: string;
  readonly items: readonly {
    readonly id: string;
    readonly file: string;
    readonly source: CapabilitySource;
    readonly content_hash: string;
  }[];
}

export interface CapabilityIssue {
  readonly code: string;
  readonly detail: string;
}

export interface CapabilityCatalog {
  readonly items: readonly CapabilityItem[];
  readonly duplicates: readonly DuplicateGroup[];
  readonly variants: readonly VariantGroup[];
  readonly listing_chars_total: number;
  readonly issues: readonly CapabilityIssue[];
}

export interface CapabilitySuggestion {
  readonly item: CapabilityItem;
  readonly score: number;
  readonly why: string;
  /**
   * Quantos tokens da intent casaram em TERMO DE DOMÍNIO — vocabulário
   * derivado dos nomes do catálogo, não de lista escrita à mão.
   *
   * Separado de `score` de propósito: "me ajuda com uma coisa" produzia score
   * positivo casando em "uma", e um corte sobre `score` não distingue isso de
   * um match real. `evidencia: 0` com `score > 0` é exatamente o caso de
   * falsa confiança que o gate B existe para pegar.
   *
   * Opcional para não quebrar chamador que não passa `dominio`.
   */
  readonly evidencia?: number;
}

/** Capacidade que o mapa da tarefa pede mas a máquina não tem ativa — nunca inventada, sempre com o remédio. */
export interface CapabilityGap {
  readonly id: string;
  readonly name: string;
  readonly reason: string;
  readonly remedy: string;
}

export interface CapabilitySuggestResult {
  readonly suggestions: readonly CapabilitySuggestion[];
  readonly gaps: readonly CapabilityGap[];
}
