/**
 * Pacote e assets são duas instalações independentes.
 *
 *   INSTALLED CODE != INSTALLED ASSETS
 *
 * `npm i -g` traz o CÓDIGO; `nexos install` projeta os ASSETS (agents, skills,
 * rules, hooks). Nada sincroniza os dois — quem atualiza o pacote e não roda
 * `install` trabalha com agente e skill de uma versão antiga enquanto o CLI é
 * novo. MEDIDO em 2026-09-18: `.nexos-version` dizia 6.5.1 com o pacote em
 * 6.5.2, e o único jeito de saber era digitar `nexos doctor --project`.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { detectAssetDrift, formatAssetDriftWarning } from "../src/lib/host/asset-drift.js";
import { getVersion } from "../src/lib/constants.js";

const tmpDirs: string[] = [];
async function marker(conteudo: unknown): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-drift-"));
  tmpDirs.push(dir);
  const p = path.join(dir, ".nexos-version");
  if (typeof conteudo === "string") await fs.writeFile(p, conteudo, "utf-8");
  else await fs.writeJson(p, conteudo);
  return p;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await fs.remove(d);
  }
});

describe("detectAssetDrift", () => {
  it("acusa quando os assets instalados são de outra versão", async () => {
    const drift = await detectAssetDrift(await marker({ version: "0.0.1" }));
    expect(drift).not.toBeNull();
    expect(drift?.installed).toBe("0.0.1");
    expect(drift?.packaged).toBe(getVersion());
  });

  it("NEGATIVE CONTROL: mesma versão não acusa — silêncio é o veredito correto", async () => {
    expect(await detectAssetDrift(await marker({ version: getVersion() }))).toBeNull();
  });

  it("NEGATIVE CONTROL: marcador ausente não acusa — nunca instalado é assunto de `install`, não deste aviso", async () => {
    expect(await detectAssetDrift(path.join(os.tmpdir(), "nexos-nao-existe-", "x.json"))).toBeNull();
  });

  it("NEGATIVE CONTROL: marcador ilegível ou sem version não vira acusação", async () => {
    expect(await detectAssetDrift(await marker("{ isto nao e json"))).toBeNull();
    expect(await detectAssetDrift(await marker({ semVersion: true }))).toBeNull();
    expect(await detectAssetDrift(await marker({ version: "" }))).toBeNull();
  });

  it("o aviso diz o comando — aviso que não diz o que fazer obriga quem lê a descobrir", () => {
    const linha = formatAssetDriftWarning({ installed: "6.5.1", packaged: "6.5.2" });
    expect(linha).toContain("6.5.1");
    expect(linha).toContain("6.5.2");
    expect(linha).toContain("nexos install");
    expect(formatAssetDriftWarning(null)).toBeUndefined();
  });
});
