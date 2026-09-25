/**
 * O aviso de asset drift chega ao TEXTO que a sessão lê?
 *
 *   DETECTOR PROVADO != CONSUMER PROVADO
 *
 * MEDIDO em 2026-09-19 (verificação independente): removendo `assetDriftLine`
 * do array que monta o `additionalContext` (`src/host/claude/session-start.ts`)
 * — o aviso some do brief, ninguém mais fica sabendo que agents/skills/rules
 * são de outra versão — `npx vitest run tests/claude-session-start.test.ts
 * tests/asset-drift.test.ts` seguiu com 87 testes verdes.
 *
 * `detectAssetDrift`/`formatAssetDriftWarning` já têm controle negativo real
 * em `tests/asset-drift.test.ts`; o CONSUMIDOR não tinha nenhum, e a única
 * rede restante era um warning de `no-unused-vars` — que desaparece no dia em
 * que alguém referenciar a variável em qualquer outro ponto do arquivo.
 *
 * O detector é trocado por teste porque o real lê `~/.claude/.nexos-version`
 * do HOST: `NEXOS_MARKER` deriva de `CLAUDE_DIR`, que `tests/isolate-nexos-home.ts`
 * deliberadamente NÃO isola. `formatAssetDriftWarning` fica REAL — o teste
 * afirma o texto que a sessão lê, não um texto inventado aqui.
 */
import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { NEXOS_MARKER } from "../src/lib/constants.js";
import type { AssetDrift } from "../src/lib/host/asset-drift.js";

let driftAtual: AssetDrift | null = null;
/**
 * Os argumentos de CADA chamada ao detector. Com ele mockado, "o brief mostra
 * o aviso" não diz NADA sobre o detector ter olhado o arquivo certo — a
 * verificação independente provou: trocar `NEXOS_MARKER` por um caminho
 * inventado deixa 89 testes verdes aqui e 27 em `doctor-project`, porque
 * nenhum teste da suíte fixa o literal e todos leem a mesma constante que
 * escrevem.
 *
 *     CONSUMIDOR PROVADO != CONSUMIDOR OLHANDO A FONTE CERTA
 */
const chamadasDoDetector: unknown[][] = [];

vi.mock("../src/lib/host/asset-drift.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/host/asset-drift.js")>();
  return {
    ...actual,
    detectAssetDrift: async (...args: unknown[]) => {
      chamadasDoDetector.push(args);
      return driftAtual;
    },
  };
});

const { runSessionStartAdapter } = await import("../src/host/claude/session-start.js");
const { formatAssetDriftWarning } = await import("../src/lib/host/asset-drift.js");

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;

beforeEach(async () => {
  driftAtual = null;
  ws = await fs.mkdtemp(path.join(TMP_BASE, "asset-drift-brief-"));
  root = path.join(ws, "project");
  await fs.ensureDir(root);
  await fs.writeJson(path.join(root, "package.json"), { name: "asset-drift-brief" });
});
afterEach(async () => {
  await fs.remove(ws);
});

async function additionalContextDaSessao(sessionId: string): Promise<string> {
  const r = await runSessionStartAdapter(
    { hook_event_name: "SessionStart", source: "startup", cwd: root, session_id: sessionId },
    { CLAUDE_PROJECT_DIR: root }
  );
  return r.additionalContext;
}

describe("SessionStart · o aviso de asset drift entra no brief", () => {
  it("drift detectado -> o AVISO inteiro está no additionalContext, byte a byte como `formatAssetDriftWarning` produz", async () => {
    driftAtual = { installed: "6.5.1", packaged: "6.5.2" };
    const esperado = formatAssetDriftWarning(driftAtual);
    expect(esperado).toBeDefined();

    const additionalContext = await additionalContextDaSessao("drift-1");

    expect(additionalContext).toContain(esperado ?? "\0");
    // As duas versões e o comando: o aviso serve para agir, não só para constar.
    expect(additionalContext).toContain("6.5.1");
    expect(additionalContext).toContain("6.5.2");
    expect(additionalContext).toContain("nexos install");
  });

  it("NEGATIVE CONTROL: sem drift, nada sobre versão de assets entra no brief — silêncio é o veredito correto", async () => {
    driftAtual = null;

    const additionalContext = await additionalContextDaSessao("drift-2");

    expect(additionalContext).not.toContain("os assets do NexOS");
  });

  /**
   * Guarda barata para a lacuna residual acima. Não prova qual caminho o
   * detector lê — isso exigiria seam em produção — mas prova que o brief NÃO
   * escolhe o caminho por conta própria: chama sem argumento e herda o default
   * (`NEXOS_MARKER`). Um chamador que passasse um caminho seu apareceria aqui
   * imediatamente, e é esse o desvio que a suíte inteira não enxergava.
   */
  it("o brief chama o detector sem argumento — quem escolhe o marcador é o default, não o consumidor", async () => {
    chamadasDoDetector.length = 0;
    driftAtual = null;
    await additionalContextDaSessao("marcador-default");

    expect(chamadasDoDetector.length).toBeGreaterThan(0);
    for (const args of chamadasDoDetector) expect(args).toEqual([]);
  });

  /**
   * O furo que a guarda acima NÃO fecha, medido pela verificação independente:
   * trocar `NEXOS_MARKER` por um caminho inventado deixa os outros testes
   * VERDES — aqui e em `doctor-project` — porque nenhum teste da suíte fixa o
   * literal e todos leem a mesma constante que escrevem.
   *
   *     CONSTANTE LIDA E ESCRITA PELO MESMO TESTE NÃO É CONSTANTE VERIFICADA
   *
   * "Não dá para provar qual caminho o detector lê sem seam em produção" é
   * verdade para LER. Fixar o literal não precisa de seam nenhum, e é uma
   * linha — foi a economia que ficou na mesa na primeira versão.
   */
  it("NEXOS_MARKER aponta para o arquivo que o installer escreve, e o literal está fixado aqui", () => {
    expect(NEXOS_MARKER).toBe(path.join(os.homedir(), ".claude", ".nexos-version"));
  });

});
