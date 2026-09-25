/**
 * Pré-condição de MCP observada SEM EXECUTAR o servidor.
 *
 *   BINÁRIO PRESENTE != SERVIDOR RESPONDE
 *
 * Antes desta mudança todo item `mcp` saía com `enabled: true` e `health`
 * ausente — o catálogo afirmava que o servidor estava disponível sem ter
 * observado nada a respeito.
 *
 * MEDIDO em 2026-09-19 na máquina do dono: `notebooklm` é `stdio` com
 * `command: "uvx"`, `uvx` está em `/Users/dono/.local/bin/uvx`, e o
 * servidor falhou com `CONNECTION_CLOSED` na mesma sessão que mediu isso.
 * É por esse caso que binário no `$PATH` vira `unknown` e NUNCA `connected`:
 * o filesystem decide o negativo (binário que não existe não sobe), nunca o
 * positivo.
 *
 * Executar para descobrir seria o NexOS invocando capability do host —
 * `CLAUDE EXECUTES, NEXOS UNDERSTANDS`
 * (nexos://decision/p1-0-remover-authorization-layer).
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { readUserMcpServers } from "../src/lib/capabilities/scan.js";

let home: string;
let binDir: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-mcp-health-"));
  binDir = path.join(home, "bin");
  await fs.ensureDir(binDir);
  await fs.writeFile(path.join(binDir, "existe"), "#!/bin/sh\n", { mode: 0o755 });
  await fs.writeJson(path.join(home, ".claude.json"), {
    mcpServers: {
      "stdio-com-binario": { type: "stdio", command: "existe" },
      "stdio-sem-binario": { type: "stdio", command: "nao-existe-em-lugar-nenhum" },
      "http-remoto": { type: "http", url: "https://exemplo.invalido/mcp" },
    },
  });
});

afterAll(async () => {
  await fs.remove(home);
});

const ler = () => readUserMcpServers(home, { pathEnv: binDir, pathSep: path.delimiter });
const acharHealth = (itens: readonly { name: string; health?: string }[], nome: string) =>
  itens.find((i) => i.name === nome)?.health;

describe("health de MCP é observado sem executar o servidor", () => {
  it("stdio cujo binário não está no PATH não pode subir — missing-binary", async () => {
    expect(acharHealth(await ler(), "stdio-sem-binario")).toBe("missing-binary");
  });

  /**
   * CONTROLE NEGATIVO do chute otimista. Se alguém trocar `unknown` por
   * `connected` aqui "porque o binário existe", este teste reprova — e é
   * exatamente o caso `notebooklm`/`uvx` que motivou a regra.
   */
  it("stdio com o binário no PATH é unknown, NUNCA connected", async () => {
    const h = acharHealth(await ler(), "stdio-com-binario");
    expect(h).toBe("unknown");
    expect(h).not.toBe("connected");
  });

  it("transporte http não é observável pelo filesystem — unknown", async () => {
    expect(acharHealth(await ler(), "http-remoto")).toBe("unknown");
  });

  /**
   * REGRESSÃO do falso positivo achado ao rodar isto contra a máquina real:
   * `pencil` e `browser-use` declaram o binário por caminho absoluto, e o
   * lookup de `$PATH` os reportava `missing-binary` com o arquivo no disco.
   * Alarme falso manda procurar defeito onde não há.
   */
  it("comando por caminho absoluto é resolvido direto, não contra o $PATH", async () => {
    const absoluto = path.join(binDir, "existe");
    await fs.writeJson(path.join(home, ".claude.json"), {
      mcpServers: {
        "abs-existe": { type: "stdio", command: absoluto },
        "abs-nao-existe": { type: "stdio", command: path.join(binDir, "fantasma") },
      },
    });
    // $PATH VAZIO de propósito: se o caminho absoluto dependesse do $PATH,
    // "abs-existe" viraria missing-binary aqui.
    const itens = await readUserMcpServers(home, { pathEnv: "", pathSep: path.delimiter });
    expect(acharHealth(itens, "abs-existe")).toBe("unknown");
    expect(acharHealth(itens, "abs-nao-existe")).toBe("missing-binary");
  });

  it("todo item mcp passa a declarar health", async () => {
    const itens = await readUserMcpServers(home, { pathEnv: binDir, pathSep: path.delimiter });
    expect(itens.length).toBeGreaterThan(0);
    expect(itens.every((i) => typeof i.health === "string")).toBe(true);
  });
});
