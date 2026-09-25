/**
 * FASE 2 do gate de promoção — os dois achados que eram implementáveis.
 *
 * `knw_01M34JTPH25MVNNBHGE4TK85XB` mediu três defeitos na fase 1:
 *
 *   1. não distingue humano de agente quando o agente herda o terminal
 *   2. `readSync` sem timeout CONGELA em vez de recusar
 *   3. type-ahead: um `y` digitado ANTES do prompt aprova o que ninguém leu
 *
 * O (1) exige `tcgetpgrp`, que a API do Node não expõe — fica aberto e dito.
 * (2) e (3) saem com `O_NONBLOCK`, MEDIDO antes de escrever código: leitura
 * sem dado lança `EAGAIN` (então dá para ter prazo em vez de bloqueio), e um
 * laço de descarte consome o que estava pendente e volta a `EAGAIN`.
 *
 *   SILÊNCIO NÃO É CONSENTIMENTO — e tecla de antes do prompt não é resposta
 *
 * Os casos usam FIFO, não arquivo regular: só um character device / pipe tem
 * a semântica de `EAGAIN` que o defeito envolve. Arquivo regular mediria o
 * fake — o mesmo motivo que `human-presence.ts` já documenta.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import {
  LIMITE_RESPOSTA_MS,
  descartarTypeAhead,
  lerComPrazo,
  interpretarResposta,
  requestHumanApproval,
} from "../src/lib/host/human-presence.js";

let lab: string;
let fifo: string;

beforeEach(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "fase2-"));
  fifo = path.join(lab, "tty");
  execFileSync("mkfifo", [fifo]);
});

afterEach(async () => {
  await fs.remove(lab);
});

const abrir = (): number => fs.openSync(fifo, fs.constants.O_RDWR | fs.constants.O_NONBLOCK);

/**
 * POR QUE OS DOIS HELPERS SÃO TESTADOS DIRETO, e não só pela função inteira:
 * num FIFO o prompt escrito cai na MESMA fila que a leitura consome, e um tty
 * tem filas separadas — escrita vai para a tela, leitura vem do teclado.
 * MEDIDO: com a função inteira sobre FIFO, `readSync` devolvia o próprio
 * prompt. O FIFO modela fielmente o LADO DA LEITURA (`EAGAIN`, type-ahead),
 * que é onde os dois defeitos vivem; não modela a escrita.
 *
 *   FIXTURE FIEL EM PARTE != FIXTURE FIEL
 *
 * A composição das duas com o prompt real só seria exercitável com um pty, e
 * o sandbox recusa (`openpty: Operation not permitted`, medido). O teto fica
 * escrito em vez de escondido atrás de um fixture que mede a si mesmo.
 */

describe("lerComPrazo — silêncio recusa, nunca congela", () => {
  it("devolve null quando o prazo estoura sem resposta, em vez de bloquear", () => {
    const fd = abrir();
    try {
      const t0 = Date.now();
      const n = lerComPrazo(fd, Buffer.alloc(16), 200);
      const gasto = Date.now() - t0;

      expect(n, "leu algo onde não havia nada").toBeNull();
      expect(gasto, "voltou antes do prazo").toBeGreaterThanOrEqual(150);
      expect(gasto, "ficou preso muito além do prazo").toBeLessThan(5000);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("lê a resposta quando ela chega dentro do prazo", () => {
    const fd = abrir();
    try {
      fs.writeSync(fd, "y\n");
      const buf = Buffer.alloc(16);
      const n = lerComPrazo(fd, buf, 1000);
      expect(n).toBe(2);
      expect(buf.toString("utf8", 0, n ?? 0)).toBe("y\n");
    } finally {
      fs.closeSync(fd);
    }
  });

  it("o prazo de produção é finito e declarado", () => {
    expect(LIMITE_RESPOSTA_MS).toBeGreaterThan(0);
    expect(Number.isFinite(LIMITE_RESPOSTA_MS)).toBe(true);
  });
});

describe("descartarTypeAhead — tecla de antes do prompt não é consentimento", () => {
  it("descarta o que já estava na fila", () => {
    const fd = abrir();
    try {
      fs.writeSync(fd, "y\n");
      descartarTypeAhead(fd);
      /** Depois do descarte não sobra nada: a leitura seguinte estoura o prazo. */
      expect(lerComPrazo(fd, Buffer.alloc(16), 150)).toBeNull();
    } finally {
      fs.closeSync(fd);
    }
  });

  it("um 'y' pendente deixa de virar aprovação — o defeito medido", () => {
    const fd = abrir();
    try {
      fs.writeSync(fd, "y\n");
      descartarTypeAhead(fd);
      const buf = Buffer.alloc(16);
      const n = lerComPrazo(fd, buf, 150);
      const resposta = n === null ? "" : buf.toString("utf8", 0, n);
      expect(interpretarResposta(resposta).approved, "o 'y' de antes do prompt ainda aprova").toBe(false);
    } finally {
      fs.closeSync(fd);
    }
  });

  it("não descarta nada quando a fila está vazia — não inventa consumo", () => {
    const fd = abrir();
    try {
      descartarTypeAhead(fd);
      fs.writeSync(fd, "s\n");
      const buf = Buffer.alloc(16);
      const n = lerComPrazo(fd, buf, 500);
      expect(interpretarResposta(buf.toString("utf8", 0, n ?? 0)).approved).toBe(true);
    } finally {
      fs.closeSync(fd);
    }
  });
});

/**
 * A LIGAÇÃO dentro de `requestHumanApproval`, não só os helpers.
 *
 *   HELPER TESTADO != HELPER CHAMADO
 *
 * MEDIDO em 24/09: tirar `descartarTypeAhead(fd)` ou trocar `lerComPrazo` por
 * `readSync` cru dentro de `requestHumanApproval` deixava a suíte inteira do
 * gate 70/70 verde. O bloqueio acima (prompt caindo na mesma fila do FIFO)
 * some com prompt VAZIO: `writeSync` de 0 bytes não enfileira nada, e o resto
 * do caminho — abrir, descartar, ler com prazo, interpretar — é o de produção.
 */
describe("requestHumanApproval — prazo e descarte ligados de verdade", () => {
  it("'y' pendente antes do prompt não aprova: é descartado e o prazo recusa", () => {
    const fd = abrir();
    fs.writeSync(fd, "y\n");
    const r = requestHumanApproval("", () => fd, 200);
    expect(r.approved, "o 'y' de antes do prompt ainda aprova").toBe(false);
    expect(r.why).toMatch(/prazo/);
  });

  it("silêncio recusa pelo PRAZO, não por erro de leitura", () => {
    const fd = abrir();
    const r = requestHumanApproval("", () => fd, 200);
    expect(r.approved).toBe(false);
    expect(r.why, "recusou por outro motivo que não o prazo").toMatch(/sem resposta no prazo/);
  });
});
