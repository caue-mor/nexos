/**
 * N3 (MEDIUM, revisão independente rodada 2).
 *
 * `runMemoryRecallAdapter`/`claudeMemoryRecall` e
 * `runUserPromptSubmitAdapter`/`claudeUserPromptSubmit` documentam "NUNCA
 * lança" como contrato — mesma doutrina dos outros adapters de hook do host
 * (`claude-session-close`, etc.). Os 4 chamavam `await persist()` direto,
 * sem try/catch: `writeShownIds`/`writePresentedId`/`registrarRecuperacao`
 * engolem sua PRÓPRIA falha de I/O, mas nada garantia que TODO `persist`
 * (presente ou futuro) teria a mesma disciplina — o contrato dos chamadores
 * não pode depender de quem implementa `persist` lembrar de se proteger.
 *
 * `persistirComSeguranca` é a mesma função (nome e corpo) em ambos os
 * arquivos, cada um exportado via `__testing` — testada aqui uma vez por
 * arquivo, com um `persist` que lança de propósito.
 */
import { describe, it, expect, vi } from "vitest";
import path from "node:path";
import os from "node:os";
import { sinalizarStdoutCompleto } from "../src/lib/host/budget-sentinel.js";
import { registrarRecuperacao } from "../src/lib/retrieval-log.js";
import { writePresentedId } from "../src/lib/host/state-presentation.js";
import fs from "fs-extra";
import { __testing as memoryRecallTesting } from "../src/host/claude/memory-recall.js";
import { __testing as userPromptSubmitTesting } from "../src/host/claude/user-prompt-submit.js";

describe.each([
  ["memory-recall.ts", memoryRecallTesting.persistirComSeguranca],
  ["user-prompt-submit.ts", userPromptSubmitTesting.persistirComSeguranca],
])("persistirComSeguranca (%s)", (_nome, persistirComSeguranca) => {
  it("persist que lança não propaga — contrato 'nunca lança' do chamador", async () => {
    const persistQueLanca = async (): Promise<void> => {
      throw new Error("falha simulada dentro de persist");
    };
    await expect(persistirComSeguranca(persistQueLanca)).resolves.toBeUndefined();
  });

  it("persist que lança SÍNCRONO (antes do primeiro await) também não propaga", async () => {
    const persistQueLancaSincrono = (): Promise<void> => {
      throw new Error("falha síncrona simulada");
    };
    await expect(persistirComSeguranca(persistQueLancaSincrono)).resolves.toBeUndefined();
  });

  it("persist que funciona normalmente ainda roda — não é um no-op disfarçado", async () => {
    let rodou = false;
    await persistirComSeguranca(async () => {
      rodou = true;
    });
    expect(rodou).toBe(true);
  });

  /** Revisão da rodada 3 (MEDIUM): NUNCA LANÇA != NUNCA AVISA — engolir sem rastro apagava a causa. */
  it("persist que lança deixa UMA linha em stderr com a causa", async () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      linhas.push(String(c));
      return true;
    });
    try {
      await persistirComSeguranca(async () => {
        throw new Error("disco cheio simulado");
      });
    } finally {
      spy.mockRestore();
    }
    expect(linhas).toHaveLength(1);
    expect(linhas[0]).toContain("disco cheio simulado");
  });
});

describe("sinalizarStdoutCompleto", () => {
  it("falha ao gravar a sentinela deixa rastro em stderr e não lança", () => {
    const linhas: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      linhas.push(String(c));
      return true;
    });
    try {
      const inexistente = path.join(os.tmpdir(), "nao-existe-nexos-sentinela", "sub", "done");
      expect(() => sinalizarStdoutCompleto({ NEXOS_BUDGET_DONE: inexistente })).not.toThrow();
    } finally {
      spy.mockRestore();
    }
    expect(linhas.join("")).toContain("ENOENT");
  });
});

/**
 * Revisão silent-failure (MEDIUM): o rastro de `persistirComSeguranca` nunca
 * dispara na prática — os `persist` reais engolem o próprio erro por dentro.
 * Se a escrita falhar sempre, a mesma memória volta a cada prompt e o buraco
 * na série parece "hook não rodou". O rastro mora onde o erro nasce.
 */
describe("persist real que falha deixa rastro em stderr", () => {
  async function capturarStderr(fn: () => Promise<void>): Promise<string> {
    const partes: string[] = [];
    const spy = vi.spyOn(process.stderr, "write").mockImplementation((c: string | Uint8Array) => {
      partes.push(String(c));
      return true;
    });
    try {
      await fn();
    } finally {
      spy.mockRestore();
    }
    return partes.join("");
  }
  const impossivel = path.join(os.tmpdir(), "nao-existe-nexos-persist", "sub", "arquivo");

  it("writeShownIds (memory-recall)", async () => {
    const saida = await capturarStderr(() => memoryRecallTesting.writeShownIds(impossivel, new Set(["knw_x"])));
    expect(saida).toContain("ENOENT");
  });

  it("writePresentedId (state-presentation)", async () => {
    const saida = await capturarStderr(() => writePresentedId(impossivel, "knw_x"));
    expect(saida).toContain("ENOENT");
  });

  it("registrarRecuperacao (retrieval-log) — root que é arquivo", async () => {
    const arquivo = path.join(os.tmpdir(), `nexos-persist-root-arquivo-${process.pid}`);
    await fs.writeFile(arquivo, "");
    try {
      const saida = await capturarStderr(() => registrarRecuperacao(arquivo, { fonte: "recall", estado: "teste" }));
      expect(saida).toMatch(/ENOTDIR|EEXIST/);
    } finally {
      await fs.remove(arquivo);
    }
  });
});
