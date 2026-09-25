/**
 * N2 — ContextAssembler v1.
 *
 *   NEXOS KNOWS N → TASK NEEDS K → MODEL SEES K
 *
 * Retrieval determinístico sobre os records canônicos. Sem embeddings, sem
 * vector DB: nada disso foi justificado por medição, e um baseline exato é o
 * que permite medir se algo mais caro vale a pena depois.
 *
 * Host-neutral por construção — não conhece Claude, hooks nem SessionStart.
 * O ciclo de vida específico do host mora no adapter.
 *
 * Cada item empacotado responde WHY WAS I INCLUDED?. Um pack sem essa resposta
 * é indistinguível de um despejo de arquivos, e foi assim que 122 KB de regras
 * chegaram ao modelo sem ninguém saber por quê.
 */
import { readCurrentRecords, contentOf, scopeOf, resolveCheckpointHead, checkpointWorkContext, type CurrentRecord, type Anomaly } from "./capsule/reader.js";
import type { RecordFamily } from "./capsule/ids.js";

/** Orçamento padrão. O SessionBrief inteiro cabe em 12 KB (SESSION_BRIEF_MAX_BYTES). */
export const DEFAULT_CONTEXT_BUDGET_BYTES = 8 * 1024;

export interface AssembleRequest {
  projectRoot: string;
  /** O que a sessão/tarefa vai fazer. Vazio = boot genérico. */
  intent?: string;
  budgetBytes?: number;
  families?: readonly RecordFamily[];
  /**
   * Kinds excluídos deste pack, mesmo que pontuem. Complementa `families`
   * quando o corte precisa ser por `kind`, não por family: `project_state`
   * divide a family `KnowledgeRecord` com `gotcha`/`pattern`/`architecture`,
   * então `families` sozinho não consegue isolar um sem o outro.
   *
   *   FAMILY-LEVEL FILTER != KIND-LEVEL FILTER
   *
   * Default vazio: boot e checkpoint continuam intactos, byte a byte — só um
   * consumidor que passe isto explicitamente muda de comportamento.
   */
  excludeKinds?: readonly string[];
  /**
   * T5 (plano de memória em camadas v3.2, §4.4) — o checkpoint/sessão ATIVOS
   * desta chamada. Sem eles, nenhum record `scope.kind: "task"`/`"session"`
   * entra: `null` (o default) satisfaz R16/R17 de forma trivial e
   * fail-closed, porque a elegibilidade abaixo checa a referência ANTES de
   * pontuar, nunca depois. `resumeCheckpoint` (`checkpoint.ts`) é o único
   * chamador que hoje passa `activeTaskRef` (o head resolvido da chain).
   * `activeSessionRef` fica `null` em todo chamador — zero records `session`
   * existem ainda (0.contagens), então propagar o `session_id` por
   * `buildSessionBriefForCwd`/`assembleKnowledge` não tem consumidor real
   * hoje (ver §4.4, ponytail).
   */
  activeTaskRef?: string | null;
  activeSessionRef?: string | null;
  /**
   * 03c (host event observation, continuação) — leitura JÁ FEITA de
   * `readCurrentRecords` para as MESMAS `families` desta requisição. Quando
   * fornecida, `assembleContext` NÃO chama `readCurrentRecords` de novo.
   *
   *   ONE FAMILY READ PER SESSIONSTART · NOT ONE PER CONSUMER
   *
   * Existe para o SessionStart compartilhar UMA leitura de `KnowledgeRecord`
   * entre conhecimento (aqui), o head de `project_state`
   * (`host/state-presentation.ts`) e o prime de apresentação
   * (`host/claude/session-start.ts`) — medido: as três liam a MESMA family
   * de forma independente, e o custo do boot era ~2,4s de I/O redundante em
   * vez de ~1,4s de uma leitura só. Nenhum OUTRO consumidor de
   * `assembleContext` (`memory-recall.ts`, `checkpoint.ts`, `memory.ts`)
   * precisa disto, e por isso é opcional e aditivo — omitido, o
   * comportamento é BYTE A BYTE o de antes.
   */
  preloadedRead?: { readonly records: readonly CurrentRecord[]; readonly anomalies: readonly Anomaly[] };
}

export interface PackedItem {
  sourceRef: string;
  /**
   * `id` do record admitido (ULID, `capsule/ids.ts`) — muda a cada revisão
   * (`publishSuperseding`), mesmo com `sourceRef` intacto. `SOURCE_REF
   * IDENTIFIES THE HEAD != ID IDENTIFIES THE REVISION`: um consumidor que
   * precise saber "já mostrei ESTA revisão nesta sessão" (dedup por
   * sessão de `claude-memory-recall`) não tem outro campo aqui que sirva —
   * `sourceRef` sozinho reaprovaria uma revisão nova como "já vista".
   */
  id: string;
  family: RecordFamily;
  kind: string;
  title: string;
  /** Campos do record que entraram, já cortados ao orçamento. */
  fields: Record<string, string>;
  bytes: number;
  score: number;
  /** WHY WAS I INCLUDED — legível por humano, derivado do cálculo real. */
  why: string;
  /**
   * Os termos do intent que realmente casaram. `why` os RESUME e trunca em 4;
   * este campo é o cálculo, não a prosa.
   *
   *   MATCH REASON AS PROSE != MATCH REASON AS DATA
   *
   * Vazio significa "entrou sem sinal de intent" (boot genérico, ou bônus de
   * `PESO_KIND` sozinho). Quem precisa distinguir "casou com o assunto" de
   * "entrou por ser o estado do projeto" lê isto — não faz parsing de `why`.
   */
  matchedTerms: readonly string[];
  /**
   * Proveniência do envelope, junto do item.
   *
   *   RETRIEVED WITHOUT PROVENANCE == GUESS
   *
   * `sourceRef` sozinho diz ONDE o texto morava; não diz QUEM o publicou nem de
   * que projeto ele é. Sem os dois, um item recuperado é indistinguível de uma
   * frase inventada com o formato certo — e o Store existe exatamente para
   * tornar essa distinção possível.
   */
  producerId: string;
  projectId: string;
  evidenceRefs: readonly string[];
}

export interface ContextPack {
  projectRoot: string;
  intent: string;
  budgetBytes: number;
  usedBytes: number;
  items: PackedItem[];
  /**
   * Heads que existiam e NÃO couberam/pontuaram/venceram. Omitir seria mentir
   * por silêncio. `OVERRIDDEN_BY_PROJECT` (T6, §4.3) — um GLOBAL suprimido por
   * um PROJECT de mesma chave (family, kind, subject_ref) DECLARADA; marcação,
   * nunca filtro silencioso.
   */
  omitted: { sourceRef: string; reason: "BUDGET" | "NO_SIGNAL" | "OVERRIDDEN_BY_PROJECT" }[];
  /** Partições anômalas do Store. Nunca escondidas do consumidor. */
  anomalies: { sourceRef: string; state: string }[];
  /** Decisões aplicáveis ausentes do corpo por orçamento/anomalia; nunca omissão silenciosa. */
  continuityIncomplete?: boolean;
}

export type AssembleResult =
  | { ok: false; reason: "UNREADABLE"; detail: string }
  | { ok: true; pack: ContextPack };

/**
 * Campos INJETADOS no pack, na ordem em que importam.
 *
 *   INDEXED FOR SEARCH != INJECTED INTO THE BRIEF
 *
 * Esta lista tem DOIS consumidores e eles querem coisas opostas: `empacotar()`
 * a usa para montar `fields` (cada campo aqui custa bytes do orçamento em TODO
 * record que o tenha), e `textoDoRecord()` a usava para montar o texto do match
 * — onde campo a mais é grátis, porque nada disso viaja. Enquanto foi uma lista
 * só, "tornar um kind buscável" e "engordar o brief" eram a mesma edição.
 *
 * TETO: no máximo UM campo por kind entra aqui — o que CARREGA a afirmação
 * (`rule` no gotcha, `practice` no pattern, `model` no architecture; `subject`
 * acompanha por ser o título que o `architecture` não tem). Campo de apoio
 * (`context`, `applicability`, `expected_effect`, `evidence`) vai para
 * `CAMPOS_INDEXADOS` e para lugar nenhum mais.
 *
 * Medido contra o Store real (253 knowledge heads, boot sem intent, brief de
 * 12 KB): pôr os 7 campos de pattern/architecture TAMBÉM na injeção derruba o
 * brief de 4 corpos / 10410 B para 3 corpos / 9636 B — `evidence` sozinho
 * engorda os 126 gotcha e expulsa um corpo inteiro. A separação abaixo entrega
 * os 3 kinds buscáveis com o brief intacto em 4 corpos / 10410 B.
 */
export const CAMPOS_UTEIS = [
  "title",
  /** `project_state` — o que a sessão seguinte precisa antes de tudo. */
  "current_state",
  /**
   * O irmão de `current_state` que ficou de fora até 2026-08-29: já é campo
   * canônico de `project_state` (`ProjectStateSchema`, `capsule/schemas.ts`),
   * `nexos state` já o lê e mostra (`commands/state.ts`) — só nunca tinha
   * chegado ao brief porque não estava nesta lista. Exceção pontual
   * autorizada pelo dono: não cria dado nem schema novo, e a ausência dele
   * impedia a linha `Objetivo:` no boot (`buildAdditionalContext`,
   * `host/claude/session-start.ts`).
   */
  "global_goal",
  "next_action",
  "blocker",
  /**
   * Os QUATRO campos do eixo WORK viajam, não dois.
   *
   *   THE AXIS HAS FOUR BRANCHES; THE BRIEF CARRIED TWO
   *
   * `ProjectStateSchema` define `next_action`, `blocker`, `decision_question` e
   * `complete`, e `resolveWorkState` decide entre eles pela precedência
   * `BLOCKED > HUMAN_DECISION_REQUIRED > COMPLETE > CONTINUE`. Até 2026-08-28 o
   * brief só transportava os dois primeiros — medido ao simular o boot de uma
   * sessão limpa: o Store dizia COMPLETE, `nexos state` mostrava, e o brief
   * chegava sem o campo.
   *
   * O caso grave é `decision_question`: é justamente o campo que diz "parei
   * esperando um humano decidir". Sem ele no brief, a sessão seguinte retoma
   * como se nada estivesse pendente — e a pergunta que motivou a parada some
   * exatamente no momento em que deveria ser feita de novo.
   */
  "decision_question",
  "complete",
  "last_verified",
  "failure_mode",
  "rule",
  "decision",
  "decision_status",
  "decision_type",
  "reported_source_ref",
  "decision_applicability",
  "decision_conditions",
  "decision_revocation_reason",
  "decision_work_ref",
  "cause",
  "mitigation",
  "prevention",
  "consequence",
  "trigger",
  /**
   * `architecture` não tem `title` no schema — `subject` é o título dele.
   * `model` e `practice` são as afirmações de `architecture` e `pattern`.
   * Sem ao menos UM campo destes, `empacotar()` monta `fields` vazio e
   * descarta o record como NO_SIGNAL: gravado e irrecuperável.
   */
  "subject",
  "model",
  "practice",
  /**
   * `Research` também não tem `title`: `question` faz o papel dele e
   * `findings` carrega a afirmação. Sem os dois, `nexos research` publicava e
   * `memory --search`/recall descartavam como NO_SIGNAL (medido em 25/09 com
   * `rsh_01M3CR1Q615GX7C71G9PAEQCCM`). `sources` é array e `contentOf` já o
   * descarta, então as fontes nunca viajam no pack.
   */
  "question",
  "findings",
] as const;

/**
 * Campos que entram no texto do MATCH e em lugar nenhum mais. Custo zero de
 * orçamento — `textoDoRecord()` não viaja para o pack.
 *
 * TETO: só campo de kind que ESTAVA cego. `evidence` fica de fora de propósito
 * — é o único campo de apoio que os 126 `gotcha` do Store real também têm, e
 * gotcha nunca esteve cego. Medido: com `evidence` indexado, a consulta
 * "receita de bolo de cenoura com cobertura de chocolate" passava de 7 para 8
 * resultados (o oitavo casa "cobertura" dentro de "Cobertura de teste do repo",
 * na evidência de um gotcha). Match legítimo, mas é recall NOVO em record que
 * já era recuperável — `FIX THE BLIND KIND != WIDEN EVERY KIND`. Com esta
 * lista, a busca sobre gotcha/project_state/Decision é idêntica byte a byte à
 * de antes da correção, e só `pattern`/`architecture` mudam de comportamento.
 */
const CAMPOS_INDEXADOS = [
  ...CAMPOS_UTEIS,
  "context",
  "expected_effect",
  "applicability",
] as const;

/**
 * `project_state` é o que responde "onde paramos". Vem primeiro em qualquer
 * boot, mesmo sem sinal de intent — um brief que gasta o orçamento com gotchas
 * e corta o estado não retoma trabalho.
 */
const PESO_KIND: Readonly<Record<string, number>> = { project_state: 100 };

/**
 * Kinds que são PROPOSTA, nunca conhecimento ativo. Ficam fora do contexto até
 * que alguém os admita — admissão é ato, não consequência de serem lidos.
 */
const PROPOSTA_KINDS: ReadonlySet<string> = new Set(["bootstrap_proposal", "memory_candidate"]);

/**
 * Piso reservado do orçamento para `kind: gotcha` — conhecimento operável
 * (falha, causa, regra, prevenção), o único kind com consumidor medido além de
 * `project_state`. `pattern`/`architecture` ficam de fora: zero records, `NO
 * CONSUMER → NO FLOOR`.
 *
 * Medido: sem piso, no boot sem intent todo record vale score 1 (só
 * `project_state` tem bonus). `Decision` empacota mais barato — `contentOf`
 * descarta `consequences` (array) e só sobra `title`+`decision`, 165–525 B — e
 * o desempate por `source_ref` favoreceu 68 Decisions sobre 19 gotchas só por
 * começarem com `.`. Resultado: 24 itens, ZERO gotcha.
 *
 * O piso corrige isso por `kind`, nunca por forma de string
 * (`SOURCE_REF LEXICAL SHAPE != RELEVANCE SIGNAL`): uma fatia do orçamento é
 * tentada primeiro só com candidatos `gotcha` já qualificados (score > 0) pelo
 * `pontuar()` — records irrelevantes ao intent nunca chegam aqui,
 * então o piso não pode "inundar" o contexto (`MEMORY AVAILABLE != MEMORY
 * ALWAYS INJECTED`). Sobra de piso não gasta (poucos gotchas, ou nenhum) volta
 * para o orçamento geral na fatia seguinte — não é orçamento a mais, é o mesmo
 * orçamento com uma reserva mínima que ninguém mais pode gastar primeiro.
 */
/**
 * Medido contra o Store REAL deste repo (78 Decision, 22 gotcha, boot sem
 * intent, orçamento default 8192 do knowledgeBudget):
 *
 *   fração  gotcha  Decision   custo marginal do gotcha extra
 *   0.20      2        19      —
 *   0.25      3        18      +1 gotcha / -1 Decision
 *   0.33      4        15      +1 gotcha / -3 Decision
 *
 * A taxa piora depois de 0.25 — gotcha carrega mais campos (failure_mode +
 * rule + prevention) que Decision (title + decision), então cada fatia
 * adicional de piso desloca Decision cada vez mais rápido. 0.25 é o ponto
 * antes desse custo acelerar, não um valor de gosto.
 */
const GOTCHA_FLOOR_FRACTION = 0.25;

const STOPWORDS = new Set([
  "a","o","as","os","de","da","do","das","dos","e","em","no","na","nos","nas","um","uma",
  "para","por","com","que","se","ao","à","é","the","of","to","and","in","for","on","is","it",
  /**
   * G2.1 (`docs/pos-mvp-matriz-capabilities.md` §2) — a lista acima cobria só
   * artigo/preposição PT + função EN; faltava a classe fechada de conjunção,
   * pronome comum e advérbio PT de alta frequência — "nao"/"não" era o
   * exemplo medido (`nexos memory --search "hono mapper framework nao
   * reconhecido"` casava 4 Decisions sem relação). Entradas SEM acento: o
   * texto já chega sem diacrítico em `termosDe` (NFD strip acima) antes de
   * comparar aqui — uma entrada acentuada nunca bateria com nada (mesmo caso
   * já presente em "à"/"é" logo acima).
   */
  "nao","sem","mais","muito","tambem","isso","isto","essa","esse","esta","este",
  "quando","onde","como","mas","ou","ja","so","foi","ser","estar",
  "seu","sua","seus","suas","pelo","pela","pelos","pelas","num","numa",
  "nem","entre","ate","depois","antes","entao","assim","cada",
  "todo","toda","todos","todas","aqui","ali","voce",
  "eles","elas","meu","minha","meus","minhas","nosso","nossa","nossos","nossas",
  "dele","dela","deles","delas","aquele","aquela","aqueles","aquelas",
  "tudo","algo","outro","outra","outros","outras","mesmo","mesma",
  /**
   * Terceira leva — INTERROGATIVAS e VERBOS VAZIOS.
   *
   *   UM TERMO EM COMUM NÃO É RELEVÂNCIA
   *
   * MEDIDO em 2026-09-19 com controle negativo: o prompt "qual a receita de
   * bolo de cenoura com cobertura" — assunto sem nenhuma relação com este
   * projeto — recuperava memória, porque casava `qual` (interrogativa) e
   * `cobertura` (homônimo de cobertura de testes). Dois termos bastam para
   * `qualifica()` em `memory-recall.ts:175`, e ali dois termos genéricos
   * valem tanto quanto dois específicos.
   *
   * `ter` e `nada` vinham do mesmo problema em "vou afirmar que a correção
   * funcionou sem ter rodado nada": casavam e traziam records sem relação
   * com verificação, que era o conceito real do prompt.
   *
   * Classe fechada: interrogativa nunca discrimina assunto, e verbo de
   * suporte (`ter`, `fazer`, `ir`) aparece em qualquer frase. O homônimo
   * (`cobertura`) NÃO se resolve por lista — sobra 1 termo e `qualifica`
   * passa a exigir sinal forte de frase, que é o comportamento correto.
   */
  "qual","quais","quem","porque","porquê","quanto","quanta","quantos","quantas",
  "ter","tem","tinha","fazer","faz","fez","vai","vou","vamos","pode","posso",
  "quero","preciso","deve","devo","poderia","queria","nada","alguma","algum",
  "alguns","algumas","sobre","dentro","fora","ainda","agora","hoje","ontem",
]);

/**
 * Termos significativos, minúsculos, sem acento, sem duplicata.
 *
 * `-` é separador, não caractere de token — MEDIDO contra o Store real: a
 * chave de uma Decision (`title`, ex. "p1-0-remover-authorization-layer",
 * "mvp-boot-nunca-adota") é o único lugar onde o slug carrega palavras PT/EN
 * de verdade separadas por hífen, e o regex antigo ([a-z0-9_.-]) engolia o
 * slug inteiro como UM token — nunca igual a nenhuma palavra solta da
 * pergunta do usuário, então a chave nunca contribuía para `matchedTerms`
 * nem para os tiers de título em `compararRelevanciaTextual`
 * (`memory-recall.ts`). Dois chamadores (`graph-query.ts:417,498`) já
 * convertiam "-" em espaço ANTES de chamar `termosDe` para contornar
 * exatamente isto — o comportamento novo é o que already assumiam, então o
 * pre-processamento deles vira redundante (idempotente), nunca quebrado.
 * `.` continua dentro do token — versão/IP (`v1.2.3`, `127.0.0.1`) não é o
 * problema medido, e widen além do necessário não tem consumidor.
 */
export function termosDe(texto: string): Set<string> {
  const norm = texto
    .normalize("NFD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase();
  return new Set(
    [...norm.matchAll(/[a-z0-9_][a-z0-9_.]{2,}/g)]
      .map((m) => m[0])
      .filter((t) => !STOPWORDS.has(t))
  );
}

function textoDoRecord(r: CurrentRecord): string {
  const c = contentOf(r.record);
  return [r.sourceRef, ...CAMPOS_INDEXADOS.map((k) => c[k] ?? "")].join(" ");
}

/**
 * Score determinístico e explicável.
 *
 * Sem intent, todo head vale o mesmo (boot genérico): a ordem é a estável do
 * reader, não um ranking inventado. Com intent, o sinal é sobreposição EXATA de
 * termos — nada de similaridade aproximada, que aqui produziria "relevante"
 * sem ninguém conseguir dizer por quê.
 */
function pontuar(
  r: CurrentRecord,
  termosIntent: Set<string>
): { score: number; why: string; matched: string[] } {
  const bonus = PESO_KIND[(r.record as { kind?: string }).kind ?? ""] ?? 0;
  if (termosIntent.size === 0) {
    return {
      score: 1 + bonus,
      why: bonus > 0 ? "estado atual do projeto" : "boot: head canônico atual do projeto",
      matched: [],
    };
  }
  const termosRecord = termosDe(textoDoRecord(r));
  const comuns = [...termosIntent].filter((t) => termosRecord.has(t));
  if (comuns.length === 0 && bonus === 0) {
    return { score: 0, why: "sem termo em comum com o intent", matched: [] };
  }
  if (comuns.length === 0) return { score: bonus, why: "estado atual do projeto", matched: [] };
  return {
    score: comuns.length + bonus,
    why:
      (bonus > 0 ? "estado atual do projeto · " : "") +
      `${comuns.length} termo(s) do intent: ${comuns.slice(0, 4).join(", ")}`,
    matched: comuns,
  };
}

const bytes = (s: string): number => Buffer.byteLength(s, "utf8");

/**
 * `created_at` do envelope, como epoch — inválido/ausente vira 0 (nunca
 * derruba a ordenação, só perde o desempate por recency e cai no lexical).
 */
function criadoEm(r: CurrentRecord): number {
  const t = Date.parse(r.record.created_at);
  return Number.isFinite(t) ? t : 0;
}

/**
 * Desempate quando `pontuar()` já esgotou o que pode decidir sozinho — o caso
 * REAL do boot, onde não há intent (`session-start.ts` nunca passa um) e todo
 * record fora de `project_state` empata em score 1.
 *
 *   SOURCE IDENTIFIER != RELEVANCE SIGNAL
 *
 * Medido contra o Store real deste repo (script A4-bis, ver PR): copiando o
 * Store duas vezes e trocando SÓ a forma do `source_ref` (mesmo kind, mesmo
 * conteúdo, mesmo `created_at`) —
 *
 *   ORIGINAL    itens=22  gotcha=3  decision=18  bytes=8115
 *   INVERTIDO   itens=9   gotcha=8  decision=0   bytes=7764
 *
 * — o desempate lexical de `source_ref` decidia SOZINHO quem entrava, porque
 * `source_ref` é um identificador gerado por máquina (path de origem da
 * migração), não um sinal de relevância.
 *
 * `created_at` substitui isso como PRIMEIRO desempate: sem sinal de intent,
 * conhecimento mais NOVO é a aposta defensável — é o que a sessão mais
 * recente registrou.
 *
 * NÃO é o `RECENCY != AUTHORITY` do `head-resolver.ts`: lá "recency"
 * escolheria qual record É o conhecimento atual entre CANDIDATOS AO MESMO
 * `source_ref` — proibido, a autoridade vem da topologia de `supersedes`.
 * Aqui os `source_ref` já são todos DIFERENTES (o head de cada um já foi
 * resolvido); a pergunta não é "qual é o atual", é "entre vários atuais
 * igualmente relevantes, qual entra primeiro no orçamento" — ranking, não
 * autoridade.
 *
 * O ÚLTIMO desempate NÃO é `sourceRef.localeCompare` — foi, até ser medido
 * contra o Store real: a C12 publicou 78 Decision em LOTE, colapsadas em só
 * 10 `created_at` DISTINTOS (grupos de até 10 registros idênticos ao
 * milissegundo). DENTRO do lote `created_at` empata, e o desempate cai de
 * volta no que sobrar — se isso for `source_ref`, a inversão lexical que o
 * `created_at` foi introduzido para matar (ver A4-bis) simplesmente volta a
 * valer dentro de cada lote. Medido sintético: 20 records com `created_at`
 * empatado, metade `source_ref` iniciando em "a", metade em "z" — invertendo
 * qual metade leva qual prefixo troca 100% de quem vence, com orçamento
 * apertado (ver A4-ter).
 *
 * `id` substitui `source_ref` aqui: é ULID (`ids.ts`) — 10 chars de timestamp
 * + 16 chars aleatórios, Crockford base32 com alfabeto em ordem estritamente
 * crescente (`0-9A-HJKMNPQRSTVWXYZ`), então a comparação lexicográfica do id
 * já ordena por instante de criação do RECORD, e o sufixo aleatório é
 * independente da forma do `source_ref` — exatamente a invariante que
 * faltava. Continua determinístico (o id não muda entre execuções) e só
 * empata de verdade se dois records diferentes colidirem em id, o que a
 * aleatoriedade de 80 bits torna desprezível.
 */
function comparar(
  a: { score: number; sourceRef: string },
  b: { score: number; sourceRef: string },
  recenciaDe: (sourceRef: string) => number,
  idDe: (sourceRef: string) => string
): number {
  return (
    b.score - a.score ||
    recenciaDe(b.sourceRef) - recenciaDe(a.sourceRef) ||
    idDe(a.sourceRef).localeCompare(idDe(b.sourceRef))
  );
}

/**
 * T5 (§4.4) — elegibilidade por escopo, avaliada ANTES de pontuar (chamada de
 * dentro do `.filter()` de `candidatos`, abaixo). Um record inelegível não é
 * despontuado: ele nunca chega ao `.map(pontuar)`, então nunca compete por
 * orçamento — "nem no ranking" exige isso, filtrar DEPOIS de pontuar já
 * teria gasto o cálculo à toa.
 *
 *   global   -> elegível em qualquer projeto (é a composição que T5 liga)
 *   project  -> elegível só no projeto atual — JÁ é estrutural (reader.ts,
 *              a partição do próprio root), nenhum check de ref aqui
 *   task     -> SOMENTE scope.ref === activeTaskRef (R16)
 *   session  -> SOMENTE scope.ref === activeSessionRef (R17)
 *
 * `activeTaskRef`/`activeSessionRef` nulos reprovam TODO record task/session,
 * mesmo que o record também carregue `ref: null` (schema não permite, mas o
 * check é explícito em vez de confiar nisso) — R16/R17 são "nenhum entra sem
 * referência ativa", não "null casa com null".
 *
 * `scopeOf` lança `LEGACY_SCOPE_UNRESOLVED` só para a string legada
 * `"session"` (zero records medidos, `13_MEMORY_SCOPE_LAYERED_DECISION.md`
 * §1.2.1) — trata como o legado `"project"`/`"host"` que sempre foi elegível
 * aqui, em vez de propagar uma exceção nova para um ramo que a leitura já
 * teria fail-closed em outro lugar se fosse real.
 */
function elegivel(
  record: CurrentRecord["record"],
  activeTaskRef: string | null,
  activeSessionRef: string | null
): boolean {
  let scope: ReturnType<typeof scopeOf>;
  try {
    scope = scopeOf(record);
  } catch {
    return true;
  }
  switch (scope.kind) {
    case "global":
    case "project":
      return true;
    case "task":
      return activeTaskRef !== null && scope.ref === activeTaskRef;
    case "session":
      return activeSessionRef !== null && scope.ref === activeSessionRef;
  }
}

/**
 * `scope.kind` do record, ou `null` se `scopeOf` não conseguir resolver
 * (legado `"session"`, `LEGACY_SCOPE_UNRESOLVED`) — nunca "project" nem
 * "global" por definição, então cai fora dos dois lados da supressão abaixo
 * sem lançar.
 */
function escopoKind(record: CurrentRecord["record"]): ReturnType<typeof scopeOf>["kind"] | null {
  try {
    return scopeOf(record).kind;
  } catch {
    return null;
  }
}

/**
 * T6 (§4.3) — chave de supressão GLOBAL vs PROJECT: `(family, kind,
 * subject_ref)` DECLARADO. Nenhum texto entra — nem `fact`, título, embedding
 * ou similaridade (R4): a chave só lê três campos estruturais do envelope,
 * nunca `content`. `null` quando o record não declarou `subject_ref` —
 * unkeyed (R8, I20): nunca suprime, nunca é suprimido, porque nunca produz
 * chave para comparar.
 */
function chaveDeAssunto(record: CurrentRecord["record"]): string | null {
  const subjectRef = record.subject_ref;
  if (!subjectRef) return null;
  const kind = (record as { kind?: string }).kind ?? "";
  return `${record.family}\x00${kind}\x00${subjectRef}`;
}

export async function assembleContext(req: AssembleRequest): Promise<AssembleResult> {
  const budget = req.budgetBytes ?? DEFAULT_CONTEXT_BUDGET_BYTES;
  const intent = req.intent?.trim() ?? "";
  const excludedKinds = new Set(req.excludeKinds ?? []);
  const activeTaskRef = req.activeTaskRef ?? null;
  const activeSessionRef = req.activeSessionRef ?? null;

  /**
   * T5 (§4.1) — `includeGlobal: true` é ligado AQUI, e só aqui:
   * `assembleContext` é o funil dos quatro consumidores de contexto
   * (`memory-recall.ts`, `bootstrap-context.ts`, `checkpoint.ts`,
   * `memory.ts`). Escrita nunca vê global; leitura de contexto sempre vê.
   *
   * `req.preloadedRead` (03c) pula esta leitura — ver o campo na definição
   * de `AssembleRequest` acima. O chamador que preenche isto é responsável
   * por ter lido com o MESMO `families`/`includeGlobal:true`; este módulo
   * não confere de novo (confiaria duplamente na mesma garantia).
   */
  const leitura = req.preloadedRead
    ? ({ ok: true, records: req.preloadedRead.records, anomalies: req.preloadedRead.anomalies } as const)
    : await readCurrentRecords(req.projectRoot, {
        ...(req.families ? { families: req.families } : {}),
        includeGlobal: true,
      });
  if (!leitura.ok) {
    return {
      ok: false,
      reason: "UNREADABLE",
      detail: leitura.issues.map((i) => i.code).join(", ") || "store ilegível",
    };
  }

  const termosIntent = termosDe(intent);
  const omitted: ContextPack["omitted"] = [];
  let activeWorkRef: string | null = null;
  let workScopeUndetermined = false;
  if (leitura.records.some((r) => r.record.family === "Decision" && r.record.content.continuity?.work_ref)) {
    const work = checkpointWorkContext(await resolveCheckpointHead(req.projectRoot, { families: ["ProjectCheckpoint"] }));
    activeWorkRef = work.kind === "current" ? work.origin : null;
    workScopeUndetermined = work.kind === "undetermined";
  }
  const continuityOf = (r: CurrentRecord) => r.record.family === "Decision" ? r.record.content.continuity : undefined;

  const elegiveis = leitura.records
    /**
     * PROPOSTA NÃO É CONHECIMENTO ATIVO.
     *
     * `bootstrap_proposal` (D1) descreve como o projeto foi detectado — estado
     * de configuração, não material sobre o qual o agente raciocina.
     * `memory_candidate` (D6) é o que alguém PROPÔS lembrar e ninguém admitiu
     * ainda; deixá-lo no contexto ativo seria promover por leitura, que é
     * exatamente a sincronização automática que D6 proíbe.
     *
     * O agente raciocina sobre gotcha, pattern, architecture e o estado do
     * trabalho. Propostas disputariam budget com isso a cada sessão — e o
     * efeito já apareceu medido: o relatório do boot passou de 1825 chars
     * contra um teto de 1800 assim que a proposta começou a ser persistida.
     *
     * Exclusão DECLARADA aqui, e não um filtro escondido no produtor: quem lê o
     * assembler precisa saber o que ele recusa.
     */
    .filter((r) => !PROPOSTA_KINDS.has((r.record as { kind?: string }).kind ?? ""))
    .filter((r) => !excludedKinds.has((r.record as { kind?: string }).kind ?? ""))
    /** T5 (§4.4) — elegibilidade de escopo, ANTES de pontuar. */
    .filter((r) => elegivel(r.record, activeTaskRef, activeSessionRef))
    .filter((r) => !continuityOf(r)?.work_ref || continuityOf(r)?.work_ref === activeWorkRef);

  /**
   * T6 (§4.2 passo C, §4.3) — chaves de assunto de todo PROJECT elegível.
   * Só `scope.kind === "project"` participa como vencedor: é o eixo DURÁVEL
   * de 4.6 (`PROJECT > GLOBAL`), distinto do eixo de contexto ativo
   * (TASK/SESSION, §4.4) que já foi resolvido acima em `elegivel`.
   */
  const chavesDeProjeto = new Set<string>();
  for (const r of elegiveis) {
    if (escopoKind(r.record) !== "project") continue;
    const chave = chaveDeAssunto(r.record);
    if (chave !== null) chavesDeProjeto.add(chave);
  }

  const candidatos = elegiveis
    /**
     * T6 (§4.2 passo C) — supressão ANTES de pontuar: gastar orçamento de
     * ranking em um record que vai ser descartado moveria o corte do piso de
     * gotcha conforme a ordem de leitura (§4.2). Só um GLOBAL keyed com par
     * PROJECT de mesma chave é suprimido; `chave === null` (unkeyed, R8) nunca
     * entra aqui dos dois lados.
     */
    .filter((r) => {
      if (escopoKind(r.record) !== "global") return true;
      const chave = chaveDeAssunto(r.record);
      if (chave !== null && chavesDeProjeto.has(chave)) {
        omitted.push({ sourceRef: r.sourceRef, reason: "OVERRIDDEN_BY_PROJECT" });
        return false;
      }
      return true;
    })
    .map((r) => {
      if (!continuityOf(r)) return { r, ...pontuar(r, termosIntent) };
      /**
       * R6/P2 REVISADO (G2.1, `docs/pos-mvp-matriz-capabilities.md` §2) —
       * Decision de continuidade não vence mais o ranking por
       * `Number.MAX_SAFE_INTEGER` incondicional. MEDIDO com golden set de 43
       * perguntas reais deste repo (`docs/memory-eval/golden.yaml`,
       * `nexos memory --eval`): score infinito fazia UMA palavra incidental —
       * "arquivo", "grep", "inteiro", nenhuma delas stopword — presente em
       * qualquer uma das ~40 Decisions de continuidade (parágrafos longos,
       * vocabulário genérico de engenharia) vencer QUALQUER match específico.
       * Baseline: recall@5 4,7%, MRR 0,0599.
       *
       * `pontuar()` sem bônus de kind (`PESO_KIND` não tem entrada para
       * `Decision`) já pontua pela MESMA fórmula de qualquer outro record —
       * `comuns.length` — então "decisão só no topo quando casa com o
       * intent" agora é literal: um match específico de muitos termos ainda
       * fica acima, um match incidental de 1 termo genérico não bate mais um
       * match específico de vários.
       *
       * O que R6/P2 ORIGINAL continua garantindo, intocado: a Decision
       * aplicável NUNCA desaparece do pack por `NO_SIGNAL` (guard abaixo) —
       * ela é sempre EMPACOTADA (linha ~783, fatia dedicada de orçamento
       * cheio, independente de score) mesmo com `matched: []`; só deixou de
       * ser artificialmente a PRIMEIRA da lista quando não casa de verdade.
       * `matched` continua a sobreposição LEXICAL real — nunca fabricada.
       */
      const p = pontuar(r, termosIntent);
      const why =
        p.matched.length > 0
          ? `decisão de continuidade aplicável · ${p.matched.length} termo(s) do intent: ${p.matched.slice(0, 4).join(", ")}`
          : "decisão de continuidade aplicável; fonte relatada pelo agente, contexto sem grant";
      return { r, score: p.score, matched: p.matched, why };
    })
    .filter((c) => {
      if (c.score > 0) return true;
      /** R6/P2 — aplicável e sem grant não é `NO_SIGNAL`: nunca sai por falta de match, só por budget (fatia dedicada abaixo). */
      if (continuityOf(c.r)) return true;
      omitted.push({ sourceRef: c.r.sourceRef, reason: "NO_SIGNAL" });
      return false;
    });

  const recenciaPorRef = new Map(candidatos.map((c) => [c.r.sourceRef, criadoEm(c.r)] as const));
  const recenciaDe = (sourceRef: string): number => recenciaPorRef.get(sourceRef) ?? 0;

  /** `id` do record, para o desempate final — ver `comparar()`. */
  const idPorRef = new Map(candidatos.map((c) => [c.r.sourceRef, c.r.record.id] as const));
  const idDe = (sourceRef: string): string => idPorRef.get(sourceRef) ?? "";

  /** Score, depois `created_at` (mais novo primeiro), depois `id` do record
   * (determinismo final, imune à forma do `source_ref`) — ver `comparar()`. */
  candidatos.sort((a, b) =>
    comparar(
      { score: a.score, sourceRef: a.r.sourceRef },
      { score: b.score, sourceRef: b.r.sourceRef },
      recenciaDe,
      idDe
    )
  );

  const items: PackedItem[] = [];
  const vistos = new Set<string>();
  /** Toda ref que já recebeu veredito FINAL (empacotada ou omitida-pra-sempre). */
  const decidido = new Set<string>();
  let used = 0;

  /**
   * Empacota UMA fatia, na ordem de rank em que chega, contra um teto absoluto
   * de `used`. `RELEVANCE ORDER != PACK ORDER BY SIZE` (decisão B): no
   * primeiro candidato com conteúdo que não cabe, a fatia FECHA — nenhum
   * candidato de rank menor (mesmo mais barato) entra depois dele nesta
   * fatia. Sem isso um item de score 2 ficava de fora e um de score 1 entrava
   * no lugar, e o pack deixava de ser prefixo do ranking.
   *
   * `final=false` (piso do gotcha): quem fecha a fatia fica PENDENTE, não
   * omitido — a fatia geral decide de verdade, com o orçamento total.
   * `final=true` (fatia geral): quem fecha aqui é omitido por BUDGET de vez.
   *
   * O prefixo estrito acima tem uma exceção: um item MAIOR QUE O TETO
   * INTEIRO nunca vai caber, não importa a ordem — não é "não coube no que
   * sobrou", é "não cabe nem com o orçamento zerado". Fechar a fatia nesse
   * caso não protege ranking nenhum (nenhuma ordem salvaria esse item), só
   * derruba todo mundo depois dele. Medido: `project_state` (~2.1 KB,
   * sempre rank 1 pelo bônus de `PESO_KIND`) sozinho zerava o pack inteiro
   * em qualquer orçamento ≤ ~1600 — inclusive orçamentos alcançáveis
   * (`CODEX_KNOWLEDGE_BUDGET_BYTES` é 6144, e `project_state` cresce a cada
   * `nexos state --set`). Este item é pulado — nunca cabe, então pular não
   * fura fila de ninguém — e a fatia continua tentando o resto.
   */
  function empacotar(fatia: typeof candidatos, tetoAbsoluto: number, final: boolean): void {
    let fechado = false;
    for (const c of fatia) {
      if (fechado) {
        if (final) {
          omitted.push({ sourceRef: c.r.sourceRef, reason: "BUDGET" });
          decidido.add(c.r.sourceRef);
        }
        continue;
      }

      const content = contentOf(c.r.record);
      const continuity = continuityOf(c.r);
      if (continuity) {
        content.decision_status = continuity.status;
        content.decision_type = continuity.type;
        content.reported_source_ref = continuity.reported_source_ref;
        content.decision_applicability = continuity.applicability;
        if (continuity.conditions) content.decision_conditions = continuity.conditions;
        if (continuity.revocation_reason) content.decision_revocation_reason = continuity.revocation_reason;
        if (continuity.work_ref) content.decision_work_ref = continuity.work_ref;
      }

      /**
       * Dedup por conteúdo, não por id: dois source_refs distintos podem
       * carregar o mesmo texto após uma migração, e injetar os dois gasta
       * orçamento para dizer a mesma coisa duas vezes.
       */
      const chave = CAMPOS_UTEIS.map((k) => content[k] ?? "").join("\x00");
      if (vistos.has(chave)) {
        omitted.push({ sourceRef: c.r.sourceRef, reason: "NO_SIGNAL" });
        decidido.add(c.r.sourceRef);
        continue;
      }

      const fields: Record<string, string> = {};
      for (const k of CAMPOS_UTEIS) {
        const v = content[k];
        if (v) fields[k] = v;
      }
      if (Object.keys(fields).length === 0) {
        omitted.push({ sourceRef: c.r.sourceRef, reason: "NO_SIGNAL" });
        decidido.add(c.r.sourceRef);
        continue;
      }

      const custo = bytes(JSON.stringify(fields)) + bytes(c.r.sourceRef);

      /**
       * Nunca vai caber, mesmo com `used = 0` — pula sem fechar a fatia.
       * `ITEM TOO LARGE FOR THE WHOLE BUDGET != BUDGET EXHAUSTED BY RANK
       * ORDER`: o segundo é o caso que o prefixo estrito existe para
       * proteger; o primeiro não tem ordem que resolva.
       */
      if (custo > tetoAbsoluto) {
        if (final) {
          omitted.push({ sourceRef: c.r.sourceRef, reason: "BUDGET" });
          decidido.add(c.r.sourceRef);
        }
        continue;
      }

      if (used + custo > tetoAbsoluto) {
        fechado = true;
        if (final) {
          omitted.push({ sourceRef: c.r.sourceRef, reason: "BUDGET" });
          decidido.add(c.r.sourceRef);
        }
        continue;
      }

      vistos.add(chave);
      used += custo;
      decidido.add(c.r.sourceRef);
      items.push({
        sourceRef: c.r.sourceRef,
        family: c.r.family,
        kind: (c.r.record as { kind?: string }).kind ?? "",
        title: fields.title ?? "",
        fields,
        bytes: custo,
        score: c.score,
        why: c.why,
        matchedTerms: c.matched,
        id: c.r.record.id,
        producerId: c.r.record.provenance.producer_id,
        /** `?? ""` — record global (T1 permite o schema; T5 lê e empacota) não tem `project_id`: scope global nunca tem identidade de projeto. */
        projectId: c.r.record.project_id ?? "",
        evidenceRefs: c.r.record.evidence_refs ?? [],
      });
    }
  }

  const ehGotcha = (c: (typeof candidatos)[number]): boolean =>
    (c.r.record as { kind?: string }).kind === "gotcha";

  /**
   * T6 (§4.5, R18/R19) — LOCAL primeiro, GLOBAL só no que sobra. `GLOBAL É
   * DEFAULT, NÃO COMPETIDOR`: os candidatos globais saem inteiros das duas
   * fatias locais abaixo (nenhum piso próprio, nenhum peso novo) e só
   * aparecem na fatia 3.
   */
  const ehGlobal = (c: (typeof candidatos)[number]): boolean =>
    escopoKind(c.r.record) === "global";
  const locais = candidatos.filter((c) => !ehGlobal(c));
  const globais = candidatos.filter(ehGlobal);

  /**
   * Fatia 1 — gotcha LOCAL, só o piso. Decision (e todo o resto) não participa.
   *
   *   RESERVAR != PEDIR O QUE SOBROU
   *
   * Esta fatia roda ANTES da de continuidade, e a ordem é a reserva. `used` é
   * um contador ÚNICO compartilhado por todas as fatias (ver sua declaração
   * acima): quando a fatia de continuidade rodava primeiro contra o orçamento
   * INTEIRO e passava de `GOTCHA_FLOOR_FRACTION`, a checagem
   * `used + custo > tetoAbsoluto` já era verdadeira no PRIMEIRO gotcha e o
   * piso fechava sem admitir nada. O piso não reservava 25%: pedia 25% de um
   * orçamento já gasto.
   *
   * Medido no Store real deste repo, canal do BOOT: 829 gotcha canônicos, 5
   * Decisions de continuidade, ZERO gotcha no brief.
   *
   * Inverter a ordem não tira orçamento da continuidade: o piso é limitado a
   * `GOTCHA_FLOOR_FRACTION`, então sobram sempre 75% para ela — e o que o piso
   * não usar continua disponível, porque `used` só cresce com o que de fato
   * entrou. É a diferença entre uma reserva e uma intenção.
   */
  empacotar(
    locais.filter((c) => ehGotcha(c) && !decidido.has(c.r.sourceRef)),
    Math.floor(budget * GOTCHA_FLOOR_FRACTION),
    false
  );

  // Decisões tipadas não dependem de termos coincidentes. Revogações são
  // heads correntes, nunca depreciações que desaparecem do leitor.
  empacotar(locais.filter((c) => continuityOf(c.r) && !decidido.has(c.r.sourceRef)), budget, true);
  /**
   * Fatia 2 — resto LOCAL que ainda não teve veredito final: os demais
   * kinds, na ordem global de rank, mais o gotcha local que não coube no
   * piso (tenta de novo contra o orçamento cheio, sem furar fila de ninguém
   * — a ordem é a mesma `candidatos` já ranqueada).
   */
  empacotar(
    locais.filter((c) => !decidido.has(c.r.sourceRef)),
    budget,
    true
  );
  /**
   * Fatia 3 — GLOBAL, contra o `used` já gasto pelas duas fatias locais:
   * `used` só cresce e as duas fatias locais rodam antes, então esta fatia
   * dispõe apenas do REMANESCENTE do orçamento (R19 sai da ordem de
   * execução, não de uma conta nova). `final=true`: quem fecha aqui é
   * omitido por `BUDGET` de vez, igual à fatia local geral.
   */
  empacotar(
    globais.filter((c) => !decidido.has(c.r.sourceRef)),
    budget,
    true
  );

  /**
   * `items` foi preenchido em TRÊS fatias (piso local, geral local, depois
   * GLOBAL) — ordem de ADMISSÃO, não de rank. Quem consome o pack lê
   * `items[0]` como "o mais importante" (é o que `project_state` promete:
   * "vem primeiro em qualquer boot"), e nem o piso nem a fatia global podem
   * quebrar essa leitura só por chegarem depois. Reordena para a MESMA
   * regra de `candidatos`, sem repetir a lógica: `INSERTION ORDER !=
   * PRESENTATION ORDER`. Usa `comparar()` — a mesma função, não a mesma regra
   * reescrita duas vezes: era exatamente essa duplicação que deixava as duas
   * ordenações divergirem em silêncio.
   */
  items.sort((a, b) => comparar(a, b, recenciaDe, idDe));

  return {
    ok: true,
    pack: {
      projectRoot: req.projectRoot,
      intent,
      budgetBytes: budget,
      usedBytes: used,
      items,
      omitted,
      anomalies: leitura.anomalies.map((a) => ({ sourceRef: a.sourceRef, state: a.state })),
      ...(workScopeUndetermined || candidatos.some((c) => continuityOf(c.r) && !items.some((i) => i.id === c.r.record.id)) || leitura.anomalies.some((a) => a.sourceRef.startsWith("nexos://decision/"))
        ? { continuityIncomplete: true } : {}),
    },
  };
}
