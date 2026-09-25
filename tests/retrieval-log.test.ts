/**
 * O log de recuperação — o produtor de `knowledge retrieved` e `context
 * injected`, que não existiam.
 *
 *     RECUPERAR SEM REGISTRAR NÃO DEIXA NADA PARA MEDIR
 *
 * Os asserts aqui seguem a régua que esta sessão pagou caro para aprender:
 * nada de `not.toBe("")` nem `toBeGreaterThan(0)` sozinho. Cada um tem um
 * conjunto ou um número exato, porque
 *
 *     ASSERÇÃO FRACA PASSA NO BUG QUE ELA NOMEIA PROIBIR
 *
 * — medido no mesmo dia: uma asserção de "não vazio" deixou passar um
 * vazamento que fazia 2 registros sumirem para sempre, com a suíte 35/35 verde.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

import {
  registrarRecuperacao,
  lerRecuperacoes,
  retrievalLogPath,
  RETRIEVAL_LOG_MAX_BYTES,
} from "../src/lib/retrieval-log.js";

let ws: string;
let root: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-retlog-"));
  root = path.join(ws, "projeto");
  await fs.ensureDir(path.join(root, ".nexos"));
});

afterEach(async () => {
  await fs.remove(ws);
});

describe("registrarRecuperacao", () => {
  it("grava uma injeção com os ids e os bytes que foram para o contexto", async () => {
    await registrarRecuperacao(root, {
      fonte: "recall",
      estado: "RECALL",
      sessao: "s1",
      termos: 4,
      candidatos: 12,
      mostrados: ["knw_A", "knw_B"],
      nomeados: ["dec_C"],
      bytes: 1832,
    });

    const { linhas, ilegiveis } = await lerRecuperacoes(root);
    expect(ilegiveis).toBe(0);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({
      fonte: "recall",
      estado: "RECALL",
      sessao: "s1",
      termos: 4,
      candidatos: 12,
      mostrados: ["knw_A", "knw_B"],
      nomeados: ["dec_C"],
      bytes: 1832,
    });
    /** `at` é o que torna a série temporal — sem ele não dá para ver tendência. */
    expect(typeof linhas[0]!["at"]).toBe("string");
  });

  /**
   * O `EMPTY` é metade do sinal. Sem ele, ausência de linha seria ambígua
   * entre "o recall não rodou" e "rodou e não achou nada" — e essas duas
   * conclusões levam a lugares opostos.
   *
   *     SILÊNCIO NÃO PODE SIGNIFICAR DUAS COISAS
   */
  it("grava também quando não injetou nada, com o porquê mensurável", async () => {
    await registrarRecuperacao(root, {
      fonte: "recall",
      estado: "EMPTY",
      termos: 5,
      candidatos: 0,
      mostrados: [],
      nomeados: [],
      bytes: 0,
    });

    const { linhas } = await lerRecuperacoes(root);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ estado: "EMPTY", termos: 5, candidatos: 0, bytes: 0 });
  });

  it("acumula em ordem de escrita — a série é o dado, não a última linha", async () => {
    for (let i = 0; i < 5; i++) {
      await registrarRecuperacao(root, { fonte: "recall", estado: "RECALL", bytes: i });
    }
    const { linhas } = await lerRecuperacoes(root);
    expect(linhas.map((l) => l["bytes"])).toEqual([0, 1, 2, 3, 4]);
  });

  /**
   * CONTROLE NEGATIVO — o que decide se isto pode existir no caminho quente.
   * O recall roda em TODO prompt; telemetria que derruba o hook é pior que
   * telemetria nenhuma.
   *
   *     TELEMETRIA QUE QUEBRA O CAMINHO QUENTE É PIOR QUE TELEMETRIA AUSENTE
   *
   * Aqui o destino é um ARQUIVO onde deveria haver diretório, então `mkdir` e
   * `appendFile` falham de verdade — não é mock de erro, é erro de sistema de
   * arquivos. A função tem que devolver normalmente mesmo assim.
   */
  it("destino impossível não lança — a promessa resolve e o hook segue", async () => {
    const bloqueado = path.join(ws, "bloqueado");
    await fs.ensureDir(path.join(bloqueado, ".nexos"));
    /** `.local` vira ARQUIVO: qualquer escrita abaixo dele falha com ENOTDIR. */
    await fs.writeFile(path.join(bloqueado, ".nexos", ".local"), "sou um arquivo", "utf-8");

    await expect(
      registrarRecuperacao(bloqueado, { fonte: "recall", estado: "RECALL", bytes: 10 })
    ).resolves.toBeUndefined();

    const { linhas } = await lerRecuperacoes(bloqueado);
    expect(linhas).toEqual([]);
  });

  /**
   * CONTROLE DE PRIVACIDADE, e o que mais importa neste arquivo. Um log de
   * prompts dentro do projeto é exatamente o tipo de coleta que se justifica
   * com "é só para medir". A API não aceita o texto, e este teste trava isso:
   * o que entra é CONTAGEM de termos, nunca os termos.
   */
  it("nenhum campo carrega texto livre do usuário", async () => {
    await registrarRecuperacao(root, {
      fonte: "recall",
      estado: "RECALL",
      termos: 3,
      candidatos: 7,
      mostrados: ["knw_A"],
      bytes: 42,
    });

    const bruto = await fs.readFile(retrievalLogPath(root), "utf-8");
    const chaves = Object.keys(JSON.parse(bruto.trim()) as Record<string, unknown>).sort();
    expect(chaves).toEqual(["at", "bytes", "candidatos", "estado", "fonte", "mostrados", "termos"]);
    /** Nenhuma chave de texto livre existe no formato — nem vazia, nem truncada. */
    for (const proibida of ["prompt", "texto", "text", "query", "intent"]) {
      expect(chaves).not.toContain(proibida);
    }
  });

  it("`motivo` é truncado — campo legível não vira despejo", async () => {
    await registrarRecuperacao(root, {
      fonte: "recall",
      estado: "SKIPPED",
      motivo: "x".repeat(5000),
    });
    const { linhas } = await lerRecuperacoes(root);
    expect((linhas[0]!["motivo"] as string).length).toBe(200);
  });
});

describe("poda por teto", () => {
  /**
   * Log que cresce sem limite dentro do projeto do usuário é defeito, não
   * observabilidade — este repositório já mediu um índice de memória chegar a
   * 369 KB e a memória virar decorativa.
   */
  it("acima do teto, descarta o começo e preserva o fim", async () => {
    const destino = retrievalLogPath(root);
    await fs.ensureDir(path.dirname(destino));

    const encher = `${JSON.stringify({ at: "x", fonte: "recall", estado: "ANTIGO" })}\n`;
    const vezes = Math.ceil(RETRIEVAL_LOG_MAX_BYTES / encher.length) + 10;
    await fs.writeFile(destino, encher.repeat(vezes), "utf-8");
    expect((await fs.stat(destino)).size).toBeGreaterThan(RETRIEVAL_LOG_MAX_BYTES);

    await registrarRecuperacao(root, { fonte: "recall", estado: "NOVO", bytes: 1 });

    expect((await fs.stat(destino)).size).toBeLessThan(RETRIEVAL_LOG_MAX_BYTES);
    const { linhas, ilegiveis } = await lerRecuperacoes(root);
    /** O corte é em quebra de linha: nenhuma entrada meio escrita sobra. */
    expect(ilegiveis).toBe(0);
    /** O que a pergunta precisa é o comportamento RECENTE — o fim nunca se perde. */
    expect(linhas[linhas.length - 1]).toMatchObject({ estado: "NOVO" });
    expect(linhas.some((l) => l["estado"] === "ANTIGO")).toBe(true);
  });

  /** CONTROLE: abaixo do teto nada é descartado. Sem isto, podar sempre passaria no teste acima. */
  it("abaixo do teto, nenhuma linha some", async () => {
    for (let i = 0; i < 20; i++) {
      await registrarRecuperacao(root, { fonte: "recall", estado: "RECALL", bytes: i });
    }
    const { linhas } = await lerRecuperacoes(root);
    expect(linhas).toHaveLength(20);
    expect(linhas[0]).toMatchObject({ bytes: 0 });
  });
});

describe("leitura tolerante", () => {
  /**
   * Append-only de um hook que pode morrer no meio da escrita: meia linha é
   * condição ESPERADA, não corrupção. Pular e CONTAR — silenciar seria
   * esconder, e o contador é o que denuncia se virar regra.
   */
  it("linha ilegível é pulada e contada, nunca derruba a leitura", async () => {
    const destino = retrievalLogPath(root);
    await fs.ensureDir(path.dirname(destino));
    await fs.writeFile(
      destino,
      `${JSON.stringify({ at: "1", estado: "RECALL" })}\n{"at":"2","esta\n${JSON.stringify({ at: "3", estado: "EMPTY" })}\n`,
      "utf-8"
    );

    const { linhas, ilegiveis } = await lerRecuperacoes(root);
    expect(linhas.map((l) => l["at"])).toEqual(["1", "3"]);
    expect(ilegiveis).toBe(1);
  });

  it("log ausente é condição válida, não erro", async () => {
    const { linhas, ilegiveis } = await lerRecuperacoes(path.join(ws, "nunca-existiu"));
    expect(linhas).toEqual([]);
    expect(ilegiveis).toBe(0);
  });
});
