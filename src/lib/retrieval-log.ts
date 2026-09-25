/**
 * O produtor que faltava para `knowledge retrieved` e `context injected`.
 *
 *     RECUPERAR SEM REGISTRAR NÃO DEIXA NADA PARA MEDIR
 *
 * MEDIDO em 2026-09-19, varrendo `src/` atrás de produtor para os sete sinais
 * de aprendizado que o dono do produto propôs:
 *
 *     verifier rejected    SIM         27 checkpoints FAILED no Store
 *     promotion latency    derivável   288 candidatos, 129 promovidos, com datas
 *     fact diverged        quase nada  4 records de 2231 têm `verify_command`
 *     knowledge retrieved  NADA        o recall recupera, injeta e não grava
 *     context injected     NADA        idem
 *     knowledge consumed   NADA        (é o `EFFECTIVE`: 108 invocações, zero sinal)
 *     violation recurred   NADA
 *
 * Os quatro ausentes são justamente os que fecham o ciclo "erro acontece →
 * conhecimento é armazenado → nova sessão → tarefa equivalente → o NexOS
 * recupera → o comportamento muda". Sem produtor em ponto nenhum do meio, a
 * resposta para "valeu a pena?" daqui a um mês é impressão, não medição.
 *
 * Este módulo resolve os dois primeiros. NÃO resolve `knowledge consumed` — e
 * essa fronteira é deliberada: saber que uma regra foi INJETADA não é saber
 * que ela foi USADA.
 *
 *     INJETADO != LIDO != APLICADO
 *
 * O que ele entrega é o DENOMINADOR. Sem saber o que entrou, nem faz sentido
 * perguntar o que foi aproveitado.
 *
 * ## Por que `.nexos/.local/`, nunca record canônico
 *
 * Uma linha por prompt vira milhares de entradas por semana. Gravar isso como
 * record faria o Store — que já custa 400ms para ler e cujo caminho de
 * retomada este projeto passou o dia enxugando — crescer com telemetria em vez
 * de conhecimento. `RETRIEVAL != AUTHORITY`: o que o recall escolheu mostrar é
 * observação de execução, não algo que o projeto AFIRMA.
 *
 * Derivado, gitignored, descartável: apagar este arquivo não perde verdade
 * nenhuma, só a série temporal.
 *
 * ## O que NÃO entra, de propósito
 *
 * **O texto do prompt.** Nem truncado. A pergunta do usuário não é telemetria
 * do produto, e um log de prompts num arquivo que ninguém audita é exatamente
 * o tipo de coleta que se justifica com "é só para medir" e depois vaza. Só a
 * CONTAGEM de termos que sobraram depois das stopwords — que é o que importa
 * para explicar por que o recall achou ou não achou algo.
 */
import { appendFile, readFile, writeFile, mkdir, stat } from "node:fs/promises";
import path from "node:path";
import { forProject } from "./capsule/paths.js";

/** Uma injeção de contexto, como ela aconteceu. */
export interface RetrievalEntry {
  /** Quem injetou: o hook de prompt, o brief de abertura, … */
  readonly fonte: "recall" | "brief";
  /** `RECALL` / `EMPTY` / `SKIPPED` — por que não houve injeção conta tanto quanto o que houve. */
  readonly estado: string;
  /** Sessão do host, quando existe. Correlaciona injeção com o trabalho que veio depois. */
  readonly sessao?: string;
  /** Termos do prompt que sobreviveram às stopwords. NUNCA o prompt. */
  readonly termos?: number;
  /** Quantos itens eram elegíveis ANTES do corte por orçamento/teto. */
  readonly candidatos?: number;
  /** Ids renderizados por extenso — o `knowledge retrieved` propriamente dito. */
  readonly mostrados?: readonly string[];
  /** Ids citados só por nome num índice: apareceram, mas sem corpo. */
  readonly nomeados?: readonly string[];
  /** Bytes que foram parar no contexto do modelo — o `context injected`. */
  readonly bytes?: number;
  /** Quando o estado não é `RECALL`, o motivo legível. */
  readonly motivo?: string;
}

/** Nome estável: quem for analisar a série procura por este arquivo. */
export const RETRIEVAL_LOG_BASENAME = "retrieval.jsonl";

/**
 * Teto de tamanho. Acima dele, a metade mais antiga é descartada.
 *
 * 2 MiB comporta ordem de 10 mil injeções — semanas de uso real. Um log que
 * cresce sem limite dentro do projeto do usuário é defeito, não observabilidade:
 * este repositório já mediu um `gotchas.md` chegar a 369 KB e a memória virar
 * decorativa. O teto existe para que ninguém precise se lembrar de podar.
 */
export const RETRIEVAL_LOG_MAX_BYTES = 2 * 1024 * 1024;

export function retrievalLogPath(root: string): string {
  return path.join(forProject(root).localRoot(), RETRIEVAL_LOG_BASENAME);
}

/**
 * Registra UMA injeção. Nunca lança, nunca bloqueia, nunca atrasa o hook por
 * mais do que um append de uma linha.
 *
 *     TELEMETRIA QUE QUEBRA O CAMINHO QUENTE É PIOR QUE TELEMETRIA AUSENTE
 *
 * Mesma doutrina de `writeShownIds` em `memory-recall.ts`: falha ao escrever
 * custa um ponto na série, jamais o adapter. Por isso todo o corpo está dentro
 * de um `try` que engole — inclusive `mkdir`, porque em clone recém-transportado
 * `.nexos/.local/` pode não existir ainda.
 */
export async function registrarRecuperacao(root: string, entrada: RetrievalEntry): Promise<void> {
  try {
    const destino = retrievalLogPath(root);
    await mkdir(path.dirname(destino), { recursive: true });
    await podarSeExcedeu(destino);

    const linha: Record<string, unknown> = {
      at: new Date().toISOString(),
      fonte: entrada.fonte,
      estado: entrada.estado,
    };
    if (entrada.sessao !== undefined) linha["sessao"] = entrada.sessao;
    if (entrada.termos !== undefined) linha["termos"] = entrada.termos;
    if (entrada.candidatos !== undefined) linha["candidatos"] = entrada.candidatos;
    if (entrada.mostrados !== undefined) linha["mostrados"] = [...entrada.mostrados];
    if (entrada.nomeados !== undefined) linha["nomeados"] = [...entrada.nomeados];
    if (entrada.bytes !== undefined) linha["bytes"] = entrada.bytes;
    if (entrada.motivo !== undefined) linha["motivo"] = entrada.motivo.slice(0, 200);

    await appendFile(destino, `${JSON.stringify(linha)}\n`, "utf-8");
  } catch (error) {
    // Observação, não contrato — mas sem rastro, buraco na série parece "hook não rodou".
    process.stderr.write(`nexos retrieval-log: ponto da série não gravado — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}

/**
 * Descarta a metade mais antiga quando o arquivo passa do teto.
 *
 * Perder o começo da série é aceitável; perder o fim não seria, porque a
 * pergunta que este log existe para responder é sempre sobre o comportamento
 * RECENTE. Corta em quebra de linha para nunca deixar meia entrada — um JSONL
 * com uma linha truncada é ilegível para quem lê com um parser estrito.
 */
async function podarSeExcedeu(destino: string): Promise<void> {
  let tamanho: number;
  try {
    tamanho = (await stat(destino)).size;
  } catch {
    return;
  }
  if (tamanho <= RETRIEVAL_LOG_MAX_BYTES) return;

  const bruto = await readFile(destino, "utf-8");
  const corte = bruto.indexOf("\n", Math.floor(bruto.length / 2));
  await writeFile(destino, corte < 0 ? "" : bruto.slice(corte + 1), "utf-8");
}

/** Uma entrada já lida de volta do disco. `desconhecido` no lugar de `any`. */
export type RetrievalLine = Record<string, unknown>;

/**
 * Lê a série de volta. Linha ilegível é PULADA e contada, nunca derruba a
 * leitura — o log é append-only de um hook que pode morrer no meio de uma
 * escrita, então meia linha é condição esperada, não corrupção.
 */
export async function lerRecuperacoes(
  root: string
): Promise<{ readonly linhas: readonly RetrievalLine[]; readonly ilegiveis: number }> {
  let bruto: string;
  try {
    bruto = await readFile(retrievalLogPath(root), "utf-8");
  } catch {
    return { linhas: [], ilegiveis: 0 };
  }

  const linhas: RetrievalLine[] = [];
  let ilegiveis = 0;
  for (const l of bruto.split("\n")) {
    const t = l.trim();
    if (t.length === 0) continue;
    try {
      const v: unknown = JSON.parse(t);
      if (typeof v === "object" && v !== null) linhas.push(v as RetrievalLine);
      else ilegiveis += 1;
    } catch {
      ilegiveis += 1;
    }
  }
  return { linhas, ilegiveis };
}
