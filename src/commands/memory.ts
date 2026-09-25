/**
 * P1 — o loop de escrita de memória, com consumidor real.
 *
 *   AGENTE PROPÕE · STORE DECIDE
 *   CANDIDATO != MEMÓRIA ADMITIDA
 *   SIMILAR != DUPLICATE
 *
 * `memory-candidate.ts` sabia montar a proposta, `memory-promotion.ts` sabia
 * medir duplicata e construir o record promovido. Faltava quem chamasse os dois
 * — sem este comando, as duas peças eram código sem consumidor.
 *
 * ─── por que existe um passo humano no meio ────────────────────────────────
 *
 * `propose` escreve o CANDIDATO. `promote` escreve a MEMÓRIA. São dois
 * comandos, e não um com `--auto`, porque D6 não proíbe apenas a sincronização
 * automática: proíbe que a admissão aconteça sem alguém decidir. Um único
 * comando que propusesse e promovesse na mesma chamada teria a decisão
 * embutida na omissão, que é a forma mais silenciosa de não decidir.
 *
 * ─── por que o produtor não lê transcript ──────────────────────────────────
 *
 * `--fact` e `--evidence` são obrigatórios e vêm de quem chama. Não existe
 * `--from-transcript`. A proibição de D6 é o FORMATO da entrada, não um `if`
 * que se possa esquecer.
 */
import { readFile, stat } from "node:fs/promises";
import path from "node:path";
import * as p from "@clack/prompts";
import pc from "picocolors";
import {
  readCurrentRecords,
  contentOf,
  isDeprecated,
  type CurrentRecord,
} from "../lib/capsule/reader.js";
import { assembleContext, termosDe } from "../lib/context-assembler.js";
import { resolveProject, resolveCommandRoot } from "../lib/project-resolver.js";
import { publishCanonical, publishSuperseding } from "../lib/capsule/store.js";
import { newRecordId } from "../lib/capsule/ids.js";
import { buildMemoryCandidate, decideAdmission } from "../lib/capsule/memory-candidate.js";
import { requestHumanApproval } from "../lib/host/human-presence.js";
import {
  CAMPO_DO_FATO,
  dedupeCandidate,
  promoteToRecord,
  type MemoryScope,
} from "../lib/capsule/memory-promotion.js";
import { subjectRef, type CapsuleRecord } from "../lib/capsule/schemas.js";
import { lerRecuperacoes, retrievalLogPath, type RetrievalLine } from "../lib/retrieval-log.js";
import {
  loadGoldenSet,
  runEval,
  defaultRetriever,
  externalRetriever,
  type EvalMetrics,
} from "../lib/memory-eval.js";

export interface MemoryOptions {
  readonly cwd?: string;
  readonly fact?: string;
  readonly evidence?: string;
  readonly origin?: string;
  readonly kind?: string;
  readonly scope?: string;
  readonly role?: string;
  /** Promove o candidato com este id. */
  readonly promote?: string;
  /** Destino da promoção (§6.2, T7a). Só "global" tem efeito; ausente/qualquer outro valor -> "project". */
  readonly to?: string;
  /** Identidade de assunto DECLARADA — nunca derivada do fato (R4, 1.4). */
  readonly subject?: string;
  /** Por que o fato vale fora do projeto onde nasceu — obrigatório com `--to global` (§6.4). */
  readonly generality?: string;
  /** Tira a linhagem deste record de circulação. Exige `--why`. */
  readonly deprecate?: string;
  /** Publica conteúdo novo na linhagem deste record. Exige `--fact`. */
  readonly correct?: string;
  /** Ator DECLARADO da depreciação/correção. `ACTOR != PRODUCER`. */
  readonly by?: string;
  readonly why?: string;
  /** Mede e reporta sem escrever. */
  readonly dryRun?: boolean;
  /** Assunto a recuperar no Store do projeto corrente. Leitura pura. */
  readonly search?: string;
  /** MEM-REVIEW — fila de decisão do dono, agrupada e ranqueada (read-only). */
  readonly review?: boolean;
  /** MEM-RETRIEVAL — a série de injeções de contexto que o recall gravou (read-only). */
  readonly retrieval?: boolean;
  /** Teto de resultados exibidos. */
  readonly limit?: number;
  /** A2.1 — caminho do golden set (YAML). Roda a régua de recall@5/MRR. Leitura pura. */
  readonly eval?: string;
  /**
   * A2.3 (encaixe) — comando de retriever externo: a query vai no stdin, um
   * array JSON de source_refs ranqueados sai no stdout. Sem isto, `--eval`
   * usa o motor interno (o mesmo de `--search`). Nenhum provider mora aqui.
   */
  readonly retrieverCmd?: string;
  /** Saída estruturada de `--eval`, para comparação automatizada entre execuções. */
  readonly json?: boolean;
}

const KINDS = new Set(["gotcha", "pattern", "architecture"]);
const SCOPES = new Set<MemoryScope>(["project", "role", "global"]);

async function lerRecords(root: string): Promise<readonly CapsuleRecord[]> {
  const res = await readCurrentRecords(root);
  if (res.ok !== true) return [];
  return res.records.map((r) => r.record);
}

/** Só a partição GLOBAL (T5, `includeGlobal`) — usada pelo gate de contradição de T7a (6.2d). */
async function lerRecordsGlobais(root: string): Promise<readonly CapsuleRecord[]> {
  const res = await readCurrentRecords(root, { includeGlobal: true });
  if (res.ok !== true) return [];
  return res.records
    .map((r) => r.record)
    .filter((r) => typeof r.scope !== "string" && r.scope.kind === "global");
}

export async function memory(options: MemoryOptions = {}): Promise<void> {
  /** Mesmo gate de `state.ts`: escrever numa capsule existente não é criar. */
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  if (options.eval !== undefined) {
    await avaliar(root, options);
    return;
  }
  if (options.review === true) {
    await revisarFila(root, options.json === true);
    return;
  }
  if (options.retrieval === true) {
    await relatarRecuperacoes(root, options.json === true);
    return;
  }
  if (options.search !== undefined) {
    await buscar(root, options);
    return;
  }
  if (options.deprecate !== undefined) {
    await depreciar(root, options);
    return;
  }
  if (options.correct !== undefined) {
    await corrigir(root, options);
    return;
  }
  if (options.promote !== undefined) {
    await promover(root, options);
    return;
  }
  if (options.fact !== undefined) {
    await propor(root, options);
    return;
  }
  await listar(root);
}

// ─── avaliar ────────────────────────────────────────────────────────────────

/**
 * A2.1 — `nexos memory --eval <golden.yaml>`. Régua reproduzível de
 * recuperação: recall@5 e MRR contra um golden set fixo.
 *
 *   MECHANICAL VERIFICATION NEEDS A NUMBER, NOT A PARECER
 *
 * Sem isto não há como medir se uma mudança de ranking (STOPWORDS, peso de
 * kind, o que for) ajuda ou piora — só "parece melhor". `rules/
 * mechanical-verification.md`: baseline → uma mudança → medir de novo.
 *
 * LEITURA PURA: `loadGoldenSet`/`runEval` (`lib/memory-eval.ts`) só leem o
 * Store via `assembleContext`, nunca escrevem — o mesmo motor de `--search`.
 */
async function avaliar(root: string, options: MemoryOptions): Promise<void> {
  const arquivo = (options.eval ?? "").trim();
  if (arquivo === "") {
    p.log.error("--eval exige o caminho do golden set (YAML).");
    process.exitCode = 1;
    return;
  }

  let raw: string;
  try {
    raw = await readFile(path.resolve(root, arquivo), "utf8");
  } catch (error) {
    p.log.error(`não foi possível ler ${arquivo}: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  const golden = loadGoldenSet(raw);
  if (!golden.ok) {
    p.log.error(`golden set inválido: ${golden.error}`);
    process.exitCode = 1;
    return;
  }

  const retriever = options.retrieverCmd ? externalRetriever(options.retrieverCmd) : defaultRetriever(root);
  let metrics: EvalMetrics;
  try {
    metrics = await runEval(golden.golden, retriever);
  } catch (error) {
    p.log.error(`eval falhou: ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
    return;
  }

  if (options.json === true) {
    console.log(JSON.stringify({ sha256: golden.sha256, retriever: options.retrieverCmd ? "external" : "default", ...metrics }, null, 2));
    return;
  }

  p.intro(pc.bgCyan(pc.black(" NexOS Memory · eval ")));
  p.log.info(`golden: ${arquivo}`);
  p.log.info(`sha256: ${golden.sha256}`);
  p.log.info(`retriever: ${options.retrieverCmd ? `externo (${options.retrieverCmd})` : "interno (assembleContext, mesmo motor de --search)"}`);

  for (const r of metrics.results) {
    const status = r.error
      ? pc.red(`ERRO: ${r.error}`)
      : r.rank === null
        ? pc.red("MISS")
        : r.rank <= 5
          ? pc.green(`hit rank=${r.rank}`)
          : pc.yellow(`rank=${r.rank} (fora do top 5)`);
    p.log.info(`${pc.dim(`[${r.type}]`)} ${r.id}: ${status}`);
  }

  p.outro(
    `${metrics.total} caso(s) — recall@5 ${(metrics.recallAt5 * 100).toFixed(1)}% · MRR ${metrics.mrr.toFixed(4)}`
  );
}

// ─── buscar ─────────────────────────────────────────────────────────────────

/**
 * Sem teto de bytes. O orçamento do `assembleContext` existe porque o brief do
 * SessionStart cabe em 12 KB e disputa espaço com o prompt; uma busca é SOB
 * DEMANDA e responde "o que existe sobre isto", não "o que cabe agora".
 * Cortar aqui reintroduziria, na recuperação, o mesmo silêncio que a busca
 * existe para desfazer — `OMITTED SILENTLY == NEVER EXISTED`.
 */
const SEARCH_BUDGET_BYTES = Number.MAX_SAFE_INTEGER;

const SEARCH_LIMIT_DEFAULT = 10;

/** Corpo por resultado: o bastante para decidir se vale abrir o record. */
const SEARCH_FIELD_MAX_CHARS = 240;

const corta = (s: string): string =>
  s.length <= SEARCH_FIELD_MAX_CHARS ? s : `${s.slice(0, SEARCH_FIELD_MAX_CHARS - 1)}…`;

/**
 * MEM-SEARCH — a superfície de comando do motor que já existia.
 *
 *   RETRIEVAL ENGINE EXISTS != RETRIEVAL IS REACHABLE
 *
 * `assembleContext` já pontuava o record certo por assunto, mas seus dois
 * únicos chamadores de produção são automáticos (SessionStart e checkpoint).
 * Sem este comando, recuperar um record exigia saber o filename — que é
 * exatamente o que uma memória deveria dispensar.
 *
 * Não há ranking novo aqui, nem índice, nem dependência: a ordem, o score e o
 * `why` são os do assembler. Este código só escolhe O QUE MOSTRAR.
 *
 * ─── isolamento ────────────────────────────────────────────────────────────
 *
 *   PROJECT FACT != GLOBAL FACT
 *
 * É ESTRUTURAL, não um filtro: `readCurrentRecords` deriva o caminho de
 * `forProject(root)` e só enxerga `<root>/.nexos/records`. Não existe caminho
 * de código daqui para o Store de outro projeto, então não há flag que possa
 * ser esquecida.
 *
 * Por que NÃO reusar o `--scope` de `propor`: aquele eixo é `memory_scope`,
 * gravado dentro do `content` de candidatos promovidos — 9 dos 397 arquivos de
 * record deste projeto o têm. Um `--scope` na busca filtraria 2% do Store e
 * devolveria vazio no resto, com cara de "não existe". Escopo de aplicabilidade
 * do fato não é seletor de Store.
 *
 * LEITURA PURA: nada aqui publica record, cria diretório ou toca no working
 * tree.
 */
async function buscar(root: string, options: MemoryOptions): Promise<void> {
  const assunto = (options.search ?? "").trim();
  if (assunto === "") {
    p.log.error("--search exige um assunto: uma busca vazia devolveria o Store inteiro, que é o mesmo que não buscar.");
    process.exitCode = 1;
    return;
  }

  const limite = options.limit ?? SEARCH_LIMIT_DEFAULT;
  if (!Number.isInteger(limite) || limite < 1) {
    p.log.error(`--limit inválido: ${String(options.limit)}. Use um inteiro >= 1.`);
    process.exitCode = 1;
    return;
  }

  const r = await assembleContext({
    projectRoot: root,
    intent: assunto,
    budgetBytes: SEARCH_BUDGET_BYTES,
  });

  /** `CANNOT OBSERVE != DOES NOT EXIST`: Store ilegível não é Store vazio. */
  if (!r.ok) {
    p.log.error(`Store ilegível: ${r.detail}`);
    process.exitCode = 1;
    return;
  }

  /**
   * Só o que casou com o ASSUNTO. `project_state` carrega bônus 100 em
   * `PESO_KIND` e entraria em toda consulta, ocupando o rank 1 com um record
   * que ninguém pediu — no boot isso é a decisão certa (é o "onde paramos"),
   * numa busca é um falso positivo fixo no topo.
   */
  const hits = r.pack.items.filter((i) => i.matchedTerms.length > 0);

  /**
   * R6/P2 — Decision de continuidade que ESTÁ no pack (vence o ranking
   * sempre, `Number.MAX_SAFE_INTEGER`) mas não casou lexicalmente com o
   * assunto buscado. `hits` já a exclui por `matchedTerms.length > 0`; sem
   * este aviso ela some do output sem rastro, e uma restrição aplicável ao
   * projeto vira silêncio indistinguível de "não existe restrição nenhuma".
   * NUNCA fabricar match aqui — o aviso aponta para `nexos decision`, não
   * finge que casou.
   */
  const foraDosHits = r.pack.items.filter(
    (i) => i.fields.decision_status !== undefined && i.matchedTerms.length === 0
  );

  p.intro(pc.bgCyan(pc.black(" NexOS Memory · search ")));

  if (r.pack.continuityIncomplete) {
    p.log.warn("CONTINUITY_CONTEXT_INCOMPLETE: consulte nexos decision; contexto omitido ou escopo indeterminado não prova ausência de restrições.");
  }

  if (foraDosHits.length > 0) {
    /**
     *   ÍNDICE NÃO É INVENTÁRIO
     *
     * O aviso existe para que uma restrição aplicável não vire silêncio — e
     * isso a CONTAGEM já entrega. Nomear todas não ajuda a escolher nenhuma:
     * por construção, estas são exatamente as que NÃO casaram o assunto, então
     * não há relevância que as ordene.
     *
     * Medido em 2026-09-19 na máquina do dono: a linha inteira custava 3998
     * bytes numa busca sem nenhum resultado — mais que o bloco de memória
     * completo de um prompt.
     *
     * Mesmo teto em BYTES da poda do índice de continuidade
     * (nexos://decision/indice-de-continuidade-poda-por-relevancia): nomeia
     * enquanto couber, conta o resto, e o ponteiro para `nexos decision` leva
     * à lista inteira. Poucas continuam nomeadas, que é o caso em que o nome
     * ainda informa.
     */
    const TETO_NOMES_BYTES = 300;
    const nomes: string[] = [];
    let usados = 0;
    for (const item of foraDosHits) {
      const custo = Buffer.byteLength(`${item.sourceRef}, `, "utf8");
      if (nomes.length > 0 && usados + custo > TETO_NOMES_BYTES) break;
      nomes.push(item.sourceRef);
      usados += custo;
    }
    const restantes = foraDosHits.length - nomes.length;
    p.log.warn(
      `${foraDosHits.length} decisão(ões) de continuidade no contexto não casaram com o assunto — consulte \`nexos decision\`` +
        `: ${nomes.join(", ")}` +
        (restantes > 0 ? ` e mais ${restantes}` : "")
    );
  }

  if (hits.length === 0) {
    p.log.info(`nenhum record casou com ${JSON.stringify(assunto)}.`);
    p.outro(`${r.pack.items.length + r.pack.omitted.length} head(s) no Store deste projeto — nenhum com termo em comum.`);
    return;
  }

  for (const [i, h] of hits.slice(0, limite).entries()) {
    /**
     * `fields` chega na ordem de `CAMPOS_UTEIS` do assembler, que já é a ordem
     * de quanto o campo é operável. O primeiro que não é `title` é o melhor
     * resumo disponível sem reimplementar julgamento aqui.
     */
    const corpo = Object.entries(h.fields).find(([k]) => k !== "title");
    /** Decision de continuidade: status/revogação/condições vêm do envelope, nunca do texto. */
    const continuidade = h.fields.decision_status
      ? `\n   ${pc.dim("status:")} ${h.fields.decision_status}` +
        (h.fields.decision_revocation_reason ? `\n   ${pc.dim("revogação:")} ${h.fields.decision_revocation_reason}` : "") +
        (h.fields.decision_conditions ? `\n   ${pc.dim("condições:")} ${h.fields.decision_conditions}` : "")
      : "";
    p.log.info(
      `${pc.dim(`#${i + 1}`)} ${pc.yellow(`score ${h.score}`)} ${pc.cyan(h.kind || h.family)}\n` +
        `   ${pc.bold(h.title || h.sourceRef)}\n` +
        (corpo ? `   ${corta(corpo[1])}\n` : "") +
        `   ${pc.dim("why:")} ${h.why}\n` +
        `   ${pc.dim("source_ref:")} ${h.sourceRef}\n` +
        `   ${pc.dim("producer_id:")} ${h.producerId}  ${pc.dim("project_id:")} ${h.projectId}` +
        continuidade +
        (h.evidenceRefs.length > 0 ? `\n   ${pc.dim("evidence_refs:")} ${h.evidenceRefs.join(", ")}` : "")
    );
  }

  const anomalias =
    r.pack.anomalies.length > 0 ? ` · ${r.pack.anomalies.length} partição(ões) anômala(s)` : "";
  p.outro(
    `${hits.length} resultado(s), exibindo ${Math.min(hits.length, limite)}${anomalias}` +
      (hits.length > limite ? ` — use --limit ${hits.length} para ver todos` : "")
  );
}

// ─── propor ─────────────────────────────────────────────────────────────────

async function propor(root: string, options: MemoryOptions): Promise<void> {
  const fact = options.fact ?? "";
  const evidence = options.evidence ?? "";
  const kind = options.kind ?? "gotcha";
  const scope = (options.scope ?? "project") as MemoryScope;

  if (evidence.trim() === "") {
    p.log.error("`--evidence` é obrigatório: EVIDENCE != ASSERTION — sem o que sustenta, promover seria acreditar.");
    process.exitCode = 1;
    return;
  }
  if (!KINDS.has(kind)) {
    p.log.error(`--kind inválido: ${kind}. Use gotcha, pattern ou architecture.`);
    process.exitCode = 1;
    return;
  }
  if (!SCOPES.has(scope)) {
    p.log.error(`--scope inválido: ${scope}. Use project, role ou global.`);
    process.exitCode = 1;
    return;
  }
  /**
   * §8.2 — `role` continua vocabulário legado de CONTEÚDO (memory_scope),
   * mas nunca mais um escopo de Store aceito silenciosamente pela CLI. Zero
   * records reais usam `memory_scope: role` hoje — a mudança não tem custo
   * de dados, e o erro explícito ensina mais do que a flag desaparecida.
   */
  if (scope === "role") {
    p.log.error("role não é um escopo de Store; declare o papel no subject ou no fato.");
    process.exitCode = 1;
    return;
  }
  if (scope === "global" && (options.subject ?? "").trim() === "") {
    p.log.error(
      "--scope global exige --subject: identidade de assunto declarada, nunca derivada do fato (R4)."
    );
    process.exitCode = 1;
    return;
  }

  /**
   * Identidade vem do MANIFEST, nunca dos records — um Store vazio (zero
   * records, manifest válido) é o caso normal logo após `nexos init`, e
   * derivar `project_id` de `records.find(...)` devolvia "" ali e abortava
   * uma capsule canônica que existe. Mesmo gate de `memory-recall.ts` e do
   * `abrirCapsule` de `state.ts`: `resolveProject` lê o manifest sem tocar em
   * `records/`.
   */
  const resolution = await resolveProject({ cwd: root });
  if (resolution.identitySource !== "manifest" || !resolution.canonicalProjectId) {
    p.log.error("projeto sem Store — não há onde propor.");
    process.exitCode = 1;
    return;
  }
  const projectId = resolution.canonicalProjectId;
  const records = await lerRecords(root);

  const agora = new Date().toISOString();
  const candidato = buildMemoryCandidate({
    projectId,
    fact,
    originNote: options.origin ?? "declarado na linha de comando",
    evidence,
    proposedKind: kind as "gotcha" | "pattern" | "architecture",
    recordId: newRecordId("KnowledgeRecord"),
    observedAt: agora,
  });
  const content = (candidato as unknown as { content: Record<string, unknown> }).content;
  content["memory_scope"] = scope;
  if (options.role !== undefined) content["role"] = options.role;

  /**
   * Identidade de assunto DECLARADA (1.4) — SOMENTE no envelope, nunca em
   * `content`. O candidato grava aqui quando `--subject` é passado na
   * proposta; a promoção (T7a) copia os dois campos de envelope para
   * envelope, sem rederivar.
   */
  if (options.subject !== undefined && options.subject.trim() !== "") {
    const subject = options.subject.trim();
    (candidato as unknown as { subject?: string; subject_ref?: string }).subject = subject;
    (candidato as unknown as { subject?: string; subject_ref?: string }).subject_ref = subjectRef(subject);
  }

  /**
   * Dedupe ANTES de escrever. Um candidato duplicado admitido no Store só é
   * descoberto na promoção, quando já existem dois records dizendo o mesmo e
   * ninguém sabe qual veio primeiro.
   */
  const veredito = dedupeCandidate(candidato, records);
  if (veredito.state !== "NOVEL") {
    p.log.warn(`${veredito.state}: ${veredito.why}`);
    for (const id of veredito.against.slice(0, 5)) p.log.info(`   contra ${id}`);
    if (veredito.state === "DUPLICATE") {
      p.log.info("nada proposto — o fato já está no Store.");
      return;
    }
    p.log.info("CONFLITO registrado: a proposta segue, e a decisão é de quem promove.");
  }

  if (options.dryRun === true) {
    p.log.info(`[dry-run] candidato ${candidato.id} (${veredito.state}) — nada escrito.`);
    return;
  }

  /**
   * `publishCanonical` roda `assertPublishable` (store.ts) ANTES de tocar
   * disco — inclusive o secret-guard (secret-guard.ts, intocado). Sem este
   * catch, uma recusa FAIL CLOSED (correta) escapava como stack crua de
   * `dist/lib/capsule/store.js`/`secret-guard.js` — mesmo defeito de
   * apresentação já corrigido em `commands/gotcha.ts`
   * (nexos://gotcha/nexos-gotcha-despeja-stack-crua-quando-o-secret-guard-recusa-o-conteudo).
   */
  try {
    await publishCanonical(root, candidato);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  if (await retiradoPorCorrida(root, candidato)) return;

  p.log.success(`candidato ${candidato.id} proposto (${veredito.state}).`);
  p.log.info(`promover com: nexos memory --promote ${candidato.id} --why "..."`);
}

/**
 * O dedupe de cima roda ANTES da escrita, e é isso que o torna furado:
 *
 *   DEDUPE NA PROPOSTA != DEDUPE NA ESCRITA
 *
 * Duas invocações concorrentes leem o Store antes de qualquer uma publicar, as
 * duas veem NOVEL, e o acervo ganha o par que o próprio guard reprovaria.
 * MEDIDO com dois processos de verdade contra uma cópia do Store real: mesmo
 * fato, ids `knw_01M15SSDJK7RGF…` e `knw_01M15SSDJKFAP7…` — o MESMO
 * milissegundo no ULID — 268 → 270 arquivos, ambos `(NOVEL)`. É a condição
 * NORMAL deste repo, não azar: sessões paralelas foram medidas com `ps`.
 *
 * ─── por que não é um CAS ──────────────────────────────────────────────────
 *
 * A reação reflexa seria "revalidar dentro do CAS de `publishCanonical`". Não
 * existe CAS aqui: o `link()` no-clobber daquele funil é chaveado por
 * `record.id`, e duplicata tem id DIFERENTE por construção. Chavear por digest
 * do fato também não resolve — o par real do Store (`knw_01M140XW3B…` ×
 * `knw_01M140XX0F…`) tem sobreposição 0.923 com facts DIFERENTES ("…sem
 * bloquear a acao" × "…sem bloquear"). Um digest não os igualaria.
 *
 *   SIMILARITY IS A PREDICATE OVER THE STORE, NOT A CLAIMABLE NAME
 *
 * Sem chave não há claim atômico, e serializar toda proposta num mutex trocaria
 * uma duplicata inócua (candidato não entra no contexto — `PROPOSTA_KINDS` no
 * assembler) por lock preso e fato que ninguém consegue mais propor. O Store
 * proíbe TTL em head-claim justamente por isso; aqui a troca seria pior ainda.
 *
 * Então: escreve otimista e RECONCILIA. Append-only já sabe tirar de circulação
 * publicando — `DEPRECATED != DELETED`.
 *
 * ─── por que o desempate é o menor id ──────────────────────────────────────
 *
 * Determinístico e SEM combinação entre os processos: cada um vê o mesmo
 * conjunto e chega ao mesmo vencedor, então exatamente um se retira. ULID é
 * monotônico no tempo, logo o menor id é o que chegou primeiro — quem perde a
 * corrida é quem a perdeu de fato.
 *
 * Só se deprecia A SI MESMO. Nunca o outro: o outro pode ser conhecimento já
 * promovido, e um comando de PROPOSTA que retira memória admitida de circulação
 * seria admissão por efeito colateral, o oposto de D6.
 *
 * ponytail: custa um record de depreciação por corrida (3 arquivos onde o ideal
 * seria 1). O ideal exigiria mutex; o teto está declarado acima e a troca é
 * pior. Se algum dia a corrida virar comum, é aqui que se mede de novo.
 */
async function retiradoPorCorrida(root: string, candidato: CapsuleRecord): Promise<boolean> {
  const agora = await lerRecords(root);
  const v = dedupeCandidate(candidato, agora);
  if (v.state !== "DUPLICATE") return false;

  const vencedor = [candidato.id, ...v.against].sort()[0];
  if (vencedor === candidato.id) return false;

  const lookup = await headPorId(root, candidato.id);
  if (!lookup.ok) {
    /** `CANNOT OBSERVE != DOES NOT EXIST`: sem head não se deprecia às cegas. */
    p.log.warn(`${candidato.id} duplicou ${vencedor} numa corrida e não pôde ser retirado: ${lookup.erro}`);
    return false;
  }

  await publicarSucessor(root, lookup.head, DEPRECATE_PRODUCER, {
    deprecation: {
      reason: `duplicata de ${vencedor} detectada após a escrita (corrida de propostas concorrentes); ${v.why}`,
      actor_ref: `policy:${DEPRECATE_PRODUCER}`,
    },
  });

  p.log.warn(`DUPLICATE: ${v.why}`);
  p.log.info(`   ${candidato.id} foi publicado e RETIRADO — ${vencedor} venceu a corrida.`);
  p.log.info(`   o arquivo continua no disco; o que mudou é a LEITURA do corrente.`);
  return true;
}

// ─── listar ─────────────────────────────────────────────────────────────────

async function listar(root: string): Promise<void> {
  const records = await lerRecords(root);
  const candidatos = records.filter(
    (r) => (r as { kind?: string }).kind === "memory_candidate"
  );
  p.intro(pc.bgCyan(pc.black(" NexOS Memory ")));
  if (candidatos.length === 0) {
    p.log.info("nenhum candidato pendente.");
    p.outro("propor: nexos memory --fact \"...\" --evidence \"...\"");
    return;
  }
  for (const c of candidatos) {
    const cont = contentOf(c);
    p.log.info(
      `${pc.dim(c.id)}  ${pc.yellow(cont["proposed_kind"] ?? "?")}/${cont["memory_scope"] ?? "project"}\n` +
        `   ${cont["fact"] ?? ""}\n` +
        `   ${pc.dim("evidência:")} ${cont["evidence"] ?? "-"}`
    );
  }
  p.outro(`${candidatos.length} candidato(s) — promover: nexos memory --promote <id> --why "..."`);
}

// ─── promover ───────────────────────────────────────────────────────────────

async function promover(root: string, options: MemoryOptions): Promise<void> {
  const alvo = options.promote ?? "";
  const records = await lerRecords(root);
  const candidato = records.find((r) => r.id === alvo);

  if (candidato === undefined) {
    p.log.error(`candidato ${alvo} não encontrado no Store.`);
    process.exitCode = 1;
    return;
  }

  /**
   * `--to` só aceita "global". Ausente -> "project" (R11). Presente com
   * qualquer OUTRO valor é erro explícito, não fallback silencioso: um typo
   * em `--to` nunca deve parecer sucesso.
   */
  if (options.to !== undefined && options.to !== "global") {
    p.log.error(`--to aceita só global; sem a flag o destino é project (recebido: "${options.to}").`);
    process.exitCode = 1;
    return;
  }

  /**
   * `resolvedTargetScope` é resolvido AQUI (13_MEMORY_SCOPE_LAYERED_DECISION.md
   * §6.2, T7a) — NUNCA deduzido de `content.memory_scope`. Sem `--to global`,
   * o destino é SEMPRE "project", mesmo que o candidato declare
   * `memory_scope: "global"` (R11, I13, I22). `promoteToRecord` recebe o valor
   * já decidido e nunca o infere (§2.2).
   */
  const resolvedTargetScope: "project" | "global" = options.to === "global" ? "global" : "project";

  /**
   * Fail-closed do produtor (6.2, dois níveis): subject e generality são
   * exigidos AQUI, antes de qualquer decisão de admissão — sem os dois, nada
   * é escrito, e o schema (checkSubjectInvariants) é a segunda defesa.
   * `candidatoParaAdmissao` é uma cópia LOCAL, nunca publicada como está: o
   * candidato original no Store não muda por causa de flags de promoção.
   */
  let candidatoParaAdmissao: CapsuleRecord = candidato;
  let generality: string | undefined;

  if (resolvedTargetScope === "global") {
    const subjectDoCandidato = (candidato as { subject?: string }).subject;
    const subject = (subjectDoCandidato ?? options.subject ?? "").trim();
    if (subject === "") {
      p.log.error(
        "--to global exige subject: presente no candidato ou passado em --subject <texto> — nunca derivado do fato (R4)."
      );
      process.exitCode = 1;
      return;
    }
    generality = (options.generality ?? "").trim();
    if (generality === "") {
      p.log.error("--to global exige --generality <texto> — sem afirmação de generalidade não há global.");
      process.exitCode = 1;
      return;
    }

    candidatoParaAdmissao = {
      ...candidato,
      subject,
      subject_ref: subjectRef(subject),
      content: { ...contentOf(candidato), generality },
    } as unknown as CapsuleRecord;
  }

  /**
   * Era `humanApproved: true` — HARDCODED, com um comentário que admitia não
   * saber se quem invocou é humano e apontava para um "broker de presença" que
   * o corte P0 removeu. O gate existia no design (`decideAdmission` recusa com
   * `false`, e `memory-candidate.ts` tirou o default `true` de propósito) e o
   * único chamador de produção o curto-circuitava:
   *
   *   FLAG DECLARADA != CRITÉRIO EXECUTADO
   *
   * É o antipadrão que `rules/mechanical-verification.md` descreve — aprovação
   * hardcoded positiva, nenhum juiz rodado — reproduzido dentro do produto que
   * o descreve. Custo medido: 4 candidatos viraram gotcha canônico num único
   * turno de agente.
   *
   * Agora quem responde é o terminal controlador, que não passa pelo argv.
   * `--why` continua sendo só o texto do registro: nunca foi, e não é, prova
   * de aprovação.
   */
  const aprovacao = requestHumanApproval(
    `\npromover ${candidato.id} → ${resolvedTargetScope} como memória canônica? [y/N] `
  );

  if (!aprovacao.approved) {
    p.log.error(`não promovido: ${aprovacao.why}`);
    process.exitCode = 1;
    return;
  }

  const veredito = decideAdmission({
    candidate: candidatoParaAdmissao,
    to: resolvedTargetScope,
    humanApproved: aprovacao.approved,
    why: options.why ?? "",
  });

  if (!veredito.admit) {
    p.log.error(`não promovido: ${veredito.why}`);
    process.exitCode = 1;
    return;
  }

  /**
   * Contradição (6.2d): mesma chave (family, kind, subject_ref) já corrente
   * no root global recusa — "conflito não se resolve sozinho". NUNCA por
   * frequência: só o root global é lido, nenhum outro projeto.
   */
  if (resolvedTargetScope === "global") {
    const subjectRefDeclarado = (candidatoParaAdmissao as { subject_ref?: string }).subject_ref;
    const globais = await lerRecordsGlobais(root);
    const conflito = globais.find((r) => {
      if (r.family !== "KnowledgeRecord") return false;
      return (
        (r as { kind?: string }).kind === veredito.targetKind &&
        (r as { subject_ref?: string }).subject_ref === subjectRefDeclarado
      );
    });
    if (conflito !== undefined) {
      p.log.error(
        `não promovido: já existe registro global corrente (${conflito.id}) com a mesma chave ` +
          "(family, kind, subject_ref) — conflito não se resolve sozinho."
      );
      process.exitCode = 1;
      return;
    }
  }

  const agora = new Date().toISOString();
  const promovido = promoteToRecord({
    candidate: candidatoParaAdmissao,
    targetKind: veredito.targetKind,
    recordId: newRecordId("KnowledgeRecord"),
    promotedAt: agora,
    /**
     * A origem REAL da aprovação, não um carimbo fixo. `human:tty` só é
     * alcançável por alguém que respondeu no terminal controlador — o caminho
     * de agente não chega até aqui, porque a recusa acima já saiu com
     * `exitCode 1`. `ApprovedBySchema` aceita `human:<id>`; era justamente esse
     * valor que `gotcha`/`state` não podiam mais alegar, porque lá nada o
     * sustentava. Aqui sustenta.
     */
    approvedBy: aprovacao.approvedBy,
    resolvedTargetScope,
    generality,
  });

  if (options.dryRun === true) {
    p.log.info(`[dry-run] promoveria para ${veredito.targetKind} como ${promovido.id} — nada escrito.`);
    return;
  }

  /** Mesmo catch de `propor` acima — `assertPublishable` (store.ts, inclusive
   *  secret-guard.ts) roda ANTES de tocar disco; sem isto a recusa escapava
   *  como stack crua. */
  try {
    await publishCanonical(root, promovido);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
    return;
  }

  /**
   * A PROPOSTA sai de circulação quando vira memória.
   *
   *   PROMOTED != RETIRED
   *
   * MEDIDO no Store real deste projeto: 9 dos 10 candidatos correntes já tinham
   * sido promovidos e seguiam correntes ao lado do próprio sucessor — 7 pares
   * com sobreposição >= 0.44, 6 deles em 1.000 exato. Não era duplicata de
   * conteúdo: era a proposta e a memória dizendo a mesma coisa, as duas vivas.
   *
   * Não some do disco nem perde a origem: `promoteToRecord` grava
   * `nexos://promoted-from/<id-do-candidato>` no `source_ref` do promovido, e é
   * por essa aresta que a proveniência continua caminhável. O que muda é só a
   * LEITURA — `DEPRECATED != DELETED`.
   *
   * Falha aqui NÃO desfaz a promoção: a memória já está publicada e é o que
   * importa. Um candidato que sobrevive é o estado de ontem, não corrupção.
   */
  const origem = await headPorId(root, candidato.id);
  if (origem.ok) {
    await publicarSucessor(root, origem.head, DEPRECATE_PRODUCER, {
      deprecation: {
        reason: `promovido para ${promovido.id} (${veredito.targetKind}); a proposta cumpriu seu papel`,
        actor_ref: `policy:${DEPRECATE_PRODUCER}`,
      },
    });
  }

  p.log.success(`promovido: ${promovido.id} (${veredito.targetKind}) — origem ${candidato.id}.`);
  p.log.info(`   o candidato saiu de circulação; a origem segue em ${promovido.provenance.source_ref}.`);
}

// ─── depreciar / corrigir ───────────────────────────────────────────────────

/**
 * MEM-DEPRECATE e MEM-CORRECT — os dois verbos que faltavam ao loop LEMBRAR.
 *
 *   DEPRECATED != DELETED
 *   APPEND-ONLY STORE FORGETS BY PUBLISHING, NOT BY REMOVING
 *
 * São o MESMO movimento no motor: publicar um record novo na MESMA linhagem
 * (`family` + `provenance.source_ref`) com `supersedes` apontando para o head
 * que sai. O head-resolver elege o head por TOPOLOGIA, então o antecessor deixa
 * de ser corrente no instante em que o sucessor existe — sem apagar arquivo,
 * sem tocar em `lifecycle: immutable`.
 *
 * A ÚNICA diferença entre os dois verbos é o que o sucessor carrega:
 *
 *   deprecate   mesmo conteúdo + `deprecation: { reason, actor_ref }` — a
 *               leitura corrente descarta a linhagem inteira (`reader.ts`)
 *   correct     conteúdo novo no campo que carrega o fato — a linhagem segue
 *               corrente, com a versão certa. A velha não volta porque não é
 *               mais head, e head não se decide por relógio.
 *
 * TETO: só `KnowledgeRecord`. Famílias append-only (`HostObservation`,
 * `CapabilityQuality`, …) PROÍBEM `supersedes` — nelas cada record é um evento
 * ocorrido, e "depreciar um evento" não tem significado. `ProjectCapabilityIntent`
 * usa `supersedes: string[]` e `CapabilityRegistration` tem linhagem própria
 * (`promotion.ts`); ambas precisariam de tratamento próprio aqui. O FILTRO de
 * leitura, esse sim, é genérico: qualquer family cujo head carregue
 * `deprecation` sai de circulação.
 */
const DEPRECATE_PRODUCER = "nexos-memory-deprecate";
const CORRECT_PRODUCER = "nexos-memory-correct";

type AlvoLookup =
  | { readonly ok: true; readonly head: CurrentRecord }
  | { readonly ok: false; readonly erro: string };

/**
 * O record com este id, se ele for HEAD da própria linhagem.
 *
 * Recusar um não-head não é rigor decorativo: publicar um sucessor de um record
 * JÁ superseded cria um segundo filho do mesmo pai — dois heads não
 * referenciados, `DIVERGED`, e a partição inteira sai de `records`. O erro
 * pedido some junto com o conhecimento que estava certo.
 */
async function headPorId(root: string, id: string): Promise<AlvoLookup> {
  const r = await readCurrentRecords(root, { includeDeprecated: true });
  if (!r.ok) {
    return { ok: false, erro: `Store ilegível: ${r.issues.map((i) => i.code).join(", ")}` };
  }
  const head = r.records.find((x) => x.record.id === id);
  if (!head) {
    return {
      ok: false,
      erro:
        `${id} não é head de nenhuma linhagem legível deste Store. ` +
        `Ou não existe, ou já foi superseded por outro record — e superseder um ` +
        `record que já tem sucessor produz DIVERGED, não correção.`,
    };
  }
  if (head.family !== "KnowledgeRecord") {
    return {
      ok: false,
      erro:
        `${id} é ${head.family}; este comando só opera KnowledgeRecord. ` +
        `Ver o TETO documentado em memory.ts.`,
    };
  }
  return { ok: true, head };
}

/**
 * Publica o sucessor na linhagem do alvo. `publishSuperseding` re-lê o head a
 * cada tentativa (CAS sobre a transição), e `buildRecord` RECUSA se o head
 * mudou: um escritor concorrente que avançou a linhagem entre a leitura e a
 * escrita faria este comando depreciar/corrigir um record que já não é o que o
 * usuário nomeou.
 */
async function publicarSucessor(
  root: string,
  alvo: CurrentRecord,
  producerId: string,
  patch: Record<string, unknown>
): Promise<string> {
  const agora = new Date().toISOString();
  const novoId = newRecordId(alvo.family);

  const { record } = await publishSuperseding(root, {
    family: alvo.family,
    sourceRef: alvo.sourceRef,
    readHead: async () => {
      const r = await readCurrentRecords(root, {
        families: [alvo.family],
        includeDeprecated: true,
      });
      if (!r.ok) return undefined;
      const h = r.records.find((x) => x.sourceRef === alvo.sourceRef);
      return h ? { id: h.record.id } : undefined;
    },
    buildRecord: (head) => {
      if (head?.id !== alvo.record.id) {
        throw new Error(
          `head de "${alvo.sourceRef}" mudou de ${alvo.record.id} para ` +
            `${head?.id ?? "nenhum"} durante esta escrita. Nada foi escrito.`
        );
      }
      const base = alvo.record as unknown as Record<string, unknown>;
      const sensitivity = (base["sensitivity"] ?? {}) as Record<string, unknown>;
      return {
        ...base,
        ...patch,
        id: novoId,
        supersedes: alvo.record.id,
        provenance: {
          ...alvo.record.provenance,
          producer_id: producerId,
          submitted_at: agora,
        },
        /**
         * ADMITIDO, e é a leitura correta: o sucessor é um fato NOVO e
         * verdadeiro sobre a linhagem. `store.ts:assertPublishable` recusaria
         * qualquer outro valor — ver `DeprecationSchema` para por que
         * `rejected`/`superseded` seguem sem produtor.
         */
        admission: {
          status: "admitted",
          approved_by: `policy:${producerId}`,
          approved_at: agora,
        },
        /** Conteúdo novo exige checagem nova — `assertNoSecretMaterial` roda neste record. */
        sensitivity: {
          ...sensitivity,
          checked_at: agora,
          checker_version: producerId,
        },
        created_at: agora,
      } as unknown as CapsuleRecord;
    },
  });

  return record.id;
}

async function depreciar(root: string, options: MemoryOptions): Promise<void> {
  const alvoId = (options.deprecate ?? "").trim();
  const motivo = (options.why ?? "").trim();

  if (motivo === "") {
    p.log.error(
      "--deprecate exige --why: depreciar sem motivo registrado é apagar história, " +
        "que é o oposto do que este Store existe para fazer."
    );
    process.exitCode = 1;
    return;
  }

  const lookup = await headPorId(root, alvoId);
  if (!lookup.ok) {
    p.log.error(lookup.erro);
    process.exitCode = 1;
    return;
  }
  const alvo = lookup.head;

  if (isDeprecated(alvo.record)) {
    p.log.info(`${alvoId} já está depreciado — nada a fazer.`);
    return;
  }

  const actorRef = (options.by ?? "").trim() || `policy:${DEPRECATE_PRODUCER}`;

  if (options.dryRun === true) {
    p.log.info(
      `[dry-run] depreciaria ${alvoId} (${alvo.sourceRef}) por "${motivo}" — nada escrito.`
    );
    return;
  }

  try {
    const novo = await publicarSucessor(root, alvo, DEPRECATE_PRODUCER, {
      deprecation: { reason: motivo, actor_ref: actorRef },
    });
    p.log.success(`${alvoId} depreciado por ${novo}.`);
    p.log.info(`   motivo: ${motivo}`);
    p.log.info(`   ator: ${actorRef}`);
    p.log.info(
      `   o arquivo de ${alvoId} continua no disco — o que mudou é a LEITURA do corrente.`
    );
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

async function corrigir(root: string, options: MemoryOptions): Promise<void> {
  const alvoId = (options.correct ?? "").trim();
  const fato = (options.fact ?? "").trim();

  if (fato === "") {
    p.log.error("--correct exige --fact: correção sem o fato novo não corrige nada.");
    process.exitCode = 1;
    return;
  }

  const lookup = await headPorId(root, alvoId);
  if (!lookup.ok) {
    p.log.error(lookup.erro);
    process.exitCode = 1;
    return;
  }
  const alvo = lookup.head;

  /**
   * Corrigir uma linhagem DEPRECIADA a ressuscitaria em silêncio: o sucessor
   * não carrega `deprecation`, logo volta a ser corrente. Quem quer isso está
   * revertendo uma depreciação, não corrigindo um fato — e essa decisão não
   * pode acontecer por efeito colateral.
   */
  if (isDeprecated(alvo.record)) {
    p.log.error(
      `${alvoId} é o marcador de uma linhagem DEPRECIADA. Corrigir aqui a traria de ` +
        `volta como corrente sem que ninguém tenha decidido isso. Proponha o fato de novo.`
    );
    process.exitCode = 1;
    return;
  }

  const kind = (alvo.record as { kind?: string }).kind ?? "";
  if (!KINDS.has(kind)) {
    p.log.error(
      `${alvoId} é kind "${kind || "?"}"; --correct só opera gotcha, pattern e architecture. ` +
        `project_state se corrige com \`nexos state --set\`, que já supersede pela mesma via.`
    );
    process.exitCode = 1;
    return;
  }

  /**
   * O campo que CARREGA a afirmação naquele kind (`CAMPO_DO_FATO`, a mesma
   * escolha de `promoteToRecord`) — mais os campos DERIVADOS dele.
   *
   *   HALF-CORRECTED RECORD STILL SHOWS THE WRONG CLAIM
   *
   * MEDIDO na prova contra a cópia do Store real: `promoteToRecord` copia o
   * fato para MAIS de um campo por construção (`title`/`subject` recebem
   * `fato.slice(0,120)`, `expected_effect` recebe o fato inteiro). Corrigindo
   * só `rule`, o `--search` seguia exibindo a versão ERRADA no título, com a
   * certa no corpo — meia correção com cara de correção.
   *
   * A condição é IGUALDADE LITERAL com o valor antigo, nunca semelhança: um
   * título ESCRITO à mão, que não é cópia do fato, permanece intacto. Nada de
   * heurística sobre o que "parece" derivado.
   */
  const campo = CAMPO_DO_FATO[kind as keyof typeof CAMPO_DO_FATO];
  const conteudoAtual = (alvo.record as unknown as { content: Record<string, unknown> }).content;
  const evidencia = (options.evidence ?? "").trim();
  const antigo = conteudoAtual[campo];

  const content: Record<string, unknown> = { ...conteudoAtual };
  if (typeof antigo === "string") {
    for (const [k, v] of Object.entries(conteudoAtual)) {
      if (typeof v !== "string") continue;
      if (v === antigo) content[k] = fato;
      else if (v === antigo.slice(0, 120)) content[k] = fato.slice(0, 120);
    }
  }
  content[campo] = fato;
  if (evidencia !== "") content["evidence"] = evidencia;

  /**
   * TETO DECLARADO: uma correção registra QUEM (`provenance.producer_id`,
   * `admission.approved_by`) e QUANDO (`created_at`), mas NÃO tem campo para o
   * porquê nem para um ator declarado — `deprecation` é o único lugar do
   * envelope com esses campos, e usá-lo aqui depreciaria o record em vez de
   * corrigi-lo. Aceitar as flags e não gravá-las seria pior que recusá-las: o
   * usuário acreditaria ter registrado o motivo.
   */
  const naoGravaveis = ["--by", "--why"].filter((f) =>
    f === "--by" ? (options.by ?? "").trim() !== "" : (options.why ?? "").trim() !== ""
  );
  if (naoGravaveis.length > 0) {
    p.log.error(
      `${naoGravaveis.join(" e ")} não têm onde ser gravados numa correção — só a ` +
        `depreciação tem campos de ator e motivo. A autoria da correção fica em ` +
        `provenance.producer_id="${CORRECT_PRODUCER}".`
    );
    process.exitCode = 1;
    return;
  }

  if (options.dryRun === true) {
    p.log.info(`[dry-run] corrigiria ${campo} de ${alvoId} (${kind}) — nada escrito.`);
    return;
  }

  try {
    const novo = await publicarSucessor(root, alvo, CORRECT_PRODUCER, { content });
    p.log.success(`${alvoId} corrigido por ${novo} (campo ${campo}).`);
    p.log.info(`   a versão anterior continua no disco e NÃO volta como corrente.`);
  } catch (error) {
    p.log.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  }
}

/**
 * MEM-REVIEW — a fila de decisão do dono, em vez da lista crua.
 *
 *   FILA SEM VAZÃO NÃO É BACKLOG, É VAZAMENTO
 *
 * MEDIDO em 2026-09-18: 258 candidatos vivos, o mais antigo de 28/08 (21 dias),
 * e a distribuição de quem admitiu conta a história — 81 promoções por
 * política, de quando o agente promovia sozinho, contra 2 pelo gate humano
 * que as substituiu. O gate parou a promoção por agente e ninguém criou o
 * ritual de decisão; a fila cresceu 247 -> 256 durante uma única sessão de
 * observação.
 *
 * Este comando NÃO decide nada e NÃO promove: promoção segue exigindo humano
 * no /dev/tty. Ele só se recusa a despejar 258 registros crus e espera que
 * alguém leia. Os sinais são todos FACTUAIS — idade, presença de evidência,
 * forma de comando na evidência, e sobreposição de tokens entre candidatos.
 * Nada aqui pontua "qualidade" por heurística inventada: EVIDENCE IS PROSE,
 * NOT A PROBE, e um número fabricado seria pior que nenhum.
 */
interface FilaItemJson {
  readonly id: string;
  readonly days: number | null;
  readonly hasEvidence: boolean;
  readonly evidenceLooksLikeCommand: boolean;
  /** NOVO — a evidência cita um script de `package.json` que existe neste projeto. */
  readonly evidenceCommandExists: boolean;
  /** NOVO — a evidência cita `arquivo:linha` e o arquivo existe neste projeto. */
  readonly evidenceFileRefExists: boolean;
  readonly proposedKind: string | null;
  readonly fact: string;
  readonly origin: string | null;
  /** SEMPRE array, vazio quando não há par — omitir faria ausência virar omissão. */
  readonly likelyDuplicateOf: readonly string[];
  /** NOVO — índice do cluster em `clusters` a que este item pertence. */
  readonly clusterId: number;
  /** NOVO — 0-5, soma de sinais factuais (ver `pontuarCandidato`). */
  readonly score: number;
  /** NOVO — os mesmos sinais, em uma frase — nota sem razão é opinião com número. */
  readonly scoreReason: string;
  /** NOVO — por que este candidato importa, montado só a partir de campos do record. */
  readonly whyItMatters: string;
}

interface ClusterJson {
  readonly id: number;
  readonly memberIds: readonly string[];
  readonly size: number;
}

interface SupersedeSuggestionJson {
  readonly newer: string;
  readonly older: string;
  readonly reason: string;
}

interface CandidatoFila {
  readonly id: string;
  readonly dias: number | null;
  readonly fato: string;
  readonly evidencia: string;
  readonly proposedKind: string | null;
  readonly origem: string | null;
}

/**
 * CLUSTER POR ASSUNTO — componentes conexos do grafo de `provaveisDuplicatas`
 * (union-find): A~B e B~C agrupam {A,B,C} mesmo que A~C sozinho fique abaixo
 * do corte de 60%. Todo candidato pertence a EXATAMENTE um cluster — sem par,
 * cluster de tamanho 1. Isso é o que torna "decidir por tema" possível: 90
 * itens soltos viram N temas, cada um com 1+ candidato.
 *
 * Ordem estável: segue a ordem de `candidatos` (mais antigo primeiro) — o
 * cluster do candidato mais velho aparece primeiro.
 */
export interface Cluster {
  readonly members: readonly string[];
}

export function clusterizarDuplicatas(
  candidatos: readonly { id: string }[],
  pares: readonly [{ id: string }, { id: string }, number][]
): Cluster[] {
  const parent = new Map<string, string>();
  for (const c of candidatos) parent.set(c.id, c.id);

  function find(x: string): string {
    let raiz = x;
    while (parent.get(raiz) !== raiz) {
      const proximo = parent.get(raiz);
      if (proximo === undefined) break;
      raiz = proximo;
    }
    let atual = x;
    while (parent.get(atual) !== raiz) {
      const proximo = parent.get(atual) as string;
      parent.set(atual, raiz);
      atual = proximo;
    }
    return raiz;
  }
  function unir(a: string, b: string): void {
    const ra = find(a);
    const rb = find(b);
    if (ra !== rb) parent.set(ra, rb);
  }
  for (const [a, b] of pares) unir(a.id, b.id);

  const grupos = new Map<string, string[]>();
  for (const c of candidatos) {
    const raiz = find(c.id);
    grupos.set(raiz, [...(grupos.get(raiz) ?? []), c.id]);
  }
  return [...grupos.values()].map((members) => ({ members }));
}

/**
 * SCORING EXPLICÁVEL — soma de sinais FACTUAIS, cada um com peso fixo e
 * documentado. Nunca "qualidade" por heurística inventada: os três sinais já
 * existiam (`hasEvidence`/`evidenceLooksLikeCommand`) ou são o novo EVIDENCE
 * LINKING (`verified`) — este helper só soma e explica, nunca mede algo novo.
 */
export function pontuarCandidato(
  hasEvidence: boolean,
  looksLikeCommand: boolean,
  verified: boolean
): { score: number; reason: string } {
  const partes: string[] = [];
  let score = 0;
  if (hasEvidence) {
    score += 2;
    partes.push("evidência presente (+2)");
  } else {
    partes.push("sem evidência (+0)");
  }
  if (looksLikeCommand) {
    score += 1;
    partes.push("evidência em forma de comando (+1)");
  }
  if (verified) {
    score += 2;
    partes.push("comando/arquivo citado verificado no projeto (+2)");
  }
  return { score, reason: `${partes.join(" · ")} = ${score}` };
}

/**
 * SUPERSEDE SUGGESTIONS — só entre candidatos do MESMO cluster (mesmo
 * assunto). SUGERE, nunca executa: nenhum caller deste helper publica nada.
 * `a` supersede `b` quando `a` é ESTRITAMENTE mais recente (menos dias) E
 * ESTRITAMENTE mais completo (score de evidência maior) — os dois ao mesmo
 * tempo, nunca um só. Empate ou ambiguidade não sugere nada: é melhor
 * silêncio que um palpite com formato de veredito.
 */
export function sugerirSupersede(
  itensDoCluster: readonly { id: string; dias: number | null; completeness: number }[]
): SupersedeSuggestionJson[] {
  const out: SupersedeSuggestionJson[] = [];
  for (const a of itensDoCluster) {
    if (a.dias === null) continue;
    for (const b of itensDoCluster) {
      if (a.id === b.id || b.dias === null) continue;
      if (a.dias < b.dias && a.completeness > b.completeness) {
        out.push({
          newer: a.id,
          older: b.id,
          reason: `${a.id} é mais recente (${a.dias}d vs ${b.dias}d) e tem evidência mais completa (${a.completeness} vs ${b.completeness})`,
        });
      }
    }
  }
  return out;
}

/** `package.json.scripts` do projeto, ou `undefined` se ilegível — EVIDENCE LINKING nunca lança por causa disto. */
async function lerScriptsDoProjeto(root: string): Promise<Readonly<Record<string, string>> | undefined> {
  try {
    const raw = await readFile(path.join(root, "package.json"), "utf8");
    const parsed: unknown = JSON.parse(raw);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return undefined;
    return scripts as Record<string, string>;
  } catch {
    return undefined;
  }
}

const NPM_SCRIPT_RX = /\bnpm\s+(?:run\s+)?([a-zA-Z][\w:-]*)/;
/** `arquivo.ext:linha` — filtra URL (`://`) logo antes do match pra não confundir porta/versão com linha. */
const FILE_LINE_RX = /\b([\w][\w./-]*\.[a-zA-Z]{1,10}):(\d+)\b/g;

/**
 * EVIDENCE LINKING — separa "prova reencontrável" de prosa. `EVIDENCE IS
 * PROSE, NOT A PROBE` continua valendo: os dois sinais aqui provam que o
 * COMANDO/ARQUIVO CITADO EXISTE no projeto, nunca que a afirmação é
 * verdadeira ou que o comando, rodado, confirmaria o fato.
 */
async function linkarEvidencia(
  root: string,
  evidencia: string,
  scripts: Readonly<Record<string, string>> | undefined
): Promise<{ commandExists: boolean; fileRefExists: boolean }> {
  let commandExists = false;
  const npmMatch = NPM_SCRIPT_RX.exec(evidencia);
  const nomeScript = npmMatch?.[1];
  if (nomeScript && scripts && Object.prototype.hasOwnProperty.call(scripts, nomeScript)) {
    commandExists = true;
  }

  let fileRefExists = false;
  FILE_LINE_RX.lastIndex = 0;
  let m: RegExpExecArray | null;
  while ((m = FILE_LINE_RX.exec(evidencia)) !== null) {
    const caminho = m[1];
    if (!caminho) continue;
    const precedidoPorUrl = evidencia.slice(Math.max(0, m.index - 3), m.index) === "://";
    if (precedidoPorUrl) continue;
    try {
      await stat(path.resolve(root, caminho));
      fileRefExists = true;
      break;
    } catch {
      // candidato não existe no disco — tenta o próximo match, se houver.
    }
  }
  return { commandExists, fileRefExists };
}

async function revisarFila(root: string, json = false): Promise<void> {
  // REUSE: mesma coleta de `listar`, mesmo funil canônico. O que muda é a
  // APRESENTAÇÃO — e é a apresentação que estava quebrando a decisão.
  const records = await lerRecords(root);
  const agora = Date.now();
  const candidatos: CandidatoFila[] = records
    .filter((r) => (r as { kind?: string }).kind === "memory_candidate" && !isDeprecated(r))
    .map((r) => {
      const c = contentOf(r);
      const criado = Date.parse(r.created_at);
      return {
        id: r.id,
        dias: Number.isNaN(criado) ? null : Math.floor((agora - criado) / 86_400_000),
        fato: c["fact"] ?? "",
        evidencia: c["evidence"] ?? "",
        proposedKind: c["proposed_kind"] ?? null,
        origem: c["origin_note"] ?? null,
      };
    })
    .sort((a, b) => (b.dias ?? 0) - (a.dias ?? 0));

  if (candidatos.length === 0) {
    if (json) {
      console.log(
        JSON.stringify({
          queue: [],
          clusters: [],
          supersedeSuggestions: [],
          stats: { total: 0, oldestDays: 0, withEvidence: 0, withCommandEvidence: 0 },
        })
      );
    } else {
      console.log(pc.green("Nenhum candidato esperando decisão."));
    }
    return;
  }

  const comEvidencia = candidatos.filter((c) => c.evidencia.trim() !== "").length;
  const comComando = candidatos.filter((c) => PARECE_COMANDO.test(c.evidencia)).length;
  const maisVelho = candidatos[0]?.dias ?? 0;
  // DUPLICATA (0.6, likelyDuplicateOf) e TEMA (0.10 + origin_note, cluster) são
  // perguntas diferentes — dois limiares, nunca um reusado pro outro (era o
  // defeito medido: 98 candidatos, 98 temas, porque cluster usava o limiar de
  // duplicata). Ver a docstring de `paresPorTema`.
  /**
   * JÁ COBERTO — candidato cuja lição já está no acervo PROMOVIDO.
   *
   *   DEDUPE ENTRE CANDIDATOS NÃO É DEDUPE CONTRA O ACERVO
   *
   * MEDIDO em 2026-09-19: a fila tinha 114 candidatos e o review comparava
   * candidato com candidato. Nove deles já existiam como gotcha promovido, seis
   * com similaridade 1.00 — texto idêntico. Eram decisões humanas pedidas para
   * conhecimento que já estava canônico.
   *
   * O limiar 0.35 é de JACCARD sobre termos, mais alto que o de tema (0.10) e
   * mais baixo que o de duplicata exata: aqui o custo de um falso positivo é
   * esconder um candidato legítimo, então erra para o lado de mostrar.
   */
  const promovidos = records
    .filter((r) => (r as { kind?: string }).kind === "gotcha" && !isDeprecated(r))
    .map((r) => {
      const c = contentOf(r);
      return { id: r.id, termos: termosDe(`${c["title"] ?? ""} ${c["rule"] ?? ""}`) };
    });

  const jaCoberto = new Map<string, { promovidoId: string; similaridade: number }>();
  for (const cand of candidatos) {
    const tc = termosDe(cand.fato);
    if (tc.size === 0) continue;
    let melhor = 0;
    let alvo: string | null = null;
    for (const prom of promovidos) {
      if (prom.termos.size === 0) continue;
      let inter = 0;
      for (const t of tc) if (prom.termos.has(t)) inter += 1;
      const jaccard = inter / (tc.size + prom.termos.size - inter);
      if (jaccard > melhor) {
        melhor = jaccard;
        alvo = prom.id;
      }
    }
    if (alvo && melhor >= 0.35) jaCoberto.set(cand.id, { promovidoId: alvo, similaridade: Math.round(melhor * 100) / 100 });
  }

  const pares = provaveisDuplicatas(candidatos);

  const dupsPorId = new Map<string, string[]>();
  for (const par of pares) {
    const [a, b] = [par[0].id, par[1].id];
    dupsPorId.set(a, [...(dupsPorId.get(a) ?? []), b]);
    dupsPorId.set(b, [...(dupsPorId.get(b) ?? []), a]);
  }

  const paresTema = paresPorTema(candidatos);
  const clusters = clusterizarDuplicatas(candidatos, paresTema);
  const clusterIdPorCandidato = new Map<string, number>();
  clusters.forEach((cluster, idx) => {
    for (const id of cluster.members) clusterIdPorCandidato.set(id, idx);
  });

  // EVIDENCE LINKING — uma leitura de package.json, N verificações de disco.
  const scripts = await lerScriptsDoProjeto(root);
  const linkagem = new Map<string, { commandExists: boolean; fileRefExists: boolean }>();
  for (const c of candidatos) {
    linkagem.set(c.id, await linkarEvidencia(root, c.evidencia, scripts));
  }

  const completenessPorId = new Map<string, number>();
  const pontuacaoPorId = new Map<string, { score: number; reason: string }>();
  for (const c of candidatos) {
    const link = linkagem.get(c.id) ?? { commandExists: false, fileRefExists: false };
    const hasEvidence = c.evidencia.trim() !== "";
    const looksLikeCommand = PARECE_COMANDO.test(c.evidencia);
    const verified = link.commandExists || link.fileRefExists;
    completenessPorId.set(c.id, (hasEvidence ? 1 : 0) + (looksLikeCommand ? 1 : 0) + (verified ? 1 : 0));
    pontuacaoPorId.set(c.id, pontuarCandidato(hasEvidence, looksLikeCommand, verified));
  }

  const supersedeSuggestions: SupersedeSuggestionJson[] = [];
  for (const cluster of clusters) {
    if (cluster.members.length < 2) continue;
    const itensDoCluster = cluster.members.map((id) => {
      const c = candidatos.find((x) => x.id === id);
      return { id, dias: c?.dias ?? null, completeness: completenessPorId.get(id) ?? 0 };
    });
    supersedeSuggestions.push(...sugerirSupersede(itensDoCluster));
  }

  function porQueImporta(c: CandidatoFila): string {
    const link = linkagem.get(c.id) ?? { commandExists: false, fileRefExists: false };
    const verified = link.commandExists || link.fileRefExists;
    const evidenciaTxt = verified ? "evidência verificável" : c.evidencia.trim() !== "" ? "com evidência" : "sem evidência";
    const clusterSize = clusters[clusterIdPorCandidato.get(c.id) ?? -1]?.members.length ?? 1;
    const clusterTxt = clusterSize > 1 ? `, agrupado com mais ${clusterSize - 1} candidato(s) sobre o mesmo tema` : "";
    return `${c.proposedKind ?? "candidato"} proposto há ${c.dias ?? "?"}d, ${evidenciaTxt}${clusterTxt}.`;
  }

  if (json) {
    const queue: FilaItemJson[] = candidatos.map((c) => {
      const link = linkagem.get(c.id) ?? { commandExists: false, fileRefExists: false };
      const pontuacao = pontuacaoPorId.get(c.id) ?? { score: 0, reason: "" };
      return {
        id: c.id,
        days: c.dias,
        hasEvidence: c.evidencia.trim() !== "",
        evidenceLooksLikeCommand: PARECE_COMANDO.test(c.evidencia),
        evidenceCommandExists: link.commandExists,
        evidenceFileRefExists: link.fileRefExists,
        proposedKind: c.proposedKind,
        fact: c.fato,
        origin: c.origem,
        likelyDuplicateOf: dupsPorId.get(c.id) ?? [],
        clusterId: clusterIdPorCandidato.get(c.id) ?? -1,
        score: pontuacao.score,
        scoreReason: pontuacao.reason,
        whyItMatters: porQueImporta(c),
      };
    });
    const clustersJson: ClusterJson[] = clusters.map((cluster, idx) => ({
      id: idx,
      memberIds: cluster.members,
      size: cluster.members.length,
    }));
    console.log(
      JSON.stringify({
        queue,
        clusters: clustersJson,
        supersedeSuggestions,
        stats: {
          total: candidatos.length,
          oldestDays: maisVelho,
          withEvidence: comEvidencia,
          withCommandEvidence: comComando,
        },
      })
    );
    return;
  }

  console.log(pc.bold(`Fila de decisão: ${candidatos.length} candidato(s) esperando o humano no terminal.`));
  console.log(
    pc.dim(
      `  mais antigo: ${maisVelho} dia(s) · com evidência: ${comEvidencia} · ` +
        `com evidência em forma de comando: ${comComando} · ${clusters.length} tema(s)`
    )
  );
  /**
   * O NÚMERO QUE IMPORTA É QUANTAS DECISÕES SOBRAM, NÃO QUANTOS ITENS HÁ.
   *
   * Cada cluster é UMA decisão (promover o representante, descartar o resto),
   * e candidato já coberto pelo acervo não é decisão nenhuma. Sem esta linha,
   * a fila anuncia 114 e quem lê desiste antes de começar.
   */
  if (jaCoberto.size > 0) {
    const emCluster = clusters.reduce((n, c) => n + (c.members.length > 1 ? c.members.length : 0), 0);
    const clustersReais = clusters.filter((c) => c.members.length > 1).length;
    const decisoes = candidatos.length - jaCoberto.size - emCluster + clustersReais;
    console.log(
      pc.dim(
        `  ${jaCoberto.size} já estão no acervo promovido (descartáveis sem decisão) · ` +
          `${emCluster} caem em ${clustersReais} tema(s) agrupado(s)\n` +
          `  DECISÕES HUMANAS REAIS: ${decisoes}`
      )
    );
    console.log(pc.dim(`\n  Já cobertos por gotcha promovido:`));
    for (const [cid, info] of [...jaCoberto].slice(0, 12)) {
      const cand = candidatos.find((c) => c.id === cid);
      console.log(
        pc.dim(`    ${cid} ~ ${info.promovidoId} (${info.similaridade}) — ${(cand?.fato ?? "").slice(0, 72)}`)
      );
    }
  }

  const clustersComMaisDeUm = clusters.filter((c) => c.members.length > 1);
  if (clustersComMaisDeUm.length > 0) {
    console.log("");
    console.log(pc.yellow(`Temas com mais de um candidato (${clustersComMaisDeUm.length}):`));
    for (const cluster of clustersComMaisDeUm) {
      console.log(`  cluster de ${cluster.members.length}: ${cluster.members.join(", ")}`);
      const sugestoes = supersedeSuggestions.filter((s) => cluster.members.includes(s.newer));
      for (const s of sugestoes) {
        console.log(pc.dim(`        sugestão: ${s.newer} supersede ${s.older} — ${s.reason}`));
      }
    }
  }

  console.log("");
  console.log(pc.bold("Mais antigos primeiro — o topo é o que está morrendo:"));
  for (const c of candidatos.slice(0, 15)) {
    const pontuacao = pontuacaoPorId.get(c.id) ?? { score: 0, reason: "" };
    console.log(`  ${c.id}  ${String(c.dias ?? "?").padStart(3)}d  nota ${pontuacao.score}/5`);
    console.log(`     ${c.fato.slice(0, 120)}`);
    console.log(pc.dim(`     ${pontuacao.reason}`));
    console.log(pc.dim(`     ${porQueImporta(c)}`));
  }
  if (candidatos.length > 15) {
    console.log(
      pc.dim(
        `  ... e mais ${candidatos.length - 15}. Não pagina de propósito: a fila inteira não cabe numa decisão só.`
      )
    );
  }

  console.log("");
  console.log(pc.dim('  admitir: nexos memory --promote <id> --why "<motivo>"  (exige terminal controlador)'));
  console.log(pc.dim('  recusar: nexos memory --deprecate <id> --why "<motivo>" --by <ator>'));
}

/** Evidência que tem FORMA de comando — sinal factual, nunca prova de que roda. */
export const PARECE_COMANDO = /(^|\s)(npm|npx|node|git|grep|rg|find|python3?|nexos|curl|ls|cat)\s/;

/** Sobreposição de tokens entre fatos. Jaccard puro, sem modelo, sem inventar semântica. */
/** Extraído de `provaveisDuplicatas` pra ser reusado por `paresPorTema` — MESMA tokenização, dois limiares diferentes. */
function tokenizarFato(t: string): Set<string> {
  return new Set(
    t
      .toLowerCase()
      .replace(/[^a-z0-9áéíóúâêôãõç\s]/g, " ")
      .split(/\s+/)
      .filter((w) => w.length > 4)
  );
}

/** Pares por sobreposição de tokens acima de `limiar` — o motor que `provaveisDuplicatas` e `paresPorTema` compartilham. */
function paresPorSobreposicao(
  cands: readonly { id: string; fato: string }[],
  limiar: number
): [{ id: string; fato: string }, { id: string; fato: string }, number][] {
  const prep = cands.map((c) => ({ c, t: tokenizarFato(c.fato) }));
  const out: [{ id: string; fato: string }, { id: string; fato: string }, number][] = [];
  for (let i = 0; i < prep.length; i += 1) {
    for (let j = i + 1; j < prep.length; j += 1) {
      const a = prep[i];
      const b = prep[j];
      if (a === undefined || b === undefined || a.t.size === 0 || b.t.size === 0) continue;
      let inter = 0;
      for (const w of a.t) if (b.t.has(w)) inter += 1;
      const uniao = a.t.size + b.t.size - inter;
      const taxa = uniao === 0 ? 0 : inter / uniao;
      if (taxa >= limiar) out.push([a.c, b.c, taxa]);
    }
  }
  return out.sort((x, y) => y[2] - x[2]);
}

/** Sobreposição de tokens entre fatos. Jaccard puro, sem modelo, sem inventar semântica. */
export function provaveisDuplicatas(
  cands: readonly { id: string; fato: string }[]
): [{ id: string; fato: string }, { id: string; fato: string }, number][] {
  return paresPorSobreposicao(cands, 0.6);
}

/**
 * `origin_note` default do CLI quando `--origin` não é passado (`propor`,
 * `originNote: options.origin ?? "declarado na linha de comando"`) — NÃO é
 * sinal de origem, é ausência disfarçada de string. MEDIDO (18/09, 98
 * candidatos reais): 26 dos 98 carregam este valor EXATO, sem relação
 * nenhuma entre si além de "ninguém passou --origin" — agrupá-los por essa
 * string faria um cluster de 26 itens não-relacionados, o oposto do que
 * cluster por tema promete. `ABSENCE = FIELD ABSENT` aplicado a um campo
 * que É string: valor-sentinela não é dado, mesmo parecendo um.
 */
const ORIGEM_SEM_SINAL = "declarado na linha de comando";

/**
 * CLUSTER POR TEMA — limiar PRÓPRIO, deliberadamente MENOR que o de
 * DUPLICATA (`provaveisDuplicatas`, 0.6). "Duplicata" e "mesmo tema" são
 * perguntas diferentes, e o limiar de duplicata nunca deveria ter sido
 * usado para a outra (era o defeito medido: 98 candidatos, 98 temas — o
 * cluster não agrupava nada).
 *
 * MEDIDO no acervo real (18/09, 98 candidatos): a similaridade MÁXIMA entre
 * dois `fact` quaisquer é 0.168 — nenhum par bate 0.6, e a distribuição
 * inteira vive abaixo de 0.09 no p99. Testei 0.15/0.12/0.10/0.08 e inspecionei
 * os clusters resultantes: em 0.08 a TRANSITIVIDADE do union-find funde 23
 * candidatos num blob só, através de vocabulário genérico comum a quase todo
 * gotcha deste projeto ("nexos", "checkpoint", "store") — dois candidatos SEM
 * relação real ficam no mesmo cluster por uma cadeia de vizinhos fracos. Em
 * 0.10 os clusters resultantes são coerentes por inspeção manual (ex.: 7
 * candidatos, todos sobre drift de assets/hooks do host; 6, quase todos
 * "Donor maestro") sem fundir temas diferentes. 0.10 é o ponto MEDIDO onde a
 * transitividade para de acumular ruído — não um meio-termo arbitrário.
 *
 * SEGUNDO SINAL, ortogonal ao texto: `origin_note` IDÊNTICO (exceto o
 * sentinela `ORIGEM_SEM_SINAL`) — candidatos da MESMA investigação/sessão
 * frequentemente compartilham pouco vocabulário no `fact` (frases técnicas
 * específicas) mas vieram do MESMO lugar, um fato factual e não uma leitura
 * de linguagem. Os dois sinais se somam por OR (união de arestas antes de
 * `clusterizarDuplicatas`) — um cluster nasce de QUALQUER um dos dois.
 */
const LIMIAR_TEMA = 0.1;

export function paresPorTema(
  cands: readonly { id: string; fato: string; origem: string | null }[]
): [{ id: string; fato: string }, { id: string; fato: string }, number][] {
  const porTexto = paresPorSobreposicao(cands, LIMIAR_TEMA);

  const porOrigem: [{ id: string; fato: string }, { id: string; fato: string }, number][] = [];
  const porOrigemAgrupado = new Map<string, { id: string; fato: string }[]>();
  for (const c of cands) {
    const origem = (c.origem ?? "").trim();
    if (origem === "" || origem === ORIGEM_SEM_SINAL) continue;
    porOrigemAgrupado.set(origem, [...(porOrigemAgrupado.get(origem) ?? []), { id: c.id, fato: c.fato }]);
  }
  for (const grupo of porOrigemAgrupado.values()) {
    for (let i = 1; i < grupo.length; i += 1) {
      const primeiro = grupo[0];
      const atual = grupo[i];
      if (primeiro && atual) porOrigem.push([primeiro, atual, 1]);
    }
  }

  return [...porTexto, ...porOrigem];
}


/**
 * MEM-RETRIEVAL — o CONSUMIDOR do log de recuperação.
 *
 *     PRODUTOR SEM CONSUMIDOR VIRA CAMPO MORTO
 *
 * Este projeto já mediu um campo `freshness` com 379 `current`, 37 `unknown`,
 * ZERO `stale` e nenhum leitor no código — escrito por anos, lido por ninguém.
 * O log de injeções nasce junto com quem o lê, para não repetir isso.
 *
 * Read-only e derivado: não toca o Store, não promove nada, não decide nada.
 * Responde duas perguntas que até hoje não tinham resposta —
 * **o que foi recuperado** e **quanto contexto foi injetado**.
 */
async function relatarRecuperacoes(root: string, json: boolean): Promise<void> {
  const { linhas, ilegiveis } = await lerRecuperacoes(root);

  if (linhas.length === 0) {
    if (json) {
      console.log(JSON.stringify({ total: 0, arquivo: retrievalLogPath(root) }, null, 2));
      return;
    }
    console.log("  Nenhuma injecao registrada ainda.");
    console.log(`  O log nasce na primeira vez que o hook de recall rodar: ${retrievalLogPath(root)}`);
    return;
  }

  const num = (v: unknown): number => (typeof v === "number" && Number.isFinite(v) ? v : 0);
  const str = (v: unknown): string => (typeof v === "string" ? v : "");
  const arr = (v: unknown): readonly string[] => (Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : []);

  const comInjecao = linhas.filter((l) => str(l["estado"]) === "RECALL");
  const vazias = linhas.filter((l) => str(l["estado"]) === "EMPTY");
  const bytes = linhas.reduce((a, l) => a + num(l["bytes"]), 0);

  /** Quantas vezes CADA record chegou ao modelo — o `knowledge retrieved` por item. */
  const porRecord = new Map<string, number>();
  for (const l of linhas) {
    for (const id of [...arr(l["mostrados"]), ...arr(l["nomeados"])]) {
      porRecord.set(id, (porRecord.get(id) ?? 0) + 1);
    }
  }

  const sessoes = new Set(linhas.map((l: RetrievalLine) => str(l["sessao"])).filter((x: string) => x.length > 0));
  const primeira = str(linhas[0]?.["at"]);
  const ultima = str(linhas[linhas.length - 1]?.["at"]);

  if (json) {
    console.log(
      JSON.stringify(
        {
          total: linhas.length,
          com_injecao: comInjecao.length,
          sem_injecao: vazias.length,
          ilegiveis,
          sessoes: sessoes.size,
          bytes_injetados: bytes,
          records_distintos: porRecord.size,
          primeira,
          ultima,
          por_record: [...porRecord].sort((a, b) => b[1] - a[1]).map(([id, n]) => ({ id, vezes: n })),
          arquivo: retrievalLogPath(root),
        },
        null,
        2
      )
    );
    return;
  }

  console.log(`  ${linhas.length} injecao(oes) registrada(s) em ${sessoes.size} sessao(oes)`);
  console.log(`    com memoria recuperada: ${comInjecao.length} · sem nada a recuperar: ${vazias.length}`);
  console.log(`    contexto injetado: ${bytes} bytes · records distintos: ${porRecord.size}`);
  if (ilegiveis > 0) console.log(`    linhas ilegiveis puladas: ${ilegiveis}`);
  if (primeira !== "") console.log(`    de ${primeira} ate ${ultima}`);

  /**
   * O que a pergunta "a memoria certa chega na tarefa certa?" precisa: QUAL
   * conhecimento foi efetivamente entregue, e quantas vezes. Um record que
   * nunca aparece aqui pode estar correto e ser inalcancavel — e essa e uma
   * conclusao diferente de "nao existe".
   */
  const top = [...porRecord].sort((a, b) => b[1] - a[1]).slice(0, 10);
  if (top.length > 0) {
    console.log("");
    console.log("  mais recuperados:");
    for (const [id, n] of top) console.log(`    ${String(n).padStart(4)}x  ${id}`);
  }

  console.log("");
  console.log(`  RECUPERADO NAO E APLICADO — isto mede o que chegou ao modelo, nunca o que ele usou.`);
}
