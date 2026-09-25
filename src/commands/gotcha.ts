import pc from "picocolors";
import { readCurrentRecords } from "../lib/capsule/reader.js";
import { recordParaJson, falhaJson, falhaSeAnomaliaRelevante } from "../lib/capsule/record-json.js";
import { publishSuperseding, StoreBoundaryError, HeadRaceExhaustedError } from "../lib/capsule/store.js";
import { SecretMaterialError } from "../lib/capsule/secret-guard.js";
import { newRecordId } from "../lib/capsule/ids.js";
import { classifyForReconciliation } from "../lib/capsule/migration-classifier.js";
import { resolveCommandRoot } from "../lib/project-resolver.js";
import { forProject } from "../lib/capsule/paths.js";
import { validateManifest, evidenceRefsExternas } from "../lib/capsule/schemas.js";
import { parseCanonical } from "../lib/capsule/codec.js";
import fs from "fs-extra";
import type { CapsuleRecord, Deprecation } from "../lib/capsule/schemas.js";

/** O head que este produtor supersede: id (pai) + a depreciacao que ele reabriria. */
interface HeadDeGotcha {
  id: string;
  deprecation?: Deprecation;
}

/**
 * `nexos gotcha` — armadilha encontrada como record CANÔNICO.
 *
 *   NO CONSUMER -> NO EXTRA VOCABULARY
 *
 * Um comando só, sem subcomando por `kind`: `pattern`/`architecture` não têm
 * consumidor hoje. `instincts` e `review-memory` já foram descartados como
 * base — nenhum publica em Capsule canônica (`instincts` grava em
 * `~/.nexos/instincts/` com schema próprio fora do Capsule; `review-memory`
 * só gera prompt markdown para humano ler).
 *
 * Mesma forma de `state.ts`: gate de reconciliação -> exigir campo obrigatório
 * -> ler manifest -> montar envelope -> `publishCanonical`.
 *
 * Diferença central: `GotchaSchema` tem um `.refine` (exige ao menos um de
 * trigger/failure_mode/cause/consequence/mitigation/prevention/rule) que este
 * comando NÃO reimplementa — deixa `publishCanonical` -> `validateRecord`
 * recusar e devolve a mensagem do próprio zod. Schema duplicado em dois
 * lugares é como eles divergem.
 */

const PRODUCER_ID = "nexos-gotcha";

/**
 * STORE AUTHORITY BOUNDARY V1 — Frente B. `nexos://gotcha/` é o namespace
 * PRÓPRIO deste produtor. `--source-ref` continua um dado legítimo do
 * caller (controla o slug, permite supersessão explícita de um gotcha
 * específico) — o que deixa de ser legítimo é usá-lo para ESCAPAR do
 * próprio namespace.
 *
 * MEDIDO em sandbox (Fase 0 + reprodução desta fatia): `nexos gotcha
 * --source-ref "nexos://project-state"` publica um `KnowledgeRecord` de
 * `kind: "gotcha"` na MESMA partição de `nexos://project-state` que
 * `nexos-state` usa. `headAtual` deste comando filtra por `kind: "gotcha"`
 * ANTES de casar `sourceRef` — nunca enxerga o head real de `project_state`
 * — então o CAS trata a partição como sem head e tenta reivindicar o claim
 * ROOT daquele source_ref. Se `nexos-state` já escreveu uma vez, o claim
 * ROOT já foi consumido e a tentativa forjada esgota tentativas
 * (`HeadRaceExhaustedError`) sem escrever nada — mas se o forjado for
 * PRIMEIRO (projeto novo, `nexos state` nunca rodou), ele CONSOME o claim
 * ROOT para sempre: todo `nexos state --set` legítimo subsequente falha com
 * "concorrência persistente" e o projeto nunca mais consegue publicar
 * estado canônico. `PUBLIC CLI PROVENANCE FORGERY` — destruição de
 * autoridade de OUTRO produtor por uma flag pública deste.
 *
 * A correção não amputa o campo: amputa a capacidade de apontar para fora
 * do próprio namespace. `RECORD identity != OTHER PRODUCER's HEAD`.
 *
 * O prefixo sozinho é checagem LEXICAL, não SEMÂNTICA: `nexos://gotcha/../
 * project-state`, `nexos://gotcha//../project-state` e
 * `nexos://gotcha/x#../../project-state` passam em `startsWith` porque
 * `..`/`//`/`#` não têm significado especial para `String.startsWith`.
 * Hoje isso não é explorável — `source_ref` nunca é resolvido como path;
 * ele é chave de mapa por igualdade literal (`sourceOf` em
 * `head-resolver.ts`) e vira `sha256(source_ref)` no nome do claim
 * (`store.ts:claimPath`) — um valor exótico fica como string literal e não
 * colide com a partição real. Mas apoiar a validação nessa propriedade não
 * teria como ser verificado por este arquivo: se algum consumidor futuro
 * passar a resolver `source_ref` como path, esta validação precisaria virar
 * semântica de qualquer forma. Fecha agora, custo zero para o caller
 * legítimo: nenhum slug gerado por `legacySourceSlug()` — nem um `--source-ref`
 * plausível dentro do namespace — contém `..`, `//` ou `#`.
 */
const GOTCHA_SOURCE_PREFIX = "nexos://gotcha/";

/**
 * CONGELADA — identidade de linhagem, nunca alterar. Bytes idênticos ao antigo
 * `slug()` deste arquivo em `main` (f7f6e41, `src/commands/gotcha.ts:105-113`):
 * o `source_ref` default de `nexos gotcha` é a chave de reconciliação de TODA
 * linhagem já publicada por este produtor — mudar um único byte deste
 * algoritmo (inclusive adicionar `.trim()`) muda o `source_ref` calculado para
 * qualquer título com espaço nas pontas, o que faz `nexos gotcha` reabrir uma
 * partição nova em vez de superseder a existente. `subjectRef` (schemas.ts) é
 * outra função, com outro contrato (identidade de ASSUNTO declarado, 1.4) —
 * as duas nunca compartilham corpo, mesmo tendo hoje a mesma saída para
 * qualquer entrada real (ver `tests/source-ref-legacy.test.ts`).
 */
function legacySourceSlug(title: string): string {
  return title
    .normalize("NFD")
    .replace(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
}

export interface GotchaOptions {
  cwd?: string;
  /** Só leitura: os gotchas correntes em JSON. */
  json?: boolean;
  title?: string;
  trigger?: string;
  failureMode?: string;
  cause?: string;
  consequence?: string;
  mitigation?: string;
  prevention?: string;
  rule?: string;
  evidence?: string;
  /**
   * O comando que RECONFERE o fato, executável e sem placeholder.
   * `EVIDENCE É PROSA, NÃO CONTRATO` — ver `verify_command` no `GotchaSchema`.
   */
  verifyCommand?: string;
  /** O que a saída deve conter. Sem isto, só o exit code 0 é exigido. */
  verifyExpect?: string;
  sourceRef?: string;
  /**
   * Reabrir DELIBERADAMENTE a linhagem depreciada deste `source_ref`. Ver o
   * bloco de reabertura em `gotcha()` para por que aqui e flag e em
   * `nexos state` e aviso.
   */
  reopen?: boolean;
}

export async function gotcha(options: GotchaOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  if (options.json) {
    if (options.title !== undefined) {
      falhaJson("JSON_SO_LEITURA", "--json não combina com --title (escrita)");
      return;
    }
    /**
     * N1 (rodada 2) — `families: ["KnowledgeRecord"]` escopa a leitura (e a
     * detecção de anomalia) à family de `gotcha`; sem isto, uma anomalia em
     * QUALQUER outra family (Decision, Research, ...) derrubava
     * `gotcha --json` mesmo com os gotchas saudáveis. Sem `sourceRef` no
     * filtro: cada gotcha tem seu PRÓPRIO `source_ref` (não uma identidade
     * fixa como `project_state`); `kind` filtra pelo kind real dos heads
     * (ver `falhaSeAnomaliaRelevante`).
     */
    const r = await readCurrentRecords(root, { kind: "gotcha", families: ["KnowledgeRecord"] });
    if (!r.ok) {
      falhaJson("STORE_ILEGIVEL", r.issues.map((i) => i.code));
      return;
    }
    if (falhaSeAnomaliaRelevante(r.anomalies, { family: "KnowledgeRecord", kind: "gotcha" })) return;
    console.log(JSON.stringify({ gotchas: r.records.map(recordParaJson) }, null, 2));
    return;
  }

  const pre = await classifyForReconciliation(root);
  if (!pre.hasCanonical) {
    console.log(pc.yellow("  ! este projeto não tem Store."));
    console.log(pc.dim("    rode `nexos init` primeiro — estado canônico exige identidade canônica."));
    process.exitCode = 1;
    return;
  }
  if (!pre.reconcilable) {
    console.log(pc.yellow(`  ! \`.nexos\` tem entrada não reconhecida: ${pre.conflicting.join(", ")}`));
    console.log(pc.dim("    FAIL CLOSED — nada foi escrito."));
    process.exitCode = 1;
    return;
  }

  if (!options.title) {
    console.log(pc.red("  x `--title` é obrigatório."));
    console.log(pc.dim("    um gotcha sem título não é achável nem supersedível."));
    process.exitCode = 1;
    return;
  }

  /**
   *   ASSERTING A CAUSE != HAVING MEASURED IT
   *
   * `cause` é o ÚNICO campo deste record que afirma POR QUE a falha aconteceu.
   * Todos os outros descrevem o que se viu (`trigger`, `failure_mode`,
   * `consequence`) ou o que fazer (`mitigation`, `prevention`, `rule`) — só a
   * causa é uma inferência que pode estar errada sem contradizer nada em volta.
   *
   * MEDIDO nesta sessão: seis causas afirmadas sem medição, TODAS com os 8
   * gates verdes — binário global culpando um Store íntegro, "regressão do
   * 8da5db5" refutada byte a byte, "concorrência persistente" num processo
   * único. O gate de entrega roda DEPOIS que a conclusão já foi tomada; por
   * construção não pega diagnóstico errado.
   *
   * Isto não julga se a causa é VERDADEIRA — nada aqui poderia. Exige que quem
   * a afirma escreva ao lado como mediu, que é o passo que faltou nas seis. Os
   * outros campos seguem livres: barrar `--trigger` sem `--evidence` seria
   * pedágio sobre observação, não sobre inferência.
   *
   * A checagem é do ESCRITOR, não do schema: `GotchaSchema` mantém `cause` e
   * `evidence` opcionais porque `validateRecord` roda na LEITURA, e apertá-lo
   * faria os 4 gotchas legados com causa e sem evidência SUMIREM do grafo.
   */
  if (options.cause && !options.evidence) {
    console.log(pc.red("  x `--cause` exige `--evidence`."));
    console.log(
      pc.dim(
        "    causa é inferência, não observação — sem dizer COMO foi medida, o\n" +
          "    record afirma um porquê que nenhum leitor consegue conferir."
      )
    );
    process.exitCode = 1;
    return;
  }

  if (options.sourceRef !== undefined && !options.sourceRef.startsWith(GOTCHA_SOURCE_PREFIX)) {
    console.log(
      pc.red(`  x --source-ref precisa começar com "${GOTCHA_SOURCE_PREFIX}" — recebeu "${options.sourceRef}".`)
    );
    console.log(
      pc.dim(
        "    FAIL CLOSED — este produtor só escreve na própria partição. Apontar para o " +
          "source_ref de outro produtor (ex.: nexos://project-state) forjaria supersessão " +
          "cruzada e pode destruir a autoridade dele (ver comentário de GOTCHA_SOURCE_PREFIX)."
      )
    );
    process.exitCode = 1;
    return;
  }

  /**
   * Prefixo bate LEXICALMENTE mas o sufixo carrega sintaxe de escape
   * (`..`, `//`, `#`) — ver comentário de `GOTCHA_SOURCE_PREFIX`. Não é
   * exploit hoje, mas nenhum valor legítimo desta CLI produz esses
   * caracteres, então recusar custa zero para o caller honesto.
   */
  if (options.sourceRef !== undefined) {
    const sufixo = options.sourceRef.slice(GOTCHA_SOURCE_PREFIX.length);
    if (sufixo.includes("..") || sufixo.includes("//") || sufixo.includes("#")) {
      console.log(
        pc.red(`  x --source-ref tem sintaxe de escape ("..", "//" ou "#") — recebeu "${options.sourceRef}".`)
      );
      console.log(
        pc.dim(
          "    FAIL CLOSED — sintaticamente parece escapar do próprio namespace, mesmo " +
            "que hoje source_ref nunca seja resolvido como path (ver comentário acima)."
        )
      );
      process.exitCode = 1;
      return;
    }
  }

  const manifesto = validateManifest(
    parseCanonical(await fs.readFile(forProject(root).manifest(), "utf-8"))
  );
  if (!manifesto.ok) {
    console.log(pc.red(`  x manifest inválido: ${manifesto.errors.join("; ")}`));
    process.exitCode = 1;
    return;
  }
  if (!manifesto.value.project) {
    console.log(pc.red(`  x manifest de ${root} não declara project (scope="${manifesto.value.scope}") — gotcha exige um projeto`));
    process.exitCode = 1;
    return;
  }
  const projectId = manifesto.value.project.id;

  const now = new Date().toISOString();
  const sourceRef =
    options.sourceRef !== undefined
      ? options.sourceRef
      : `nexos://gotcha/${legacySourceSlug(options.title)}`;
  const refsExternas = evidenceRefsExternas(sourceRef, [sourceRef]);

  const content: Record<string, string> = { title: options.title };
  if (options.trigger) content.trigger = options.trigger;
  if (options.failureMode) content.failure_mode = options.failureMode;
  if (options.cause) content.cause = options.cause;
  if (options.consequence) content.consequence = options.consequence;
  if (options.mitigation) content.mitigation = options.mitigation;
  if (options.prevention) content.prevention = options.prevention;
  if (options.rule) content.rule = options.rule;
  if (options.evidence) content.evidence = options.evidence;
  if (options.verifyCommand) content.verify_command = options.verifyCommand;
  if (options.verifyExpect) content.verify_expect = options.verifyExpect;

  /**
   * REABERTURA DE LINHAGEM DEPRECIADA — visivel e deliberada, nunca silenciosa.
   *
   *   REVIVING A LINEAGE != SILENTLY REVIVING A LINEAGE
   *
   * MEDIDO (38b4b46): publicar aqui no `source_ref` de uma linhagem depreciada
   * ressuscitava-a — `heads correntes: 1, deprecation: undefined, anomalias: 0`
   * — sem que o autor soubesse que estava derrubando uma decisao com motivo
   * registrado. Topologicamente correto, e por isso mesmo invisivel.
   *
   * FLAG e nao aviso, ao contrario de `nexos state`: `nexos gotcha` e um ato de
   * autoria isolado, sempre reexecutavel, e recusar nao perde nada — quem foi
   * barrado le o motivo antigo e decide. `nexos state --set` roda no fim de toda
   * sessao e recusar la perderia o snapshot da sessao, que e dado que so existe
   * naquele instante. `HOT PATH REFUSAL != FREE REFUSAL`.
   *
   * Recusar `--reopen` sobre linhagem VIVA nao e simetria decorativa: se a flag
   * fosse inocua fora da reabertura, o habito seria passa-la sempre, e o portao
   * voltaria a ser silencio com uma flag por cima.
   *
   * Este read e o do CAS sao leituras distintas de proposito: esta e o PORTAO
   * (autorizacao, antes de tocar claim), a de dentro do laco e o PAI de
   * `supersedes`. Sob corrida quem manda e a de dentro, e o `reopens` gravado
   * sai do head que o `buildRecord` realmente superseder — o record nunca
   * afirma uma reabertura que nao aconteceu.
   */
  const portao = await headAtual(root, sourceRef);
  if (portao?.deprecation && options.reopen !== true) {
    console.log(pc.red(`  x "${sourceRef}" e uma linhagem DEPRECIADA — publicar aqui a torna corrente de novo.`));
    console.log(pc.dim(`    motivo da depreciacao: ${portao.deprecation.reason}`));
    console.log(pc.dim(`    depreciada por: ${portao.deprecation.actor_ref}`));
    console.log(
      pc.dim(
        "    se o conhecimento novo supera esse motivo, reabra explicitamente com --reopen; " +
          "para publicar um fato NOVO sem reabrir, use outro --source-ref."
      )
    );
    process.exitCode = 1;
    return;
  }
  if (options.reopen === true && !portao?.deprecation) {
    console.log(pc.red(`  x --reopen, mas "${sourceRef}" nao esta depreciada — nao ha o que reabrir.`));
    console.log(
      pc.dim("    FAIL CLOSED — flag de reabertura aceita por rotina vira o mesmo silencio que ela existe para quebrar.")
    );
    process.exitCode = 1;
    return;
  }

  /** Identidade fixa por chamada — só o `supersedes` muda entre tentativas do CAS. */
  const id = newRecordId("KnowledgeRecord");

  try {
    const { outcome, record } = await publishSuperseding(root, {
      family: "KnowledgeRecord",
      sourceRef,
      /** Mesmo `source_ref` já publicado -> supersede, nunca acumula (mesmo padrão de `state.ts`). */
      readHead: () => headAtual(root, sourceRef),
      buildRecord: (anterior) =>
        ({
          schema_version: 1,
          id,
          project_id: projectId,
          family: "KnowledgeRecord",
          kind: "gotcha",
          scope: "project",
          origin: "agent",
          provenance: { source_ref: sourceRef, producer_id: PRODUCER_ID, submitted_at: now },
          lifecycle: "immutable",
          portability: "portable",
          regenerable: false,
          admission: {
            status: "admitted",
            /**
             * SEMPRE `policy:${PRODUCER_ID}`, nunca outro valor — `SELF-EVOLUTION !=
             * SELF-TRUST`. Não há mais `--approved-by` (STORE AUTHORITY BOUNDARY V1,
             * Frente B): o caller não FORNECE proveniência de aprovação, o Store a
             * DERIVA. `approved_by` era uma flag pública que produzia
             * `admission.approved_by: human:<qualquer coisa>` sem nenhum humano
             * envolvido — `approved_by STRING != HUMAN PRESENCE`. Ver `nexos gotcha
             * --approved-by human:steve` reproduzido em sandbox nesta fatia.
             */
            approved_by: `policy:${PRODUCER_ID}`,
            approved_at: now,
          },
          sensitivity: {
            classification: "internal",
            checked_at: now,
            checker_version: `${PRODUCER_ID}-1`,
          },
          /**
           * Era `[sourceRef]` — o record citando o próprio nome como prova de
           * si (`A CLAIM IS NOT ITS OWN EVIDENCE`, ver `evidenceRefsExternas`).
           * O comando não recebe ref externa de ninguém hoje, então o honesto é
           * o campo AUSENTE: `ABSENCE = FIELD ABSENT`. A prova em prosa que o
           * autor mediu vai em `content.evidence`, que agora é obrigatória
           * quando há `--cause`.
           */
          ...(refsExternas.length > 0 ? { evidence_refs: refsExternas } : {}),
          created_at: now,
          version: 1,
          content,
          ...(anterior ? { supersedes: anterior.id } : {}),
          /** Do head que ESTA tentativa supersede, nunca do lido pelo portao. */
          ...(anterior?.deprecation ? { reopens: anterior.deprecation } : {}),
        }) as CapsuleRecord,
    });

    console.log(
      outcome === "CREATED"
        ? pc.green(`  + gotcha publicado — ${record.id}`)
        : pc.yellow(`  = ${outcome}`)
    );
    const supersedeu = (record as { supersedes?: string }).supersedes;
    if (supersedeu) console.log(pc.dim(`    supersede ${supersedeu}`));
    const reaberta = (record as { reopens?: Deprecation }).reopens;
    if (reaberta) {
      console.log(pc.yellow(`    ! linhagem DEPRECIADA reaberta — o motivo antigo deixa de valer`));
      console.log(pc.dim(`      era: ${reaberta.reason} (${reaberta.actor_ref})`));
    }
  } catch (error) {
    /**
     * SecretMaterialError (nexos://gotcha/nexos-gotcha-despeja-stack-crua-quando-o-secret-guard-recusa-o-conteudo)
     * — mesma recusa FAIL CLOSED de sempre (secret-guard.ts, intocado); só a
     * SAÍDA muda. Sem este ramo, o erro escapava daqui e virava stack crua de
     * `dist/lib/capsule/secret-guard.js` no terminal do usuário — a recusa
     * estava certa, a apresentação não.
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

/** Head atual deste `source_ref` — base da supersessão, mesmo padrão de `state.ts`. */
async function headAtual(root: string, sourceRef: string): Promise<HeadDeGotcha | undefined> {
  /** Pai de `supersedes`, não conhecimento corrente — ver `state.ts:headAtual`. */
  const r = await readCurrentRecords(root, { kind: "gotcha", includeDeprecated: true });
  if (!r.ok) return undefined;
  const atual = r.records.find((x) => x.sourceRef === sourceRef);
  if (!atual) return undefined;
  /**
   * `deprecation` sobe junto com o `id` porque quem le o head para superseder e
   * exatamente quem precisa saber que esta reabrindo. Ler duas vezes — uma
   * para o pai, outra para a checagem — e como as duas leituras divergem.
   */
  const dep = atual.record.deprecation;
  return { id: atual.record.id, ...(dep ? { deprecation: dep } : {}) };
}
