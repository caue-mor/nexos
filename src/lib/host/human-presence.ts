/**
 * HUMAN PRESENCE — o único sinal de humano que NÃO passa pelo argv.
 *
 *   CLI INVOCATION != HUMAN PRESENCE
 *   APPROVAL STRING != HUMAN APPROVAL
 *
 * `--approved-by human:steve` e `--why "o dono aprovou"` são texto que o
 * próprio chamador escreve: não provam nada, e foi por isso que
 * STORE AUTHORITY BOUNDARY V1 tirou `--approved-by` de `gotcha`/`state`. Lá
 * bastou parar de ALEGAR presença humana (sempre `policy:`, nunca `human:`),
 * porque escrever um gotcha é ato legítimo de agente.
 *
 * `memory --promote` é diferente: o ato promovido É a admissão, o gate que a
 * arquitetura reservou para um humano. Registro honesto não substitui gate —
 * `memory.ts` carimbava `policy:nexos-memory-promote` com toda a honestidade
 * do mundo enquanto passava `humanApproved: true` hardcoded, e um agente
 * promoveu 4 candidatos a gotcha canônico num único turno, sem nenhuma
 * mensagem humana no meio (log da sessão 74db5d34, linhas 20 → 137 → 167).
 *
 * O sinal usado aqui é o TERMINAL CONTROLADOR. Um comando lançado por agente
 * não tem um. MEDIDO nesta máquina, pela Bash tool do host:
 *
 *     /dev/tty  -> ENXIO        stdin.isTTY  -> undefined
 *                               stdout.isTTY -> undefined
 *
 * `stdin.isTTY` sozinho não serve: um pipe qualquer o derruba e um humano
 * legítimo rodando `nexos ... < arquivo` seria recusado. `/dev/tty` é o
 * terminal da SESSÃO, independente de para onde stdin e stdout apontem.
 *
 * ponytail: isto NÃO é inforjável. `script -q` ou `expect` aloca um pty e
 * responde nele. O que muda é o custo: a promoção por agente deixa de ser o
 * CAMINHO PADRÃO — que é o que aconteceu — e passa a exigir um ato deliberado
 * de evasão, que fica no transcript do host. Inforjável de verdade exige que a
 * aprovação chegue de FORA do processo (hook do host, canal separado), e isso
 * é a fase seguinte, registrada como NEXT — não um upgrade especulativo daqui.
 */
import fs from "fs-extra";

/**
 * Abre o terminal controlador. Só o TESTE substitui — não há flag de CLI nem
 * campo em `MemoryOptions` que chegue até aqui, então um agente invocando
 * `nexos memory --promote` não tem por onde injetar um aprovador complacente.
 * Mesmo padrão de `managedSettingsPath` em `memory-authority.ts`: produção
 * nunca passa o parâmetro.
 */
export type TtyOpener = () => number;

/** `O_NONBLOCK`: sem ele `readSync` bloqueia a thread e não há prazo possível. */
const openControllingTty: TtyOpener = () =>
  fs.openSync("/dev/tty", fs.constants.O_RDWR | fs.constants.O_NONBLOCK);

export interface HumanApproval {
  readonly approved: boolean;
  /** `human:tty` quando aprovado; string vazia quando não — `ABSENCE = FIELD ABSENT`. */
  readonly approvedBy: string;
  /** Por que foi recusado, ou como foi aprovado. Vai para o log, nunca para o record. */
  readonly why: string;
}

const RECUSA_SEM_TTY: HumanApproval = {
  approved: false,
  approvedBy: "",
  why:
    "sem terminal controlador (/dev/tty indisponível) — a admissão exige um humano no terminal. " +
    "Um agente PROPÕE (nexos memory --fact), nunca ADMITE.",
};

/**
 * A DECISÃO, separada do IO — função pura, testável sem terminal nenhum.
 *
 * Existe separada porque um fd de arquivo regular NÃO consegue imitar um tty:
 * MEDIDO neste repo, depois de `writeSync(prompt)` o cursor fica no fim e
 * `readSync(..., null)` devolve 0 bytes, enquanto um character device ignora o
 * offset e entrega o que foi digitado. Um teste que tentasse falsificar o
 * terminal com um arquivo mediria o próprio fake — dois casos deste arquivo
 * chegaram a "passar" lendo string vazia, que é recusa por outro motivo.
 *
 *   TESTE QUE MEDE O FAKE != TESTE QUE MEDE O CÓDIGO
 */
export function interpretarResposta(bruta: string): HumanApproval {
  const resposta = bruta.trim().toLowerCase();

  /** Só "y"/"s" explícito admite: Enter vazio é recusa, não consentimento. */
  if (resposta !== "y" && resposta !== "s") {
    return {
      approved: false,
      approvedBy: "",
      why: `recusado no terminal (resposta: ${resposta === "" ? "<vazia>" : `"${resposta}"`})`,
    };
  }

  return { approved: true, approvedBy: "human:tty", why: "aprovado no terminal controlador" };
}

/**
 * Pergunta no terminal controlador e devolve o veredito. Falha fechada: tudo
 * que não for um "sim" digitado por alguém é recusa.
 *
 *   FAIL CLOSED — a dúvida nunca promove.
 */
/**
 * Prazo para o humano responder. FINITO por decisão: `fs.readSync` bloqueia a
 * THREAD, e sem prazo um agente que herdou o terminal do dono fica pendurado
 * para sempre — MEDIDO em `knw_01M34JTPH25MVNNBHGE4TK85XB`, onde o modo de
 * falha não era recusa, era congelamento.
 *
 *   SILÊNCIO NÃO É CONSENTIMENTO — e esperar para sempre não é fail-closed
 */
export const LIMITE_RESPOSTA_MS = 120_000;

/** Dorme sem async: `readSync` já é síncrono, e o laço precisa ceder CPU. */
function dormir(ms: number): void {
  Atomics.wait(new Int32Array(new SharedArrayBuffer(4)), 0, 0, ms);
}

/**
 * Descarta o que já estava no buffer do terminal ANTES do prompt.
 *
 *   TECLA DE ANTES DO PROMPT != RESPOSTA
 *
 * `readSync` entrega o que estiver na fila de entrada, então um `y` digitado
 * para outra coisa aprovava uma promoção que o humano nunca leu — "alguém
 * digitou" e "alguém consentiu com ISTO" deixavam de ser a mesma coisa.
 * POSIX resolveria com `tcflush`, que o Node não expõe; o equivalente é ler
 * em modo não-bloqueante até `EAGAIN`.
 *
 * Só em character device: num arquivo regular não existe type-ahead, e drenar
 * comeria o conteúdo que o próprio teste posicionou.
 */
export function descartarTypeAhead(fd: number): void {
  const lixo = Buffer.alloc(256);
  for (;;) {
    try {
      const n = fs.readSync(fd, lixo, 0, lixo.length, null);
      if (n === 0) return;
    } catch {
      return;
    }
  }
}

/** `true` só quando o fd é tty/pipe — onde `EAGAIN` e type-ahead existem. */
function ehDispositivoDeEntrada(fd: number): boolean {
  try {
    const st = fs.fstatSync(fd);
    return st.isCharacterDevice() || st.isFIFO() || st.isSocket();
  } catch {
    return false;
  }
}

/**
 * Lê com prazo. Devolve `null` quando o prazo estourou sem uma resposta —
 * distinto de "leu vazio", que é resposta vazia e já era recusa.
 */
export function lerComPrazo(fd: number, buf: Buffer, limiteMs: number): number | null {
  const fim = Date.now() + limiteMs;
  for (;;) {
    try {
      return fs.readSync(fd, buf, 0, buf.length, null);
    } catch (error) {
      const code = (error as { code?: string }).code;
      if (code !== "EAGAIN" && code !== "EWOULDBLOCK") throw error;
      if (Date.now() >= fim) return null;
      dormir(25);
    }
  }
}

/**
 * Pergunta no terminal controlador e devolve o veredito. Falha fechada: tudo
 * que não for um "sim" digitado por alguém é recusa.
 *
 *   FAIL CLOSED — a dúvida nunca promove.
 *
 * FASE 2 PARCIAL: dois dos três defeitos medidos em
 * `knw_01M34JTPH25MVNNBHGE4TK85XB` estão fechados aqui — o congelamento (agora
 * há prazo) e o type-ahead (agora há descarte). O terceiro, distinguir humano
 * de agente quando o agente herda o terminal, continua ABERTO: exigiria
 * `tcgetpgrp` para comparar o process group do processo com o do terminal, e
 * a API do Node não expõe essa chamada. Não é limitação aceita em silêncio —
 * é gap nomeado, sem workaround honesto em Node puro.
 */
export function requestHumanApproval(
  prompt: string,
  openTty: TtyOpener = openControllingTty,
  limiteMs: number = LIMITE_RESPOSTA_MS
): HumanApproval {
  let fd: number;
  try {
    fd = openTty();
  } catch {
    return RECUSA_SEM_TTY;
  }

  try {
    if (ehDispositivoDeEntrada(fd)) descartarTypeAhead(fd);
    fs.writeSync(fd, prompt);
    const buf = Buffer.alloc(16);
    const lidos = lerComPrazo(fd, buf, limiteMs);
    if (lidos === null) {
      return {
        approved: false,
        approvedBy: "",
        why: `sem resposta no prazo de ${String(Math.round(limiteMs / 1000))}s — silêncio não é consentimento`,
      };
    }
    return interpretarResposta(buf.toString("utf8", 0, lidos));
  } catch (error) {
    /** Terminal ilegível não é aprovação — mesma regra de `readKey` em
     *  `memory-authority.ts`: quebrado não decide nada. */
    return {
      approved: false,
      approvedBy: "",
      why: `falha ao ler confirmação do terminal: ${error instanceof Error ? error.message : String(error)}`,
    };
  } finally {
    try {
      fs.closeSync(fd);
    } catch {
      /* fd já fechado pelo opener de teste — nada a fazer */
    }
  }
}
