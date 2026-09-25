/**
 * Trava de publicação (nexos://decision/memoria-nunca-sai-da-maquina): o script
 * reprova o pacote que leva termo privado e nunca repete o termo na saída.
 */
import { describe, it, expect, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const ROOT = path.resolve(__dirname, "..");
const listas: string[] = [];

function rodar(termos: string[]): { status: number | null; saida: string } {
  const lista = path.join(fs.mkdtempSync(path.join(os.tmpdir(), "termos-")), "lista.txt");
  listas.push(path.dirname(lista));
  fs.writeFileSync(lista, `# comentario nao conta\n${termos.join("\n")}\n`);
  const r = spawnSync("node", ["scripts/scan-termos-privados.mjs"], {
    cwd: ROOT,
    encoding: "utf8",
    env: { ...process.env, NEXOS_TERMOS_PRIVADOS: lista },
  });
  return { status: r.status, saida: `${r.stdout}${r.stderr}` };
}

afterEach(() => {
  for (const d of listas.splice(0)) fs.removeSync(d);
});

describe("scan de termos privados no pacote", () => {
  it("termo presente no pacote reprova, e a saída cita o número, nunca o termo", () => {
    // `dirSeguro` existe no conteúdo dos hooks empacotados, não em nome de arquivo.
    const r = rodar(["dirSeguro"]);
    expect(r.status).toBe(1);
    expect(r.saida).toContain("termo #1");
    expect(r.saida).not.toContain("dirSeguro");
  });

  it("termo ausente do pacote passa", () => {
    const r = rodar(["termo-que-nao-existe-em-lugar-nenhum-9f3a"]);
    expect(r.status).toBe(0);
    expect(r.saida).toContain("termos privados: 0");
  });
}, 120_000);
