/**
 * O inventário de MCP via UM arquivo de config não é o inventário da SESSÃO.
 *
 *     AVAILABLE != CONSUMED · OBSERVED SURFACE != CAPABILITY REGISTRY
 *
 * MEDIDO em 2026-09-20 nesta máquina: `nexos capabilities --kind mcp` enxergava
 * 9 servidores e 90 caracteres, enquanto a sessão real carregava 472
 * ferramentas em 49 servidores. Os que faltavam nunca estiveram em
 * `mcpServers` — moram em outras duas chaves do MESMO `~/.claude.json`, e por
 * isso a cegueira durou: o arquivo estava certo, a chave é que era uma só.
 *
 * O efeito não era cosmético: todo cálculo de custo de superfície do NexOS
 * media o catálogo de skills (144.055 chars, fonte exata) e ignorava MCP.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { readHostKnownMcpServers, readUserMcpServers } from "../src/lib/capabilities/scan.js";

let home: string;

beforeAll(async () => {
  home = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-mcp-superficie-"));
  await fs.writeJson(path.join(home, ".claude.json"), {
    mcpServers: { "declarado-local": { type: "stdio", command: "qualquer" } },
    /** Conectores da conta — o host os conhece, o `mcpServers` nunca os viu. */
    claudeAiMcpEverConnected: ["claude.ai Canva", "claude.ai Meta Ads", "declarado-local"],
    /** Servidores de plugin, na forma `plugin:categoria:nome`. */
    mcpNeedsAuthNoticed: { "plugin:marketing:ahrefs": 1, "plugin:productivity:slack": 1 },
  });
});

afterAll(async () => {
  await fs.remove(home);
});

describe("MCP: o inventário enxerga a superfície do host, não só o mcpServers", () => {
  it("lê conector de conta e servidor de plugin, que `mcpServers` não declara", async () => {
    const nomes = (await readHostKnownMcpServers(home)).map((i) => i.name).sort();
    expect(nomes).toEqual(["claude.ai Canva", "claude.ai Meta Ads", "plugin:marketing:ahrefs", "plugin:productivity:slack"]);
  });

  it("não duplica o que `readUserMcpServers` já devolve", async () => {
    /**
     * `declarado-local` aparece em `mcpServers` E em `claudeAiMcpEverConnected`.
     * Contá-lo duas vezes inflaria o inventário exatamente no número que este
     * trabalho existe para tornar confiável.
     */
    const doUser = await readUserMcpServers(home, { pathEnv: "", pathSep: path.delimiter });
    const doHost = await readHostKnownMcpServers(home);
    expect(doUser.map((i) => i.name)).toContain("declarado-local");
    expect(doHost.map((i) => i.name)).not.toContain("declarado-local");

    const ids = [...doUser, ...doHost].map((i) => i.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  it("a origem separa conector de conta (personal) de plugin", async () => {
    const itens = await readHostKnownMcpServers(home);
    const porNome = new Map(itens.map((i) => [i.name, i.source]));
    expect(porNome.get("claude.ai Canva")).toBe("personal");
    expect(porNome.get("plugin:marketing:ahrefs")).toBe("plugin");
  });

  it("health é sempre `unknown` — a chave prova conhecimento, nunca conexão", async () => {
    /**
     * Estas duas chaves registram que o host JÁ VIU o servidor. Declarar
     * `connected` a partir disso seria o chute otimista que `mcpItemFromEntry`
     * também recusa: um nome em lista não é um servidor no ar.
     */
    const itens = await readHostKnownMcpServers(home);
    expect(itens.every((i) => i.health === "unknown")).toBe(true);
  });

  it("não promete o que o disco não sabe: contagem de ferramentas e schema", async () => {
    /**
     * `AVAILABLE != CONSUMED`. O disco dá o NOME do servidor; quantas
     * ferramentas ele expõe e o tamanho do schema só aparecem no manifesto da
     * sessão, que é fonte do host. `listing_chars` reflete o que foi medido
     * (o nome), nunca uma estimativa de schema apresentada como fato.
     */
    const itens = await readHostKnownMcpServers(home);
    for (const i of itens) {
      expect(i.listing_chars).toBe(i.name.length);
      expect(i.description).toContain("não observáveis pelo disco");
    }
  });

  it("arquivo sem as chaves novas devolve vazio, e não erro", async () => {
    const vazio = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-mcp-vazio-"));
    await fs.writeJson(path.join(vazio, ".claude.json"), { mcpServers: {} });
    expect(await readHostKnownMcpServers(vazio)).toEqual([]);
    await fs.remove(vazio);
  });
});
