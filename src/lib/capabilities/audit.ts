/**
 * AUDITORIA DAS SUPERFÍCIES NATIVAS — o que está quebrado, o que se sombreia,
 * e quanto cada peça custa de contexto.
 *
 *   INSTALLED != USABLE
 *   CITED PATH != SHIPPED FILE
 *   DUPLICATE IS NOT FREE — a cópia perdida ainda paga listagem
 *
 * Medido em 2026-09-17 nesta máquina: 639 capabilities visíveis (312 skills,
 * 272 comandos), 139.550 caracteres de descrição — ~35 mil tokens entrando na
 * janela toda sessão, dos quais o NexOS governa 18 skills e 5 agentes. Sem
 * auditoria, "instalado" e "utilizável" viram a mesma palavra: no mesmo dia,
 * uma skill DO PACOTE mandava rodar 13 scripts Python inexistentes e três
 * agentes mandavam ler 19 task files que nunca foram publicados.
 *
 * READ-ONLY por construção: recebe o catálogo e um probe de existência, nunca
 * escreve, nunca desinstala. Classificar é do NexOS; remover é do dono.
 */
import path from "node:path";
import os from "node:os";

/**
 * De onde a peça veio — `CONHECIDO PELO NEXOS != CRIADO PELO NEXOS`.
 *
 * Sem isto, "não é nosso" vira "órfã", e as centenas de skills do usuário
 * viram lixo num relatório que ele deveria poder confiar. ORPHANED fica
 * reservado ao que o NexOS gravou e perdeu o dono no pacote; o resto é
 * classificado pela origem, nunca pela ausência de origem.
 */
import { resolveSurface, type SurfaceNote, type SurfaceTotals } from "./surface.js";
import type { OverrideValue } from "./types.js";

export type Provenance =
  /** O NexOS instalou (está no manifesto do `nexos install`). */
  | "NEXOS_OWNED"
  /** Vive no `.claude/` do projeto. */
  | "PROJECT_MANAGED"
  /** Veio de um plugin instalado. */
  | "PLUGIN_MANAGED"
  /** Está no `~/.claude` do usuário e o NexOS não gravou. */
  | "USER_MANAGED"
  /** Existe, foi descoberto, e a origem não se encaixa nas anteriores. */
  | "UNCLASSIFIED";

export type AuditFindingKind =
  /** Cita arquivo/script que não existe onde a própria citação manda procurar. */
  | "broken-reference"
  /** Mesmo conteúdo em mais de um escopo — só um vence a precedência, o resto paga listagem à toa. */
  | "duplicate"
  /** Mesmo NOME com conteúdos diferentes — qual ganha depende da precedência, não da intenção. */
  | "variant"
  /** Perde a precedência para outra peça de mesmo nome: está instalada e não é ela que roda. */
  | "shadowed"
  /**
   * O canônico mudou e a cópia instalada ficou para trás — decidido por HASH
   * DE CONTEÚDO, nunca por data nem por commit. `FRESCOR É DO CONTEÚDO`: o
   * commit do artefato contra o HEAD pune mudança que não altera o que o
   * artefato descreve (gotcha medido no graphify deste repo).
   */
  | "stale"
  /** O NexOS gravou, e o host editou depois: customização local, nunca sobrescrita. */
  | "modified"
  /** O NexOS gravou e o pacote não tem mais — o único caso em que "órfão" é a palavra certa. */
  | "orphaned"
  /**
   * O diretório tem o arquivo com OUTRO case (`SKILL.MD`, `skill.md`) e por
   * isso nem o host nem o catálogo a carregam.
   *
   *   NÃO DESCOBERTA != INEXISTENTE
   *
   * MEDIDO em 2026-09-19: 244 diretórios de skill no disco, 236 descobertos, e
   * a diferença passava como se fossem pastas de apoio. Duas eram skills
   * íntegras de 16 KB e 11 KB, invisíveis para todo mundo — inclusive para o
   * audit, que existe para achar exatamente isto.
   */
  | "invisible";

/**
 * Ação MECÂNICA derivada de (achado × proveniência). Nunca de gosto.
 *
 * `ADOPT` não é emitido por este código de propósito: adotar exige julgar se a
 * peça é BOA, e isso precisa de eval com Δ medido — que não existe ainda. Ação
 * sem régua é opinião com nome de comando.
 */
export type AuditAction = "KEEP" | "REPAIR" | "UPDATE" | "REMOVE" | "REVIEW";

export interface AuditFinding {
  readonly kind: AuditFindingKind;
  /** O que fazer, derivado do achado e da proveniência — determinístico. */
  readonly action: AuditAction;
  /** `id` da capability (mesmo id do catálogo). */
  readonly id: string;
  readonly name: string;
  readonly provenance: Provenance;
  readonly file: string | undefined;
  /**
   * Caracteres que esta peça ocupa na SUPERFÍCIE descoberta (nome + descrição).
   * Não é o que entra na janela: o host lista nome+descrição com teto de 1% da
   * janela do modelo e ENCURTA as descrições para caber (doc oficial,
   * skills.md "Skill descriptions are cut short"). `DECLARED != OBSERVED`.
   */
  readonly listingChars: number;
  /** Detalhe legível: caminho ausente, escopos em conflito, etc. */
  readonly detail: string;
}

export interface AuditInput {
  readonly items: readonly AuditItem[];
  readonly duplicates: readonly AuditGroup[];
  readonly variants: readonly AuditGroup[];
  /** Diretórios de skill que nenhum catálogo carrega por case do arquivo (ver `invisible`). */
  readonly invisibleSkills?: readonly {
    readonly dirName: string;
    readonly encontrado: string;
    readonly file: string;
  }[];
  /**
   * Só para o que o NexOS gravou: os TRÊS hashes que decidem frescor.
   * `manifest` é o que o install declarou ter escrito, `package` é o canônico
   * de hoje (`null` = saiu do pacote), `disk` é o que está lá agora.
   */
  readonly nexosFiles?: ReadonlyMap<string, HashTriple>;
}

export interface HashTriple {
  readonly manifest: string;
  readonly package: string | null;
  readonly disk: string;
}

export interface AuditItem {
  readonly id: string;
  readonly name: string;
  readonly kind: string;
  /** `personal` | `project` | `plugin` | ... — como o catálogo classifica a origem. */
  readonly source: string;
  /** `true` quando o caminho está no manifesto do `nexos install` (o NexOS gravou). */
  readonly nexosOwned?: boolean;
  readonly file?: string;
  readonly listing_chars?: number;
  /** Conteúdo do arquivo da capability; ausente quando não foi possível ler. */
  readonly body?: string;
  /**
   * `skillOverrides` JÁ RESOLVIDO por `scan.ts` — nunca re-resolvido aqui.
   * O scan aplica a regra do host (vale para skill pessoal/projeto, não para
   * plugin) e é por isso que este campo chega vazio em plugin. Re-resolver
   * contra o mapa cru marcou dois plugins ligados como não-invocáveis.
   */
  readonly override?: OverrideValue;
  /**
   * `false` = fora da sessão (plugin fora de `enabledPlugins` ou override
   * `off`), já resolvido por `scan.ts`. Ausente = desconhecido, conta como
   * carregada. Cópia desligada não disputa precedência nem custa listagem.
   */
  readonly enabled?: boolean;
}

export interface AuditGroup {
  readonly items: readonly { readonly id: string; readonly file?: string; readonly source?: string }[];
}

/** Existe no disco? Injetado para manter a decisão pura e testável. */
export type ExistsProbe = (absolutePath: string) => boolean;

/**
 * Referências que o texto manda ABRIR ou EXECUTAR. Duas formas, as duas
 * medidas no mundo real:
 *
 * - invocação de comando (`python ~/.claude/skills/x/scripts/y.py`): quebra na
 *   hora se o arquivo não existir;
 * - caminho relativo em crase (`scripts/y.py`, `./referencia.md`): a skill
 *   manda ler e o leitor não acha.
 *
 * Fora do escopo por construção: linha com `2>/dev/null` (o autor declarou que
 * a ausência é tolerada — é o padrão de descoberta opcional do `create-plans`)
 * e caminho com placeholder (`<dominio>`, `[domain]`, `*`), que é exemplo, não
 * alvo. A lição é de hoje: filtrar a LINHA inteira por causa de um `*` escondia
 * script morto em tabela markdown, então o placeholder é medido no CAMINHO.
 */
const COMANDO_COM_CAMINHO = /(python3?|node|bash|sh|cat|ls)\s+((?:~|\.{1,2})?\/?[\w.@/<>[\]*-]+\.(?:py|sh|mjs|cjs|js|ts|md))/g;
/** `cat`/`ls` LEEM; `python`/`node`/`bash` EXECUTAM. O verbo separa dependência de arquivo alheio. */
const VERBO_DE_LEITURA = /^(?:cat|ls)$/;
const CAMINHO_EM_CRASE = /`((?:\.{1,2}\/|scripts\/|references\/|assets\/)[\w.@/<>[\]*-]+\.(?:py|sh|mjs|cjs|js|ts|md))`/g;

/**
 * O caminho tem placeholder? A classe de caracteres ACEITA `<>[]*` de
 * propósito: sem isso, `scripts/<nome>.py` casaria só `nome.py` e viraria
 * falso positivo — o exemplo do autor acusado como arquivo ausente. Aceitar e
 * então descartar é o que separa exemplo de alvo.
 */
function temPlaceholder(caminho: string): boolean {
  return /[[<*\]>]/.test(caminho);
}

/**
 * O caminho é EXEMPLO na prosa, e não dependência executável da peça?
 *
 *     EXEMPLO DIDÁTICO != REFERÊNCIA EXECUTÁVEL
 *
 * MEDIDO em 2026-09-20 neste host: 6 dos 32 `broken-reference` (19%) eram o
 * autor mostrando ao leitor o que ELE vai criar — `your_automation.py`,
 * `/path/to/storage_state.js`, `app.js`, `main.py` — nunca um arquivo que a
 * skill precisa ter. Acusar isso de quebrado gasta a atenção de quem audita no
 * ruído e, pior, ensina a ignorar a lista inteira.
 *
 * DOIS SINAIS, e nenhum é lista dos casos encontrados:
 *
 * 1. CONVENÇÃO DE PLACEHOLDER no próprio caminho (`/path/to/…`, `your_…`,
 *    `my_…`, `foo`/`bar`). São marcações que a indústria usa para dizer
 *    "troque isto pelo seu", e valem em qualquer repositório.
 *
 * 2. ENTRYPOINT GENÉRICO SOLTO: nome universal de ponto de entrada (`app`,
 *    `main`, `server`, `index`, `script`) SEM diretório nenhum. Este sinal só
 *    existe porque foi medido: das 280 referências que RESOLVEM neste host, 10
 *    são basename solto — e são nomes específicos do domínio (`recalc.py`,
 *    `run.js`), nunca `app.js`. Das 98 que não resolvem, os soltos são
 *    `app.js`, `server.py`, `main.py`, `your_automation.py`. Skill real guarda
 *    o que executa em `scripts/`; prosa cita o entrypoint do leitor.
 *
 * O SEGUNDO SINAL EXIGE AS DUAS CONDIÇÕES. `scripts/main.py` continua broken
 * se não existir — o diretório prova intenção de dependência. E `run.js` solto
 * continua broken, porque `run` não é entrypoint genérico: a regra não pode
 * absolver todo arquivo sem pasta, ou vira o falso negativo que ela deveria
 * impedir.
 */
const PREFIXO_DE_EXEMPLO = /(^|\/)(path\/to\/|your[_-]|my[_-]|foo\b|bar\b)/i;
const ENTRYPOINT_GENERICO = /^(app|main|server|index|script|example|demo)\.\w+$/i;

function ehExemploDidatico(caminho: string): boolean {
  if (PREFIXO_DE_EXEMPLO.test(caminho)) return true;
  return !caminho.includes("/") && ENTRYPOINT_GENERICO.test(caminho);
}

/**
 * Prefixos do LAYOUT de uma capability. Fora deles, um caminho relativo não é
 * dependência da peça — é outro contexto.
 *
 *   BROKEN CAPABILITY != GENERATED ARTIFACT != PROJECT-LOCAL FILE
 *
 * MEDIDO em 2026-09-21: 3 das 7 classes semânticas viravam `broken-reference`
 * indevidamente. `node dist/index.js` (o artefato que o LEITOR vai construir),
 * `cat CHANGELOG.md` (arquivo do projeto onde o comando roda) e
 * `assets/agents/nexos-master.md` (registry canônico do repo NexOS) foram
 * resolvidos contra o diretório da skill e acusados de ausentes. Nenhum dos
 * três é dependência da peça.
 */
const LAYOUT_DE_CAPABILITY = /^(?:scripts|references?|assets|templates)\//;

/**
 * O caminho relativo SOBE acima do diretório da própria peça?
 *
 *   FORA DA ÁRVORE DA PEÇA != DEPENDÊNCIA DA PEÇA
 *
 * `../shared/x.md` ainda pode ser layout de um plugin com referências
 * compartilhadas — um nível acima continua plausível. Três não: um arquivo a
 * três diretórios acima nunca é entregue junto com a skill; é ponteiro para o
 * repositório de onde ela foi copiada.
 *
 * MEDIDO em 2026-09-22: `cua-driver` era a ÚNICA `broken-reference` ativa do
 * host, e a citação é prosa para o leitor — "The full wire contract and 0.14
 * migration notes are in `../../../docs/action-result-contract.md`". O arquivo
 * não existe em lugar nenhum da máquina porque pertence ao repo de origem. A
 * skill funciona sem ele.
 *
 * Mesma distinção que este arquivo já faz para `node dist/index.js` (artefato
 * que o LEITOR constrói) e `cat CHANGELOG.md` (arquivo do projeto onde o
 * comando roda): `BROKEN CAPABILITY != PROJECT-LOCAL FILE`.
 */
const ESCAPA_A_ARVORE = /^(?:\.\.\/){2,}/;

function ehCaminhoDaCapability(caminho: string, verbo: string | undefined): boolean {
  if (caminho.startsWith("~/") || path.isAbsolute(caminho)) return true;
  if (ESCAPA_A_ARVORE.test(caminho)) return false;
  if (caminho.startsWith("./") || caminho.startsWith("../")) return true;
  // Basename solto (`run.js`, `recalc.py`): MEDIDO como dependência real neste
  // host. Só é arquivo alheio quando o verbo apenas LÊ — `cat CHANGELOG.md` é o
  // changelog do projeto onde o comando roda, não da peça.
  if (!caminho.includes("/")) return verbo === undefined || !VERBO_DE_LEITURA.test(verbo);
  return LAYOUT_DE_CAPABILITY.test(caminho);
}

/** Primeiro segmento de um caminho relativo de layout (`assets/agents/x.md` -> `assets`). */
export function raizDoLayout(caminho: string): string | undefined {
  if (!LAYOUT_DE_CAPABILITY.test(caminho)) return undefined;
  return caminho.split("/")[0];
}

function resolver(caminho: string, arquivoDaCapability: string, home: string): string {
  if (caminho.startsWith("~/")) return path.join(home, caminho.slice(2));
  if (path.isAbsolute(caminho)) return caminho;
  return path.resolve(path.dirname(arquivoDaCapability), caminho);
}

export interface ReferenciaCitada {
  readonly citado: string;
  readonly resolvido: string;
  /** `comando` declara EXECUÇÃO (quebra na hora); `citacao` só manda LER. */
  readonly origem: "comando" | "citacao";
}

/**
 * O caminho é PRODUZIDO pelo próprio texto antes de ser consumido?
 *
 *   O DOC CRIA != O DOC DEPENDE
 *
 * MEDIDO em 2026-09-22: `obsidian-cli` estava marcada `broken-reference` por
 * "ler /tmp/obs.js". Duas linhas antes ela escreve o arquivo:
 *
 *     cat > /tmp/obs.js << 'JS'
 *     obsidian eval code="$(cat /tmp/obs.js)"
 *
 * Não é dependência ausente: é arquivo temporário que a própria peça gera.
 * Acusar isso é o mesmo defeito que as duas isenções acima já combatem —
 * gastar a atenção de quem audita no ruído até a lista inteira ser ignorada.
 */
const PRODUCAO_DE_CAMINHO =
  /(?:^|[|;&]\s*|\b)(?:cat|tee|printf|echo)\b[^|;&]*?>{1,2}\s*([^\s"'`;|&]+)|(?:^|\s)(?:touch|mkdir(?:\s+-p)?)\s+([^\s"'`;|&]+)/g;

function caminhosProduzidos(body: string): ReadonlySet<string> {
  const out = new Set<string>();
  PRODUCAO_DE_CAMINHO.lastIndex = 0;
  for (const m of body.matchAll(PRODUCAO_DE_CAMINHO)) {
    const alvo = m[1] ?? m[2];
    if (alvo) out.add(alvo);
  }
  return out;
}

/**
 * A LINHA inteira é ilustrativa, mesmo que o caminho isolado não pareça?
 *
 *   PLACEHOLDER NO IRMÃO != CAMINHO REAL
 *
 * `ehExemploDidatico` só enxerga o caminho capturado, e isso deixa passar dois
 * casos MEDIDOS em 2026-09-22 neste host:
 *
 *   `0 2 * * * cd /path/to/project && node workflow-engine.js run …`
 *       o placeholder está no IRMÃO (`/path/to/project`), não em
 *       `workflow-engine.js` — mas o snippet inteiro é exemplo de crontab.
 *
 *   ``- Example: `./prompts/001-implement-user-authentication.md` ``
 *       o marcador `Example:` declara a intenção na própria linha.
 *
 * O marcador é exigido na FORMA (`Example:` com dois-pontos, `e.g.`, `for
 * example`), nunca a palavra solta: "this skill handles example files" não
 * pode absolver uma dependência real.
 */
/**
 * O marcador precede ESTA ocorrência — não "existe em algum lugar da linha".
 *
 *   EXEMPLO E DEPENDÊNCIA REAL NA MESMA FRASE SAEM SEPARADOS
 *
 * A primeira versão desta camada testava a LINHA inteira e quebrou o guard
 * `audit-exemplo-didatico.test.ts` na hora: em
 * ``Troque `your_file.py` e rode `python scripts/real.py`.`` ela matou também
 * `scripts/real.py`. Lição já paga neste repo — filtrar a linha por causa de
 * um marcador escondia script morto em tabela markdown.
 *
 * A janela é curta (40 caracteres ANTES do match) porque marcador de exemplo
 * gruda no que exemplifica: ``(e.g., `./prompts/005-…`)``,
 * `cd /path/to/project && node workflow-engine.js`. Longe disso, é outra
 * frase, e a dependência volta a valer.
 *
 * `your_`/`my_` NÃO entram aqui: `ehExemploDidatico` já os trata no CAMINHO,
 * que é o nível correto — foi justamente `\bYOUR_[A-Z]` com flag `i` casando
 * `your_file.py` que derrubou o guard.
 */
const MARCADOR_DE_EXEMPLO = /(?:^|[\s([])(?:e\.g\.|i\.e\.|ex\.:|example:|for example|por exemplo)|\/path\/to\/|example\.com/i;
const JANELA_DE_MARCADOR = 40;

function precedidoPorMarcador(linha: string, indice: number): boolean {
  return MARCADOR_DE_EXEMPLO.test(linha.slice(Math.max(0, indice - JANELA_DE_MARCADOR), indice));
}

/** Referências citadas por UM texto, já resolvidas contra o diretório da capability. */
export function referenciasCitadas(
  body: string,
  arquivoDaCapability: string,
  home: string = os.homedir()
): readonly ReferenciaCitada[] {
  const out: ReferenciaCitada[] = [];
  const produzidos = caminhosProduzidos(body);
  for (const linha of body.split("\n")) {
    if (linha.includes("2>/dev/null")) continue;
    for (const [origem, regex] of [
      ["comando", COMANDO_COM_CAMINHO],
      ["citacao", CAMINHO_EM_CRASE],
    ] as const) {
      regex.lastIndex = 0;
      for (const m of linha.matchAll(regex)) {
        const verbo = origem === "comando" ? m[1] : undefined;
        const citado = (origem === "comando" ? m[2] : m[1])!;
        if (temPlaceholder(citado) || ehExemploDidatico(citado)) continue;
        if (produzidos.has(citado)) continue;
        if (m.index !== undefined && precedidoPorMarcador(linha, m.index)) continue;
        if (!ehCaminhoDaCapability(citado, verbo)) continue;
        out.push({ citado, origem, resolvido: resolver(citado, arquivoDaCapability, home) });
      }
    }
  }
  return out;
}

export interface AuditReport {
  readonly findings: readonly AuditFinding[];
  readonly totals: {
    readonly items: number;
    /**
     * Soma da superfície descoberta (nome + descrição de cada peça). O host
     * NÃO injeta isto inteiro: o listing tem teto de 1% da janela e as
     * descrições são encurtadas para caber. Quando estoura, o que se perde são
     * as palavras-chave que fariam a peça casar com o pedido — o dano é
     * discovery degradada, não token gasto. Medir o que de fato entra é com
     * `/context` no host, não aqui.
     */
    readonly surfaceChars: number;
    /** Superfície SÓ das peças com achado — o que se recupera resolvendo. */
    readonly surfaceCharsComAchado: number;
    readonly porTipo: Readonly<Record<AuditFindingKind, number>>;
    readonly porProveniencia: Readonly<Record<Provenance, number>>;
    readonly porAcao: Readonly<Record<AuditAction, number>>;
  };
  /**
   * O plano que faltava. Findings respondem "o que está errado"; `surface`
   * responde "o que o host de fato oferece ao modelo". Uma peça `off` não
   * produz finding nenhum e mesmo assim é inalcançável.
   *
   *   DISK != LISTED != INVOCABLE
   */
  readonly surface: SurfaceTotals;
}

/**
 * (achado × proveniência) → ação. Tabela fechada, sem julgamento:
 *
 *   quebrada + nosso    → REPAIR  (o arquivo é do pacote; consertamos lá)
 *   quebrada + alheio   → REVIEW  (reportar ao dono/autor; não tocamos)
 *   stale               → UPDATE  (`nexos install` traz o canônico de hoje)
 *   modified            → REVIEW  (customização local: preservar é o default)
 *   orphaned intocado   → REMOVE  (o NexOS gravou, o pacote perdeu, ninguém editou)
 *   orphaned editado    → REVIEW  (tem trabalho de alguém dentro)
 *   duplicate/variant/shadowed → REVIEW (qual sobrevive é decisão de quem usa)
 */
export function acaoPara(kind: AuditFindingKind, provenance: Provenance, intocado = true): AuditAction {
  switch (kind) {
    case "broken-reference":
      return provenance === "NEXOS_OWNED" ? "REPAIR" : "REVIEW";
    /** Renomear o arquivo é conserto mecânico, e a peça está íntegra por dentro. */
    case "invisible":
      return "REPAIR";
    case "stale":
      return "UPDATE";
    case "orphaned":
      return intocado ? "REMOVE" : "REVIEW";
    case "modified":
    case "duplicate":
    case "variant":
    case "shadowed":
      return "REVIEW";
  }
}

/**
 * `CONHECIDO != CRIADO`. O manifesto do install é a única prova de autoria do
 * NexOS; o resto se classifica pela origem que o catálogo observou. Nada cai em
 * "órfão" por não ser nosso — órfão é o que o NexOS gravou e o pacote perdeu,
 * e isso o `nexos install` já reporta no próprio plano.
 */
export function classificarProveniencia(item: AuditItem): Provenance {
  if (item.nexosOwned === true) return "NEXOS_OWNED";
  switch (item.source) {
    case "project":
      return "PROJECT_MANAGED";
    case "plugin":
      return "PLUGIN_MANAGED";
    case "personal":
      return "USER_MANAGED";
    default:
      return "UNCLASSIFIED";
  }
}

/**
 * Precedência de SKILL de mesmo nome, conforme a doc oficial (skills.md,
 * "Same name in"): enterprise vence personal, personal vence project. É o
 * INVERSO da precedência de subagentes (projeto vence usuário) — confundir as
 * duas faz o relatório apontar o perdedor errado. Plugin é namespaced
 * (`/plugin:skill`), então convive sem sombrear; sincronizada idem
 * (`anthropic-skills:<nome>`).
 */
const PRECEDENCIA_SKILL: Readonly<Record<string, number>> = { enterprise: 3, personal: 2, project: 1 };

function vencedorDoNome(membros: readonly { readonly id: string; readonly source?: string }[]): string | undefined {
  const disputam = membros.filter((m) => (m.source ?? "") in PRECEDENCIA_SKILL);
  if (disputam.length < 2) return undefined; // plugin/sincronizada não disputam: convivem namespaced
  return [...disputam].sort(
    (a, b) => (PRECEDENCIA_SKILL[b.source!] ?? 0) - (PRECEDENCIA_SKILL[a.source!] ?? 0) || a.id.localeCompare(b.id)
  )[0]!.id;
}

/**
 * Cruza catálogo × disco e devolve achados ordenados por custo de listagem
 * (o que mais pesa na janela aparece primeiro), com `id` como desempate para
 * saída determinística.
 */
export function auditarCapabilities(
  input: AuditInput,
  exists: ExistsProbe,
  home: string = os.homedir()
): AuditReport {
  const findings: AuditFinding[] = [];
  const porId = new Map(input.items.map((i) => [i.id, i]));
  const custo = (id: string): number => porId.get(id)?.listing_chars ?? 0;

  /**
   * Estes NÃO estão em `input.items` — é essa a questão. Um item invisível
   * nunca chega ao catálogo, então nenhum laço sobre `items` o alcançaria.
   */
  for (const inv of input.invisibleSkills ?? []) {
    findings.push({
      kind: "invisible",
      action: "REPAIR",
      id: `skill:invisible::${inv.dirName}`,
      name: inv.dirName,
      provenance: "USER_MANAGED",
      file: inv.file,
      listingChars: 0,
      detail: `o arquivo se chama ${inv.encontrado} e o host só carrega SKILL.md — a peça está íntegra e ninguém a enxerga`,
    });
  }

  for (const item of input.items) {
    if (!item.body || !item.file) continue;
    const ausentes = referenciasCitadas(item.body, item.file, home)
      .filter((r) => !exists(r.resolvido))
      // Um COMANDO declara execução: ausência quebra na hora, e é achado.
      // Uma CITAÇÃO cujo diretório de layout nem existe ao lado da peça aponta
      // para outro contexto (o repo upstream), não para uma dependência local.
      .filter((r) => {
        if (r.origem === "comando") return true;
        const raiz = raizDoLayout(r.citado);
        return raiz === undefined || exists(path.resolve(path.dirname(item.file!), raiz));
      })
      .map((r) => r.citado);
    if (ausentes.length === 0) continue;
    const unicos = [...new Set(ausentes)];
    findings.push({
      kind: "broken-reference",
      action: acaoPara("broken-reference", classificarProveniencia(item)),
      id: item.id,
      name: item.name,
      provenance: classificarProveniencia(item),
      file: item.file,
      listingChars: item.listing_chars ?? 0,
      detail: `manda abrir/executar ${unicos.length} caminho(s) ausente(s): ${unicos.slice(0, 3).join(", ")}${unicos.length > 3 ? ", …" : ""}`,
    });
  }

  for (const item of input.items) {
    const tripla = item.file ? input.nexosFiles?.get(item.file) : undefined;
    if (!tripla) continue;
    const proveniencia = classificarProveniencia(item);
    const intocado = tripla.disk === tripla.manifest;

    if (tripla.package === null) {
      findings.push({
        kind: "orphaned",
        action: acaoPara("orphaned", proveniencia, intocado),
        id: item.id,
        name: item.name,
        provenance: proveniencia,
        file: item.file,
        listingChars: item.listing_chars ?? 0,
        detail: intocado
          ? "o NexOS gravou e o pacote não tem mais; conteúdo idêntico ao instalado"
          : "o NexOS gravou, o pacote não tem mais, e alguém editou depois",
      });
      continue;
    }

    if (!intocado) {
      findings.push({
        kind: "modified",
        action: acaoPara("modified", proveniencia),
        id: item.id,
        name: item.name,
        provenance: proveniencia,
        file: item.file,
        listingChars: item.listing_chars ?? 0,
        detail: "editado no host depois de instalado — o install preserva, nunca sobrescreve",
      });
      continue;
    }

    if (tripla.package !== tripla.disk) {
      findings.push({
        kind: "stale",
        action: acaoPara("stale", proveniencia),
        id: item.id,
        name: item.name,
        provenance: proveniencia,
        file: item.file,
        listingChars: item.listing_chars ?? 0,
        detail: `conteúdo difere do pacote (${tripla.disk.slice(0, 8)} != ${tripla.package.slice(0, 8)}) — hash, não data`,
      });
    }
  }

  for (const [kind, grupos] of [
    ["duplicate", input.duplicates],
    ["variant", input.variants],
  ] as const) {
    for (const grupoNoDisco of grupos) {
      /**
       *   NO DISCO != NA SESSÃO
       *
       * Só disputa quem carrega. MEDIDO 23/09: as 16 duplicatas do host eram
       * todas contra o plugin document-skills, fora de enabledPlugins — o
       * relatório mandava "revisar" 8 pares que custavam zero.
       */
      const grupo = { items: grupoNoDisco.items.filter((i) => porId.get(i.id)?.enabled !== false) };
      if (grupo.items.length < 2) continue;
      const escopos = grupo.items.map((i) => i.source ?? "?").join(" × ");
      /**
       *   SHADOWED É POR NOME, NUNCA POR CONTEÚDO
       *
       * `duplicates` vem agrupado por CONTENT_HASH e `variants` por NAME, mas
       * os dois caem neste mesmo loop. Precedência de skill é por NOME
       * (skills.md, "Same name in"): duas skills de nomes DIFERENTES coexistem
       * ativas por mais idêntico que seja o corpo, então um grupo de conteúdo
       * não autoriza falar em sombreamento.
       *
       * Medido no Store real antes desta guarda: 4 dos 17 grupos de duplicate
       * tinham nomes divergentes e produziam 5 dos 20 findings `shadowed`,
       * todos falsos — `doc-coauthoring` × `productivity--doc-coauthoring`
       * entre eles. O relatório dizia "instalada e NÃO é a que roda" sobre
       * peça que roda, e uma reconciliação guiada por ele removeria capability
       * viva.
       */
      /**
       * A checagem é sobre quem DISPUTA, nunca sobre o grupo inteiro. Plugin e
       * sincronizada entram no grupo de conteúdo mas são namespaced
       * (`document-skills:brand-guidelines`), não concorrem por nome e por isso
       * não podem vetar o sombreamento legítimo entre personal e project.
       * Olhar o grupo todo zerava os 20 sombreados do Store real em vez dos 5
       * falsos — a primeira tentativa desta guarda fez exatamente isso.
       */
      const nomeDe = (id: string): string => porId.get(id)?.name ?? id;
      const porNome = new Map<string, { readonly id: string; readonly source?: string }[]>();
      for (const i of grupo.items) {
        if (!((i.source ?? "") in PRECEDENCIA_SKILL)) continue;
        const n = nomeDe(i.id);
        porNome.set(n, [...(porNome.get(n) ?? []), i]);
      }
      /** Vencedor DAQUELE nome — não do grupo. Ver o bloco acima. */
      const vencedorDe = (id: string): string | undefined =>
        vencedorDoNome(porNome.get(nomeDe(id)) ?? []);
      for (const membro of grupo.items) {
        const item = porId.get(membro.id);
        const vencedor = vencedorDe(membro.id);
        const sombreado = vencedor !== undefined && membro.id !== vencedor && (membro.source ?? "") in PRECEDENCIA_SKILL;
        findings.push({
          kind: sombreado ? "shadowed" : kind,
          action: "REVIEW",
          id: membro.id,
          name: item?.name ?? membro.id,
          provenance: item ? classificarProveniencia(item) : "UNCLASSIFIED",
          file: membro.file ?? item?.file,
          listingChars: custo(membro.id),
          detail: sombreado
            ? `instalada em ${membro.source} e NÃO é a que roda: ${escopos} — vence ${porId.get(vencedor)?.source ?? "outra"} (enterprise > personal > project)`
            : kind === "duplicate"
              ? `conteúdo idêntico em ${grupo.items.length} escopos (${escopos}) — só um vence a precedência`
              : `mesmo nome com conteúdos diferentes em ${grupo.items.length} escopos (${escopos}) — qual vence depende da precedência`,
        });
      }
    }
  }

  findings.sort((a, b) => b.listingChars - a.listingChars || a.id.localeCompare(b.id));

  const porTipo: Record<AuditFindingKind, number> = {
    "broken-reference": 0,
    duplicate: 0,
    variant: 0,
    shadowed: 0,
    stale: 0,
    modified: 0,
    invisible: 0,
    orphaned: 0,
  };
  for (const f of findings) porTipo[f.kind] += 1;

  const porProveniencia: Record<Provenance, number> = {
    NEXOS_OWNED: 0,
    PROJECT_MANAGED: 0,
    PLUGIN_MANAGED: 0,
    USER_MANAGED: 0,
    UNCLASSIFIED: 0,
  };
  for (const item of input.items) porProveniencia[classificarProveniencia(item)] += 1;

  /**
   *   CONTAGEM DE TRABALHO É POR PEÇA, ACHADO É POR ACHADO
   *
   * `porAcao` responde "quantas peças tocar", então conta ids DISTINTOS — do
   * contrário mistura unidades com `KEEP`, que sempre deduplicou. A mesma peça
   * cai em `duplicates` E em `variants` e emite um finding em cada: medido no
   * Store real desta máquina, `REVIEW` somava 102 findings sobre 87 peças, e
   * quem lesse dimensionaria 15 unidades de trabalho a mais.
   *
   * `porTipo` acima segue contando ACHADOS de propósito: ali a pergunta é
   * "quantos sombreamentos existem", não "quantas peças tocar".
   *
   * A SOMA de `porAcao` PODE EXCEDER `items`, e isso é correto: uma peça com
   * referência quebrada dentro de um grupo duplicado recebe `REPAIR` e
   * `REVIEW`, que são dois trabalhos genuinamente diferentes sobre o mesmo
   * arquivo. Verificado em 2026-09-18 com input isolado: 2 peças, `REPAIR 1` e
   * `REVIEW 2`, soma 3. Nenhum consumidor lê essa soma como total — cada bucket
   * é impresso isolado em `printAudit` —, mas quem for usá-la precisa saber que
   * ela responde "quantas unidades de trabalho", nunca "quantas peças".
   */
  const pecasPorAcao = new Map<AuditAction, Set<string>>();
  for (const f of findings) {
    const s = pecasPorAcao.get(f.action) ?? new Set<string>();
    s.add(f.id);
    pecasPorAcao.set(f.action, s);
  }
  const porAcao: Record<AuditAction, number> = { KEEP: 0, REPAIR: 0, UPDATE: 0, REMOVE: 0, REVIEW: 0 };
  for (const [acao, ids] of pecasPorAcao) porAcao[acao] = ids.size;
  // KEEP é a ausência de achado: peça sem nenhuma linha continua como está.
  porAcao.KEEP = input.items.length - new Set(findings.map((f) => f.id)).size;

  const idsComAchado = new Set(findings.map((f) => f.id));
  return {
    findings,
    totals: {
      items: input.items.length,
      surfaceChars: input.items.reduce((acc, i) => acc + (i.listing_chars ?? 0), 0),
      surfaceCharsComAchado: [...idsComAchado].reduce((acc, id) => acc + custo(id), 0),
      porTipo,
      porProveniencia,
      porAcao,
    },
    surface: resumirSuperficie(input),
  };
}

/**
 * Projeta cada peça nos quatro planos. NÃO emite finding: `off` e `name-only`
 * são estados de exposição, não defeitos.
 *
 *   OFF != BROKEN · NAME-ONLY != BROKEN
 *
 * Consome `item.override` já resolvido por `scan.ts`. A versão anterior
 * re-resolvia contra o mapa cru de `skillOverrides` e marcava plugins ligados
 * como não-invocáveis por colisão de nome — 63 "off" onde o scan resolve 52.
 */
export function resumirSuperficie(input: AuditInput): SurfaceTotals {
  const porOverride: Record<OverrideValue, number> = { on: 0, off: 0, "name-only": 0, "user-invocable-only": 0 };
  const notInvocable: SurfaceNote[] = [];
  const reduced: SurfaceNote[] = [];
  let desconhecida = 0;
  let naoGovernadas = 0;

  for (const item of input.items) {
    const estado = resolveSurface(item.kind, item.override);
    if (estado.invocableBasis === "NOT_APPLICABLE") naoGovernadas += 1;
    if (estado.invocable === "UNKNOWN") desconhecida += 1;
    if (estado.override === undefined) continue;

    porOverride[estado.override] += 1;
    const nota: SurfaceNote = {
      id: item.id,
      name: item.name,
      override: estado.override,
      basis: estado.invocableBasis,
      detail: estado.detail,
    };
    if (estado.invocable === "NO") notInvocable.push(nota);
    else if (estado.override === "name-only") reduced.push(nota);
  }

  return {
    discovered: input.items.length,
    naoGovernadas,
    porOverride,
    notInvocable,
    reduced,
    invocabilidadeDesconhecida: desconhecida,
    /** Nenhuma medição direta passa por este caminho — a de theme-factory foi manual. */
    medidasDiretamente: 0,
  };
}
