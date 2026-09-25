/**
 * FATIA 2 — MEMORY RECALL AUTOMÁTICO.
 *
 *   USER TYPES NORMALLY != USER RUNS `nexos memory --search`
 *
 * `nexos memory --search` (comando P1, `commands/memory.ts`) já resolvia
 * "recuperar memória por assunto" — mas exigia que alguém digitasse o
 * comando. A maior parte da sessão é o usuário conversando normalmente, sem
 * saber que o Store tem algo relevante para dizer. Este adapter é o mesmo
 * motor (`assembleContext`), acionado pelo hook em vez de pelo teclado.
 *
 * ─── por que não é um segundo motor de busca ────────────────────────────────
 *
 * ZERO embeddings, ZERO vector DB, ZERO LLM decidindo relevância. O ranking
 * determinístico inteiro já existe em `context-assembler.ts` (`pontuar`,
 * `comparar`). Este arquivo só faz DUAS coisas que o assembler não faz:
 * decide SE o sinal é forte o bastante para interromper o usuário
 * (`qualifica`, mais conservador que o piso do assembler) e resolve o EMPATE
 * de forma legível por humano (`compararRelevanciaTextual`) — o assembler
 * empata por recency/id porque não tem noção de "frase da pergunta", só de
 * termos soltos.
 *
 * ─── por que `project_state` fica fora ──────────────────────────────────────
 *
 *   BOOT/DELTA JÁ ENTREGAM O STATE != RECALL PRECISA ENTREGAR DE NOVO
 *
 * `claude-session-start` (boot) e `claude-user-prompt-submit` (delta) já são
 * o canal do "onde paramos". `PESO_KIND.project_state = 100` dominaria
 * qualquer ranking de memória — um record de estado quase sempre vence um
 * gotcha específico só pelo bônus, mesmo quando o assunto da pergunta é outra
 * coisa. `excludeKinds: ["project_state"]` (aditivo em `AssembleRequest`,
 * default vazio — boot/checkpoint continuam intactos) tira o State do pool
 * ANTES do ranking, não depois: nenhum filtro posterior teria efeito sobre um
 * bônus de +100 já vencido.
 *
 * ─── por que a política é conservadora ──────────────────────────────────────
 *
 *   NO MATCH IS BETTER THAN AN IRRELEVANT MEMORY
 *
 * `assembleContext` já filtra por `score > 0`, mas isso basta para BUSCA sob
 * demanda (`memory --search`, onde o usuário decidiu procurar) — não para
 * INJEÇÃO não solicitada em todo prompt. `qualifica()` exige sinal mais forte:
 * dois termos distintos do intent bateram, OU o intent inteiro (2+ termos)
 * casa fortemente com um campo de alta informação do record. Uma única
 * palavra do intent nunca qualifica sozinha — é sinal fraco demais para
 * interromper o usuário, não importa quantos records a compartilhem.
 *
 * ─── por que o dedup vive em `/tmp`, chaveado por sessão ────────────────────
 *
 * Mesmo padrão de `state-presentation.ts` e do marker de instincts em
 * `nexos-session-init.sh`: TMP = PRESENTATION CACHE, nunca autoridade. O
 * marker guarda só os `id`s (revisão exata, `ContextAssembler` doc) já
 * MOSTRADOS nesta sessão — nunca o quê foi dito, só que já foi. Falha ao ler
 * o marker (ausente, corrompido) devolve conjunto vazio: a memória PODE
 * reaparecer, nunca fica bloqueada por um cache ilegível.
 */
import { readFile, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { resolveProject } from "../../lib/project-resolver.js";
import { assembleContext, termosDe, type PackedItem } from "../../lib/context-assembler.js";
import { readCurrentRecords } from "../../lib/capsule/reader.js";
import { resolveReadRoot } from "../../lib/capsule/authority.js";
import { loadIntegrityCache, saveIntegrityCacheIfDirty } from "../../lib/capsule/integrity-cache.js";
import { registrarRecuperacao } from "../../lib/retrieval-log.js";
import { sinalizarStdoutCompleto } from "../../lib/host/budget-sentinel.js";

export interface MemoryRecallHookInput {
  readonly hook_event_name?: unknown;
  readonly session_id?: unknown;
  /** Observacional — nunca alimenta a resolução de identidade (mesma doutrina dos irmãos). */
  readonly cwd?: unknown;
  readonly prompt?: unknown;
}

/**
 * `RECALL`  — 1 a 3 memórias qualificadas; `text` é o bloco `[NEXOS MEMORY]` pronto.
 * `EMPTY`   — Store legível, nada qualificou (ou tudo já foi mostrado nesta sessão).
 * `SKIPPED` — sem projeto governado, sem prompt, ou Store ilegível — condição normal.
 * `FAILED`  — exceção inesperada.
 */
export type MemoryRecallResult =
  | { readonly state: "RECALL"; readonly text: string }
  | { readonly state: "EMPTY" }
  | { readonly state: "SKIPPED"; readonly reason: string }
  | { readonly state: "FAILED"; readonly reason: string };

/**
 * `result` vai para o host; `persist` é o efeito colateral (marcar `idx:`/id
 * mostrado, registrar a recuperação) que só pode rodar DEPOIS que `result` já
 * foi escrito no stdout — nunca antes.
 *
 *   MARCADO COMO MOSTRADO != REALMENTE ENTREGUE
 *
 * H3 REABERTO (revisão independente, rodada 2) — uma versão anterior desta
 * nota dizia que adiar `persist` para depois do `process.stdout.write`
 * FECHAVA o problema. Falso, e a contraprova do revisor rodou o mesmo cenário
 * contra o código de ANTES desta fatia (c6d8721e) com o resultado idêntico:
 * `nexos_run_with_budget` (`nexos-budget.sh`) redireciona o stdout do FILHO
 * para um ARQUIVO e só o repassa ao host se o filho sair DENTRO do
 * orçamento — a ORDEM dentro do processo nunca foi a variável que
 * protegia nada. Repro: atrasar só o `appendFile` de `registrarRecuperacao`
 * (que já roda depois do `process.stdout.write`, graças a este split) além
 * do orçamento — o wrapper mata o filho e descarta `$dir/out` de qualquer
 * jeito, porque o filho ainda estava "rodando" do ponto de vista dele.
 *
 * O que fecha de verdade é a sentinela cooperativa
 * (`sinalizarStdoutCompleto`, `lib/host/budget-sentinel.ts`) chamada por
 * `claudeMemoryRecall` NO MESMO PONTO onde este split já isolava `persist` —
 * o split continua necessário (é o que dá um lugar seguro para o sinal
 * entrar), só deixou de ser suficiente sozinho.
 *
 * `runMemoryRecallAdapter` (abaixo) continua chamando `persist` na hora —
 * é o que os ~20 testes que chamam o adapter direto (`claude-memory-recall.
 * test.ts`, `memory-recall-registra-injecao.test.ts`) exigem: marker e log
 * já no disco quando o `await` retorna. Só `claudeMemoryRecall`, o
 * entrypoint real sob o budget, sinaliza e adia `persist` para depois do
 * `process.stdout.write`.
 */
interface MemoryRecallComputation {
  readonly result: MemoryRecallResult;
  readonly persist: () => Promise<void>;
}

const SEM_EFEITO: () => Promise<void> = async () => {};

/**
 * N3 (MEDIUM, revisão independente rodada 2) — os dois chamadores de
 * `persist` (`runMemoryRecallAdapter`, `claudeMemoryRecall`) documentam
 * "NUNCA lança" como contrato, mas chamavam `await persist()` direto, sem
 * try/catch. `writeShownIds`/`registrarRecuperacao` engolem sua PRÓPRIA
 * falha de I/O, mas nada garante que TODO `persist` futuro terá a mesma
 * disciplina — o contrato dos dois chamadores não pode depender de quem
 * implementa `persist` lembrar de se proteger.
 */
async function persistirComSeguranca(persist: () => Promise<void>): Promise<void> {
  try {
    await persist();
  } catch (error) {
    // Melhor esforço: nunca derruba o contrato "nunca lança" do chamador — mas
    // NUNCA LANÇA != NUNCA AVISA. stderr é o canal de diagnóstico do adapter.
    process.stderr.write(`nexos memory-recall: persist falhou — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/** Sem teto de bytes — a mesma escolha de `memory.ts` (busca não é boot, não disputa orçamento fixo). */
const RECALL_BUDGET_BYTES = Number.MAX_SAFE_INTEGER;

/** `0→nada · 1→1 · 2→2 · 3+→top 3`. Nunca preencher posições artificialmente. */
const RECALL_MAX_ITEMS = 3;

/** Orçamento do CORPO do bloco de memória, em bytes. */
const ORCAMENTO_CORPO = 4096;

/**
 * Fatia do orçamento que `mudadas` (Decision alterada desde a última chamada)
 * NUNCA pode tomar — fica reservada para o que casou com o prompt atual. Um
 * terço: cabem as 3 memórias de `RECALL_MAX_ITEMS` no tamanho típico medido
 * (~550 bytes cada) com folga, sem estreitar a via de continuidade a ponto de
 * uma revogação demorar turnos para aparecer.
 */
const PISO_RELEVANCIA = 1365;

/** Campo extra de `rule`, truncado — a mesma disciplina de `SEARCH_FIELD_MAX_CHARS` de `memory.ts`, mais curta: isto é injeção não solicitada, não uma resposta a um `--search`. */
const RULE_LINE_MAX_CHARS = 160;

/** Campos de alta informação, na mesma ordem do TETO documentado em `context-assembler.ts` (`CAMPOS_UTEIS`): o que CARREGA a afirmação do kind. `title` é tratado à parte (tier 1/2 do desempate usam só ele). */
const CAMPOS_ALTA_INFO_RESTANTES = ["subject", "rule", "practice"] as const;

const norm = (s: string): string => s.normalize("NFD").replace(/[̀-ͯ]/g, "").toLowerCase();

/** Todo termo de `termosIntent` aparece em `texto` (tokenizado pelo mesmo tokenizer do assembler). Vazio nunca "contém tudo". */
function contemTodosOsTermos(texto: string, termosIntent: ReadonlySet<string>): boolean {
  if (termosIntent.size === 0 || texto === "") return false;
  const termosTexto = termosDe(texto);
  for (const t of termosIntent) if (!termosTexto.has(t)) return false;
  return true;
}

/**
 * Bigramas ADJACENTES do texto normalizado — "frase", não "termos soltos".
 * `termosDe`/`matchedTerms` já cobrem sobreposição de palavras sem ordem; o
 * que falta para "frase exata no title" é ADJACÊNCIA: uma pergunta inteira
 * ("vamos mexer novamente no permission gate") quase nunca aparece LITERAL
 * no título de um record — mas o par que carrega o assunto de verdade
 * ("permission gate") aparece, adjacente, em ambos. Bigrama (não a frase
 * inteira) é o que essa comparação precisa: par de palavras na MESMA ordem
 * em que o usuário as digitou, sem exigir a sentença inteira nem soltar a
 * ordem (o que já seria `todosOsTermosNoTitle`, o tier seguinte).
 *
 * ponytail: bigrama, não n-grama geral — par consecutivo já resolve o caso
 * medido ("permission gate"); n-grama maior é complexidade sem consumidor.
 *
 * Cada palavra do par passa por `termosDe` antes de virar bigrama — a MESMA
 * peneira de stopword/tamanho mínimo que decide `matchedTerms`. Sem isto,
 * uma preposição de liga ("de", "do", "no"...) casa QUALQUER par de
 * conteúdo em qualquer título que a contenha: medido no Store real, o
 * prompt "adicionar gate de permissão" gerava o bigrama "gate de" e "de
 * permissao" — string literal presente em dezenas de títulos que só
 * compartilham a preposição ("...o gate de segredo regrediu", "...gate de
 * verificacao...", "...ampliacao de permissao..."), nenhum sobre o MESMO
 * assunto do prompt — e vencia o desempate de tier 1 sobre
 * `nexos://decision/p1-0-remover-authorization-layer` (`matchedTerms`=2:
 * "gate","permissao"), que nunca aparecia no corpo do recall. `fraseExataNoTitle`
 * existe para "o usuário citou a frase que carrega o assunto" (ver acima) —
 * uma preposição sozinha não carrega assunto nenhum, é ruído gramatical que
 * qualquer título compartilha.
 */
function bigramasDe(texto: string): readonly string[] {
  const palavras = norm(texto).split(/[^a-z0-9]+/).filter((p) => p.length > 0);
  const bigramas: string[] = [];
  for (let i = 0; i < palavras.length - 1; i++) {
    if (termosDe(palavras[i] ?? "").size === 0 || termosDe(palavras[i + 1] ?? "").size === 0) continue;
    bigramas.push(`${palavras[i]} ${palavras[i + 1]}`);
  }
  return bigramas;
}

interface SinaisDesempate {
  readonly fraseExataNoTitle: boolean;
  readonly todosOsTermosNoTitle: boolean;
  readonly todosOsTermosEmCampoAltaInfo: boolean;
}

function sinaisDe(
  item: PackedItem,
  intentBigramas: readonly string[],
  termosIntent: ReadonlySet<string>
): SinaisDesempate {
  const title = item.fields.title ?? "";
  const titleNorm = norm(title);
  return {
    fraseExataNoTitle: intentBigramas.some((bg) => titleNorm.includes(bg)),
    todosOsTermosNoTitle: contemTodosOsTermos(title, termosIntent),
    todosOsTermosEmCampoAltaInfo: CAMPOS_ALTA_INFO_RESTANTES.some((f) =>
      contemTodosOsTermos(item.fields[f] ?? "", termosIntent)
    ),
  };
}

/**
 * Sinal real, conservador (ver doc de topo). `matchedTerms` já é a
 * interseção EXATA calculada pelo assembler — nada aqui reimplementa
 * scoring, só decide o LIMIAR de injeção não solicitada.
 */
function qualifica(item: PackedItem, intentBigramas: readonly string[], termosIntent: ReadonlySet<string>): boolean {
  if (item.matchedTerms.length >= 2) return true;
  /** Intent de 1 termo nunca qualifica pela via de frase — não há frase, só a mesma palavra solta que `matchedTerms` já reprovou. */
  if (termosIntent.size < 2) return false;
  const s = sinaisDe(item, intentBigramas, termosIntent);
  return s.fraseExataNoTitle || s.todosOsTermosNoTitle || s.todosOsTermosEmCampoAltaInfo;
}

/**
 * Desempate determinístico, na ordem exata do contrato: frase exata no title
 * → todos os termos no title → todos os termos em campo de alta informação →
 * contagem de `matchedTerms` → score do assembler → recency por ÚLTIMO (via
 * `id`, ULID — monotônico no tempo, mesma disciplina do `comparar()` do
 * assembler para determinismo imune à forma do `source_ref`).
 *
 * ponytail: EXPERIMENTO — laço mecânico, baseline → 1 mudança → medir →
 * keep/revert, três variantes testadas contra o MESMO contraexemplo medido
 * ("revisar o processo de deploy" empata uma Decision genérica ["revisar
 * periodicamente o processo de arquitetura"] com um gotcha específico sobre
 * deploy/rollback):
 *
 *   BASELINE — tier condicional "Decision vence empate exato"
 *     (`family === "Decision"`, entre `score` e `id`): resolve o caso que
 *     motivou o tier (Decision alcança o top-3, ver describe H), mas É CEGO
 *     A RELEVÂNCIA — o contraexemplo falha: a Decision genérica vence o
 *     gotcha on-topic só por ser Decision, sem olhar o TEXTO de nenhum dos
 *     dois. `family` não é sinal de relevância — é sinal de KIND, a mesma
 *     classe de erro que `SOURCE IDENTIFIER != RELEVANCE SIGNAL`
 *     (`comparar()`, `context-assembler.ts`) já proíbe para `source_ref`.
 *   VARIANTE B — desempate por especificidade (`matchedTerms` / termos do
 *     título, título curto vence título longo no mesmo empate): também
 *     falha o contraexemplo, e pelo MESMO motivo por outra porta — chave de
 *     Decision é sempre um slug curto (`p1-0-remover-authorization-layer`,
 *     3-5 termos após o split de hífen), então densidade-por-título
 *     favorece Decision sistematicamente, na prática quase sinônimo de
 *     "family === Decision" para este Store. Medido: mesmos 7/25 pares
 *     top-3 do baseline, contraexemplo idêntico (Decision vence).
 *   VARIANTE A (ESCOLHIDA) — desempate puro por recency/id, sem tier de
 *     kind nem de título: único que resolve o contraexemplo (medido:
 *     gotcha on-topic vence). Custo: perde 2 dos 3 pares que o tier ganhara
 *     (dl07, dl23 — "adicionar gate de permissão" volta a não alcançar o
 *     top-3; mantém dl15 via bigrama+hífen). `golden.yaml`/`golden-v2.yaml`
 *     (recall@5/MRR) são IDÊNTICOS nas três variantes — este comparador
 *     nunca é chamado pelo retriever de `nexos memory --eval`
 *     (`defaultRetriever`, `memory-eval.ts`, usa só `assembleContext`), só
 *     pelo hook (`runMemoryRecallAdapter`).
 *
 * `tests/claude-memory-recall.test.ts`: describe H documenta o caso que
 * motivou o tier como LIMITAÇÃO CONHECIDA (recency decide, nem sempre
 * acerta); describe I é o contraexemplo, como regressão.
 */
function compararRelevanciaTextual(
  a: PackedItem,
  b: PackedItem,
  intentBigramas: readonly string[],
  termosIntent: ReadonlySet<string>
): number {
  const sa = sinaisDe(a, intentBigramas, termosIntent);
  const sb = sinaisDe(b, intentBigramas, termosIntent);
  return (
    Number(sb.fraseExataNoTitle) - Number(sa.fraseExataNoTitle) ||
    Number(sb.todosOsTermosNoTitle) - Number(sa.todosOsTermosNoTitle) ||
    Number(sb.todosOsTermosEmCampoAltaInfo) - Number(sa.todosOsTermosEmCampoAltaInfo) ||
    b.matchedTerms.length - a.matchedTerms.length ||
    b.score - a.score ||
    b.id.localeCompare(a.id)
  );
}

const corta = (s: string): string =>
  s.length <= RULE_LINE_MAX_CHARS ? s : `${s.slice(0, RULE_LINE_MAX_CHARS - 1)}…`;

/**
 * nexos://decision/recall-formato-compacto-revisa-p1-5 — formato compacto:
 * `- <título> [· <status>] (disclaimer se decisão)\n  source_ref: <ref>` mais,
 * no máximo, UMA linha de regra e, só para decisão ativa, UMA linha extra de
 * condições. NUNCA o record inteiro — `Object.entries(item.fields)` dumpava
 * toda a family `Decision` (título, decision, decision_type,
 * reported_source_ref, decision_applicability, decision_conditions,
 * decision_revocation_reason, decision_work_ref: até 8 linhas por item,
 * ~15 KB/sessão medidos pelo master, e uma decisão REVOGADA saía com o MESMO
 * corpo de uma ativa) — corpo completo é `nexos decision`/`nexos memory
 * --search`, nunca a injeção não solicitada de todo prompt.
 *
 * Revoga a cláusula de escopo de nexos://decision/p1-5-hot-brief que dizia
 * "UserPromptSubmit continua completo" — aquilo delimitava o P1.5
 * (SessionStart), não era regra de produto do dono; SessionStart continua
 * intacto (fora desta função).
 *
 * nexos://decision/recall-continuidade-indice-por-janela — `opcoes.compacto`
 * é a REAPARIÇÃO (Decision já renderizada nesta sessão que volta a qualificar
 * para o prompt atual, ver `reaparecidas` mais abaixo): mesma chave e
 * `source_ref`, mesma linha de regra, mas SEM o disclaimer "(contexto
 * relatado pelo agente; não é grant)" (o usuário já viu na primeira vez) nem
 * `decision_conditions` (detalhe, não o essencial do lembrete). Status
 * (`· active`/`· revoked`) NUNCA some — omitir "revoked" faria uma decisão
 * revogada reaparecer com a cara de ativa, o oposto do que a decisão exige.
 */
function formatarItem(item: PackedItem, opcoes: { readonly compacto?: boolean } = {}): string {
  const titulo = item.title || item.fields.subject || item.sourceRef;
  const status = item.fields.decision_status;
  const disclaimer = opcoes.compacto ? "" : " (contexto relatado pelo agente; não é grant)";

  if (status === "revoked") {
    /** Decisão revogada nunca carrega corpo — só o motivo, curto, da revogação. */
    const linhas = [`- ${titulo} · ${status}${disclaimer}`, `  source_ref: ${item.sourceRef}`];
    const motivo = item.fields.decision_revocation_reason;
    if (motivo && motivo.trim() !== "") linhas.push(`  decision_revocation_reason: ${corta(motivo)}`);
    return linhas.join("\n");
  }

  const linhas = status
    ? [`- ${titulo} · ${status}${disclaimer}`, `  source_ref: ${item.sourceRef}`]
    : [`- ${titulo}`, `  source_ref: ${item.sourceRef}`];

  /** Regra curta: `decision` para decisão ativa (a afirmação em si); `rule` senão `practice` para o resto — a mesma disciplina de sempre. */
  const campo = status ? "decision" : item.fields.rule ? "rule" : "practice";
  const regra = item.fields[campo];
  if (regra && regra.trim() !== "" && regra.trim() !== titulo.trim()) {
    linhas.push(`  ${campo}: ${corta(regra)}`);
  }

  /** Só decisão ativa, só quando presente, e nunca na reaparição compacta: o que MUDA a aplicabilidade original (ex.: "Até revisão explícita") — nunca reconstruído a partir do corpo inteiro. */
  if (status && !opcoes.compacto) {
    const condicoes = item.fields.decision_conditions;
    if (condicoes && condicoes.trim() !== "") linhas.push(`  decision_conditions: ${corta(condicoes)}`);
  }

  return linhas.join("\n");
}

// ─── dedup por sessão ────────────────────────────────────────────────────────

/**
 * Mesma chave dos irmãos (`projectLocator` + `session_id` sanitizado) — ver
 * `state-presentation.ts:presentationCacheFile`. Arquivo PRÓPRIO (não
 * compartilhado): aquele guarda UM id (o head de `project_state`); este
 * guarda uma LISTA (todo `id` de memória já mostrado nesta sessão) — formas
 * de dado incompatíveis, chaves de arquivo distintas.
 *
 * Exportado de verdade (não só via `__testing`): `session-start.ts` precisa
 * dele para limpar o marker em `compact`/`clear` — SessionStart apaga o
 * contexto do modelo, o marker de dedup precisa acompanhar.
 */
export function shownMarkerFile(projectLocator: string, sessionId: string): string {
  const safeSession = sessionId.replace(/[^a-zA-Z0-9_-]/g, "_").slice(0, 128);
  return path.join(os.tmpdir(), `nexos-memory-recall-shown-${projectLocator}-${safeSession}`);
}

/** Fail-safe: qualquer problema devolve conjunto vazio — pior caso é reaparecer, nunca bloquear. */
async function readShownIds(file: string): Promise<Set<string>> {
  try {
    const raw = await readFile(file, "utf-8");
    return new Set(raw.split("\n").map((l) => l.trim()).filter((l) => l.length > 0));
  } catch {
    return new Set();
  }
}

/** Melhor esforço: falha ao escrever custa uma repetição futura, não o adapter. */
async function writeShownIds(file: string, ids: ReadonlySet<string>): Promise<void> {
  try {
    await writeFile(file, [...ids].join("\n"), "utf-8");
  } catch (error) {
    // Não é contrato, mas falha calada reinjeta a mesma memória a cada prompt sem ninguém saber por quê.
    process.stderr.write(`nexos memory-recall: marker de exibidos não gravado — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

// ─── adapter ─────────────────────────────────────────────────────────────────

/**
 * NUNCA lança. Mesma doutrina dos outros adapters de hook do host
 * (`claude-session-close`, `claude-user-prompt-submit`): condição normal vira
 * `SKIPPED`/`EMPTY`, exceção vira `FAILED` reportado — nunca uma promise
 * rejeitada surpreendendo o host.
 * SOMENTE RECALL: nada aqui publica, promove ou corrige record — leitura pura.
 */
// O campo `prompt` do hook difere do texto gravado no transcript (medido 23/09: relatório de
// subagente disparou os hooks mesmo com o cabeçalho no transcript) — por isso também a marca
// da mensagem nos primeiros 400 caracteres, onde quer que o cabeçalho esteja.
// `<cross-session-message from="...">` é o wrapper documentado da ferramenta
// SendMessage ("Your message arrives wrapped as..."), achado HIGH #4 da
// rodada 3 — faltava aqui e nas duas cópias irmãs (`nexos-docs-route.mjs`,
// `nexos-team-route.mjs`). As 3 cópias têm que ficar IDÊNTICAS — ver
// `tests/nao-humano-regex-paridade.test.ts`, fonte única por verificação.
const NAO_HUMANO = /^(?:<task-notification>|<channel\s|Another Claude session sent a message:)|^[\s\S]{0,400}?(?:<agent-message from=|<teammate-message|<cross-session-message from=|\[Subagent hand-back\])/;

export async function runMemoryRecallAdapter(
  input: MemoryRecallHookInput,
  env: NodeJS.ProcessEnv
): Promise<MemoryRecallResult> {
  const { result, persist } = await computeMemoryRecall(input, env);
  await persistirComSeguranca(persist);
  return result;
}

/** Núcleo do adapter — ver `MemoryRecallComputation` para por que `persist` sai separado do `result`. */
async function computeMemoryRecall(
  input: MemoryRecallHookInput,
  env: NodeJS.ProcessEnv
): Promise<MemoryRecallComputation> {
  if (input.hook_event_name !== "UserPromptSubmit") {
    return {
      result: { state: "SKIPPED", reason: `evento não reconhecido: ${JSON.stringify(input.hook_event_name)}` },
      persist: SEM_EFEITO,
    };
  }

  const prompt = typeof input.prompt === "string" ? input.prompt.trim() : "";
  if (prompt === "") {
    return { result: { state: "SKIPPED", reason: "prompt vazio — sem intent não há o que recuperar" }, persist: SEM_EFEITO };
  }
  /**
   * Notificação de tarefa, mensagem de canal (peer) e relatório de subagente
   * chegam como UserPromptSubmit, mas não são o pedido do usuário. MEDIDO 23/09:
   * 169 de 1.250 injeções do hook irmão vinham delas, e cada mensagem do peer
   * trazia ~3k tokens de decisões sem relação. No transcript os três começam
   * pelo prefixo, mas o `prompt` que o hook recebe tem outra forma — por isso
   * NAO_HUMANO também procura a marca da mensagem nos primeiros 400 caracteres.
   */
  if (NAO_HUMANO.test(prompt)) {
    return {
      result: { state: "SKIPPED", reason: "mensagem de tarefa/canal/subagente — recall é para o pedido do usuário" },
      persist: SEM_EFEITO,
    };
  }

  /** MISSING HOST PROJECT BINDING != FALL BACK TO LIVE CWD — mesma razão dos outros host adapters. */
  const projectDir = env.CLAUDE_PROJECT_DIR;
  if (typeof projectDir !== "string" || projectDir.length === 0) {
    return {
      result: { state: "SKIPPED", reason: "CLAUDE_PROJECT_DIR ausente — identidade não vem do cwd do hook" },
      persist: SEM_EFEITO,
    };
  }

  try {
    const resolution = await resolveProject({ cwd: projectDir });

    /** NO CANONICAL CAPSULE != READ ANYWAY (mesmo gate dos irmãos). */
    if (resolution.identitySource !== "manifest" || !resolution.canonicalProjectId) {
      return { result: { state: "SKIPPED", reason: "projeto sem Store — nada a recuperar" }, persist: SEM_EFEITO };
    }

    /**
     * 03e (hot-path, checkpoint chk_01M2QJ99BGH6RW1BFW4NTZ3K27) — mesmo cache
     * de validação por hash de conteúdo que `session-start.ts` já usa
     * (`integrity-cache.ts`): todo record já provado canônico numa leitura
     * anterior (deste processo ou de outro — o cache é do PROJETO, não da
     * sessão) pula parse+validate+serialize inteiros. `readCurrentRecords`
     * com `integrityCache` é o MESMO ponto de leitura que `assembleContext`
     * chamaria sozinho (`preloadedRead`, `context-assembler.ts`) — só troca
     * QUEM lê primeiro, nunca o conjunto de records elegíveis.
     * `includeGlobal: true` replica exatamente o que `assembleContext` já
     * liga por conta própria; omiti-lo mudaria esse conjunto.
     */
    const readRoot = await resolveReadRoot(resolution.rootPath);
    const integrityCache = await loadIntegrityCache(readRoot);
    const preRead = await readCurrentRecords(resolution.rootPath, {
      includeGlobal: true,
      integrityCache,
    });
    /** Melhor esforço, custo real ~0 quando nada mudou (`cache.dirty` de saída) — ver docstring de `saveIntegrityCacheIfDirty`. */
    await saveIntegrityCacheIfDirty(integrityCache);

    /**
     * `excludeKinds: ["project_state"]` — ISOLAMENTO ESTRUTURAL de projeto
     * (G): `assembleContext` lê só `<resolution.rootPath>/.nexos/records`
     * (`readCurrentRecords` → `forProject(root)`), então não há caminho de
     * código daqui para o Store de outro projeto — não é filtro posterior.
     *
     * `preRead.ok === false` cai de volta no caminho sem preload:
     * `assembleContext` faz a MESMA leitura sozinha e produz o MESMO
     * `UNREADABLE`/`detail` de antes desta fatia — falha aqui nunca inventa
     * um erro diferente do que já existia.
     */
    const r = await assembleContext({
      projectRoot: resolution.rootPath,
      intent: prompt,
      budgetBytes: RECALL_BUDGET_BYTES,
      excludeKinds: ["project_state"],
      ...(preRead.ok ? { preloadedRead: { records: preRead.records, anomalies: preRead.anomalies } } : {}),
    });

    /** `CANNOT OBSERVE != DOES NOT EXIST`, mas sem consumidor de erro aqui — FAIL-OPEN EM OBSERVAÇÃO: Store ilegível é "nada a recuperar", não exceção. */
    if (!r.ok) {
      /** Store ilegível é o SKIPPED que mais importa na série: o recall rodou e não pôde ler. */
      await registrarRecuperacao(resolution.rootPath, {
        fonte: "recall",
        estado: "SKIPPED",
        ...(typeof input.session_id === "string" ? { sessao: input.session_id } : {}),
        motivo: `Store ilegível: ${r.detail}`,
      });
      return { result: { state: "SKIPPED", reason: `Store ilegível: ${r.detail}` }, persist: SEM_EFEITO };
    }

    const termosIntent = termosDe(prompt);
    const intentBigramas = bigramasDe(prompt);

    const candidatos = r.pack.items.filter((i) => i.matchedTerms.length > 0);
    const qualificados = candidatos.filter((i) => qualifica(i, intentBigramas, termosIntent));
    qualificados.sort((a, b) => compararRelevanciaTextual(a, b, intentBigramas, termosIntent));
    /** Toda Decision aplicável, casando ou não lexicalmente — é o universo que o índice (abaixo) precisa poder nomear inteiro. */
    const continuity = r.pack.items.filter((i) => i.fields.decision_status);
    /** Decision compete pelo corpo como QUALQUER outro record — nenhum tratamento de kind aqui; `qualifica`/`compararRelevanciaTextual` já a avaliam igual. */
    const top = qualificados.slice(0, RECALL_MAX_ITEMS);

    /**
     * nexos://decision/recall-continuidade-indice-por-janela — continuidade
     * NOMEADA por chave, uma vez por janela de sessão, nunca perdida.
     *
     * O marker (`vistos`) guarda dois tipos de entrada: id "cru" (já
     * RENDERIZADO no corpo desta sessão — dedup comum) e `idx:<id>` (já
     * CONTADO no índice fora do bloco, mesmo sem nunca ter ido ao corpo).
     * `indexadas` é só o segundo grupo. `primeiraChamada` (índice vazio) é a
     * condição em que o índice ainda não apareceu nesta sessão — inclui a
     * sessão sem `session_id` (marker sempre vazio, reemite sempre, mesma
     * doutrina do dedup comum).
     *
     * Nas chamadas seguintes o índice fica em silêncio, mas `mudadas` —
     * toda Decision aplicável cujo id ainda não está `idx:` nem já mostrada —
     * fura a fila e vai para o corpo ANTES do top lexical: Decision nova,
     * revisada (novo id) ou revogada desde a última chamada nunca fica
     * escondida atrás de um índice já visto.
     */
    const sessionId = typeof input.session_id === "string" ? input.session_id : "";
    const marker = sessionId ? shownMarkerFile(resolution.bootstrapLocator, sessionId) : "";
    const vistos = sessionId ? await readShownIds(marker) : new Set<string>();
    const indexadas = new Set([...vistos].filter((id) => id.startsWith("idx:")).map((id) => id.slice(4)));
    const primeiraChamada = indexadas.size === 0;
    /**
     * LINHA DE BASE DA JANELA — `base:<id>`, gravada na primeira chamada para
     * toda Decision que já existia.
     *
     *   NÃO NOMEADA != MUDADA
     *
     * Sem ela, toda Decision que a poda deixou fora do índice caía em
     * `mudadas` na chamada seguinte e ia ao CORPO, cortada pelo orçamento,
     * ligando `CONTINUITY_CONTEXT_INCOMPLETE` a cada prompt. MEDIDO 24/09 numa
     * cópia do Store deste repo (172 Decisions, 10 prompts reais): 58 corpos
     * de Decision e 31 KB nas chamadas 2-10, INCOMPLETE em 9 de 10 — mesmo
     * para "GO". `mudadas` volta a ser o que a decisão
     * recall-continuidade-indice-por-janela diz: nova, revisada (id novo) ou
     * revogada desde a base. A não nomeada continua sendo nomeada — pelo
     * índice, só a chave (`pendentes`, abaixo), não pelo corpo inteiro.
     */
    const base = new Set([...vistos].filter((id) => id.startsWith("base:")).map((id) => id.slice(5)));
    const mudadas = primeiraChamada ? [] : continuity.filter((i) => !indexadas.has(i.id) && !vistos.has(i.id) && !base.has(i.id));
    const pendentes = primeiraChamada ? [] : continuity.filter((i) => base.has(i.id) && !indexadas.has(i.id) && !vistos.has(i.id));
    /** `top` sem quem já entra pela via `mudadas` — evita a mesma Decision contar duas vezes no mesmo turno (nunca mudada+reaparição juntas). */
    const topRestante = top.filter((i) => !mudadas.includes(i));
    /**
     * DISPLAY DEDUPE != RECALL/APPLICATION (dec_01M2R3DA3EP46K0Q77BM75CAFD):
     * `vistos` continua bloqueando gotcha/pattern já mostrados (dedup comum,
     * ver `E`/CONTRAFACTUAL 4 em `claude-memory-recall.test.ts`) — mas uma
     * Decision já renderizada nesta sessão que volta a qualificar para o
     * prompt ATUAL (está em `topRestante`, sinal léxico real de
     * `qualifica()`) não é dropada pelo `!vistos.has(i.id)` de baixo: ela
     * reaparece COMPACTA (`formatarItem(item, { compacto: true })`).
     * `mudadas` já cobre "id novo desde a última chamada"; isto cobre o caso
     * complementar, "mesmo id, prompt novo relevante" — nunca gotcha/pattern
     * (`decision_status` ausente neles).
     */
    const reaparecidas = topRestante.filter((i) => i.fields.decision_status && vistos.has(i.id));
    const corpoItens: { readonly item: PackedItem; readonly compacto: boolean }[] = [
      ...mudadas.map((item) => ({ item, compacto: false })),
      ...topRestante
        .filter((i) => !vistos.has(i.id) || reaparecidas.includes(i))
        .map((item) => ({ item, compacto: reaparecidas.includes(item) })),
    ];

    const linhas: string[] = [];
    const mostrados: string[] = [];
    let usado = 0;
    let incompleto = !!r.pack.continuityIncomplete;
    /** Decision que devia estar no corpo (mudada, top ou reaparição) mas não coube no orçamento — nexos://decision/recall-continuidade-indice-por-janela: NUNCA marcada `idx:`, fica na fila e volta a competir pelo corpo na PRÓXIMA chamada. */
    let cortadas = 0;
    /**
     * PRIORIDADE POR MUDANÇA NÃO PODE ENGOLIR PRIORIDADE POR RELEVÂNCIA.
     *
     *   MUDOU != IMPORTA AGORA
     *
     * `mudadas` fura a fila de propósito (uma Decision nova ou revogada não
     * pode ficar escondida atrás de um índice já visto) e vinha PRIMEIRO num
     * orçamento ÚNICO, sem teto próprio. Consequência medida em 2026-09-22,
     * neste repo com 132 Decisions: o prompt "adicionar um campo styling no
     * mapa" devolveu 9 itens em 4.350 bytes, dos quais 7 não tinham relação
     * nenhuma com a tarefa (hot-brief, statusline ×2, bootstrap, lifecycle,
     * resolver de fronteira, poda P0) — e ainda anunciou "107 decisões
     * alteradas não couberam; seguem no próximo prompt", isto é, uma fila que
     * continua despejando nos turnos seguintes independentemente do que se
     * está fazendo. A memória que casava com o prompt era exatamente a que
     * sobrava de fora.
     *
     * O piso resolve sem tirar a prioridade de ninguém: `mudadas` continua
     * primeiro e continua furando a fila, mas só até
     * `ORCAMENTO_CORPO - PISO_RELEVANCIA`. O que não couber NÃO some — cai no
     * mesmo `cortadas` que já existe, que mantém a Decision fora de `idx:`,
     * na fila, competindo de novo na chamada seguinte. Nada de novo foi
     * inventado: só um teto no que já tinha fila.
     */
    let usadoPorMudadas = 0;
    /**
     * MUDADA E RELEVANTE CONTA COMO RELEVANTE.
     *
     * `topRestante` já EXCLUI quem veio por `mudadas`, então uma Decision que
     * mudou E casa com o prompt existe só na lista de mudadas. Tratá-la como
     * "mudada" para efeito de teto foi o defeito da primeira versão deste
     * piso, medido na hora: o prompt "adicionar um campo styling no mapa"
     * passou de 9 itens para ZERO, porque as que casavam estavam todas em
     * `mudadas` e morreram no teto. O piso existe para barrar mudança
     * IRRELEVANTE, nunca relevância.
     */
    const relevantes = new Set(top.map((i) => i.id));
    for (const { item, compacto } of corpoItens) {
      const texto = formatarItem(item, { compacto });
      const tamanho = Buffer.byteLength(texto, "utf8");
      const ehMudada = mudadas.includes(item) && !relevantes.has(item.id);
      const estouraPiso = ehMudada && usadoPorMudadas + tamanho > ORCAMENTO_CORPO - PISO_RELEVANCIA;
      if (estouraPiso || usado + tamanho > ORCAMENTO_CORPO) {
        /** Memória comum cortada pelo teto é só "não coube" — só Decision truncada é contexto de continuidade incompleto E entra na fila de retry. */
        if (item.fields.decision_status) { incompleto = true; cortadas++; }
        continue;
      }
      linhas.push(texto);
      mostrados.push(item.id);
      usado += tamanho;
      if (ehMudada) usadoPorMudadas += tamanho;
    }
    if (cortadas > 0) {
      linhas.push(`${cortadas} decisões alteradas não couberam; seguem no próximo prompt — \`nexos decision\`.`);
    }

    /**
     * Índice na primeira chamada da janela com todas as Decisions; nas
     * seguintes, só com as `pendentes` (da base, ainda não nomeadas) — quem
     * mudou de verdade já virou corpo acima. `foraNomeadas` é o subconjunto
     * de `fora` que o índice de fato NOMEOU por chave (não o resumo de
     * contagem, abaixo) — só essas podem ganhar `idx:`; o resto volta a
     * competir pelo nome na chamada seguinte.
     */
    const fora = (primeiraChamada ? continuity : pendentes).filter((i) => !mostrados.includes(i.id));
    let foraNomeadas: readonly PackedItem[] = [];
    if (fora.length > 0) {
      const chave = (i: PackedItem): string => i.title || i.sourceRef.replace("nexos://decision/", "");
      const ativas = fora.filter((i) => i.fields.decision_status === "active");
      const grupos = [
        ["restrições", ativas.filter((i) => i.fields.decision_type === "constraint")],
        ["preferências", ativas.filter((i) => i.fields.decision_type === "preference")],
        ["decisões", ativas.filter((i) => i.fields.decision_type === "decision")],
        ["revogadas", fora.filter((i) => i.fields.decision_status === "revoked")],
      ] as const;
      /**
       * PODA POR RELEVÂNCIA — nexos://decision/indice-de-continuidade-poda-por-relevancia
       * (pedido do dono em 2026-09-19).
       *
       *   ÍNDICE NÃO É INVENTÁRIO
       *
       * Medido antes: 81 chaves, 2716 caracteres — 44% do bloco da primeira
       * chamada da janela, contra 690 do bloco de arquivos relevantes, que é
       * a peça que responde à tarefa em mãos. Nomear tudo não ajuda a escolher.
       *
       *   TETO EM GRANDEZA DIFERENTE NÃO COMPÕE
       *
       * O teto que já existia aqui é em BYTES (4096, abaixo). A primeira
       * tentativa pôs um teto em CONTAGEM no mesmo caminho: ele saturava
       * antes e o gatilho do outro nunca mais disparava. Mesma grandeza,
       * então — nomeia por relevância até encher o orçamento de bytes.
       */
      const TETO_NOMES_BYTES = 600;
      const porRelevancia = [...fora].sort((a, b) => compararRelevanciaTextual(a, b, intentBigramas, termosIntent));
      const nomeadas: PackedItem[] = [];
      let bytesUsados = 0;
      for (const item of porRelevancia) {
        const custo = Buffer.byteLength(`${chave(item)}, `, "utf8");
        if (nomeadas.length > 0 && bytesUsados + custo > TETO_NOMES_BYTES) break;
        nomeadas.push(item);
        bytesUsados += custo;
      }
      const restantes = porRelevancia.length - nomeadas.length;
      const nomeadasSet = new Set(nomeadas.map((i) => i.id));
      const indice =
        `Decisões de continuidade fora deste bloco (${fora.length}; corpo em \`nexos decision\`; ausência aqui não é ausência de decisão)` +
        (restantes > 0 ? ` — ${nomeadas.length} mais prováveis para esta tarefa, ${restantes} não nomeadas` : "") +
        " — " +
        grupos
          .map(([nome, xs]) => [nome, xs.filter((i) => nomeadasSet.has(i.id))] as const)
          .filter(([, xs]) => xs.length > 0)
          .map(([nome, xs]) => `${nome}: ${xs.map(chave).join(", ")}`)
          .join(" · ");
      /**
       * Teto de 4096 B do índice inteiro — DEFESA RESIDUAL depois da poda.
       *
       *   RAMO ALCANÇÁVEL != RAMO ALCANÇADO NA PRÁTICA
       *
       * Antes da poda este ramo disparava com muitas chaves (60 de 76
       * caracteres somam 4860 B). Com a poda a ~600 B, muitas chaves nunca
       * mais somam 4096: só dispara se UMA chave sozinha passar de ~3900 B,
       * porque o laço acima garante pelo menos um nome. Nenhuma chave real
       * chega perto — `chave()` é `title` ou o `source_ref` sem prefixo.
       *
       * Fica como defesa contra record patológico, DECLARADA como residual.
       * Quem ler isto não deve supor que protege o caso comum: o caso comum
       * é a poda acima.
       */
      if (Buffer.byteLength(indice, "utf8") <= 4096) {
        linhas.push(indice);
        /**
         *   NÃO NOMEADO != NÃO RECUPERÁVEL
         *
         * Só as EXIBIDAS ganham `idx:`. As podadas não — voltam a competir pelo
         * nome na chamada seguinte (`pendentes`). E `incompleto` NÃO liga por poda: o flag diz "parte
         * dos registros não pôde ser recuperada", e o que ficou de fora está
         * declarado na linha e inteiro em `nexos decision`.
         */
        foraNomeadas = nomeadas;
      } else {
        /** Contagem genérica, NENHUMA chave nomeada — nenhuma delas ganha `idx:` (abaixo), então continuam alcançáveis (corpo ou nova tentativa de índice) em vez de sumir atrás de um resumo que nunca as citou. */
        linhas.push(`Decisões de continuidade fora deste bloco: ${fora.length} — \`nexos decision\`.`);
        incompleto = true;
      }
    }

    if (incompleto) {
      linhas.push("CONTINUITY_CONTEXT_INCOMPLETE: consulte nexos decision; há contexto fora deste bloco. Não conclua que decisões ou revogações estão ausentes.");
    }
    const texto = linhas.length === 0 ? "" : `[NEXOS MEMORY]\n\n${linhas.join("\n\n")}`;
    /**
     * `persist` reúne os dois efeitos que ANTES rodavam aqui, na hora — ver
     * `MemoryRecallComputation` para por que agora só o CHAMADOR decide
     * quando é seguro rodá-los (depois do stdout, no entrypoint real).
     */
    const persist = async (): Promise<void> => {
      /**
       * Marca `idx:` SÓ quem foi renderizado nominalmente nesta chamada —
       * corpo (`mostrados`) ou chave citada no índice (`foraNomeadas`). Uma
       * Decision cortada pelo orçamento do corpo, ou perdida no resumo de
       * contagem do índice, NUNCA entra aqui — é exatamente o que a mantém na
       * fila (`mudadas`/`fora` na próxima chamada) em vez de desaparecer para
       * sempre atrás de um `idx:` que ela nunca mereceu.
       */
      if (sessionId) {
        const nomeadas = [...mostrados, ...foraNomeadas.map((i) => i.id)];
        const linhaDeBase = primeiraChamada ? continuity.map((i) => `base:${i.id}`) : [];
        await writeShownIds(marker, new Set([...vistos, ...mostrados, ...nomeadas.map((id) => `idx:${id}`), ...linhaDeBase]));
      }
      /**
       * O PRODUTOR QUE FALTAVA. Até aqui o recall recuperava, injetava e não
       * deixava rastro — `knowledge retrieved` e `context injected` eram dois
       * dos quatro sinais de aprendizado sem produtor nenhum no código.
       *
       *     RECUPERAR SEM REGISTRAR NÃO DEIXA NADA PARA MEDIR
       *
       * Registra o `EMPTY` também: saber que o recall rodou com 4 termos e 12
       * candidatos e mesmo assim não injetou nada é tão informativo quanto
       * saber o que ele injetou.
       *
       *     SILÊNCIO NÃO PODE SIGNIFICAR DUAS COISAS
       *
       * Melhor esforço por construção (`registrarRecuperacao` engole tudo): este
       * é o caminho mais quente do produto e telemetria não derruba hook.
       */
      await registrarRecuperacao(resolution.rootPath, {
        fonte: "recall",
        estado: linhas.length === 0 ? "EMPTY" : "RECALL",
        ...(sessionId ? { sessao: sessionId } : {}),
        termos: termosIntent.size,
        candidatos: candidatos.length,
        mostrados,
        nomeados: foraNomeadas.map((i) => i.id),
        bytes: Buffer.byteLength(texto, "utf-8"),
      });
    };

    return {
      result: linhas.length === 0 ? { state: "EMPTY" } : { state: "RECALL", text: texto },
      persist,
    };
  } catch (error) {
    return {
      result: { state: "FAILED", reason: error instanceof Error ? error.message : String(error) },
      persist: SEM_EFEITO,
    };
  }
}

/**
 * Entrypoint do hook. stdout carrega SOMENTE o bloco `[NEXOS MEMORY]` (vazio
 * em EMPTY/SKIPPED/FAILED) — sem memória relevante, 0 bytes, silêncio
 * absoluto. Diagnóstico de FAILED vai para stderr. Exit SEMPRE 0: não existe
 * fallback de host que dependa do exit code aqui (ao contrário de
 * `claude-user-prompt-submit`, que decide entre Store e `state.md` legado) —
 * FAIL-OPEN EM OBSERVAÇÃO.
 */
export async function claudeMemoryRecall(): Promise<void> {
  let input: MemoryRecallHookInput;
  try {
    const parsed: unknown = JSON.parse(await readStdin());
    if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) return;
    input = parsed as MemoryRecallHookInput;
  } catch {
    return;
  }

  const { result, persist } = await computeMemoryRecall(input, process.env);
  if (result.state === "RECALL") {
    process.stdout.write(result.text);
  } else if (result.state === "FAILED") {
    process.stderr.write(`[nexos claude-memory-recall] ${result.reason}\n`);
  }
  /**
   * H3 REABERTO (rodada 2) — o que de fato protege contra o kill de
   * `nexos-budget.sh` no meio de `persist()` NÃO é a ordem acima (ver
   * `MemoryRecallComputation`): é este sinal. Sem ele, `$dir/out` já
   * completo é descartado do mesmo jeito no timeout, porque o wrapper só
   * sabe que o filho ainda estava "rodando" quando foi morto.
   */
  sinalizarStdoutCompleto();
  await persistirComSeguranca(persist);
}

async function readStdin(): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of process.stdin) {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  }
  return Buffer.concat(chunks).toString("utf-8");
}

/**
 * Exportado só para os testes (não é API pública do produto): marker de
 * dedup (`shownMarkerFile`) e as duas peças do desempate textual
 * (`bigramasDe`, `compararRelevanciaTextual`) — o contrafactual "sem o tier
 * de frase exata no título" precisa acionar o comparador real, não uma
 * reimplementação no teste.
 *
 * `computeMemoryRecall` NÃO sai mais daqui (H3 reaberto, rodada 2): um teste
 * que só confere "result antes de persist, dentro do processo" prova uma
 * premissa falsa — sob `nexos-budget.sh` real o stdout do filho vai para um
 * arquivo que só é repassado se ele sair a tempo, então a ordem interna
 * nunca foi suficiente. A prova real mora em
 * `tests/hook-budget-h3.test.ts`, rodando `claudeMemoryRecall` como processo
 * de verdade sob o wrapper real.
 *
 * `persistirComSeguranca` (N3, rodada 2) sai daqui para o teste provar
 * diretamente que um `persist` que lança NUNCA propaga — contrato "nunca
 * lança" dos dois chamadores, sem precisar reconstruir um `persist` real.
 */
export const __testing = { shownMarkerFile, bigramasDe, compararRelevanciaTextual, persistirComSeguranca, writeShownIds };
