/**
 * Componente que sai de INSTALL_TARGETS leva junto a memória do que foi
 * instalado nele.
 *
 *   TIRAR DO ALVO APAGA A MEMÓRIA DO QUE FOI INSTALADO NELE
 *
 * MEDIDO: 0b96f2fb removeu `commands` de INSTALL_TARGETS. A partir dali
 * `coletarPackageOrphans` passou a pular o componente (resolve o diretório por
 * INSTALL_TARGETS[component] e dá `continue` no que não está lá) e o manifesto
 * futuro parou de registrar as chaves. Resultado medido no host em
 * 2026-09-18: 284 arquivos em ~/.claude/commands, incluindo 8 de spec-kit cujos
 * scripts obrigatórios não existem, sem uma linha de aviso em nenhum install.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { coletarRetiredResidue, aplicarLapides } from "../src/lib/installer.js";

const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await fs.remove(d);
  }
});

describe("coletarRetiredResidue", () => {
  it("conta arquivos recursivamente no diretório de um componente aposentado", async () => {
    const base = await makeTmpDir("nexos-retired-");
    const commands = path.join(base, "commands");
    await fs.outputFile(path.join(commands, "a.md"), "x");
    await fs.outputFile(path.join(commands, "spec-kit/plan.md"), "x");
    await fs.outputFile(path.join(commands, "spec-kit/nested/deep.md"), "x");

    const res = await coletarRetiredResidue({ commands });

    expect(res).toHaveLength(1);
    expect(res[0]?.component).toBe("commands");
    expect(res[0]?.dir).toBe(commands);
    expect(res[0]?.fileCount).toBe(3);
  });

  it("NEGATIVE CONTROL: diretório ausente não vira resíduo", async () => {
    const base = await makeTmpDir("nexos-retired-none-");
    const res = await coletarRetiredResidue({ commands: path.join(base, "nao-existe") });
    expect(res).toEqual([]);
  });

  it("NEGATIVE CONTROL: diretório vazio não vira resíduo — existir não é ter conteúdo", async () => {
    const base = await makeTmpDir("nexos-retired-empty-");
    const commands = path.join(base, "commands");
    await fs.ensureDir(commands);
    const res = await coletarRetiredResidue({ commands });
    expect(res).toEqual([]);
  });
});

/**
 * O detector de órfãos tinha janela de UM install.
 *
 *   MANIFEST KNOWS AUTHORSHIP — MAS SÓ ENQUANTO LEMBRA
 *
 * `futureManifest` é montado só do que o pacote envia hoje. Sem lápide:
 * install N+1 reporta o órfão e regrava o manifesto sem ele; install N+2 já
 * não tem `previousManifest[key]` e o arquivo fica invisível para sempre.
 * Medido no host: `nexos-host-memory-check.sh` é um caso de janela perdida.
 */
describe("aplicarLapides", () => {
  it("preserva a entrada do órfão com o hash ORIGINAL — a única prova de autoria", () => {
    const previous = { "hooks/x.sh": "hash-nosso", "skills/a/SKILL.md": "h2" };
    const future: Record<string, string> = { "skills/a/SKILL.md": "h2" };

    aplicarLapides(future, previous, [{ component: "hooks", path: "x.sh", status: "untouched" }]);

    expect(future["hooks/x.sh"]).toBe("hash-nosso");
    expect(Object.keys(future).sort()).toEqual(["hooks/x.sh", "skills/a/SKILL.md"]);
  });

  it("órfão 'modified' também recebe lápide — editado no host não deixa de ser nosso", () => {
    const previous = { "rules/r.md": "hash-nosso" };
    const future: Record<string, string> = {};
    aplicarLapides(future, previous, [{ component: "rules", path: "r.md", status: "modified" }]);
    expect(future["rules/r.md"]).toBe("hash-nosso");
  });

  it("NEGATIVE CONTROL: sem entrada anterior não inventa autoria", () => {
    const future: Record<string, string> = {};
    aplicarLapides(future, {}, [{ component: "hooks", path: "desconhecido.sh", status: "untouched" }]);
    expect(future).toEqual({});
  });

  it("NEGATIVE CONTROL: a lápide se auto-limpa — arquivo removido do host sai da lista de órfãos e some do manifesto", () => {
    const previous = { "hooks/x.sh": "hash-nosso" };
    const future: Record<string, string> = {};
    // coletarPackageOrphans não lista o que não está mais no disco, então a
    // lista chega vazia — e é ISSO que limpa a lápide, sem código de expurgo.
    aplicarLapides(future, previous, []);
    expect(future["hooks/x.sh"]).toBeUndefined();
  });
});
