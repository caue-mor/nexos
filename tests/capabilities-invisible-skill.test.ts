/**
 * Skill que existe no disco e ninguém carrega, por CASE do nome do arquivo.
 *
 *   NÃO DESCOBERTA != INEXISTENTE
 *
 * MEDIDO em 2026-09-19 na máquina do dono: 244 diretórios em
 * `~/.claude/skills`, 236 descobertos pelo catálogo. Seis da diferença são
 * pastas de apoio sem `SKILL.md` — corretas em não aparecer. As outras duas
 * eram skills íntegras:
 *
 *     database--postgres-schema-design   SKILL.MD   16 KB
 *     design-principles                  skill.md   11 KB
 *
 * Nenhuma aparece na listagem do host, e nenhuma aparecia no audit. O scan
 * está CERTO em não carregá-las (compara a string do `readdir` byte a byte,
 * reproduzindo o que um host case-sensitive faz); o defeito era o silêncio.
 * Uma peça invisível nunca entra em `items`, então nenhum laço sobre o
 * catálogo poderia alcançá-la — por isso o achado entra por um canal próprio.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { listSkillDirsComCaseErrado } from "../src/lib/capabilities/scan.js";
import { auditarCapabilities } from "../src/lib/capabilities/audit.js";

const TMP = fs.realpathSync(os.tmpdir());
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.remove(d);
});

async function skillsDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(TMP, "skills-case-"));
  dirs.push(d);
  return d;
}

const FM = "---\nname: x\ndescription: y\n---\n\ncorpo\n";

describe("listSkillDirsComCaseErrado", () => {
  it("acha SKILL.MD e skill.md, e ignora quem está correto", async () => {
    const dir = await skillsDir();
    await fs.outputFile(path.join(dir, "maiuscula/SKILL.MD"), FM);
    await fs.outputFile(path.join(dir, "minuscula/skill.md"), FM);
    await fs.outputFile(path.join(dir, "certa/SKILL.md"), FM);

    const r = await listSkillDirsComCaseErrado(dir);
    expect(r.map((x) => x.dirName).sort()).toEqual(["maiuscula", "minuscula"]);
    expect(r.find((x) => x.dirName === "maiuscula")?.encontrado).toBe("SKILL.MD");
  });

  /**
   * CONTROLE NEGATIVO — sem ele, um detector que acusasse todo diretório sem
   * `SKILL.md` exato passaria no teste acima e encheria o audit de achados
   * sobre pastas de apoio, que foram 6 das 8 na medição real.
   */
  it("diretório SEM nenhum skill.md não é achado — é pasta de apoio", async () => {
    const dir = await skillsDir();
    await fs.outputFile(path.join(dir, "apoio/README.md"), "# nada");
    await fs.outputFile(path.join(dir, "scripts/run.mjs"), "// nada");

    expect(await listSkillDirsComCaseErrado(dir)).toHaveLength(0);
  });

  /** `synced` é nome reservado do host e tem varredura própria. */
  it("synced é pulado, mesmo com arquivo em case errado", async () => {
    const dir = await skillsDir();
    await fs.outputFile(path.join(dir, "synced/SKILL.MD"), FM);
    expect(await listSkillDirsComCaseErrado(dir)).toHaveLength(0);
  });
});

describe("o audit reporta a peça invisível", () => {
  it("vira finding `invisible` com ação REPAIR, mesmo sem estar em items", () => {
    const report = auditarCapabilities(
      {
        items: [],
        duplicates: [],
        variants: [],
        invisibleSkills: [{ dirName: "design-principles", encontrado: "skill.md", file: "/x/skill.md" }],
      },
      () => true
    );
    const f = report.findings.filter((x) => x.kind === "invisible");
    expect(f).toHaveLength(1);
    expect(f[0]?.action).toBe("REPAIR");
    expect(f[0]?.name).toBe("design-principles");
    expect(f[0]?.detail).toContain("SKILL.md");
    expect(report.totals.porTipo.invisible).toBe(1);
  });

  /** CONTROLE: sem invisíveis, o contador não inventa achado. */
  it("sem invisibleSkills, zero findings desse tipo", () => {
    const report = auditarCapabilities({ items: [], duplicates: [], variants: [] }, () => true);
    expect(report.totals.porTipo.invisible).toBe(0);
  });
});
