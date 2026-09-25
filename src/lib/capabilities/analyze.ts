/**
 * `nexos capabilities` — análise sobre o que `scan.ts` observou. Ainda LEITURA
 * PURA (nenhuma função aqui toca disco) — duplicata exata por hash, custo de
 * listagem agregado, e `--for` (cruza a tarefa em texto livre com a stack do
 * mapa e ranqueia no máximo 3 sugestões, nunca decide por Claude).
 *
 *   NEAR-DUPLICATE != EXACT DUPLICATE
 *
 * Duplicata aqui é só EXATA (mesmo `content_hash`) — cópia editada (a maioria
 * dos casos reais de G1.3) fica para a onda 2 (mesma régua de similaridade
 * fuzzy que G2.3 já pede para gotchas). Marcar isso é o que evita este módulo
 * fingir que resolveu um problema maior do que resolveu.
 */
import type {
  CapabilityItem,
  CapabilitySource,
  CapabilitySuggestResult,
  CapabilitySuggestion,
  CapabilityGap,
  DuplicateGroup,
  VariantGroup,
} from "./types.js";
import type { MapFact } from "../map/stack-detector.js";

export function groupDuplicates(items: readonly CapabilityItem[]): readonly DuplicateGroup[] {
  const byHash = new Map<string, { id: string; file: string; source: CapabilitySource }[]>();
  for (const item of items) {
    if (!item.content_hash || !item.file) continue;
    const list = byHash.get(item.content_hash) ?? [];
    list.push({ id: item.id, file: item.file, source: item.source });
    byHash.set(item.content_hash, list);
  }
  const groups: DuplicateGroup[] = [];
  for (const [hash, list] of byHash) {
    if (list.length < 2) continue;
    groups.push({ content_hash: hash, items: list });
  }
  return groups.sort((a, b) => a.content_hash.localeCompare(b.content_hash));
}

/** `"plugin-a:skill-name"` → `"skill-name"`; sem namespace, devolve como está. */
function lastNameSegment(name: string): string {
  const i = name.lastIndexOf(":");
  return i === -1 ? name : name.slice(i + 1);
}

/**
 * Review pós-A1.3 (achado do verifier) — sinal BARATO para cópia
 * DIVERGENTE: mesmo nome final, fontes distintas, hash diferente. Não é
 * duplicata (`groupDuplicates`, hash exato) nem similaridade fuzzy (onda 2)
 * — é só "estes N locais alegam ser a mesma capability e não batem
 * byte a byte", o caso real medido para
 * `development--systematic-debugging` (pessoal, editado) ×
 * `superpowers:systematic-debugging` (plugin, donor original).
 *
 * ESSE caso concreto foi RESOLVIDO em 2026-09-22: medido que a cópia do
 * pacote NexOS só acrescentava `license`/`port_ref` ao upstream, e ela saiu
 * (`HOST-PRIMEIRO`). O mecanismo continua — a variante divergente é um sinal
 * genérico, e o exemplo que o originou agora é histórico, não estado vivo.
 *
 * Um grupo só nasce com ≥2 fontes DISTINTAS e ≥2 hashes DISTINTOS — mesmo
 * nome em fontes diferentes mas conteúdo idêntico já é `DuplicateGroup`,
 * não variante; mesmo nome numa fonte só (duas versões dentro do MESMO
 * plugin, por exemplo) não é o sinal que este grupo existe para dar.
 */
export function groupVariants(items: readonly CapabilityItem[]): readonly VariantGroup[] {
  const byName = new Map<
    string,
    { id: string; file: string; source: CapabilitySource; content_hash: string }[]
  >();
  for (const item of items) {
    if (!item.content_hash || !item.file) continue;
    const key = lastNameSegment(item.name);
    const list = byName.get(key) ?? [];
    list.push({ id: item.id, file: item.file, source: item.source, content_hash: item.content_hash });
    byName.set(key, list);
  }

  const groups: VariantGroup[] = [];
  for (const [name, list] of byName) {
    const distinctSources = new Set(list.map((i) => i.source));
    const distinctHashes = new Set(list.map((i) => i.content_hash));
    if (distinctSources.size < 2 || distinctHashes.size < 2) continue;
    groups.push({ name, items: list });
  }
  return groups.sort((a, b) => a.name.localeCompare(b.name));
}

export function totalListingChars(items: readonly CapabilityItem[]): number {
  return items.reduce((sum, item) => sum + item.listing_chars, 0);
}

// ─── --for: ranking bilíngue leve ──────────────────────────────────────────

/**
 * ponytail: ponte PT→EN fixa e pequena (não um dicionário genérico nem
 * embeddings) — o suficiente para "teste falhando" casar com uma descrição em
 * inglês ("test failure"), que é o caso real deste projeto (regras em
 * português, skills majoritariamente em inglês). Teto conhecido: só cobre
 * vocabulário comum de desenvolvimento; upgrade para similaridade semântica
 * real é onda 2 (mesmo teto de G2.1 — stopwords/sinônimo no golden set).
 */
const PT_EN_BRIDGE: Readonly<Record<string, string>> = {
  teste: "test",
  testes: "test",
  /** Stem, não palavra inteira: casa "failure"/"failing"/"failed" por prefixo (`scoreAgainst`, ≥4 chars). */
  falha: "fail",
  falhando: "fail",
  falhou: "fail",
  erro: "error",
  erros: "error",
  bug: "bug",
  bugs: "bug",
  causa: "cause",
  corrigir: "fix",
  correcao: "fix",
  depurar: "debug",
  depuracao: "debugging",
  desempenho: "performance",
  seguranca: "security",
  revisao: "review",
  construir: "build",
  implantar: "deploy",
  documentacao: "documentation",
};

const STOPWORDS = new Set(["sem", "com", "para", "the", "and", "for", "com", "que", "clara", "claro"]);

function stripDiacritics(s: string): string {
  return s.normalize("NFD").replace(/[̀-ͯ]/g, "");
}

function tokenize(text: string): readonly string[] {
  return stripDiacritics(text.toLowerCase())
    .split(/[^a-z0-9]+/)
    .filter((t) => t.length >= 3 && !STOPWORDS.has(t));
}

function expandTokens(tokens: readonly string[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const t of tokens) {
    out.add(t);
    const bridged = PT_EN_BRIDGE[t];
    if (bridged) out.add(bridged);
  }
  return out;
}

/** Um ponto por token igual; meio ponto por correspondência parcial (prefixo de ≥4 chars) — nunca o contrário (evitaria empate sistemático). */
function scoreAgainst(
  intentTokens: ReadonlySet<string>,
  itemTokens: readonly string[],
  /** Tokens que valem como evidência (ver `vocabularioDeDominio`). Ausente = todos valem, comportamento legado. */
  dominio?: ReadonlySet<string>,
  /** Tokens do NOME do item — evidência aí pesa mais que na description. */
  nomeTokens?: readonly string[]
): { score: number; matched: readonly string[]; evidencia: number } {
  let score = 0;
  let evidencia = 0;
  const matched: string[] = [];
  const itemSet = new Set(itemTokens);
  /**
   * NOME É CURADO, DESCRIPTION É PROSA.
   *
   * Calibrado em corpus próprio (o holdout é acceptance, não calibração):
   * com "1 termo de domínio basta", `otimizar uma query lenta no Postgres`
   * devolvia `llm-council` — 1262 chars de description casando em "query" —
   * e `pentest no endpoint` devolvia `meta-platform-bible` por "endpoint".
   * Um único termo vindo de prosa longa não distingue peça adequada de peça
   * grande. No NOME, um termo basta: alguém escolheu aquela palavra para
   * identificar a peça.
   */
  const nomeSet = new Set(nomeTokens ?? []);
  let porNome = 0;
  let porTexto = 0;
  const conta = (t: string): void => {
    if (dominio !== undefined && !dominio.has(t)) return;
    if (nomeSet.has(t)) porNome += 1;
    else porTexto += 1;
  };
  for (const t of intentTokens) {
    if (itemSet.has(t)) {
      score += 1;
      matched.push(t);
      conta(t);
      continue;
    }
    const partial = itemTokens.find((it) => it.length >= 4 && t.length >= 4 && (it.startsWith(t) || t.startsWith(it)));
    if (partial) {
      score += 0.5;
      matched.push(partial);
      /* Match parcial conta como evidência pelo token da INTENT, não pelo do item:
         "isso" casou com "establishing" por prefixo e não deve virar domínio. */
      conta(t);
    }
  }
  evidencia = porNome > 0 ? porNome + porTexto : porTexto >= 2 ? porTexto : 0;
  return { score, matched: [...new Set(matched)], evidencia };
}

/**
 *   CASAR EM PALAVRA FUNCIONAL NÃO É EVIDÊNCIA DE ADEQUAÇÃO
 *
 * Medido em 2026-09-21: "me ajuda com uma coisa" devolvia três sugestões
 * confiantes, todas casando no token "uma"; "depois disso não sei" devolvia
 * `nexos-verifier` por "depois" e "nao". O corte era `total <= 0`, então UM
 * token funcional bastava para produzir três candidatos com score.
 *
 * O vocabulário de domínio não é uma lista escrita à mão — STOPWORDS tinha 9
 * palavras efetivas, com "clara" e "claro" dentro, e foi crescendo por remendo
 * conforme alguém via um resultado estranho. Aqui ele é DERIVADO do catálogo:
 * um token é de domínio se aparece no NOME de alguma capability instalada,
 * inclusive COLD. Nomes são curados por humanos; "debugging", "postgres",
 * "security" e "react" estão lá, "uma", "isso", "depois" e "coisa" não.
 *
 * Isto NÃO é IDF nem BM25, que já foram medidos e reprovados neste catálogo
 * (nexos://decision/retrieval-bakeoff-no-winner: PT 6%→57%, abaixo do gate).
 * Não há peso por raridade nem reordenação: é um predicado binário sobre QUAL
 * match conta como evidência. O ranking de quem passa continua intacto.
 */
function vocabularioDeDominio(items: readonly CapabilityItem[]): ReadonlySet<string> {
  const out = new Set<string>();
  for (const item of items) for (const t of tokenize(item.name)) out.add(t);
  /* A ponte PT→EN também é vocabulário CURADO: alguém escolheu à mão que
     "falhando" vira "fail". Sem isto, `fail` ficava fora do domínio porque
     nenhum NOME de capability o contém — só "failure", dentro de prosa — e
     "tem um teste falhando" perdia `systematic-debugging`. Medido na
     calibração, não no holdout. */
  for (const alvo of Object.values(PT_EN_BRIDGE)) out.add(alvo);
  return out;
}

export interface SuggestOptions {
  readonly stackFacts?: readonly MapFact[];
  readonly limit?: number;
  /** Tokens que valem como evidência. Omitido = comportamento legado (todo match conta). */
  readonly dominio?: ReadonlySet<string>;
}

/**
 * Ranqueia `skill`/`agent` ATIVOS pela sobreposição de tokens com `task`;
 * bônus quando `metadata.stacks` do item cita um fato de stack observado no
 * mapa. Devolve no máximo `limit` (padrão 3) — mais do que isso não é
 * "sugestão", é lista.
 */
export function suggestForTask(items: readonly CapabilityItem[], task: string, opts: SuggestOptions = {}): readonly CapabilitySuggestion[] {
  const limit = opts.limit ?? 3;
  const intentTokens = expandTokens(tokenize(task));
  const stackValues = (opts.stackFacts ?? []).map((f) => stripDiacritics(f.value.toLowerCase()));

  const scored: CapabilitySuggestion[] = [];
  for (const item of items) {
    if (item.kind !== "skill" && item.kind !== "agent") continue;
    if (!item.enabled) continue;
    const itemTokens = tokenize(`${item.name} ${item.description ?? ""}`);
    const { score, matched, evidencia } = scoreAgainst(intentTokens, itemTokens, opts.dominio, tokenize(item.name));

    let bonus = 0;
    const stacks = item.metadata?.stacks;
    const stackNames = Array.isArray(stacks) ? stacks.filter((s): s is string => typeof s === "string") : [];
    const stackHit = stackNames.find((s) => stackValues.some((v) => v.includes(stripDiacritics(s.toLowerCase()))));
    if (stackHit) bonus += 1;

    const total = score + bonus;
    if (total <= 0) continue;
    const why = [
      matched.length > 0 ? `combina em: ${matched.join(", ")}` : undefined,
      stackHit ? `stack do projeto usa ${stackHit}` : undefined,
    ]
      .filter((x): x is string => x !== undefined)
      .join(" · ");
    scored.push({ item, score: total, why: why || "correspondência fraca de vocabulário", evidencia });
  }

  return scored.sort((a, b) => b.score - a.score).slice(0, limit);
}

/**
 * `lsp` que a stack observada pede mas não está `connected` — o item já
 * carrega `health`/`description` (`<linguagem> via <comando>`) de
 * `scan.ts`; aqui só cruza contra `stackFacts` e escreve o remédio.
 */
export function findCapabilityGaps(items: readonly CapabilityItem[], stackFacts: readonly MapFact[] = []): readonly CapabilityGap[] {
  const stackValues = stackFacts.map((f) => stripDiacritics(f.value.toLowerCase()));
  const gaps: CapabilityGap[] = [];
  for (const item of items) {
    if (item.kind !== "lsp" || item.health === "connected") continue;
    const language = item.description?.split(" via ")[0]?.trim();
    if (!language) continue;
    const wanted = stackValues.some((v) => v.includes(stripDiacritics(language.toLowerCase())));
    if (!wanted) continue;
    const command = item.description?.split(" via ")[1]?.trim();
    const remedy =
      item.health === "not-installed"
        ? `instalar o plugin \`${item.plugin_id}\``
        : `instalar \`${command ?? "o binário"}\` no PATH`;
    gaps.push({ id: item.id, name: item.name, reason: `capability ausente: ${item.health}`, remedy });
  }
  return gaps;
}

/**
 *   B — DISPONIBILIDADE, NÃO RANKING
 *
 * "Qual das utilizáveis é a melhor?" é A. Esta função responde ANTES disso:
 * "existe alguma utilizável?" — e aceita NÃO como resposta legítima.
 *
 * Medido em holdout cego de 36 tarefas (sha256:f7da8ca2…): quatro mecanismos
 * diferentes — léxico, BM25, tradução+BM25, BM25+rerank — devolveram 3
 * candidatos SEMPRE, acertando 0, 0, 0 e 1 dos 5 casos sem capability ativa.
 * Isso é pior que errar o ranking: a peça errada chega com a mesma cara de
 * certeza da peça certa. Pedir "revisar segurança do fluxo de pagamento"
 * devolvia duas skills de anúncios do Facebook, com score.
 *
 * B NÃO REORDENA A. Quando há candidato com evidência de domínio, as
 * sugestões saem exatamente como `suggestForTask` as produziu — mesma ordem,
 * mesmo conjunto. B é gate de disponibilidade; virar router seria repetir o
 * problema com outro nome.
 *
 * DETECTAR != ATIVAR (nexos://decision/cold-detectavel-nunca-autoativado):
 * quando a peça adequada existe mas está COLD, esta função a NOMEIA e informa
 * a remediação — e nunca altera `enabled`.
 */
export type DisponibilidadeEstado = "ELIGIBLE_AVAILABLE" | "CAPABILITY_DISABLED" | "NO_ELIGIBLE_CAPABILITY";

export interface DisponibilidadeResult {
  readonly estado: DisponibilidadeEstado;
  /** Em ELIGIBLE_AVAILABLE: as sugestões de A, ordem intacta. Vazio nos demais. */
  readonly suggestions: readonly CapabilitySuggestion[];
  /** Em CAPABILITY_DISABLED: a peça instalada e desligada. */
  readonly latente?: {
    readonly name: string;
    readonly provenance: string;
    readonly motivo: string;
    /** Só quando o caminho de ativação é conhecido e autoritativo. */
    readonly remediation?: string;
  };
  readonly porque: string;
}

export function avaliarDisponibilidade(
  items: readonly CapabilityItem[],
  task: string,
  opts: SuggestOptions = {}
): DisponibilidadeResult {
  const dominio = vocabularioDeDominio(items);
  /**
   *   AVALIAR DISPONIBILIDADE ANTES DO CORTE, NÃO DEPOIS.
   *
   * `suggestForTask` corta em `limit` (3). Filtrar evidência sobre o recorte
   * pergunta "os 3 melhores por score têm evidência?", que é outra pergunta.
   * Medido: em "tem um teste falhando", os 3 primeiros casavam em "tem",
   * "nao" e "por", e `development--systematic-debugging` — a peça certa,
   * ATIVA, casando em "test" e "failure" — ficava em 5º, fora do corte. O
   * resultado era CAPABILITY_DISABLED com a resposta certa ativa e ignorada:
   * falsa abstenção, que é o erro que o gate de >=30/31 existe para pegar.
   */
  const universo = suggestForTask(items, task, { ...opts, dominio, limit: Number.MAX_SAFE_INTEGER });
  const comEvidencia = universo.filter((s) => (s.evidencia ?? 0) > 0);
  /* A ordem e o recorte de A saem intactos: B é gate, não router. */
  const suggestions = suggestForTask(items, task, { ...opts, dominio });

  if (comEvidencia.length > 0) {
    return {
      estado: "ELIGIBLE_AVAILABLE",
      suggestions,
      porque: `${comEvidencia.length} candidato(s) com termo de domínio em comum`,
    };
  }

  /* Nenhuma ativa serve. O catálogo INTEIRO é consultado como diagnóstico —
     COLD informa disponibilidade latente, nunca participa como executável. */
  const intentTokens = expandTokens(tokenize(task));
  let melhor: { item: CapabilityItem; evidencia: number } | undefined;
  for (const item of items) {
    if (item.kind !== "skill" && item.kind !== "agent") continue;
    if (item.enabled) continue;
    const { evidencia } = scoreAgainst(
      intentTokens,
      tokenize(`${item.name} ${item.description ?? ""}`),
      dominio,
      tokenize(item.name)
    );
    if (evidencia > 0 && (melhor === undefined || evidencia > melhor.evidencia)) melhor = { item, evidencia };
  }

  if (melhor) {
    const it = melhor.item;
    const porOverride = it.override === "off";
    return {
      estado: "CAPABILITY_DISABLED",
      suggestions: [],
      latente: {
        name: it.name,
        provenance: it.plugin_id ? `PLUGIN_MANAGED (${it.plugin_id})` : "USER_MANAGED",
        motivo: porOverride
          ? "desativada por override em ~/.claude/settings.json"
          : "o plugin que a fornece está desativado",
        /* Proveniência desconhecida NÃO inventa comando
           (nexos://decision/remediacao-cold-por-proveniencia). */
        ...(porOverride && !it.plugin_id
          ? { remediation: `em ~/.claude/settings.json, skillOverrides["${it.name}"] está "off"` }
          : {}),
      },
      porque: "nenhuma capability ativa serve, mas existe uma instalada e desativada",
    };
  }

  return {
    estado: "NO_ELIGIBLE_CAPABILITY",
    suggestions: [],
    porque: "nenhuma capability, ativa ou desativada, casa em termo de domínio desta tarefa",
  };
}

export function suggestCapabilities(
  items: readonly CapabilityItem[],
  task: string,
  opts: SuggestOptions = {}
): CapabilitySuggestResult {
  return {
    suggestions: suggestForTask(items, task, opts),
    gaps: findCapabilityGaps(items, opts.stackFacts ?? []),
  };
}

/**
 * O recorte que `--kind` produz para o audit. Existe como função PORQUE a
 * lógica morava solta dentro de `capabilities()` e não tinha teste nenhum:
 *
 *   UNIT GREEN != WIRED
 *
 * MEDIDO em 2026-09-21 por um verifier independente: desligar a correção lá
 * dentro não deixava UM teste vermelho na suíte inteira, porque os testes
 * chamavam `auditarCapabilities` direto com grupos montados à mão — provavam o
 * conceito e nunca a fiação. Grupo nascido do catálogo INTEIRO aplicado a um
 * recorte filtrado faz `--kind agent` reportar achados sobre SKILLS e derrete
 * o `shadowed` (precedência) em dois `variant` soltos.
 */
export function recorteParaAudit(
  catalog: {
    readonly items: readonly CapabilityItem[];
    readonly duplicates: readonly DuplicateGroup[];
    readonly variants: readonly VariantGroup[];
  },
  kind: string | undefined
): {
  readonly items: readonly CapabilityItem[];
  readonly duplicates: readonly DuplicateGroup[];
  readonly variants: readonly VariantGroup[];
  /** Skill invisível é achado de SKILL: fora do recorte de skill, é vazamento. */
  readonly incluiSkillsInvisiveis: boolean;
} {
  if (kind === undefined) {
    return {
      items: catalog.items,
      duplicates: catalog.duplicates,
      variants: catalog.variants,
      incluiSkillsInvisiveis: true,
    };
  }
  const items = catalog.items.filter((i) => i.kind === kind);
  return {
    items,
    duplicates: groupDuplicates(items),
    variants: groupVariants(items),
    incluiSkillsInvisiveis: kind === "skill",
  };
}
