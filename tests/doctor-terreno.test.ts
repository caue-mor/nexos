/**
 * E6 — `doctor --project` distingue greenfield de brownfield ANTES de adotar.
 *
 *   NOT_ADOPTED != PASTA VAZIA
 *
 * MEDIDO em `docs/E2-nexos-x-aiox-2026-09-22.md`, com as duas fixtures do
 * experimento: o diagnóstico era IDÊNTICO (`NOT_ADOPTED`, `.nexos ausente`)
 * para um diretório vazio e para um app Next + Supabase + Tailwind completo. A
 * skill `/nexos` ramifica em Caso A (do zero) e Caso B (app existente) e tinha
 * que descobrir o terreno sozinha, fora do diagnóstico que existe para isso.
 *
 * Os três casos que importam estão aqui: manifest presente (sinal forte),
 * conteúdo sem manifest (sinal fraco, e a frase precisa DIZER que é fraco), e
 * vazio de verdade — com `.git` presente, que é o estado real de um `git init`
 * e não pode contar como conteúdo.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { buildProjectDoctorReport } from "../src/lib/doctor/project-doctor.js";

let raiz: string;

beforeEach(async () => {
  raiz = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-terreno-"));
  /**
   * `.git` em TODOS os casos, de propósito. Sem fronteira de projeto (git ou
   * marker de stack) o doctor devolve `UNSUPPORTED` e nem chega no terreno —
   * comportamento correto do produto, e foi a primeira versão deste teste que
   * estava errada, não ele. Um diretório onde alguém rodaria `/nexos` tem git.
   */
  await fs.ensureDir(path.join(raiz, ".git"));
});
afterEach(async () => {
  await fs.remove(raiz);
});

/** O terreno vive em `evidence` (para quem lê) e no `detail` do plano (para quem decide). */
async function terrenoDe(dir: string): Promise<{ evidencia: string | undefined; plano: string | undefined }> {
  const r = await buildProjectDoctorReport({ cwd: dir });
  return {
    evidencia: r.evidence.find((e) => e.area === "terreno")?.detail,
    plano: r.plan.find((p) => p.area === "capsule")?.detail,
  };
}

describe("E6 · terreno no doctor --project", () => {
  it("diretório recém-criado com .git é GREENFIELD — dotfile não é código do app", async () => {
    const { evidencia, plano } = await terrenoDe(raiz);
    expect(evidencia).toContain("GREENFIELD");
    expect(plano).toContain("GREENFIELD");
  });

  it("package.json presente é BROWNFIELD e CITA o manifest que provou", async () => {
    await fs.writeJson(path.join(raiz, "package.json"), { name: "app" });
    const { evidencia, plano } = await terrenoDe(raiz);
    expect(evidencia).toContain("BROWNFIELD");
    expect(evidencia).toContain("package.json");
    expect(plano).toContain("BROWNFIELD");
  });

  it.each(["pyproject.toml", "go.mod", "Cargo.toml", "requirements.txt"])(
    "%s também é sinal forte — a lista é a mesma do detector do mapa",
    async (manifest) => {
      await fs.writeFile(path.join(raiz, manifest), "");
      const { evidencia } = await terrenoDe(raiz);
      expect(evidencia).toContain("BROWNFIELD");
      expect(evidencia).toContain(manifest);
    }
  );

  it("conteúdo SEM manifest é BROWNFIELD, e a frase declara que o sinal é fraco", async () => {
    await fs.ensureDir(path.join(raiz, "docs"));
    await fs.writeFile(path.join(raiz, "notas.md"), "oi");
    const { evidencia } = await terrenoDe(raiz);
    expect(evidencia).toContain("BROWNFIELD");
    // Sem isto o diagnóstico afirmaria com a mesma força de um manifest.
    expect(evidencia).toContain("sinal fraco");
  });

  it("sem fronteira de projeto NÃO inventa terreno — UNSUPPORTED continua sendo a resposta", async () => {
    const solto = await fs.mkdtemp(path.join(os.tmpdir(), "nexos-sem-git-"));
    await fs.writeFile(path.join(solto, "notas.md"), "oi");
    try {
      const r = await buildProjectDoctorReport({ cwd: solto });
      expect(r.state).toBe("UNSUPPORTED");
      expect(r.evidence.some((e) => e.area === "terreno")).toBe(false);
    } finally {
      await fs.remove(solto);
    }
  });
});
