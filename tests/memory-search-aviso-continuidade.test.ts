/**
 * O aviso de "decisões de continuidade que não casaram" listava TODAS as
 * chaves. Medido em 2026-09-19 na máquina do dono: 3998 bytes numa busca sem
 * nenhum resultado — mais que o bloco de memória completo de um prompt.
 *
 *   ÍNDICE NÃO É INVENTÁRIO
 *
 * O aviso existe para que uma restrição aplicável não vire silêncio, e isso a
 * CONTAGEM entrega. Nomear todas não ajuda a escolher nenhuma: por
 * construção, estas são exatamente as que NÃO casaram o assunto.
 *
 * Mesma grandeza da poda do índice de continuidade: teto em BYTES.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { init } from "../src/commands/init.js";
import { memory } from "../src/commands/memory.js";
import { publishContextDecision } from "../src/commands/decision.js";

/** Mesmo helper local dos outros testes de memory — não há um compartilhado. */
function captureStdout(): { text: () => string; restore: () => void } {
  let out = "";
  const stream = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
  });
  return { text: () => out, restore: () => { stream.mockRestore(); log.mockRestore(); } };
}

let ws: string;
beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-aviso-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

const silencioso = async (fn: () => Promise<unknown>): Promise<void> => {
  const cap = captureStdout();
  try {
    await fn();
  } finally {
    cap.restore();
  }
};

async function projetoCom(n: number): Promise<string> {
  const root = path.join(ws, "p");
  await fs.ensureDir(root);
  await silencioso(() => init({ cwd: root, registerGlobally: false }));
  for (let i = 0; i < n; i += 1) {
    await silencioso(() =>
      publishContextDecision({
        cwd: root,
        key: `continuidade-assunto-${String(i).padStart(2, "0")}`,
        set: `Regra operacional numero ${i} sobre continuidade para efeito de fixture.`,
        type: "constraint",
        source: "fixture://aviso",
        applicability: "fixture",
      })
    );
  }
  return root;
}

const buscar = async (root: string, assunto: string): Promise<string> => {
  const cap = captureStdout();
  try {
    await memory({ cwd: root, search: assunto });
    return cap.text();
  } finally {
    cap.restore();
  }
};

const linhaDoAviso = (t: string): string =>
  t.split("\n").find((l) => l.includes("não casaram com o assunto")) ?? "";

describe("aviso de continuidade conta, não inventaria", () => {
  it("com muitas decisões, o TOTAL continua declarado e a linha encolhe", async () => {
    const root = await projetoCom(40);
    const saida = await buscar(root, "termo-que-nao-existe-em-lugar-nenhum");
    const linha = linhaDoAviso(saida);

    /** ASSERÇÃO FORTE: o número exato precisa estar lá — some o total, some o aviso. */
    expect(linha).toMatch(/\b40 decisão\(ões\) de continuidade/);
    expect(linha, "quem não coube tem que ser contado, não omitido").toMatch(/e mais \d+/);
    expect(linha).toContain("nexos decision");

    /**
     * O teto é em bytes. 40 chaves inteiras passariam de 2000; o aviso tem
     * que caber numa ordem de grandeza de linha legível.
     */
    expect(Buffer.byteLength(linha, "utf8")).toBeLessThan(600);
  });

  it("com poucas, nomeia todas — o nome ainda informa e não há o que contar", async () => {
    const root = await projetoCom(2);
    const linha = linhaDoAviso(await buscar(root, "termo-que-nao-existe-em-lugar-nenhum"));
    expect(linha).toMatch(/\b2 decisão\(ões\)/);
    expect(linha).toContain("continuidade-assunto-00");
    expect(linha).toContain("continuidade-assunto-01");
    expect(linha, "sem corte não existe sufixo de contagem").not.toMatch(/e mais \d+/);
  });
});
