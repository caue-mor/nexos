/**
 * MEM-SEM-STORE — pasta sem Store não é Store vazio.
 *
 *   CANNOT OBSERVE != DOES NOT EXIST
 *
 * MEDIDO em 2026-09-25: fora de projeto, `nexos memory --review` imprimia
 * "Nenhum candidato esperando decisão." com exit 0 — afirmava ausência onde
 * não havia Store para olhar (no projeto havia 193). `resolveCommandRoot`
 * devolve o cwd quando não acha manifest e `lerRecords` lê isso como zero
 * records; o mesmo valia para a listagem, `--retrieval` e `--promote`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { init } from "../src/commands/init.js";
import { memory, type MemoryOptions } from "../src/commands/memory.js";

/** O caso `--promote` nunca pode chegar ao /dev/tty real — nega, se o gate regredir. */
vi.mock("../src/lib/host/human-presence.js", () => ({
  requestHumanApproval: () => ({ approved: false, why: "negado (mock de teste)" }),
}));

const TMP = fs.realpathSync(os.tmpdir());

let root: string;
let saida: string[];

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "mem-sem-store-"));
  saida = [];
  process.exitCode = undefined;
  const grava = (...a: unknown[]): void => {
    saida.push(a.map(String).join(" "));
  };
  vi.spyOn(console, "log").mockImplementation(grava);
  vi.spyOn(console, "error").mockImplementation(grava);
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    saida.push(String(chunk));
    return true;
  });
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(root);
  process.exitCode = undefined;
});

describe("nexos memory fora de projeto", () => {
  it.each<[string, Omit<MemoryOptions, "cwd">]>([
    ["--review", { review: true }],
    ["listagem", {}],
    ["--retrieval", { retrieval: true }],
    ["--promote", { promote: "knw_inexistente" }],
    ["--search", { search: "qualquer coisa" }],
  ])("%s diz que a pasta não tem Store e sai com erro", async (_nome, opts) => {
    await memory({ cwd: root, ...opts });

    const texto = saida.join("\n");
    expect(process.exitCode).toBe(1);
    expect(texto).toContain("não tem Store");
    expect(texto).not.toMatch(/nenhum candidato|nenhuma injec|não encontrado no Store/i);
  });

  it("--review --json devolve o mesmo erro de máquina de state/gotcha --json", async () => {
    await memory({ cwd: root, review: true, json: true });

    expect(process.exitCode).toBe(1);
    expect(JSON.parse(saida.join(""))).toEqual({ error: "STORE_ILEGIVEL", detail: ["MANIFEST_UNREADABLE"] });
  });

  it("CONTRAFACTUAL: projeto adotado com fila vazia continua dizendo que não há candidato", async () => {
    await init({ cwd: root, registerGlobally: false });
    saida = [];
    process.exitCode = undefined;

    await memory({ cwd: root, review: true });

    expect(process.exitCode).not.toBe(1);
    expect(saida.join("\n")).toContain("Nenhum candidato esperando decisão.");
  });
});
