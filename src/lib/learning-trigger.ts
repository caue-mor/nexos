import fs from "fs-extra";
import path from "node:path";
import { readCurrentRecords } from "./capsule/reader.js";
import { publishCanonical } from "./capsule/store.js";
import { newRecordId } from "./capsule/ids.js";
import { forProject } from "./capsule/paths.js";
import { proposeFromOutcome, dedupeCandidate } from "./capsule/memory-promotion.js";
import type { ExecutionOutcome, LearnedFact } from "./capsule/memory-promotion.js";
import type { CapsuleRecord } from "./capsule/schemas.js";

/**
 * O gatilho automático do learning loop.
 *
 *   EVENTO QUE PODERIA DISPARAR != CAPABILITY REALMENTE CONSUMIDA
 *
 * `nexos learn` existia e tinha ZERO caller automático: alguém precisava
 * lembrar de digitá-lo, e ninguém lembrava. Uma capability que depende de
 * memória humana para registrar memória é a definição do problema que ela
 * deveria resolver.
 *
 * Três decisões de desenho, cada uma com o motivo medido:
 *
 * 1. **O gatilho é `SUCCEEDED`, o evento semântico mais estreito que existe.**
 *    `nexos verify` roda ~23x/dia neste repo e inundaria o Store; `SessionEnd`
 *    não sabe o que foi concluído; varredura periódica reprocessa o passado.
 *    `SUCCEEDED` acontece ~2x/dia e é o ÚNICO evento que já carrega contrato
 *    (o statement) e base de verificação (a Evidence do subject).
 *
 * 2. **Propõe, nunca promove.** Publica `memory_candidate` e para. A promoção
 *    continua exigindo `nexos memory --promote`, que é humano.
 *    `CANDIDATE != TRUTH` e `single-canonical-writer` seguem intactos — um
 *    gatilho que promovesse sozinho transformaria "o gate ficou verde" em
 *    verdade canônica sem ninguém ler.
 *
 * 3. **Nem todo SUCCEEDED vira candidato.** O único fato que o gatilho afirma
 *    sozinho é uma transição red→green ATRAVESSANDO commit. Das 16 transições
 *    no acervo deste repo, 10 eram no MESMO commit — re-run, árvore suja,
 *    flaky. Sem esse filtro, o "sinal de aprendizado" seria majoritariamente
 *    ruído, e um detector que aprende com flaky ensina a suíte a mentir.
 *
 * Reuso, não pipeline novo: `proposeFromOutcome` e `dedupeCandidate` são os
 * mesmos que `nexos learn` usa. A idempotência (reprocessar o mesmo
 * `SUCCEEDED` não duplica) sai do dedupe que já existe, não de um registro
 * novo de "já processei isto".
 */
/**
 * A assinatura deste produtor no Store. Antes disto o gatilho escrevia pelo
 * canal comum e saía como `nexos-memory-candidate`, indistinguível de escrita
 * à mão — e a única pista de que ele havia agido era `content.origin_note`.
 */
export const LEARNING_TRIGGER_PRODUCER = "nexos-learning-trigger";

export interface EvidenceFile {
  readonly id: string;
  readonly gate?: string;
  readonly commit?: string;
  readonly observed_pass?: boolean;
  readonly subject_ref?: string;
  readonly finished_at?: string;
}

export interface PropostaAutomatica {
  /** Ids publicados. Vazio é o caso comum e NÃO é erro. */
  readonly candidatos: readonly string[];
  /** Por que nada foi proposto, quando nada foi — para o caller poder dizer. */
  readonly motivo: string;
  /** Regra em uma linha, pronta para o human gate. */
  readonly regra: string;
}

/**
 * Extrai o subject de um record de checkpoint COMO O STORE O PUBLICA.
 *
 *   ENVELOPE FIELD != CONTENT FIELD
 *
 * `previous_checkpoint_id` mora no ENVELOPE. Lê-lo de `content` devolve
 * `undefined` sem erro nenhum — o gatilho não dispara, o SUCCEEDED sai normal,
 * e o learning loop fica morto em silêncio. Duas execuções reais passaram por
 * aqui parecendo corretas.
 *
 * Isto vive aqui, exportado, para que o teste importe A FUNÇÃO REAL. A versão
 * anterior tinha uma CÓPIA da leitura dentro do arquivo de teste, com um
 * comentário afirmando que a cópia denunciaria mudanças no original — uma
 * cópia local não denuncia nada, e a mutação que reintroduzia o bug deixava
 * 28/28 testes verdes.
 */
export function subjectDoCheckpoint(record: unknown): string {
  if (typeof record !== "object" || record === null) return "";
  const v = (record as Record<string, unknown>)["previous_checkpoint_id"];
  return typeof v === "string" ? v : "";
}

/** O projeto do record, pelo mesmo motivo: envelope, nunca `content`. */
export function projectIdDoCheckpoint(record: unknown): string {
  if (typeof record !== "object" || record === null) return "";
  const v = (record as Record<string, unknown>)["project_id"];
  return typeof v === "string" ? v : "";
}

/**
 * Corta na FRONTEIRA DE PALAVRA.
 *
 *   TRUNCAR NO MEIO DA PALAVRA PRODUZ MEMÓRIA ILEGÍVEL
 *
 * A regra do candidato é o que um humano lê no gate de promoção e o que outra
 * sessão recupera meses depois. Um corte cego em N caracteres entrega
 * "...o executor não julga se ca" — e regra que termina em fragmento é regra
 * que ninguém aplica. Palavra única maior que o limite ainda é cortada, senão
 * um identificador longo furaria o teto.
 */
export function cortarStatement(texto: string, limite: number): string {
  const limpo = texto.replace(/\s+/g, " ").trim();
  if (limpo.length <= limite) return limpo;
  const fatia = limpo.slice(0, limite);
  const ultimoEspaco = fatia.lastIndexOf(" ");
  return ultimoEspaco > 0 ? `${fatia.slice(0, ultimoEspaco)}…` : `${fatia}…`;
}

/**
 * Transição red→green que ATRAVESSA commit. O filtro de commit é o que separa
 * aprendizado de ruído de re-execução — ver o ponto 3 acima.
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

export async function lerEvidencesDoSujeito(root: string, subjectRef: string): Promise<readonly EvidenceFile[]> {
  const dir = path.join(forProject(root).localRoot(), "evidence");
  if (!(await fs.pathExists(dir))) return [];
  const arquivos = (await fs.readdir(dir)).filter((f) => f.endsWith(".json"));
  const out: EvidenceFile[] = [];
  for (const f of arquivos) {
    try {
      const raw = (await fs.readJson(path.join(dir, f))) as EvidenceFile;
      if (raw.subject_ref === subjectRef) out.push(raw);
    } catch {
      /** Evidence ilegível é ruído local, nunca motivo para falhar a transição. */
    }
  }
  return out;
}

/**
 * Chamado logo depois de um checkpoint entrar em SUCCEEDED.
 *
 * NUNCA lança: um defeito aqui não pode derrubar a transição do checkpoint —
 * o trabalho foi verificado, e perder isso porque a proposta de memória falhou
 * seria trocar o certo pelo acessório.
 */
export async function proporAoConcluir(
  root: string,
  checkpointId: string,
  subjectRef: string,
  statement: string,
  projectId: string
): Promise<PropostaAutomatica> {
  try {
    const evidencias = await lerEvidencesDoSujeito(root, subjectRef);
    const observados = redGreenCrossCommit(evidencias);
    if (observados.length === 0) {
      return { candidatos: [], motivo: "nenhuma transição red→green cross-commit neste trabalho", regra: "" };
    }

    /**
     * O fato afirmado é o que FOI OBSERVADO, com o statement como contexto —
     * nunca uma lição inventada a partir do texto. Quem sabe o que se aprendeu
     * é quem consertou; o gatilho registra que houve o que aprender.
     */
    /**
     *   UM SINAL RELATADO != TODOS OS SINAIS OBSERVADOS
     *
     * A primeira versão citava `observados[0]`. Com `lint` e `build` virando
     * verde no mesmo trabalho, o candidato mencionava um e escondia o outro —
     * e quem lesse a memória depois concluiria que só um gate estivera
     * quebrado. Relatar parte do que se observou é pior que não relatar: vira
     * uma meia-verdade com id canônico.
     */
    /**
     *   DOIS FATOS NA MESMA FRASE VIRAM UM FATO FALSO
     *
     * A primeira versão soldava o `statement` do checkpoint com os red→green
     * observados, como se descrevessem o mesmo trabalho. Não descrevem: o
     * statement é fixado quando a tarefa ABRE e não acompanha o que a cadeia
     * faz depois; os red→green vêm de QUALQUER Evidence sob o subject, de
     * qualquer momento.
     *
     * Aconteceu em produção, e o dono promoveu: o statement falava do bug do
     * ENVELOPE — que nunca acendeu gate algum, porque falhar em silêncio ERA
     * o defeito — e os gates citados vinham do ciclo de OUTRO trabalho. A
     * memória canônica passou a afirmar que os gates pegaram o bug silencioso.
     * O inverso da verdade, com id canônico e aprovação humana.
     *
     * A correção não é escolher melhor: é PARAR DE AFIRMAR o que não se
     * observou. O fato registrado é só o que a Evidence sustenta — a transição
     * de gate, com seus commits. O statement entra como CONTEXTO rotulado, que
     * o leitor pode conferir, não como causa.
     */
    const fato = `${observados.join("; ")} [tarefa aberta como: ${cortarStatement(statement, 110)}]`;
    const evidencia = `checkpoint ${checkpointId} SUCCEEDED; ${evidencias.length} evidence(s) do subject ${subjectRef}; ${observados.join("; ")}`;
    const learned: LearnedFact[] = [
      { fact: fato, evidence: evidencia, proposedKind: "gotcha", memoryScope: "project" },
    ];
    const outcome: ExecutionOutcome = {
      projectId,
      nodeId: checkpointId,
      occurredAt: new Date().toISOString(),
      learned,
    };

    const leitura = await readCurrentRecords(root);
    /** `CANNOT OBSERVE != DOES NOT EXIST` — sem Store legível, o dedupe seria cego. */
    if (!leitura.ok) return { candidatos: [], motivo: "Store ilegível — proposta suprimida", regra: "" };
    const existentes: readonly CapsuleRecord[] = leitura.records.map((r) => r.record);

    const candidatos = proposeFromOutcome(outcome, () => newRecordId("KnowledgeRecord"), LEARNING_TRIGGER_PRODUCER);
    const publicados: string[] = [];
    for (const candidato of candidatos) {
      /**
       * IDEMPOTÊNCIA sem registro novo: reprocessar o mesmo SUCCEEDED produz o
       * mesmo fato, e o dedupe já existente o reconhece como DUPLICATE. Um
       * campo "já processei este checkpoint" seria um segundo pipeline de
       * controle para um problema que o funil já resolve.
       */
      if (dedupeCandidate(candidato, existentes).state === "DUPLICATE") continue;
      await publishCanonical(root, candidato);
      publicados.push(candidato.id);
    }
    if (publicados.length === 0) {
      return { candidatos: [], motivo: "já existe candidato equivalente — nada duplicado", regra: "" };
    }
    return { candidatos: publicados, motivo: "", regra: fato };
  } catch {
    /** Ver o comentário da assinatura: a transição do checkpoint é soberana. */
    return { candidatos: [], motivo: "proposta automática falhou — transição preservada", regra: "" };
  }
}
