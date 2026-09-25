/**
 * O diagnóstico dizia "Global root: íntegro" contando só os RECORDS e ignorando
 * o registro de projetos ao lado.
 *
 *     GLOBAL ROOT ÍNTEGRO != CAMADA GLOBAL SAUDÁVEL
 *
 * MEDIDO em 2026-09-19 na máquina do dono: `~/.nexos/records` tinha 1 record
 * (PASS, "íntegro") e `~/.nexos/projects` tinha 2477 entradas de authority, das
 * quais 2403 (97%) apontavam para diretórios temporários de teste já apagados.
 * O índice de projetos — a única coisa que a camada global tem de índice — era
 * 74 reais anunciados como 2477, e nenhum instrumento dizia isso.
 *
 * O vazamento que gerou o lixo já estava fechado (`tests/isolate-nexos-home.ts`,
 * zero entradas mortas nos últimos 7 dias). O que faltava era ENXERGAR:
 *
 *     DEFEITO FECHADO != LIXO REMOVIDO
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

import { medirRegistroDeProjetos } from "../src/lib/doctor/checks.js";

let ws: string;
let nexosHome: string;

/** Escreve uma entrada de authority apontando para `raiz`. */
async function registrar(id: string, raiz: string): Promise<void> {
  const dir = path.join(nexosHome, "projects", id);
  await fs.ensureDir(dir);
  await fs.writeFile(
    path.join(dir, "authority.yaml"),
    `active_root: ${raiz}\nclaimed_at: 2026-09-19T00:00:00.000Z\nproject_id: ${id}\n`,
    "utf-8"
  );
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "nexos-registro-"));
  nexosHome = path.join(ws, ".nexos");
});

afterEach(async () => {
  await fs.remove(ws);
});

describe("medirRegistroDeProjetos", () => {
  it("separa entrada viva de entrada cujo diretório sumiu", async () => {
    const vivo = path.join(ws, "projeto-vivo");
    await fs.ensureDir(vivo);
    await registrar("prj_01VIVO", vivo);
    await registrar("prj_01MORTO1", path.join(ws, "sumiu-1"));
    await registrar("prj_01MORTO2", path.join(ws, "sumiu-2"));
    await registrar("prj_01MORTO3", path.join(ws, "sumiu-3"));

    const r = await medirRegistroDeProjetos(nexosHome);
    expect(r.total).toBe(4);
    expect(r.vivos).toBe(1);
    expect(r.orfaos).toBe(3);
    /** O número que o dono precisa ler: quantos projetos o índice REALMENTE tem. */
    expect(r.detalhe).toContain("75%");
    expect(r.detalhe).toContain("1 real");
  });

  /**
   * CONTROLE NEGATIVO — sem ele, uma implementação que marcasse tudo como órfão
   * passaria no teste acima e transformaria o check num WARN permanente que
   * ninguém consegue zerar. Registro são NÃO pode acusar.
   */
  it("registro inteiramente vivo não acusa nada", async () => {
    for (const nome of ["a", "b", "c"]) {
      const raiz = path.join(ws, nome);
      await fs.ensureDir(raiz);
      await registrar(`prj_01${nome.toUpperCase()}`, raiz);
    }
    const r = await medirRegistroDeProjetos(nexosHome);
    expect(r.total).toBe(3);
    expect(r.orfaos).toBe(0);
    expect(r.detalhe).toContain("todas apontam para diretório existente");
  });

  it("registro ausente é condição válida, não falha", async () => {
    const r = await medirRegistroDeProjetos(nexosHome);
    expect(r).toMatchObject({ total: 0, vivos: 0, orfaos: 0 });
    expect(r.detalhe).toContain("ausente");
  });

  /** Entrada ilegível não derruba o diagnóstico nem vira órfão fantasma. */
  it("diretório sem authority.yaml é ignorado, não contado", async () => {
    const vivo = path.join(ws, "vivo");
    await fs.ensureDir(vivo);
    await registrar("prj_01OK", vivo);
    await fs.ensureDir(path.join(nexosHome, "projects", "prj_01SEMARQUIVO"));

    const r = await medirRegistroDeProjetos(nexosHome);
    expect(r.total).toBe(1);
    expect(r.orfaos).toBe(0);
  });

  /** `active_root` ausente no arquivo conta como entrada que não resolve. */
  it("authority sem active_root conta como órfão, nunca como vivo", async () => {
    const dir = path.join(nexosHome, "projects", "prj_01TRUNCADO");
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, "authority.yaml"), "project_id: prj_01TRUNCADO\n", "utf-8");

    const r = await medirRegistroDeProjetos(nexosHome);
    expect(r.total).toBe(1);
    expect(r.vivos).toBe(0);
    expect(r.orfaos).toBe(1);
  });
});
