import pc from "picocolors";
import { readCurrentRecords, contentOf } from "../lib/capsule/reader.js";
import { recordParaJson, falhaJson, falhaSeAnomaliaRelevante } from "../lib/capsule/record-json.js";
import {
  publishSuperseding,
  publishCanonical,
  StoreBoundaryError,
  HeadRaceExhaustedError,
} from "../lib/capsule/store.js";
import { SecretMaterialError } from "../lib/capsule/secret-guard.js";
import { newRecordId } from "../lib/capsule/ids.js";
import { classifyForReconciliation } from "../lib/capsule/migration-classifier.js";
import { resolveCommandRoot } from "../lib/project-resolver.js";
import { forProject } from "../lib/capsule/paths.js";
import { resolveHeadsBySource, headFor } from "../lib/capsule/head-resolver.js";
import { resolveReadRoot } from "../lib/capsule/authority.js";
import {
  validateManifest,
  resolveWorkState,
  evidenceRefsExternas,
  documentoDelegado,
} from "../lib/capsule/schemas.js";
import { parseCanonical } from "../lib/capsule/codec.js";
import { systemGitRunner } from "../lib/capsule/git-boundary.js";
import { loadEvidence } from "../lib/evidence.js";
import { writeStatuslineSnapshot } from "../lib/statusline-snapshot.js";
import fs from "fs-extra";
import type { CapsuleRecord, Deprecation } from "../lib/capsule/schemas.js";

/**
 * `nexos state` — o "onde paramos" como record CANÔNICO.
 *
 *   STATE IS A SNAPSHOT != STATE IS HISTORY LOG
 *   PORTABLE KNOWLEDGE != OPERATIONAL STATE
 *
 * Medido em 14/08 no próprio nexos-cli: um clone recupera 68 decisões e 7
 * gotchas, e não sabe onde o trabalho parou. Estado e próxima ação viviam só em
 * `state.md` / `PROXIMA-SESSAO.md`, que são markdown local e não atravessam
 * clone. O projeto que desenvolve o produto não usava a arquitetura do produto.
 *
 * Este comando fecha esse buraco pelo caminho do produto — sem editar arquivo
 * canônico à mão, sem inventar segunda autoridade.
 */

const SOURCE_REF = "nexos://project-state";

export interface StateOptions {
  /** Só leitura: o estado atual em JSON (contrato de `record-json.ts`). */
  json?: boolean;
  cwd?: string;
  set?: string;
  next?: string;
  blocker?: string;
  /** Para onde o trabalho vai — distinto de `--set` (onde ESTÁ). */
  goal?: string;
  /** Pergunta exata que só um humano decide — marca o work-state HUMAN_DECISION_REQUIRED. */
  decision?: string;
  /** O que foi atingido — marca o work-state COMPLETE. */
  complete?: string;
  title?: string;
  /** Referência a uma evidência observada (`ev_…`), quando houver. */
  verified?: string;
}

/**
 * Gate de abertura de capsule, compartilhado por `state` e `state-reconcile`.
 *
 *   CREATE != RECONCILE   ·   LEGACY_TOLERATED != PORTABLE
 *
 * `initializeCapsule` recusa `.nexos` com legado — e está certo, porque CRIAR
 * por cima de legado destruiria a fonte. Mas ESCREVER estado numa capsule que
 * já tem manifest e records não é criar: o próprio nexos-cli convive com
 * `memory/`, `logs/` e `dev-scripts/`, os três LEGACY_TOLERATED de C12.4, e
 * mesmo assim tem identidade canônica e Store legível.
 *
 * Extraído de `state()` sem mudar comportamento: `state-reconcile` precisa do
 * MESMO gate (mesmo manifest, mesmo projectId), e duplicar o bloco seria dois
 * lugares para o gate divergir.
 */
async function abrirCapsule(root: string): Promise<{ projectId: string; projectName: string } | undefined> {
  const pre = await classifyForReconciliation(root);
  if (!pre.hasCanonical) {
    console.log(pc.yellow("  ! este projeto não tem Store."));
    console.log(pc.dim("    rode `nexos init` primeiro — estado canônico exige identidade canônica."));
    process.exitCode = 1;
    return undefined;
  }
  if (!pre.reconcilable) {
    console.log(pc.yellow(`  ! \`.nexos\` tem entrada não reconhecida: ${pre.conflicting.join(", ")}`));
    console.log(pc.dim("    FAIL CLOSED — nada foi escrito."));
    process.exitCode = 1;
    return undefined;
  }

  const manifesto = validateManifest(
    parseCanonical(await fs.readFile(forProject(root).manifest(), "utf-8"))
  );
  if (!manifesto.ok) {
    console.log(pc.red(`  x manifest inválido: ${manifesto.errors.join("; ")}`));
    process.exitCode = 1;
    return undefined;
  }
  if (!manifesto.value.project) {
    console.log(pc.red(`  x manifest de ${root} não declara project (scope="${manifesto.value.scope}") — state exige um projeto`));
    process.exitCode = 1;
    return undefined;
  }
  if (pre.legacyTolerated.length > 0) {
    console.log(pc.dim(`  ~ legado tolerado ao lado do canônico: ${pre.legacyTolerated.join(", ")}`));
  }
  return { projectId: manifesto.value.project.id, projectName: manifesto.value.project.name };
}

/**
 * `--verified` ausente numa mudança semântica não é erro — é um vínculo
 * claim→evidência que ficou vazio quando já existia observação para o HEAD
 * atual. AVISA, nunca bloqueia nem auto-elege: `A CLAIM IS NOT ITS OWN
 * EVIDENCE`, e escolher a evidência pelo autor seria o mesmo defeito ao
 * contrário.
 *
 * ponytail: HEAD não resolvível ou nenhuma evidência do commit fica
 * silencioso — teto proposital; upgrade cabível é a mesma checagem no boot
 * (SessionStart), não aqui.
 */
async function avisarSemEvidenciaLigada(root: string): Promise<void> {
  const rev = await systemGitRunner().run(["-C", root, "rev-parse", "HEAD"]);
  const headSha = rev.ok && rev.code === 0 ? rev.stdout.trim() : undefined;
  if (!headSha) return;

  const daHead = (await loadEvidence(root)).filter(
    (e) => e.commit === headSha && e.tree_state === "clean"
  );
  if (daHead.length === 0) return;

  const recente = daHead.reduce((a, b) => (a.finished_at >= b.finished_at ? a : b));
  console.error(
    `AVISO: snapshot sem --verified — ${daHead.length} evidência(s) para HEAD ${headSha.slice(0, 7)} · ` +
      `mais recente: ${recente.id} (${recente.gate} · ${recente.finished_at} · exit ${recente.exit_code})`
  );
}

export async function state(options: StateOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  if (options.json) {
    const escrita = [options.set, options.next, options.blocker, options.goal, options.decision, options.complete, options.title, options.verified];
    if (escrita.some((v) => v !== undefined)) {
      falhaJson("JSON_SO_LEITURA", "--json não combina com --set/--next/--blocker/--goal/--decision/--complete/--title/--verified");
      return;
    }
    /**
     * N1 (rodada 2) — `families: ["KnowledgeRecord"]` escopa a leitura (e a
     * detecção de anomalia) à family de `project_state`; sem isto, uma
     * anomalia em QUALQUER outra family (Decision, Research, ...) derrubava
     * `state --json` mesmo com o estado saudável. `falhaSeAnomaliaRelevante`
     * ainda filtra por `sourceRef === SOURCE_REF` — só existe UM
     * `project_state` por projeto, então a identidade exata é conhecida sem
     * I/O extra: uma anomalia em outro `KnowledgeRecord` (um gotcha quebrado,
     * por exemplo) também não pode derrubar esta saída.
     */
    const r = await readCurrentRecords(root, { kind: "project_state", families: ["KnowledgeRecord"] });
    if (!r.ok) {
      falhaJson("STORE_ILEGIVEL", r.issues.map((i) => i.code));
      return;
    }
    if (falhaSeAnomaliaRelevante(r.anomalies, { family: "KnowledgeRecord", sourceRef: SOURCE_REF })) return;
    const atual = r.records.find((x) => x.sourceRef === SOURCE_REF);
    const estado = atual ? { ...recordParaJson(atual), work: resolveWorkState(contentOf(atual.record)) ?? null } : null;
    console.log(JSON.stringify({ state: estado }, null, 2));
    return;
  }

  const capsula = await abrirCapsule(root);
  if (!capsula) return;
  const { projectId, projectName } = capsula;

  /** Sem NENHUMA flag, o comando LÊ. Ler nunca escreve. */
  const semFlags =
    !options.set &&
    !options.next &&
    !options.blocker &&
    !options.goal &&
    !options.decision &&
    !options.complete &&
    !options.title &&
    !options.verified;
  if (semFlags) {
    await mostrar(root);
    return;
  }

  const anterior = await headAtual(root);
  const now = new Date().toISOString();

  /**
   * Validação de UX rápida, contra a primeira leitura — sai ANTES de tocar
   * disco quando o pedido já é inválido. Sob concorrência real o head pode
   * mudar entre esta leitura e a publicação; `montarConteudo` é reaplicada
   * dentro do `buildRecord` do CAS abaixo, contra o head FRESCO de cada
   * tentativa — nunca herda de um head que já foi superado por outro escritor.
   */
  const primeiraTentativa = montarConteudo(anterior, options);
  if (!primeiraTentativa.ok) {
    console.log(pc.red(`  x ${primeiraTentativa.error}`));
    console.log(pc.dim(`    ${primeiraTentativa.detail}`));
    process.exitCode = 1;
    return;
  }

  if (options.verified === undefined && primeiraTentativa.mudancaSemantica) {
    await avisarSemEvidenciaLigada(root);
  }

  /**
   * REABERTURA DE LINHAGEM DEPRECIADA — AVISA e publica, nao recusa.
   *
   *   REVIVING A LINEAGE != SILENTLY REVIVING A LINEAGE
   *   HOT PATH REFUSAL != FREE REFUSAL
   *
   * Mesmo defeito medido em 38b4b46 que `nexos gotcha` fecha com `--reopen`, e
   * a decisao OPOSTA de proposito. `nexos state --set` e o comando obrigatorio
   * de fim de sessao (CLAUDE.md): recusar aqui nao adia uma escrita, DESTROI o
   * unico registro de onde a sessao parou — dado que so existe naquele
   * instante e nao e reproduzivel depois. O custo de barrar e maior que o de
   * reabrir, entao o portao e visibilidade: o autor le o aviso, o record grava
   * `reopens` com o motivo antigo, e ninguem descobre a reabertura por
   * arqueologia.
   *
   * Aviso e `stdout` junto do resto do comando, nao um canal separado: quem le
   * a saida de `nexos state` e exatamente quem precisa ver isto.
   */
  if (anterior?.deprecation) {
    console.log(pc.yellow(`  ! "${SOURCE_REF}" esta DEPRECIADA — este snapshot a torna corrente de novo.`));
    console.log(pc.dim(`    motivo da depreciacao: ${anterior.deprecation.reason}`));
    console.log(pc.dim(`    depreciada por: ${anterior.deprecation.actor_ref}`));
    console.log(pc.dim("    a reabertura fica gravada em `reopens` no record novo."));
  }

  /**
   * DELEGAÇÃO DE CONTINUIDADE — AVISA e publica, nao recusa.
   *
   *   STORE = AUTORIDADE  ·  MARKDOWN = PROJECAO
   *   HOT PATH REFUSAL != FREE REFUSAL
   *
   * Mesma decisao, e pelo mesmo motivo, do aviso de reabertura logo acima:
   * `nexos state --set` e o comando obrigatorio de fim de sessao, e recusar
   * aqui nao adia uma escrita, DESTROI o unico registro de onde a sessao
   * parou. Nao ha versao "melhor" do snapshot esperando ser reescrita — ha o
   * snapshot ou nada.
   *
   * Difere de `--cause` exige `--evidence` (`gotcha.ts`) de proposito, e a
   * diferenca e o CUSTO DE BARRAR, nao a gravidade: `nexos gotcha` roda quando
   * o autor escolhe, e barrar so o faz digitar mais uma flag. Aqui barrar
   * apaga dado irreproduzivel. O que os dois compartilham e a forma da
   * mensagem — dizer o PORQUE, nao so recusar.
   *
   * SO sobre `options.next`: o que o autor esta escrevendo AGORA, nunca o
   * `next_action` herdado do head. Avisar sobre texto herdado faria o alarme
   * tocar em toda escrita parcial (`--set` sozinho) ate alguem reescrever o
   * campo — e alarme que toca sempre e alarme desligado.
   */
  const delegado = documentoDelegado(options.next);
  if (delegado) {
    console.log(pc.yellow(`  ! \`--next\` manda LER "${delegado}" — a continuidade fica no arquivo, nao no Store.`));
    console.log(
      pc.dim(
        "    markdown nao atravessa clone e envelhece sozinho: se esse arquivo sumir,\n" +
          "    mudar de branch ou nunca ser commitado, a proxima sessao retoma no vazio\n" +
          "    e nada reclama. Escreva o proximo passo AQUI; cite o arquivo como apoio.\n" +
          "    Publicado assim mesmo — snapshot perdido custa mais que snapshot fraco."
      )
    );
  }

  /** Identidade fixa por chamada — só o `supersedes` e o `content` herdado mudam entre tentativas do CAS. */
  const id = newRecordId("KnowledgeRecord");

  try {
    const { outcome, record } = await publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef: SOURCE_REF,
      readHead: () => headAtual(root),
      buildRecord: (head) => {
        const m = montarConteudo(head, options);
        if (!m.ok) throw new StoreBoundaryError(m.error);

        const content: Record<string, string> = { title: m.title, current_state: m.current_state };
        if (m.global_goal) content.global_goal = m.global_goal;
        if (m.next_action) content.next_action = m.next_action;
        if (m.blocker) content.blocker = m.blocker;
        if (m.decision_question) content.decision_question = m.decision_question;
        if (m.complete) content.complete = m.complete;
        if (m.last_verified) content.last_verified = m.last_verified;

        const refsExternas = evidenceRefsExternas(
          SOURCE_REF,
          m.last_verified ? [SOURCE_REF, m.last_verified] : [SOURCE_REF]
        );

        return {
          schema_version: 1,
          id,
          project_id: projectId,
          family: "KnowledgeRecord",
          kind: "project_state",
          scope: "project",
          origin: "agent",
          provenance: { source_ref: SOURCE_REF, producer_id: "nexos-state", submitted_at: now },
          lifecycle: "immutable",
          portability: "portable",
          regenerable: false,
          admission: {
            status: "admitted",
            /**
             * SEMPRE "policy:nexos-state" — SELF-EVOLUTION != SELF-TRUST (ADR-036).
             * Nunca houve `--approved-by` exposto neste comando; o campo aceitava
             * `options.approvedBy` de qualquer chamador programático mesmo assim
             * (STORE AUTHORITY BOUNDARY V1, Frente B: removido por consistência —
             * o mesmo defeito que a flag pública de `gotcha`/`checkpoint` tinha,
             * só sem CLI wiring que o expusesse ainda).
             */
            approved_by: "policy:nexos-state",
            approved_at: now,
          },
          sensitivity: { classification: "internal", checked_at: now, checker_version: "nexos-state-1" },
          /**
           * `SOURCE_REF` saiu daqui: `nexos://project-state` é o nome DESTE
           * record, e um snapshot citando o próprio nome não sustenta nada
           * (`A CLAIM IS NOT ITS OWN EVIDENCE`). Sem `--last-verified` o campo
           * some inteiro — `ABSENCE = FIELD ABSENT`, e um array vazio afirmaria
           * "procurei e não achei", que é observação que ninguém fez.
           */
          ...(refsExternas.length > 0 ? { evidence_refs: refsExternas } : {}),
          created_at: now,
          version: 1,
          content,
          /**
           * Snapshot novo SUPERSEDE o head desta tentativa — não acumula.
           * `RECENCY != AUTHORITY`: quem decide o head é a topologia de
           * `supersedes`, não o relógio.
           */
          ...(head ? { supersedes: head.id } : {}),
          /** Do head que ESTA tentativa supersede, nunca do lido para o aviso acima. */
          ...(head?.deprecation ? { reopens: head.deprecation } : {}),
        } as unknown as CapsuleRecord;
      },
    });

    console.log(
      outcome === "CREATED"
        ? pc.green(`  + estado publicado — ${record.id}`)
        : pc.yellow(`  = ${outcome}`)
    );
    const supersedeu = (record as { supersedes?: string }).supersedes;
    if (supersedeu) console.log(pc.dim(`    supersede ${supersedeu}`));

    const titulo = contentOf(record).title;
    await writeStatuslineSnapshot(root, {
      project_name: projectName,
      ...(titulo ? { state_title: titulo } : {}),
    });

    console.log();
    await mostrar(root);
  } catch (error) {
    /**
     * `SecretMaterialError` entra aqui pelo mesmo motivo que entrou em
     * `gotcha.ts` e `memory.ts`: a recusa do secret-guard está certa, a
     * apresentação não. Sem esta linha, `nexos state --set` com padrão de
     * credencial despeja stack de `dist/lib/capsule/secret-guard.js` no
     * terminal — e stack crua é onde o usuário procura o valor recusado.
     */
    if (
      error instanceof StoreBoundaryError ||
      error instanceof HeadRaceExhaustedError ||
      error instanceof SecretMaterialError
    ) {
      console.log(pc.red(`  x ${error.message}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}

/**
 * PARTIAL UPDATE É O PADRÃO — nunca reconstruir do zero.
 *
 *   OMITTED FLAG != RESET FIELD
 *
 * O head passado entra como base; só os campos com flag explícita mudam. Sem
 * isto, `--next` sozinho apagava `current_state` (campo nunca escrito no
 * record novo) e omitir `--title`/`--verified` resetava título e gate
 * verificado — o único escritor do Store canônico perdia dado por padrão a
 * cada chamada parcial.
 *
 * Reaplicada a cada tentativa do CAS contra o head FRESCO — nunca contra um
 * head que a leitura inicial já tinha, e que outro escritor pode ter
 * superado entretanto.
 */
type ConteudoMontado =
  | {
      ok: true;
      title: string;
      current_state: string;
      global_goal?: string;
      next_action?: string;
      blocker?: string;
      decision_question?: string;
      complete?: string;
      last_verified?: string;
      /** Exposto para o chamador decidir o aviso de `--verified` ausente — mesmo booleano, sem recomputar. */
      mudancaSemantica: boolean;
    }
  | { ok: false; error: string; detail: string };

function montarConteudo(
  head: { content: Record<string, string> } | undefined,
  options: StateOptions
): ConteudoMontado {
  const current_state = options.set ?? head?.content.current_state;
  if (!current_state) {
    return {
      ok: false,
      error: "`current_state` ausente — use `--set` no primeiro snapshot.",
      detail: "sem estado anterior, não há o que herdar.",
    };
  }

  /**
   * next_action, blocker, decision_question e complete NÃO são mutuamente
   * exclusivos — o WORK axis (ver comentário em `ProjectStateSchema`,
   * `schemas.ts`) aceita os quatro presentes ao mesmo tempo; quem escolhe UM
   * vencedor é `resolveWorkState` (mesmo arquivo), pela precedência `BLOCKED >
   * HUMAN_DECISION_REQUIRED > COMPLETE > CONTINUE`. Uma versão anterior deste
   * comentário dizia "mutuamente exclusivos" — falso, medido: nada aqui nunca
   * impediu passar os quatro na mesma chamada.
   *
   * O que este bloco faz é só higiene de escrita PARCIAL, não exclusão: se
   * QUALQUER uma das quatro flags é passada nesta chamada, os quatro campos
   * são redefinidos do zero a partir das flags desta chamada (passada = valor
   * novo, ausente = limpa a herdada) — sem isto, um `--next` isolado herdaria
   * um `blocker`/`decision_question`/`complete` velho do snapshot anterior
   * pra sempre, e nunca haveria como limpá-lo. Passar mais de uma flag na
   * mesma chamada define todas explicitamente — a combinação é legítima, só
   * não fica stale por omissão.
   */
  let next_action = head?.content.next_action;
  let blocker = head?.content.blocker;
  let decision_question = head?.content.decision_question;
  let complete = head?.content.complete;
  const setNext = options.next !== undefined;
  const setBlocker = options.blocker !== undefined;
  const setDecision = options.decision !== undefined;
  const setComplete = options.complete !== undefined;
  if (setNext || setBlocker || setDecision || setComplete) {
    next_action = setNext ? options.next : undefined;
    blocker = setBlocker ? options.blocker : undefined;
    decision_question = setDecision ? options.decision : undefined;
    complete = setComplete ? options.complete : undefined;
  }
  if (!next_action && !blocker && !decision_question && !complete) {
    return {
      ok: false,
      error: "`--next`, `--blocker`, `--decision` ou `--complete` é obrigatório.",
      detail:
        "um snapshot que não diz o que fazer, por que parou, o que pergunta, ou o que foi concluído não retoma trabalho nenhum.",
    };
  }

  /**
   * `last_verified` NÃO sobrevive a mudança de conteúdo.
   *
   *   HERDADO != REVERIFICADO
   *
   * Medido: `ev_01M16MY1SNAKXDY89GV9CBBW83` (gate `test`, árvore SUJA, commit
   * `1c7e029f`) atravessou 19 revisões de `project_state` só por herança, pelo
   * `?? head?.content.last_verified` que ficava nesta linha — chegou intacto a
   * um head que declarava trabalho concluído, 34 commits adiante, e o
   * SessionStart imprimia aquele id como verificação CORRENTE.
   *
   * O `??` era a mesma higiene de escrita parcial dos campos acima (`OMITTED
   * FLAG != RESET FIELD`), aplicada ao único campo onde ela não vale: `title`
   * herdado continua verdadeiro quando o estado muda; uma OBSERVAÇÃO de gate,
   * não — ela descreve um commit e um instante, nunca o snapshot.
   *
   * Mesma disciplina de detecção do bloco WORK acima (`options.X !==
   * undefined`, nunca truthiness): se ESTA chamada mudou o que o snapshot
   * AFIRMA, a evidência velha deixa de descrever o que está escrito e some —
   * a menos que a mesma chamada traga `--verified` novo. `--title` sozinho não
   * invalida: renomear o snapshot não muda nada do que foi observado.
   *
   * Some INTEIRO, não vira placeholder — e `evidence_refs` some junto, porque
   * é derivado deste campo (`state()`, acima). `NO CURRENT EVIDENCE` é estado
   * válido, e melhor que um id que ninguém revalidou.
   */
  const mudancaSemantica =
    options.set !== undefined ||
    options.goal !== undefined ||
    setNext ||
    setBlocker ||
    setDecision ||
    setComplete;

  return {
    ok: true,
    title: options.title ?? head?.content.title ?? "Estado do projeto",
    current_state,
    global_goal: options.goal ?? head?.content.global_goal,
    next_action,
    blocker,
    decision_question,
    complete,
    last_verified: options.verified ?? (mudancaSemantica ? undefined : head?.content.last_verified),
    mudancaSemantica,
  };
}

/** Head atual deste `source_ref` — id e content, base do merge não-destrutivo. */
async function headAtual(
  root: string
): Promise<
  { id: string; content: Record<string, string>; deprecation?: Deprecation } | undefined
> {
  /**
   * `includeDeprecated` porque aqui o alvo é o PAI DE `supersedes`, não o
   * conhecimento corrente — `CURRENT KNOWLEDGE != LINEAGE HEAD`. Sem isso, uma
   * linhagem depreciada faria a próxima escrita nascer sem pai: DIVERGED.
   */
  const r = await readCurrentRecords(root, { kind: "project_state", includeDeprecated: true });
  if (!r.ok) return undefined;
  const atual = r.records.find((x) => x.sourceRef === SOURCE_REF);
  if (!atual) return undefined;
  /** `deprecation` sobe com o head porque quem supersede e quem reabre — ver o aviso em `state()`. */
  const dep = atual.record.deprecation;
  return {
    id: atual.record.id,
    content: contentOf(atual.record),
    ...(dep ? { deprecation: dep } : {}),
  };
}

async function mostrar(root: string): Promise<void> {
  const r = await readCurrentRecords(root, { kind: "project_state" });
  if (!r.ok) {
    console.log(pc.red(`  x Store ilegível: ${r.issues.map((i) => i.code).join(", ")}`));
    return;
  }
  const atual = r.records.find((x) => x.sourceRef === SOURCE_REF);
  if (!atual) {
    console.log(pc.dim("  (sem estado canônico ainda)"));
    console.log(pc.dim('  defina com: nexos state --set "..." --next "..."'));
    return;
  }

  const c = contentOf(atual.record);
  console.log(pc.bold(`  ${c.title ?? "Estado do projeto"}`));
  if (c.global_goal) console.log(`  ${pc.dim("objetivo:")} ${c.global_goal}`);
  console.log(`  ${pc.dim("estado atual:")} ${c.current_state ?? "-"}`);
  if (c.next_action) console.log(`  ${pc.dim("próxima ação:")} ${c.next_action}`);
  if (c.blocker) console.log(`  ${pc.yellow("blocker:")} ${c.blocker}`);
  if (c.decision_question) console.log(`  ${pc.yellow("decisão pendente:")} ${c.decision_question}`);
  if (c.complete) console.log(`  ${pc.green("concluído:")} ${c.complete}`);
  if (c.last_verified) console.log(`  ${pc.dim("verificado:")} ${c.last_verified}`);
  /** Verdito ÚNICO da precedência (`resolveWorkState`, `schemas.ts`) — nunca recalculado aqui. */
  console.log(`  ${pc.dim("trabalho (resolvido):")} ${resolveWorkState(c) ?? "nenhum sinal"}`);
}

export interface StateReconcileOptions {
  cwd?: string;
  /** POR QUÊ — mesmo eixo de `DeprecationSchema.reason`. Obrigatório. */
  reason?: string;
  /** QUEM — mesmo eixo de `DeprecationSchema.actor_ref`. Obrigatório. */
  actor?: string;
  set?: string;
  next?: string;
  blocker?: string;
  goal?: string;
  decision?: string;
  complete?: string;
  title?: string;
  verified?: string;
}

/**
 * `nexos state-reconcile` — o ÚNICO caminho que publica `project_state` com
 * `supersedes: string[]`.
 *
 *   RECOVERY IS DELIBERATE, NEVER A SIDE EFFECT OF THE HOT PATH
 *
 * `state()` (`--set`) é single-parent por contrato: `headAtual` resolve o pai
 * via `readCurrentRecords`, e `readCurrentRecords` DESCARTA a partição inteira
 * quando ela está DIVERGED (`reader.ts` — o `continue` roda ANTES de `records`
 * existir, MEDIDO). Rodar `state --set` sobre uma partição DIVERGED não
 * reconcilia nada: `headAtual` devolve `undefined`, o record novo nasce SEM
 * `supersedes`, e o Store sai com 3 heads em vez de 2.
 *
 * Este comando lê os heads pelo caminho que os REPORTA —
 * `resolveHeadsBySource`/`head-resolver.ts`, que devolve `{state:"DIVERGED",
 * heads:[...]}` mesmo quando `readCurrentRecords` devolveria vazio — e publica
 * um record que supersede TODOS eles de uma vez, fechando a divergência num
 * único descendente comum (`ProjectStateSupersedesSchema`, `schemas.ts`).
 *
 * `content` NUNCA herda de um head escolhido: `montarConteudo(undefined, ...)`
 * exige `--set` e ao menos um de `--next`/`--blocker`/`--decision`/`--complete`
 * explícitos nesta chamada — herdar de UM dos N heads divergentes seria uma
 * escolha arbitrária disfarçada de reconciliação.
 *
 * ponytail: usa `publishCanonical` direto, não o laço CAS de `publishSuperseding`
 * — aquele reivindica por UM `parentId` (`claimPath`, `store.ts`), e aqui
 * existem N heads, não um. Reconciliação é invocação humana, única, gated por
 * `--reason`/`--actor`; o risco aceito é a janela entre ler os heads e publicar
 * — mesmo risco de qualquer read-then-write sem CAS. Upgrade se doer: claim
 * multi-parent com chave = hash dos N heads ordenados, mesma primitiva de
 * `claimHeadTransition`.
 */
export async function stateReconcile(options: StateReconcileOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  const capsula = await abrirCapsule(root);
  if (!capsula) return;
  const { projectId, projectName } = capsula;

  if (!options.reason) {
    console.log(pc.red("  x `--reason` é obrigatório: reconciliar sem motivo registrado apaga história."));
    process.exitCode = 1;
    return;
  }
  if (!options.actor) {
    console.log(pc.red("  x `--actor` é obrigatório: reconciliação exige QUEM decidiu."));
    process.exitCode = 1;
    return;
  }

  const readRoot = await resolveReadRoot(root);
  const headReport = await resolveHeadsBySource(readRoot, "KnowledgeRecord");
  if (headReport.state === "UNREADABLE") {
    console.log(pc.red(`  x Store ilegível: ${headReport.issues.map((i) => i.code).join(", ")}`));
    process.exitCode = 1;
    return;
  }

  const partition = headFor(headReport.bySource, SOURCE_REF);
  if (partition.state !== "DIVERGED") {
    console.log(
      pc.yellow(
        `  ! "${SOURCE_REF}" não está DIVERGED (${partition.state}) — reconciliar sem ` +
          "divergência é erro, não no-op."
      )
    );
    process.exitCode = 1;
    return;
  }

  /** `resolvePartitions` (`head-resolver.ts`) já devolve `heads` ordenado e único. */
  const supersedes = partition.heads;

  const conteudo = montarConteudo(undefined, options);
  if (!conteudo.ok) {
    console.log(pc.red(`  x ${conteudo.error}`));
    console.log(pc.dim(`    ${conteudo.detail}`));
    process.exitCode = 1;
    return;
  }

  const now = new Date().toISOString();
  const id = newRecordId("KnowledgeRecord");

  const content: Record<string, unknown> = {
    title: conteudo.title,
    current_state: conteudo.current_state,
    reconciliation: { reason: options.reason, actor_ref: options.actor },
  };
  if (conteudo.global_goal) content.global_goal = conteudo.global_goal;
  if (conteudo.next_action) content.next_action = conteudo.next_action;
  if (conteudo.blocker) content.blocker = conteudo.blocker;
  if (conteudo.decision_question) content.decision_question = conteudo.decision_question;
  if (conteudo.complete) content.complete = conteudo.complete;
  if (conteudo.last_verified) content.last_verified = conteudo.last_verified;

  const refsExternas = evidenceRefsExternas(
    SOURCE_REF,
    conteudo.last_verified ? [SOURCE_REF, conteudo.last_verified] : [SOURCE_REF]
  );

  const record = {
    schema_version: 1,
    id,
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "project_state",
    scope: "project",
    origin: "agent",
    provenance: { source_ref: SOURCE_REF, producer_id: "nexos-state-reconcile", submitted_at: now },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: {
      status: "admitted",
      approved_by: "policy:nexos-state-reconcile",
      approved_at: now,
    },
    sensitivity: { classification: "internal", checked_at: now, checker_version: "nexos-state-1" },
    ...(refsExternas.length > 0 ? { evidence_refs: refsExternas } : {}),
    created_at: now,
    version: 1,
    content,
    supersedes,
  } as unknown as CapsuleRecord;

  try {
    const result = await publishCanonical(root, record);
    console.log(
      result.outcome === "CREATED"
        ? pc.green(`  + reconciliação publicada — ${record.id}`)
        : pc.yellow(`  = ${result.outcome}`)
    );
    console.log(pc.dim(`    supersede ${supersedes.join(", ")}`));

    await writeStatuslineSnapshot(root, {
      project_name: projectName,
      state_title: conteudo.title,
    });

    console.log();
    await mostrar(root);
  } catch (error) {
    if (error instanceof StoreBoundaryError || error instanceof SecretMaterialError) {
      console.log(pc.red(`  x ${error.message}`));
      process.exitCode = 1;
      return;
    }
    throw error;
  }
}
