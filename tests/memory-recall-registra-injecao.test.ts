/**
 * O hook de recall REALMENTE grava o que injetou — a ligação, não o módulo.
 *
 *     DETECTOR PROVADO != CONSUMER PROVADO
 *
 * Esta sessão mediu duas vezes o mesmo buraco: um detector de drift com
 * controle negativo impecável cuja LIGAÇÃO ao brief podia ser removida com 87
 * testes verdes, e uma derivação de `outcome` correta cujo caminho de leitura
 * ninguém exercitava. `tests/retrieval-log.test.ts` prova o módulo; se só ele
 * existisse, arrancar a chamada de dentro do adapter passaria despercebido.
 *
 * O que se trava aqui é a outra metade: que o adapter chama, e que o que ele
 * grava DESCREVE a injeção que de fato aconteceu.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

import { init } from "../src/commands/init.js";
import { gotcha } from "../src/commands/gotcha.js";
import { runMemoryRecallAdapter, type MemoryRecallHookInput } from "../src/host/claude/memory-recall.js";
import { lerRecuperacoes } from "../src/lib/retrieval-log.js";
import { memory } from "../src/commands/memory.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;

const silencioso = <T>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => vi.restoreAllMocks());
};

async function projetoComGotcha(): Promise<string> {
  const root = path.join(ws, "projeto");
  await fs.ensureDir(root);
  await silencioso(() => init({ cwd: root, registerGlobally: false }));
  await silencioso(() =>
    gotcha({
      cwd: root,
      title: "Media query declarada antes da regra base e codigo morto",
      rule: "MEDIA QUERY ATIVA NAO E MEDIA QUERY APLICADA",
      failureMode: "responsividade verificada na largura do desenvolvedor nao verifica nada",
      evidence: "medido no console em 2026-09-19",
    })
  );
  return root;
}

const chamar = (root: string, sessionId: string, prompt: string): Promise<unknown> =>
  runMemoryRecallAdapter(
    { hook_event_name: "UserPromptSubmit", session_id: sessionId, cwd: root, prompt } as MemoryRecallHookInput,
    { CLAUDE_PROJECT_DIR: root }
  );

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "recall-log-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

describe("o hook de recall registra a injeção", () => {
  it("prompt que casa memória grava a linha com o id mostrado e os bytes injetados", async () => {
    const root = await projetoComGotcha();
    const r = (await chamar(root, "s1", "corrigir a media query do css que nao aplica")) as {
      state: string;
      text?: string;
    };
    expect(r.state).toBe("RECALL");

    const { linhas, ilegiveis } = await lerRecuperacoes(root);
    expect(ilegiveis).toBe(0);
    expect(linhas).toHaveLength(1);

    const l = linhas[0]!;
    expect(l["fonte"]).toBe("recall");
    expect(l["estado"]).toBe("RECALL");
    expect(l["sessao"]).toBe("s1");

    /**
     * O que torna isto `knowledge retrieved` de verdade: a CONTAGEM registrada
     * bate com o que foi renderizado. Sem esta igualdade, o log contaria
     * recuperações que o modelo nunca viu — pior que não contar.
     *
     * A comparação é por quantidade de itens renderizados, não por substring
     * do id: o bloco mostra `source_ref` (a identidade lógica, estável entre
     * versões) enquanto o log guarda o `id` (a versão exata que foi exibida).
     * São as duas metades certas — `source_ref` para o leitor humano, `id`
     * para auditar depois QUAL versão daquele conhecimento chegou ao modelo.
     */
    const mostrados = l["mostrados"] as string[];
    const itensRenderizados = (r.text ?? "").split("\n\n").filter((b) => b.startsWith("- "));
    expect(mostrados.length).toBe(itensRenderizados.length);
    expect(mostrados.length).toBeGreaterThan(0);

    /** E isto é `context injected`: o número tem que ser o tamanho real do bloco. */
    expect(l["bytes"]).toBe(Buffer.byteLength(r.text ?? "", "utf-8"));
  });

  /**
   * O `EMPTY` é metade do sinal. Sem ele, ausência de linha seria ambígua
   * entre "o hook não rodou" e "rodou e não achou nada".
   *
   *     SILÊNCIO NÃO PODE SIGNIFICAR DUAS COISAS
   */
  it("prompt sem relação grava EMPTY com bytes zero — e não injeta nada", async () => {
    const root = await projetoComGotcha();
    const r = (await chamar(root, "s2", "qual a receita de bolo de cenoura com cobertura")) as {
      state: string;
    };
    expect(r.state).toBe("EMPTY");

    const { linhas } = await lerRecuperacoes(root);
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toMatchObject({ estado: "EMPTY", bytes: 0 });
    expect(linhas[0]!["mostrados"]).toEqual([]);
  });

  it("uma linha por chamada — a série acompanha a sessão", async () => {
    const root = await projetoComGotcha();
    await chamar(root, "s3", "corrigir a media query do css");
    await chamar(root, "s3", "outra coisa totalmente sem relacao alguma");
    await chamar(root, "s3", "media query de novo");

    const { linhas } = await lerRecuperacoes(root);
    expect(linhas).toHaveLength(3);
    expect(linhas.every((l) => l["sessao"] === "s3")).toBe(true);
  });

  /**
   * CONTROLE — sem isto, gravar o prompt inteiro passaria nos testes acima. A
   * asserção é sobre o BYTE do arquivo, não sobre a API: se algum dia alguém
   * acrescentar um campo de texto, é aqui que cai.
   */
  it("o texto do prompt nunca chega ao disco", async () => {
    const root = await projetoComGotcha();
    const segredo = "mediaquerysupersecretaxyz";
    await chamar(root, "s4", `corrigir a media query ${segredo} do css`);

    const bruto = await fs.readFile(path.join(root, ".nexos", ".local", "retrieval.jsonl"), "utf-8");
    expect(bruto).not.toContain(segredo);
    expect(bruto.length).toBeGreaterThan(0);
  });

  /**
   * CONTROLE NEGATIVO do caminho quente: o hook roda em TODO prompt. Se o log
   * não puder ser escrito, o recall tem que entregar a memória do mesmo jeito.
   *
   *     TELEMETRIA QUE QUEBRA O CAMINHO QUENTE É PIOR QUE TELEMETRIA AUSENTE
   */
  it("log impossível de escrever não muda o que o recall devolve", async () => {
    const root = await projetoComGotcha();
    const bom = (await chamar(root, "s5", "corrigir a media query do css")) as { state: string; text?: string };

    /** Segundo projeto idêntico, com `.local` ocupado por um ARQUIVO: ENOTDIR real. */
    const root2 = path.join(ws, "bloqueado");
    await fs.ensureDir(root2);
    await silencioso(() => init({ cwd: root2, registerGlobally: false }));
    await silencioso(() =>
      gotcha({
        cwd: root2,
        title: "Media query declarada antes da regra base e codigo morto",
        rule: "MEDIA QUERY ATIVA NAO E MEDIA QUERY APLICADA",
        failureMode: "responsividade verificada na largura do desenvolvedor nao verifica nada",
        evidence: "medido no console em 2026-09-19",
      })
    );
    await fs.remove(path.join(root2, ".nexos", ".local"));
    await fs.writeFile(path.join(root2, ".nexos", ".local"), "sou um arquivo", "utf-8");

    const ruim = (await chamar(root2, "s5", "corrigir a media query do css")) as { state: string; text?: string };

    expect(ruim.state).toBe(bom.state);
    expect(ruim.state).toBe("RECALL");
    /** Nada foi gravado, e o recall entregou igual. */
    expect((await lerRecuperacoes(root2)).linhas).toEqual([]);
  });

  /**
   * O CONSUMIDOR. Sem este caso, o log seria mais um produtor que ninguém lê —
   * e este projeto já mediu um campo `freshness` com 379 `current`, 34
   * `unknown`, ZERO `stale` e nenhum leitor no código.
   *
   *     PRODUTOR SEM CONSUMIDOR VIRA CAMPO MORTO
   */
  it("`memory --retrieval --json` lê a série e conta o que foi injetado", async () => {
    const root = await projetoComGotcha();
    await chamar(root, "s6", "corrigir a media query do css");
    await chamar(root, "s6", "assunto totalmente sem relacao alguma nenhuma");

    const saida: string[] = [];
    vi.spyOn(console, "log").mockImplementation((...a: unknown[]) => {
      saida.push(a.map(String).join(" "));
    });
    await memory({ cwd: root, retrieval: true, json: true });
    vi.restoreAllMocks();

    const r = JSON.parse(saida.join("\n")) as {
      total: number;
      com_injecao: number;
      sem_injecao: number;
      ilegiveis: number;
      sessoes: number;
      bytes_injetados: number;
      records_distintos: number;
      por_record: readonly { id: string; vezes: number }[];
    };

    expect(r.total).toBe(2);
    expect(r.com_injecao).toBe(1);
    expect(r.sem_injecao).toBe(1);
    expect(r.ilegiveis).toBe(0);
    expect(r.sessoes).toBe(1);
    /** `context injected` agregado: veio da injeção real, não de um placeholder. */
    expect(r.bytes_injetados).toBeGreaterThan(0);
    /** `knowledge retrieved` por item — o que a pergunta "a memória certa chegou?" precisa. */
    expect(r.records_distintos).toBe(r.por_record.length);
    expect(r.records_distintos).toBeGreaterThan(0);
  });

});

/**
 * H3 REABERTO (revisão independente, rodada 2) — o describe que morava aqui
 * ("item 3, persist só depois do stdout") provava uma premissa FALSA: que
 * chamar `persist()` depois de obter `result`, DENTRO do mesmo processo,
 * bastava para proteger contra o kill de `nexos-budget.sh`. Não basta — o
 * wrapper redireciona o stdout do filho para um ARQUIVO e só o repassa ao
 * host se o filho sair dentro do orçamento; a ordem interna nunca foi a
 * variável que decidia isso. A prova real (sentinela + wrapper cooperando,
 * processo de verdade sob o `nexos-budget.sh` real, com o `appendFile` de
 * `registrarRecuperacao` atrasado além do orçamento) mora em
 * `tests/hook-budget-h3.test.ts`.
 */
