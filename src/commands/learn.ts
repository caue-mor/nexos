import pc from "picocolors";
import fs from "fs-extra";
import path from "node:path";
import { readCurrentRecords } from "../lib/capsule/reader.js";
import { publishCanonical, StoreBoundaryError } from "../lib/capsule/store.js";
import { SecretMaterialError } from "../lib/capsule/secret-guard.js";
import { newRecordId } from "../lib/capsule/ids.js";
import { classifyForReconciliation } from "../lib/capsule/migration-classifier.js";
import { resolveCommandRoot } from "../lib/project-resolver.js";
import { forProject } from "../lib/capsule/paths.js";
import { validateManifest } from "../lib/capsule/schemas.js";
import { parseCanonical } from "../lib/capsule/codec.js";
import { proposeFromOutcome, dedupeCandidate, MemoryPromotionError } from "../lib/capsule/memory-promotion.js";
import type { ExecutionOutcome, LearnedFact } from "../lib/capsule/memory-promotion.js";
import type { CapsuleRecord } from "../lib/capsule/schemas.js";

/**
 * `nexos learn --from <chk_id>` — transforma trabalho VERIFICADO em candidato a
 * memória, pelo funil que já existe.
 *
 *   TRABALHO VERIFICADO != APRENDIZADO GRAVADO
 *
 * Medido em 2026-09-17: uma sessão produziu 4 gotchas, 3 decisões e 3
 * project_states, e um humano-agente digitou cada um. Busca por `promote` em
 * `src/host/` e `assets/hooks/`: zero. Nada promovia sozinho — e o Store já tem
 * gotcha de quando isso custou caro (`resultado do verifier virou gotcha mas
 * nunca virou project_state`, GOTCHA WRITTEN != STATE WRITTEN).
 *
 * O que este comando NÃO faz, por decisão de desenho:
 *
 * - **não promove.** Publica `memory_candidate` e para. `nexos memory
 *   --promote` continua sendo do coordenador — `single-canonical-writer`
 *   intacto. Promoção automática "quando dedupe=NOVEL e confiança alta" é
 *   exatamente a regra que aquela decisão proíbe.
 * - **não lê transcript nem diff.** Minerar fato de texto livre produz
 *   candidato que ninguém consegue reencontrar. Todo fato declarado vem de
 *   quem roda; o único que o comando afirma sozinho é o red->green
 *   cross-commit, que sai de Evidence com commit carimbado.
 * - **não roda em hook.** `session-close` tem stdout vazio por contrato, é
 *   proibido de escrever no Store (`p0-corte-presence-capability-observations`)
 *   e divide 1,5s entre três eventos — não cabe ler o Store para deduplicar.
 */
export interface LearnOptions {
  cwd?: string;
  /** Checkpoint de origem. Obrigatório: aprendizado sem contrato é anedota. */
  from?: string;
  /** Fatos declarados por quem roda. Pareado posicionalmente com `evidence`. */
  fact?: string[];
  evidence?: string[];
  /** `gotcha` é o único alvo da v1 — ver "fora da v1" no desenho. */
  kind?: string;
}

interface EvidenceFile {
  readonly id: string;
  readonly gate?: string;
  readonly commit?: string;
  readonly observed_pass?: boolean;
  readonly subject_ref?: string;
  readonly finished_at?: string;
}

/**
 * RED->GREEN atravessando commit — o único fato que o comando propõe sozinho.
 *
 * O filtro `commit` diferente não é zelo: das 16 transições red->green nas 687
 * Evidence deste acervo, **10 são no MESMO commit** — re-run, árvore suja,
 * flaky. Sem descontá-las, o "sinal de aprendizado" seria majoritariamente
 * ruído, e um detector que aprende com flaky ensina a suíte a mentir.
 */
export function redGreenCrossCommit(evidencias: readonly EvidenceFile[]): readonly string[] {
  const porGate = new Map<string, EvidenceFile[]>();
  for (const e of evidencias) {
    if (e.gate === undefined || e.observed_pass === undefined) continue;
    const lista = porGate.get(e.gate) ?? [];
    lista.push(e);
    porGate.set(e.gate, lista);
  }
  const achados: string[] = [];
  for (const [gate, lista] of porGate) {
    const ordenadas = [...lista].sort((a, b) => (a.finished_at ?? "").localeCompare(b.finished_at ?? ""));
    for (let i = 1; i < ordenadas.length; i += 1) {
      const antes = ordenadas[i - 1];
      const depois = ordenadas[i];
      if (antes === undefined || depois === undefined) continue;
      const virou = antes.observed_pass === false && depois.observed_pass === true;
      const commitMudou = antes.commit !== undefined && depois.commit !== undefined && antes.commit !== depois.commit;
      if (virou && commitMudou) {
        achados.push(`gate "${gate}" passou de vermelho (${antes.commit?.slice(0, 8)}) para verde (${depois.commit?.slice(0, 8)})`);
      }
    }
  }
  return achados;
}

/** Um checkpoint fechado não é head — ver o comentário em `learn()`. */
async function lerCheckpointDoDisco(root: string, id: string): Promise<CapsuleRecord | undefined> {
  const arquivo = path.join(forProject(root).recordsRoot(), "checkpoints", `${id}.yaml`);
  if (!(await fs.pathExists(arquivo))) return undefined;
  try {
    return parseCanonical(await fs.readFile(arquivo, "utf-8")) as CapsuleRecord;
  } catch {
    return undefined;
  }
}

async function lerEvidencesDoSujeito(root: string, subjectRef: string): Promise<readonly EvidenceFile[]> {
  const dir = path.join(forProject(root).localRoot(), "evidence");
  if (!(await fs.pathExists(dir))) return [];
  const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const out: EvidenceFile[] = [];
  for (const f of arquivos) {
    try {
      const raw = (await fs.readJson(path.join(dir, f))) as EvidenceFile;
      if (raw.subject_ref === subjectRef) out.push(raw);
    } catch {
      /** Evidence ilegível é ruído local, nunca motivo para falhar o comando. */
    }
  }
  return out;
}

export async function learn(options: LearnOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  const pre = await classifyForReconciliation(root);
  if (!pre.hasCanonical) {
    console.log(pc.yellow("  ! este projeto não tem Store."));
    console.log(pc.dim("    rode `nexos init` primeiro — candidato exige identidade canônica."));
    process.exitCode = 1;
    return;
  }
  if (!pre.reconcilable) {
    console.log(pc.yellow(`  ! \`.nexos\` tem entrada não reconhecida: ${pre.conflicting.join(", ")}`));
    console.log(pc.dim("    FAIL CLOSED — nada foi escrito."));
    process.exitCode = 1;
    return;
  }

  if (!options.from) {
    console.log(pc.red("  x `--from <chk_id>` é obrigatório."));
    console.log(pc.dim("    aprendizado sem checkpoint de origem é anedota: não tem contrato nem base de verificação."));
    process.exitCode = 1;
    return;
  }

  const manifesto = validateManifest(
    parseCanonical(await fs.readFile(forProject(root).manifest(), "utf-8"))
  );
  if (!manifesto.ok || !manifesto.value.project) {
    console.log(pc.red("  x manifest inválido ou sem project — `learn` exige um projeto."));
    process.exitCode = 1;
    return;
  }
  const projectId = manifesto.value.project.id;

  /**
   * `CANNOT OBSERVE != DOES NOT EXIST` — o próprio `ReadResult` carrega esse
   * aviso. Tratar Store ilegível como Store vazio faria o dedupe achar que nada
   * existe e republicar o acervo inteiro como novidade.
   */
  const leitura = await readCurrentRecords(root);
  if (!leitura.ok) {
    console.log(pc.red("  x Store ilegível — nada foi escrito."));
    for (const i of leitura.issues) console.log(pc.dim(`    ${JSON.stringify(i).slice(0, 120)}`));
    process.exitCode = 1;
    return;
  }
  const registros: readonly CapsuleRecord[] = leitura.records.map((r) => r.record);

  /**
   * O checkpoint vem do DISCO, não de `readCurrentRecords`.
   *
   *   CURRENT HEAD != EVERY CHECKPOINT
   *
   * A cadeia é append-only: cada transição publica um record novo e o anterior
   * deixa de ser head. Procurar o `SUCCEEDED` entre os heads acha só o último
   * de todos — qualquer trabalho fechado antes seria "não encontrado", que foi
   * exatamente o que aconteceu na primeira execução deste comando.
   */
  const checkpoint = await lerCheckpointDoDisco(root, options.from);
  if (checkpoint === undefined) {
    console.log(pc.red(`  x checkpoint "${options.from}" não encontrado no Store deste projeto.`));
    process.exitCode = 1;
    return;
  }
  const conteudo = checkpoint.content as Record<string, unknown>;
  const estado = typeof conteudo["state"] === "string" ? conteudo["state"] : "";
  if (estado !== "SUCCEEDED") {
    console.log(pc.yellow(`  ! o checkpoint está em "${estado}", não em SUCCEEDED.`));
    console.log(pc.dim("    só trabalho VERIFICADO vira candidato — antes disso não há o que aprender, há o que terminar."));
    process.exitCode = 1;
    return;
  }
  const statement = typeof conteudo["statement"] === "string" ? conteudo["statement"] : "";

  const evidencias = await lerEvidencesDoSujeito(root, options.from);
  const observados = redGreenCrossCommit(evidencias);

  console.log(pc.bold(`\n  learn · ${options.from}`));
  console.log(pc.dim(`  ${statement.slice(0, 110)}`));
  console.log(pc.dim(`  ${evidencias.length} evidence(s) do sujeito · ${observados.length} transição(ões) red→green cross-commit`));
  for (const o of observados) console.log(pc.dim(`    observado: ${o}`));

  const declarados: LearnedFact[] = [];
  const fatos = options.fact ?? [];
  const provas = options.evidence ?? [];
  for (const [i, fato] of fatos.entries()) {
    const prova = provas[i];
    if (prova === undefined || prova.trim() === "") {
      console.log(pc.red(`  x --fact "${fato.slice(0, 50)}" sem --evidence pareado.`));
      console.log(pc.dim("    fato sem prova reencontrável não é memória, é opinião com id."));
      process.exitCode = 1;
      return;
    }
    declarados.push({ fact: fato, evidence: prova, proposedKind: "gotcha", memoryScope: "project" });
  }

  if (declarados.length === 0) {
    /**
     * Sem `--fact`, o comando RELATA e sai 0. O detector sozinho não propõe:
     * "o gate virou verde" é observação, não lição — quem sabe o que se
     * aprendeu é quem consertou.
     */
    console.log(pc.dim("\n  nenhum --fact declarado — nada publicado."));
    console.log(pc.dim(`  para propor:  nexos learn --from ${options.from} --fact "<lição>" --evidence "<comando e saída>"`));
    return;
  }

  const outcome: ExecutionOutcome = {
    projectId,
    nodeId: options.from,
    occurredAt: new Date().toISOString(),
    learned: declarados,
  };

  let candidatos: readonly CapsuleRecord[];
  try {
    candidatos = proposeFromOutcome(outcome, () => newRecordId("KnowledgeRecord"));
  } catch (e) {
    if (e instanceof MemoryPromotionError) {
      console.log(pc.red(`  x ${e.message}`));
      process.exitCode = 1;
      return;
    }
    throw e;
  }

  const publicados: string[] = [];
  for (const candidato of candidatos) {
    const veredito = dedupeCandidate(candidato, registros);
    if (veredito.state === "DUPLICATE") {
      console.log(pc.yellow(`  ~ duplicata — não publicado: ${veredito.why}`));
      continue;
    }
    if (veredito.state === "CONFLICT") {
      console.log(pc.yellow(`  ! conflito com ${veredito.against.join(", ")}: ${veredito.why}`));
      console.log(pc.dim("    publicado assim mesmo: conflito é decisão humana, não motivo para engolir o fato."));
    }
    try {
      await publishCanonical(root, candidato);
      publicados.push(candidato.id);
    } catch (e) {
      if (e instanceof SecretMaterialError || e instanceof StoreBoundaryError) {
        console.log(pc.red(`  x ${e.message}`));
        process.exitCode = 1;
        return;
      }
      throw e;
    }
  }

  if (publicados.length === 0) {
    console.log(pc.dim("\n  nada publicado — tudo já estava no Store."));
    return;
  }
  console.log(pc.green(`\n  + ${publicados.length} candidato(s): ${publicados.join(", ")}`));
  console.log(pc.dim(`  promover:  nexos memory --promote ${publicados[0]} --why "<por que vale>"`));
  console.log(pc.dim("  quem promove é o coordenador — este comando nunca promove (single-canonical-writer)."));
}
