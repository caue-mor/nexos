/**
 * SUPERFÍCIE REAL DO HOST — quatro planos, não um.
 *
 *   DISK != LISTED != INVOCABLE
 *
 * O audit media DISCO e chamava de capability. MEDIDO: das 23 skills de
 * projeto, 14 que o modelo não consegue invocar — e o audit reportava todas
 * como disponíveis. O mecanismo não era sombreamento (cada invisível tem 7
 * cópias, incluindo uma em `~/.claude/skills`, o mesmo escopo de 233 skills
 * apresentadas; sombreamento deixaria a vencedora visível). Era configuração,
 * e o host disse qual ao recusar a invocação:
 *
 *     Skill theme-factory is disabled for model invocation
 *     in skillOverrides settings
 *
 * ─── por que este módulo NÃO lê skillOverrides ────────────────────────────
 *
 *   REUSE > CREATE — e a primeira versão daqui violou isso.
 *
 * `scan.ts` JÁ resolve `skillOverrides` por peça e grava em
 * `CapabilityItem.override`, com o cuidado que a doc exige: overrides valem
 * para skill pessoal/projeto e NÃO para plugin (plugin se controla por
 * `/plugin`), então quem varre um plugin recebe `{}`. A primeira versão deste
 * módulo reimplementou essa resolução contra o mapa cru e errou exatamente
 * onde o original acerta:
 *
 *   MEDIDO — `plugin:nanobanana@opc-skills` e `plugin:requesthunt@opc-skills`,
 *   ambos `enabled: true` e `health: "connected"`, foram reportados
 *   `invocable: "NO"` porque o nome do diretório colidia por acaso com uma
 *   skill pessoal homônima desligada. 63 peças "off" onde o scan resolve 52.
 *   O vício original ao contrário: capability LIGADA declarada indisponível.
 *
 * Por isso aqui se CONSOME `item.override` já resolvido. Uma fonte só para a
 * mesma pergunta.
 *
 * ─── o que `off` NÃO é ────────────────────────────────────────────────────
 *
 *   OFF != BROKEN
 *
 * Uma skill desligada está inteira; alguém decidiu não expô-la ao modelo.
 * Classificar isso como achado fabricaria dezenas de defeitos que ninguém tem.
 * Superfície é EIXO SEPARADO dos findings, nunca um `AuditFindingKind`.
 *
 * ─── por que UNKNOWN é o default ──────────────────────────────────────────
 *
 *   NO OVERRIDE != PROVEN WORKING
 *
 * Ausência de override prova ausência de override. Só há dois fatos: o que o
 * host recusou na nossa frente (UMA skill, manualmente) e o que o settings
 * declara. O resto sai rotulado UNKNOWN.
 */
import type { OverrideValue } from "./types.js";

/** Três estados, porque dois mentem: ausência de prova não é prova de ausência. */
export type Tristate = "YES" | "NO" | "UNKNOWN";

/**
 * De onde veio a afirmação — separa FATO MEDIDO de dedução.
 *
 *   MEASURED            — observamos o host se comportar assim
 *   DOCUMENTED          — a doc oficial do host declara o comportamento
 *   DERIVED_FROM_CONFIG — `skillOverrides` declara, semântica aplicada
 *   NOT_APPLICABLE      — overrides não governam esta peça (plugin, mcp, lsp…)
 *   UNKNOWN             — não há base; ninguém mediu
 */
export type Basis = "MEASURED" | "DOCUMENTED" | "DERIVED_FROM_CONFIG" | "NOT_APPLICABLE" | "UNKNOWN";

export interface SurfaceState {
  readonly discovered: true;
  /**
   * Aparece na listagem que o host carrega no contexto?
   *
   *   RECUSAR A INVOCAÇÃO NÃO MEDE A LISTAGEM
   *
   * Este campo saía `UNKNOWN` para os quatro valores, com a nota "o que `off`
   * corta é a INVOCAÇÃO, pode continuar aparecendo na listagem". A doc oficial
   * (code.claude.com/docs/en/skills.md, "Override skill visibility from
   * settings") responde a pergunta em tabela e diz o contrário:
   *
   *     valor                  Listed to Claude        no menu /
   *     "on"                   nome e descrição        sim
   *     "name-only"            só o nome               sim
   *     "user-invocable-only"  oculta                  sim
   *     "off"                  oculta                  oculta
   *
   * A inferência antiga veio de UM salto: o host recusou `theme-factory`
   * citando `skillOverrides`, e disso se concluiu algo sobre listagem. A
   * recusa prova recusa. A nota citava `docx`/`pdf`/`pptx`/`xlsx` "off na
   * tabela do /context", mas essas são BUNDLED (governadas por
   * `disableBundledSkills`) e a linha Skills do `/context` reporta o TAMANHO
   * da listagem, nunca peça por peça — a observação não distinguia os dois.
   *
   * Isto muda a recomendação prática: desligar é via REVERSÍVEL de cortar
   * contexto, e apagar arquivo deixa de ser necessário para skill pessoal ou
   * de projeto.
   */
  readonly listed: Tristate;
  readonly listedBasis: Basis;
  /** O MODELO consegue invocar? É a pergunta que `off` responde com NÃO. */
  readonly invocable: Tristate;
  readonly invocableBasis: Basis;
  /** Valor canônico do host (`types.ts`), não um vocabulário paralelo. */
  readonly override: OverrideValue | undefined;
  readonly detail: string;
}

/**
 * Quem `skillOverrides` governa.
 *
 *   COMMAND FILE É SKILL EM FORMATO ANTIGO
 *
 * `command` estava fora, e isso vinha de ler o nome do diretório em vez da doc.
 * `skills.md` é explícito: "Custom commands have been merged into skills. A
 * file at `.claude/commands/deploy.md` and a skill at
 * `.claude/skills/deploy/SKILL.md` both create `/deploy` and work the same
 * way", e "a Markdown file in `.claude/commands/` is the older format and
 * still works. It supports the same frontmatter except `name` and `paths`".
 * O override casa por NOME, e o nome de um command file é o caminho relativo
 * a `commands/` com `/` virando `:`.
 *
 * MEDIDO em 2026-09-19: um bloco de 470 entradas `off` no settings.json
 * pessoal casava só 195 peças no audit, porque os 167 arquivos de
 * `commands/` caíam em "fora do alcance de overrides". O usuário lia que 310
 * peças não podiam ser desligadas por config — e podiam.
 *
 * `plugin` FICA FORA, e essa parte a doc também diz: "Plugin skills are not
 * affected by `skillOverrides`. Manage those through `/plugin` instead."
 * `mcp`, `lsp` e `agent` têm superfícies próprias.
 */
export function overridesGovernam(kind: string): boolean {
  return kind === "skill" || kind === "command";
}

const NAO_APLICA = (kind: string): SurfaceState => ({
  discovered: true,
  listed: "UNKNOWN",
  listedBasis: "NOT_APPLICABLE",
  invocable: "UNKNOWN",
  invocableBasis: "NOT_APPLICABLE",
  override: undefined,
  detail: `skillOverrides não governa "${kind}" — plugin se controla por /plugin, e mcp/lsp/command têm superfícies próprias`,
});

const SEM_OVERRIDE: SurfaceState = {
  discovered: true,
  listed: "UNKNOWN",
  listedBasis: "UNKNOWN",
  invocable: "UNKNOWN",
  invocableBasis: "UNKNOWN",
  override: undefined,
  detail:
    "sem entrada em skillOverrides — invocabilidade NÃO verificada: " +
    "ausência de override não é prova de que funciona",
};

/**
 * Projeta UMA peça nos quatro planos, a partir do override JÁ RESOLVIDO por
 * `scan.ts`. Os quatro valores do vocabulário do host são tratados; nenhum
 * cai em "assume que funciona".
 */
export function resolveSurface(kind: string, override: OverrideValue | undefined): SurfaceState {
  if (!overridesGovernam(kind)) return NAO_APLICA(kind);
  if (override === undefined) return SEM_OVERRIDE;

  switch (override) {
    case "off":
      return {
        discovered: true,
        listed: "NO",
        listedBasis: "DOCUMENTED",
        invocable: "NO",
        invocableBasis: "DERIVED_FROM_CONFIG",
        override,
        detail:
          'skillOverrides="off" — oculta na listagem E no menu /, então NÃO custa contexto ' +
          "(doc do host, tabela de visibilidade). É a via REVERSÍVEL de cortar a listagem: " +
          "apagar arquivo não é necessário. OFF != BROKEN — a peça está íntegra.",
      };

    /**
     * O usuário digita `/skill`, o modelo não alcança — precisamente a
     * distinção que `invocable` existe para fazer. A primeira versão deste
     * módulo nem modelava este valor: tratava como "fora do vocabulário".
     */
    case "user-invocable-only":
      return {
        discovered: true,
        listed: "NO",
        listedBasis: "DOCUMENTED",
        invocable: "NO",
        invocableBasis: "DERIVED_FROM_CONFIG",
        override,
        detail:
          'skillOverrides="user-invocable-only" — o USUÁRIO invoca, o MODELO não. ' +
          "Oculta na listagem do modelo e visível no menu /: some do contexto sem sumir " +
          "de quem digita. NÃO é defeito.",
      };

    case "name-only":
      return {
        discovered: true,
        listed: "YES",
        listedBasis: "DOCUMENTED",
        invocable: "UNKNOWN",
        invocableBasis: "UNKNOWN",
        override,
        detail:
          'skillOverrides="name-only" — listada SEM descrição: discovery degradada, porque é a ' +
          "descrição que faz a peça casar com o pedido. Invocabilidade não verificada. NAME-ONLY != BROKEN.",
      };

    /** Ligada por decisão explícita — que ainda não é prova de que funciona. */
    case "on":
      return {
        discovered: true,
        listed: "YES",
        listedBasis: "DOCUMENTED",
        invocable: "UNKNOWN",
        invocableBasis: "UNKNOWN",
        override,
        detail: 'skillOverrides="on" — habilitada explicitamente; funcionamento não verificado',
      };
  }
}

export interface SurfaceNote {
  readonly id: string;
  readonly name: string;
  readonly override: OverrideValue;
  readonly basis: Basis;
  readonly detail: string;
}

export interface SurfaceTotals {
  readonly discovered: number;
  /** Peças que `skillOverrides` sequer governa (plugin, command, mcp, lsp, agent). */
  readonly naoGovernadas: number;
  readonly porOverride: Readonly<Record<OverrideValue, number>>;
  /** `invocable: "NO"` — `off` e `user-invocable-only`. */
  readonly notInvocable: readonly SurfaceNote[];
  readonly reduced: readonly SurfaceNote[];
  readonly invocabilidadeDesconhecida: number;
  /**
   * Quantas peças foram MEDIDAS diretamente contra o host. Hoje zero por este
   * caminho: a única medição direta (theme-factory) foi manual, fora do audit.
   * Imprimir isto impede que "derivado" seja lido como "observado".
   */
  readonly medidasDiretamente: number;
}
