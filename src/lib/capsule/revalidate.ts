/**
 * REVALIDAÇÃO — reconferir um fato que já teve prova.
 *
 *   EVIDENCE ANCHORED != EVIDENCE RE-RUN
 *
 * MEDIDO em 2026-09-19 por duas sessões com predicados independentes: a
 * disciplina de gravação está entre 79% e 93% — quase todo fato numerado
 * carrega a prova que o produziu. O problema nunca foi gravar. Seis
 * afirmações do Store envelheceram em silêncio num único dia, todas com
 * âncora CORRETA para o instante em que foram escritas:
 *
 *     gotcha do checkpoint      obsoleto em 3h28
 *     frase do audit            obsoleta em 11 dias
 *     "27 arquivos citam X"     eram 3, e zero no que é distribuído
 *
 * E não dá para minerar o acervo: `EVIDENCE É PROSA, NÃO CONTRATO`. De 995
 * records com evidência longa, 3 trazem comando entre crases. O resto é texto
 * com placeholder e contexto implícito. Por isso a revalidação só alcança o
 * que foi gravado com `verify_command` — o passado fica como está.
 *
 * ─── por que allowlist, e não confiança ─────────────────────────────────────
 *
 *   O STORE É ESCRITO POR AGENTE, E AGENTE ERRA
 *
 * O comando vem de um record. Mesmo sendo nós que escrevemos, executar string
 * gravada sem filtro transforma um erro de gravação em execução arbitrária. A
 * allowlist é de LEITURA PURA e fechada: o que não casa não roda, e isso é
 * resultado (`REFUSED`), nunca falha silenciosa.
 */
import { execFile } from "node:child_process";
import { promisify } from "node:util";

const exec = promisify(execFile);

/**
 * Comandos que só LEEM. Fechada de propósito: adicionar verbo aqui é decisão
 * com consequência, não conveniência. `git` entra apenas nos subcomandos de
 * leitura — `git log` sim, `git checkout` nunca.
 */
const PERMITIDOS = [
  /^grep\b/,
  /^rg\b/,
  /^find\b/,
  /^wc\b/,
  /^ls\b/,
  /^cat\b/,
  /^head\b/,
  /^tail\b/,
  /^sort\b/,
  /^uniq\b/,
  /^comm\b/,
  /^shasum\b/,
  /^test\b/,
  /^git (log|status|ls-files|show|diff|rev-parse|branch|cat-file)\b/,
  /^node dist\/index\.js [a-z-]+/,
  /^npm run (lint|typecheck|test|build)\b/,
] as const;

/**
 * Sintaxe que muda o mundo ou sai da máquina. Barra ANTES da allowlist: um
 * comando pode começar com `grep` e terminar com `> arquivo`.
 */
const PROIBIDOS = /(^|[\s;|&])(rm|mv|cp|chmod|chown|kill|curl|wget|ssh|npm i|npm install|yarn|pnpm)\b|>|>>|\$\(|`|&&\s*(rm|mv)/;

export type RevalidationState =
  /** Rodou e a saída bate com o esperado — o fato continua de pé. */
  | "CONFIRMED"
  /** Rodou e a saída NÃO bate — o fato envelheceu, e é isto que se queria achar. */
  | "DIVERGED"
  /** O comando não casa a allowlist, ou tem sintaxe proibida. Nunca executa. */
  | "REFUSED"
  /** Rodou e falhou (exit != 0) — pode ser o fato ou pode ser o ambiente. */
  | "FAILED"
  /** Estourou o tempo. Não é veredito sobre o fato. */
  | "TIMEOUT";

export interface RevalidationResult {
  readonly recordId: string;
  readonly command: string;
  readonly state: RevalidationState;
  /** Por que, em uma frase. Sempre presente — veredito sem motivo não serve. */
  readonly detail: string;
  readonly durationMs: number;
}

export function comandoPermitido(comando: string): boolean {
  const limpo = comando.trim();
  if (limpo.length === 0) return false;
  if (PROIBIDOS.test(limpo)) return false;
  return PERMITIDOS.some((p) => p.test(limpo));
}

export interface RevalidationInput {
  readonly recordId: string;
  readonly command: string;
  /** O que a saída deve conter. Ausente: só exige exit 0. */
  readonly expect?: string;
}

/**
 * Executa UM comando de revalidação.
 *
 * `cwd` é a raiz do projeto: os comandos gravados assumem isso, como qualquer
 * prova escrita durante o trabalho. `timeoutMs` existe porque um `find` mal
 * escrito num Store grande não pode travar a revalidação inteira.
 */
export async function revalidarUm(
  entrada: RevalidationInput,
  cwd: string,
  timeoutMs = 20_000
): Promise<RevalidationResult> {
  const inicio = Date.now();
  const base = { recordId: entrada.recordId, command: entrada.command };

  if (!comandoPermitido(entrada.command)) {
    return {
      ...base,
      state: "REFUSED",
      detail: "fora da allowlist de leitura pura, ou com sintaxe que escreve/sai da máquina",
      durationMs: 0,
    };
  }

  try {
    const { stdout } = await exec("sh", ["-c", entrada.command], {
      cwd,
      timeout: timeoutMs,
      maxBuffer: 4 * 1024 * 1024,
      env: { ...process.env, GIT_PAGER: "cat", PAGER: "cat" },
    });
    const durationMs = Date.now() - inicio;
    if (entrada.expect === undefined) {
      return { ...base, state: "CONFIRMED", detail: "exit 0, e nenhum esperado foi declarado", durationMs };
    }
    const bate = stdout.includes(entrada.expect);
    return {
      ...base,
      state: bate ? "CONFIRMED" : "DIVERGED",
      detail: bate
        ? `a saída contém "${entrada.expect}"`
        : `a saída NÃO contém "${entrada.expect}" — o fato envelheceu ou o comando mudou de significado`,
      durationMs,
    };
  } catch (erro) {
    const durationMs = Date.now() - inicio;
    const e = erro as { killed?: boolean; signal?: string; message?: string };
    if (e.killed === true || e.signal === "SIGTERM") {
      return { ...base, state: "TIMEOUT", detail: `passou de ${timeoutMs}ms`, durationMs };
    }
    return {
      ...base,
      state: "FAILED",
      detail: `exit != 0: ${(e.message ?? "sem mensagem").slice(0, 120)}`,
      durationMs,
    };
  }
}

/**
 * `DIVERGED` é o resultado ÚTIL, e por isso vem primeiro na ordenação: quem
 * roda revalidação quer achar o que envelheceu, não confirmar o que está de
 * pé. `REFUSED` vem logo atrás porque é defeito de gravação — comando que
 * ninguém consegue rodar não é prova, é texto.
 */
const ORDEM: Record<RevalidationState, number> = {
  DIVERGED: 0,
  REFUSED: 1,
  FAILED: 2,
  TIMEOUT: 3,
  CONFIRMED: 4,
};

export async function revalidarTodos(
  entradas: readonly RevalidationInput[],
  cwd: string,
  timeoutMs = 20_000
): Promise<readonly RevalidationResult[]> {
  const out: RevalidationResult[] = [];
  for (const entrada of entradas) {
    out.push(await revalidarUm(entrada, cwd, timeoutMs));
  }
  return out.sort((a, b) => ORDEM[a.state] - ORDEM[b.state] || a.recordId.localeCompare(b.recordId));
}
