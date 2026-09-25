import pc from "picocolors";
import {
  advanceCheckpoint,
  resumeCheckpoint,
  resolveCheckpointHead,
  describeCheckpointCapabilityLines,
  type AdvanceCheckpointResult,
} from "../lib/capsule/checkpoint.js";
import { loadFamilyForResolution } from "../lib/capsule/head-resolver.js";
import { CHECKPOINT_STATES, type CheckpointState } from "../lib/capsule/schemas.js";
import { classifyForReconciliation } from "../lib/capsule/migration-classifier.js";
import { resolveCommandRoot } from "../lib/project-resolver.js";
import { verifyFromEvidence, commitAtual, type VerifyVerdict } from "../lib/evidence.js";
import { REQUIRED_QUALITY_CATEGORIES } from "../lib/quality-recipe.js";
import { buildVerificationBasis, type VerificationBasis } from "../lib/capsule/verification-basis.js";
import {
  resolveVerifiability,
  isTampered,
  descreverVerificabilidade,
  type EvidenceVerifiability,
} from "../lib/capsule/evidence-verifiability.js";
import { loadEvidenceHere } from "../lib/evidence.js";
import { readFile } from "node:fs/promises";
import path from "node:path";
import { contentOf } from "../lib/capsule/reader.js";
import { writeStatuslineSnapshot, readProjectNameForSnapshot } from "../lib/statusline-snapshot.js";
import { proporAoConcluir, subjectDoCheckpoint, projectIdDoCheckpoint } from "../lib/learning-trigger.js";

/**
 * `nexos checkpoint` — Harness V1 slice 1: publica ou retoma o nó de execução
 * (`ProjectCheckpoint`). Mesma forma de `state.ts`/`gotcha.ts`: gate de
 * reconciliação -> ação -> mostrar.
 *
 * Sem flag de estado, o comando LÊ (retoma o head) — nunca escreve. Ler nunca
 * despacha: `SESSION != EXECUTION` (`checkpoint.ts`, `resumeCheckpoint`).
 */
export interface CheckpointOptions {
  cwd?: string;
  state?: string;
  statement?: string;
  contract?: string;
  /**
   * D9 — QUAL nó do plano esta linhagem executa. Declarado por QUEM CRIA a
   * cabeça, do mesmo jeito que `--contract`: é a única parte do sistema que sabe
   * a resposta. O produtor do plano projeta nós a partir do YAML de trabalho
   * (`graph-projection.ts`) e não tem opinião sobre qual deles é a sessão de
   * agora; o dispatch lê o campo e não pode inventá-lo. Herdado depois, nunca
   * repetido a cada transição.
   */
  node?: string;
  /**
   * D3 — quem SOLICITOU esta transição. Sem default, nunca inferido: ausência
   * vira `actorRef: undefined` (UNKNOWN), do mesmo jeito que
   * `advanceCheckpoint` já trata. `ACTOR != PRODUCER`.
   */
  actor?: string;
  /** Só com `--state SUPERSEDED`: nexos://decision/<chave> da decisão que retirou o trabalho. */
  supersededBy?: string;
  /**
   * C1/C2 — capabilities que esta linhagem exige, vocabulário cru do
   * registry (ex.: `project.structure`). Repetível na CLI; dedupe + ordem
   * canônica acontecem em `advanceCheckpoint`, nunca aqui.
   */
  capability?: readonly string[];
  /**
   * STORE ROOT != WORK COMMIT (knw_01M29J63JVENJRN7Q2TMMBDD00) — commit exato
   * que a evidência a amarrar descreve. Sem isto, `verificarEvidenciaParaFechamento`
   * só sabia derivar o commit exigido rodando `git rev-parse HEAD` no MESMO
   * `root` usado para resolver o Store; quando a chain vive na raiz mas o
   * trabalho e a evidência foram gerados num worktree em outro commit, o
   * commit exigido nunca é o commit real do trabalho e SUCCEEDED fica
   * mecanicamente irrealizável dos dois lados. Só usado com `--state
   * SUCCEEDED`; ausência preserva o comportamento anterior (deriva de `root`).
   */
  commit?: string;
  /**
   * Contrato de máquina (frente JARVIS) — só em modo LEITURA (sem `--state`):
   * a cadeia INTEIRA (não só o head) como JSON, para uma tela de auditoria
   * ler sem regex sobre YAML. Ver `mostrarJson` para o schema exato.
   */
  json?: boolean;
}

export async function checkpoint(options: CheckpointOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  const pre = await classifyForReconciliation(root);
  if (!pre.hasCanonical) {
    console.log(pc.yellow("  ! este projeto não tem Store."));
    console.log(pc.dim("    rode `nexos init` primeiro — checkpoint exige identidade canônica."));
    process.exitCode = 1;
    return;
  }
  if (!pre.reconcilable) {
    console.log(pc.yellow(`  ! \`.nexos\` tem entrada não reconhecida: ${pre.conflicting.join(", ")}`));
    console.log(pc.dim("    FAIL CLOSED — nada foi escrito."));
    process.exitCode = 1;
    return;
  }

  if (!options.state) {
    if (options.json) {
      await mostrarJson(root);
    } else {
      await mostrar(root);
    }
    return;
  }

  if (!isCheckpointState(options.state)) {
    console.log(pc.red(`  x --state inválido: "${options.state}"`));
    console.log(pc.dim(`    esperado um de: ${CHECKPOINT_STATES.join(", ")}`));
    process.exitCode = 1;
    return;
  }

  /**
   * Gate de evidência — SÓ para `SUCCEEDED`. `FAILED` continua livre (fechar
   * em falha nunca precisou de prova). `AGENT SAID TESTS PASS != SYSTEM
   * OBSERVED TESTS PASS`: a MESMA receita de `dispatch.ts` `runVerifier`
   * (`REQUIRED_QUALITY_CATEGORIES`), mais a amarração ao commit atual e ao
   * checkpoint que está fechando (`subjectRef`) — que o dispatch, rodando os
   * gates na hora, não precisa provar; a CLI, checando evidência JÁ no disco,
   * precisa.
   */
  let verification: VerificationBasis[] | undefined;
  if (options.state === "SUCCEEDED") {
    const gate = await verificarEvidenciaParaFechamento(root, options.commit);
    if (!gate.pass) {
      console.log(pc.red("  x SUCCEEDED recusado — evidência insuficiente:"));
      for (const f of gate.findings) {
        console.log(pc.dim(`    ${f.ok ? "PASS" : "FAIL"}  ${f.gate}: ${f.detail}`));
      }
      console.log(pc.dim("    FAIL CLOSED — nada foi escrito."));
      process.exitCode = 1;
      return;
    }
    /**
     * Base portátil de verificação (ver `verification-basis.ts`) — montada
     * SÓ com o que `verifyFromEvidence` já carregou (`gate.findings[].evidence`),
     * nunca relendo nem recomputando. `verifierDetail` é o `detail` que o
     * próprio finding já formatou; `observedFacts` guarda o único fato que a
     * decisão de fechamento usou além do exit code — quando terminou.
     */
    verification = gate.findings
      .filter((f): f is typeof f & { evidence: NonNullable<typeof f.evidence> } => f.evidence !== undefined)
      .map((f) =>
        buildVerificationBasis({
          evidence: f.evidence,
          verifierDetail: f.detail,
          observedFacts: { finished_at: f.evidence.finished_at },
        })
      );
  }

  const result = await advanceCheckpoint({
    projectRoot: root,
    state: options.state,
    ...(options.statement ? { statement: options.statement } : {}),
    ...(options.contract ? { contractId: options.contract } : {}),
    ...(options.node ? { planNodeId: options.node } : {}),
    ...(options.actor ? { actorRef: options.actor } : {}),
    ...(options.capability && options.capability.length > 0
      ? { requiredCapabilities: options.capability }
      : {}),
    ...(verification && verification.length > 0 ? { verification } : {}),
    ...(options.supersededBy ? { supersededBy: options.supersededBy } : {}),
  });

  reportar(result);
  if (!result.ok) {
    process.exitCode = 1;
    return;
  }

  const publicado = contentOf(result.record);
  const projectName = await readProjectNameForSnapshot(root);
  await writeStatuslineSnapshot(root, {
    ...(projectName ? { project_name: projectName } : {}),
    ...(publicado.state ? { checkpoint_state: publicado.state } : {}),
    ...(publicado.statement ? { state_title: publicado.statement } : {}),
  });

  /**
   * O gatilho do learning loop. `SUCCEEDED` é o evento semântico mais estreito
   * que existe: já carrega contrato (o statement) e base de verificação (a
   * Evidence do subject), e acontece ~2x/dia neste repo contra ~23x do
   * `verify`. Propõe candidato; NUNCA promove.
   *
   * Roda DEPOIS de a transição estar publicada e do statusline, de propósito:
   * o trabalho verificado é soberano, e `proporAoConcluir` nunca lança por
   * contrato — perder um SUCCEEDED porque a proposta de memória falhou seria
   * trocar o certo pelo acessório.
   */
  if (publicado.state === "SUCCEEDED") {
    /**
     *   ENVELOPE FIELD != CONTENT FIELD
     *
     * `previous_checkpoint_id` mora no ENVELOPE, não em `content`. Lê-lo de
     * `contentOf(...)` devolve `undefined` sem erro nenhum: o gatilho
     * simplesmente não dispara, o SUCCEEDED sai normal, e ninguém percebe que
     * o learning loop está morto. Foi o que aconteceu nas duas primeiras
     * execuções reais deste circuito — e é o mesmo erro que o `nexos context`
     * cometeu com `kind`.
     */
    const subjectRef = subjectDoCheckpoint(result.record);
    const declaracao = typeof publicado.statement === "string" ? publicado.statement : "";
    const projectId = projectIdDoCheckpoint(result.record);
    if (subjectRef !== "" && projectId !== "") {
      const proposta = await proporAoConcluir(root, result.record.id, subjectRef, declaracao, projectId);
      if (proposta.candidatos.length > 0) {
        console.log(pc.green(`\n  + aprendizado proposto — ${proposta.candidatos.join(", ")}`));
        console.log(pc.dim(`    ${proposta.regra.slice(0, 140)}`));
        console.log(pc.dim(`    CANDIDATE != TRUTH — promover exige humano: nexos memory --promote <id> --why "<por que vale>"`));
      } else if (proposta.motivo !== "") {
        /**
         * O MOTIVO DA RECUSA NÃO PODE SER DESCARTADO.
         *
         *   SILENT DECLINE IS INDISTINGUISHABLE FROM NOT RUNNING
         *
         * `proporAoConcluir` sempre devolveu `motivo`, e este call site só
         * imprimia quando havia candidato. Resultado medido: para saber se o
         * gatilho havia rodado numa transição específica foi preciso datar
         * records, cruzar `origin_note` e reimplementar `redGreenCrossCommit`
         * em outra linguagem — porque "não propôs" e "não rodou" produziam
         * exatamente o mesmo silêncio.
         */
        console.log(pc.dim(`\n  · aprendizado não proposto — ${proposta.motivo}`));
      }
    }
  }

  console.log();
  await mostrar(root);
}

/**
 * `VerifyVerdict` degradado com um `findings` sintético quando não há sequer
 * um head para amarrar — mesmo formato que `reportar()` já imprime, sem um
 * segundo formato de saída só para este caso de recusa cedo.
 */
async function verificarEvidenciaParaFechamento(
  root: string,
  /**
   * D-commit — commit EXATO do trabalho verificado, quando o caller sabe
   * (`--commit` na CLI). `undefined` preserva o comportamento anterior:
   * deriva de `commitAtual(root)`, que só é correto quando o Store root e o
   * commit do trabalho coincidem (ver `CheckpointOptions.commit`).
   */
  explicitCommit?: string
): Promise<VerifyVerdict> {
  const head = await resolveCheckpointHead(root);
  if (head.kind !== "HEAD") {
    return {
      pass: false,
      findings: [
        {
          gate: "checkpoint-evidence",
          ok: false,
          detail: `chain ${head.kind} — sem head legível para amarrar evidência a este checkpoint`,
        },
      ],
    };
  }

  const commit = explicitCommit ?? (await commitAtual(root));
  if (!commit) {
    return {
      pass: false,
      findings: [
        {
          gate: "checkpoint-evidence",
          ok: false,
          detail: "HEAD do git não observável neste diretório — sem commit não há o que amarrar",
        },
      ],
    };
  }

  return verifyFromEvidence({
    projectRoot: root,
    requiredGates: [...REQUIRED_QUALITY_CATEGORIES],
    commit,
    subjectRef: head.id,
  });
}

function isCheckpointState(value: string): value is CheckpointState {
  return (CHECKPOINT_STATES as readonly string[]).includes(value);
}

function reportar(result: AdvanceCheckpointResult): void {
  if (result.ok) {
    console.log(
      result.outcome === "CREATED"
        ? pc.green(`  + checkpoint publicado — ${result.record.id}`)
        : pc.yellow(`  = ${result.outcome}`)
    );
    const previous = (result.record as { previous_checkpoint_id?: string | null }).previous_checkpoint_id;
    if (previous) console.log(pc.dim(`    encadeado a ${previous}`));
    return;
  }

  switch (result.reason) {
    case "DIVERGED":
      console.log(pc.red(`  x chain divergente — ${result.heads.length} heads: ${result.heads.join(", ")}`));
      console.log(pc.dim("    reconciliação explícita necessária (ADR-046); nada foi escrito."));
      return;
    case "CHAIN_UNHEALTHY":
      console.log(pc.red(`  x chain de checkpoint não íntegra: ${result.detail}`));
      return;
    case "TRANSITION_REJECTED":
      console.log(pc.red(`  x transição recusada: ${result.why}`));
      return;
    case "MISSING_STATEMENT":
      console.log(pc.red("  x --statement é obrigatório no primeiro checkpoint da chain."));
      return;
    case "MISSING_SUPERSEDED_BY":
      console.log(pc.red("  x SUPERSEDED exige --superseded-by nexos://decision/<chave> — a decisão que retirou o trabalho."));
      return;
    case "SUPERSEDED_BY_NOT_FOUND":
      console.log(pc.red(`  x ${result.ref} não é uma decisão viva no Store — cite a decisão ativa que substituiu o trabalho.`));
      return;
    case "SUPERSEDED_BY_ONLY_WITH_SUPERSEDED":
      console.log(pc.red("  x --superseded-by só vale com --state SUPERSEDED."));
      return;
    case "STORE_ERROR":
      console.log(pc.red(`  x ${result.detail}`));
      return;
  }
}

/**
 * Um item de `nexos checkpoint --json` — contrato de máquina para a frente
 * JARVIS (tela de auditoria sobre a chain inteira). `verification` (e, pela
 * mesma razão, `actor_ref`) saem `null` EXPLÍCITO quando ausentes, nunca
 * omitidos: omissão e ausência viram a mesma coisa no parse de um consumidor
 * JSON, e aqui a ausência É o dado que importa — nenhum FAILED/BLOCKED do
 * Store registra hoje por que terminou (medido: 109 checkpoints terminais,
 * 84 sem `content.verification`).
 */
/**
 * Os scripts que o `package.json` DESTE checkout declara — insumo da
 * pré-checagem de instrumento, e leitura pura: abre o manifesto, não roda nada.
 *
 * `undefined` quando não dá para ler. Ausência de leitura não é ausência de
 * instrumento, e é por isso que o erro devolve `undefined` em vez de `[]`:
 * lista vazia diria "nenhum script existe" e marcaria TODA base como
 * `UNRUNNABLE_HERE`, transformando um manifesto ilegível em veredito sobre o
 * trabalho.
 */
async function scriptsDoAmbiente(root: string): Promise<readonly string[] | undefined> {
  try {
    const bruto = await readFile(path.join(root, "package.json"), "utf-8");
    const parsed: unknown = JSON.parse(bruto);
    if (typeof parsed !== "object" || parsed === null) return undefined;
    const scripts = (parsed as { scripts?: unknown }).scripts;
    if (typeof scripts !== "object" || scripts === null) return undefined;
    return Object.keys(scripts as Record<string, unknown>);
  } catch {
    return undefined;
  }
}

/**
 * O CONSUMIDOR HUMANO dos três eixos, e a razão de ele existir.
 *
 *     PRODUTOR SEM CONSUMIDOR VIRA CAMPO MORTO
 *
 * MEDIDO em 2026-09-20: `verifiability` era o ÚNICO dos 10 campos de
 * `checkpoint --json` com ZERO leitores no repositório (`id` tem 321, `state`
 * 109), e `descreverVerificabilidade` só era chamada por teste. O commit que
 * criou o campo justificou-o dizendo "é o que o JARVIS lê" — e o JARVIS não lê;
 * `console/collect.mjs` faz `readdir` direto em `.nexos/.local/evidence`. A
 * régua pegou quem a escreveu, do mesmo jeito que pegou `freshness`.
 *
 * Três linhas distintas, nunca um selo só: colapsar faz o leitor ler instrução
 * como prova. E `reproduce_at` anda colado ao `reproduce_with` porque
 * `INSTRUÇÃO SEM CONTEXTO ENVELHECE SOZINHA` — "rode `npm run test:all`" é
 * falso no HEAD e verdadeiro em `0d966eef`.
 */
async function mostrarVerificabilidadeDoHead(root: string, headId: string): Promise<void> {
  const loaded = await loadFamilyForResolution(root, "ProjectCheckpoint").catch(() => null);
  /**
   * Family ilegível não vira linha nenhuma, e isso é deliberado: o `mostrar`
   * já reportou o estado do head acima. Inventar "verificabilidade
   * desconhecida" aqui acrescentaria ruído sobre uma falha que o leitor já viu.
   */
  if (!loaded || loaded.state !== "LOADED") return;
  const record = loaded.records.find((e) => e.record.id === headId)?.record;
  /** A family estreita o union — mesmo guard de `mostrarJson`, nunca um cast. */
  if (!record || record.family !== "ProjectCheckpoint") return;
  const bases = record.content.verification;
  if (!bases || bases.length === 0) return;

  const [evidenciasLocais, scripts] = await Promise.all([
    loadEvidenceHere(root).catch(() => []),
    scriptsDoAmbiente(root),
  ]);

  console.log(`  ${pc.dim("verificabilidade:")}`);
  for (const b of bases) {
    const v = resolveVerifiability(b, evidenciasLocais, scripts);
    const linha = descreverVerificabilidade(v);
    const cor = isTampered(v) ? pc.red : v.claim === "UNRUNNABLE_HERE" || v.availability === "MISSING" ? pc.yellow : pc.dim;
    console.log(`    ${b.gate.padEnd(14)} ${cor(linha)}`);
    if (v.reproducible) {
      const onde = b.repo_commit ? ` @ ${b.repo_commit.slice(0, 8)}` : " (sem commit registrado)";
      console.log(`    ${" ".repeat(14)} ${pc.dim(`reproduzir: ${[b.command, ...b.args].join(" ")}${onde}`)}`);
    }
  }
}

interface EvidenceVerifiabilityJson {
  readonly evidence_id: string;
  readonly gate: string;
  readonly availability: EvidenceVerifiability["availability"];
  readonly integrity: EvidenceVerifiability["integrity"];
  readonly claim: EvidenceVerifiability["claim"];
  readonly tampered: boolean;
  /** `REPRODUCIBLE != REPRODUCED != VERIFIED` — por isso vive fora de `claim`. */
  readonly reproducible: boolean;
  /** O comando que PERMITE tentar reproduzir. Nunca é prova de que se reproduziu. */
  readonly reproduce_with: string | null;
  /**
   * O commit em que aquele comando valia.
   *
   *     INSTRUÇÃO SEM CONTEXTO ENVELHECE SOZINHA
   *
   * MEDIDO: 25 das 112 bases dizem `npm run test:all`, script ausente do HEAD e
   * presente nos `repo_commit` delas (`git show <c>:package.json | grep -c` = 1).
   * A instrução não mente sobre o passado; ela era muda sobre em que mundo
   * vale, e quem a lesse no checkout de hoje receberia exit 1 sem saber por quê.
   */
  readonly reproduce_at: string | null;
}

interface CheckpointChainItemJson {
  readonly id: string;
  readonly previous_checkpoint_id: string | null;
  readonly created_at: string;
  readonly content: {
    readonly state: CheckpointState;
    readonly statement: string;
    readonly attempt: number;
    readonly actor_ref: string | null;
    readonly verification: readonly VerificationBasis[] | null;
    /**
     * O CONSUMIDOR dos três eixos de `evidence-verifiability.ts`. Antes disto,
     * quem lia esta chain via `verification` e concluía "verificado" — sem
     * saber se a prova existe NESTE ambiente, e sem nunca conferir o
     * `evidence_sha256` que a própria base transporta.
     *
     *     PORTABLE TRUTH TRAVELS · PORTABLE PROOF DOES NOT
     *
     * `null` quando o checkpoint não tem base nenhuma — ausência de base é
     * diferente de base cuja prova sumiu, e colapsar as duas esconderia
     * justamente o caso que este campo existe para mostrar.
     */
    readonly verifiability: readonly EvidenceVerifiabilityJson[] | null;
  };
}

/**
 * `nexos checkpoint --json` — a cadeia INTEIRA (não só o head resolvido),
 * estável para consumo de máquina. Reusa `loadFamilyForResolution` — o MESMO
 * loader que `checkpoint.ts`/`reader.ts` já usam para a family ProjectCheckpoint,
 * nunca um segundo leitor de `.nexos/records/checkpoints/`.
 *
 * Devolve TODOS os records da family, saudáveis ou não — um DIVERGED/UNHEALTHY
 * na resolução de HEAD (`resolveCheckpointHead`) não impede a auditoria de ver
 * a chain bruta; é exatamente o tipo de anomalia que uma tela de auditoria
 * quer enxergar, não esconder atrás de um erro de leitura.
 *
 * REGRA DURA (mesma de `nexos boot --json`): nada além do JSON no stdout.
 */
async function mostrarJson(root: string): Promise<void> {
  const loaded = await loadFamilyForResolution(root, "ProjectCheckpoint");
  if (loaded.state !== "LOADED") {
    console.log(JSON.stringify({ checkpoints: [], error: loaded.state }));
    process.exitCode = 1;
    return;
  }

  /**
   * UMA leitura das evidências locais para a chain inteira — não uma por base.
   * `FILTRO POR KIND NÃO É LEITURA PARCIAL` foi medido neste repositório a um
   * custo de segundos; reler por item repetiria o defeito em escala menor.
   *
   * Falha ao ler é `MISSING` para todas, que é a resposta honesta: sem acesso
   * ao acervo local, nenhuma prova está disponível AQUI.
   *
   * `loadEvidenceHere`, não `loadEvidence`: o "AQUI" desta frase é o checkout,
   * e a segunda seguiria a authority global até o `active_root` — que num
   * worktree devolvia as 837 evidências da máquina e reportava `AVAILABLE`
   * sobre prova que não viajou. `nexos://decision/evidence-availability-por-ambiente`.
   */
  const evidenciasLocais = await loadEvidenceHere(root).catch(() => []);
  const scripts = await scriptsDoAmbiente(root);

  const checkpoints: CheckpointChainItemJson[] = [];
  for (const entry of loaded.records) {
    const r = entry.record;
    if (r.family !== "ProjectCheckpoint") continue; // nunca deveria acontecer — a family já filtra o diretório
    const bases = r.content.verification ?? null;
    const verifiability: EvidenceVerifiabilityJson[] | null = bases
      ? bases.map((b) => {
          const v = resolveVerifiability(b, evidenciasLocais, scripts);
          return {
            evidence_id: b.evidence_id,
            gate: b.gate,
            availability: v.availability,
            integrity: v.integrity,
            claim: v.claim,
            tampered: isTampered(v),
            reproducible: v.reproducible,
            reproduce_with: v.reproducible ? [b.command, ...b.args].join(" ") : null,
            reproduce_at: v.reproducible ? (b.repo_commit ?? null) : null,
          };
        })
      : null;
    checkpoints.push({
      id: r.id,
      previous_checkpoint_id: r.previous_checkpoint_id,
      created_at: r.created_at,
      content: {
        state: r.content.state,
        statement: r.content.statement,
        attempt: r.content.attempt,
        actor_ref: r.content.actor_ref ?? null,
        verification: r.content.verification ?? null,
        verifiability,
      },
    });
  }
  console.log(JSON.stringify({ checkpoints }, null, 2));
}

async function mostrar(root: string): Promise<void> {
  const resumed = await resumeCheckpoint(root);
  if (resumed.kind !== "RESUMED" && resumed.continuityIncomplete) {
    console.log("  CONTINUITY_CONTEXT_INCOMPLETE: cadeia de trabalho ilegível ou ausente; consulte nexos decision antes de inferir encerramento.");
  }

  switch (resumed.kind) {
    case "EMPTY":
      console.log(pc.dim("  (sem checkpoint ainda)"));
      console.log(pc.dim('  crie o primeiro com: nexos checkpoint --state PENDING --statement "..."'));
      return;
    case "DIVERGED":
      console.log(pc.red(`  x chain divergente — ${resumed.heads.length} heads: ${resumed.heads.join(", ")}`));
      return;
    case "UNHEALTHY":
      console.log(pc.red(`  x chain de checkpoint não íntegra: ${resumed.detail}`));
      return;
    case "RESUMED": {
      const { checkpoint: head } = resumed;
      console.log(pc.bold(`  ${head.statement}`));
      console.log(`  ${pc.dim("estado:")} ${head.state}`);
      console.log(`  ${pc.dim("checkpoint:")} ${head.id}`);
      if (head.contractId) console.log(`  ${pc.dim("contrato:")} ${head.contractId}`);
      if (head.planNodeId) console.log(`  ${pc.dim("nó do plano:")} ${head.planNodeId}`);
      for (const line of describeCheckpointCapabilityLines({ kind: "HEAD", ...head })) {
        console.log(`  ${pc.dim(line)}`);
      }
      if (resumed.context && resumed.context.items.length > 0) {
        console.log(`  ${pc.dim(`contexto: ${resumed.context.items.length} item(ns) relevante(s)`)}`);
      }
      if (resumed.context?.continuityIncomplete) {
        console.log("  CONTINUITY_CONTEXT_INCOMPLETE: consulte nexos decision; a retomada não recebeu todo o contexto aplicável.");
      }
      await mostrarVerificabilidadeDoHead(root, head.id);
      return;
    }
  }
}
