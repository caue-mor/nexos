/**
 * As SEIS coisas que um caminho citado pode ser, e que o detector confundia:
 *
 *   BROKEN CAPABILITY != GENERATED ARTIFACT != PROJECT-LOCAL FILE
 *                     != DOCUMENTATION REFERENCE != UPSTREAM REFERENCE
 *
 * MEDIDO em 2026-09-21 contra o detector real: 3 das 7 classes viravam
 * `broken-reference` indevidamente. O teste mede pelo CONSUMIDOR
 * (`auditarCapabilities`), não por `referenciasCitadas`: a regra de citação
 * vive no consumidor, e uma fixture na camada de baixo passou verde com a
 * correção desligada — DETECTOR PROVADO != CONSUMER PROVADO.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import fs from "fs-extra";
import os from "node:os";
import { auditarCapabilities, type AuditItem } from "../src/lib/capabilities/audit.js";
import type { VariantGroup } from "../src/lib/capabilities/types.js";
import { recorteParaAudit } from "../src/lib/capabilities/analyze.js";

async function comSkillDeMentira<T>(fn: (skillMd: string) => Promise<T> | T): Promise<T> {
  const raiz = await fs.mkdtemp(path.join(os.tmpdir(), "audit-classes-"));
  try {
    const dir = path.join(raiz, "skills", "fake");
    await fs.ensureDir(path.join(dir, "scripts"));
    await fs.ensureDir(path.join(dir, "reference"));
    await fs.writeFile(path.join(dir, "scripts", "real.py"), "existo");
    await fs.writeFile(path.join(dir, "reference", "methodology.md"), "doc");
    return await fn(path.join(dir, "SKILL.md"));
  } finally {
    await fs.remove(raiz);
  }
}

function itemCom(body: string, file: string): AuditItem {
  return { id: "skill:x", kind: "skill", source: "personal", name: "x", file, body, listing_chars: 10 };
}

function temBroken(item: AuditItem): boolean {
  const r = auditarCapabilities(
    { items: [item], duplicates: [], variants: [], nexosFiles: new Map(), invisibleSkills: [] },
    (p) => fs.pathExistsSync(p)
  );
  return r.findings.some((f) => f.kind === "broken-reference");
}

describe("as classes semânticas de um caminho citado", () => {
  const CASOS: readonly [string, string, boolean][] = [
    ["dependency interna presente", "Rode `python scripts/real.py`.", false],
    ["dependency interna AUSENTE", "Rode `python scripts/missing.py`.", true],
    ["artefato que o leitor vai gerar", "Verify dist/index.js is created. Run `node dist/index.js`.", false],
    ["arquivo do projeto onde o comando roda", 'Notes: $(cat CHANGELOG.md | sed -n "1,5p")', false],
    ["referência upstream (repo canônico)", "A política vive em `assets/agents/nexos-master.md`.", false],
    ["referência documental local presente", "Ver `./reference/methodology.md`.", false],
    ["placeholder didático", "Exemplo: `python path/to/script.py`", false],
  ];

  for (const [nome, body, esperaBroken] of CASOS) {
    it(`${nome} -> broken-reference: ${esperaBroken}`, async () => {
      await comSkillDeMentira((skillMd) => {
        expect(temBroken(itemCom(body, skillMd))).toBe(esperaBroken);
      });
    });
  }

  it("COMANDO para diretório inexistente continua achado; CITAÇÃO para o mesmo diretório não", async () => {
    await comSkillDeMentira((skillMd) => {
      // `assets/` não existe ao lado da skill nos dois casos — o que separa é a intenção.
      expect(temBroken(itemCom("Rode `python assets/x.py`.", skillMd))).toBe(true);
      expect(temBroken(itemCom("Ver `assets/x.md`.", skillMd))).toBe(false);
    });
  });
});

type ItemDeTeste = AuditItem & { readonly content_hash: string };

describe("recorte por --kind não pode fraturar o bucket de nome", () => {
  const skills = [
    { id: "skill:personal:dup", kind: "skill", source: "personal", name: "dup", file: "/x/a.md", body: "", listing_chars: 10, content_hash: "h1" },
    { id: "skill:project:dup", kind: "skill", source: "project", name: "dup", file: "/x/b.md", body: "", listing_chars: 10, content_hash: "h2" },
  ] as ItemDeTeste[];
  const agents = [
    { id: "agent:personal:outro", kind: "agent", source: "personal", name: "outro", file: "/x/c.md", body: "", listing_chars: 10, content_hash: "h3" },
  ] as ItemDeTeste[];
  const todos = [...skills, ...agents];

  const grupoDe = (items: readonly ItemDeTeste[]): readonly VariantGroup[] => {
    const nomes = new Map<string, { id: string; file: string; source: string; content_hash: string }[]>();
    for (const i of items) {
      const lista = nomes.get(i.name) ?? [];
      lista.push({ id: i.id, file: i.file!, source: i.source, content_hash: i.content_hash });
      nomes.set(i.name, lista);
    }
    return [...nomes]
      .filter(([, l]) => new Set(l.map((x) => x.source)).size >= 2 && new Set(l.map((x) => x.content_hash)).size >= 2)
      .map(([name, items]) => ({ name, items })) as readonly VariantGroup[];
  };

  const rodar = (items: readonly AuditItem[], variants: readonly VariantGroup[]) =>
    auditarCapabilities({ items, duplicates: [], variants, nexosFiles: new Map(), invisibleSkills: [] }, () => true);

  it("grupo do catálogo INTEIRO sobre recorte filtrado derrete o shadowed (a regressão)", () => {
    const r = rodar(agents, grupoDe(todos));
    expect(r.findings.some((f) => f.kind === "shadowed")).toBe(false);
    // e pior: reporta peças de SKILL num recorte de agent
    expect(r.findings.some((f) => f.id?.startsWith("skill:"))).toBe(true);
  });

  it("grupo RECOMPUTADO sobre o recorte não vaza nem perde precedência", () => {
    const soAgent = rodar(agents, grupoDe(agents));
    expect(soAgent.findings.some((f) => f.id?.startsWith("skill:"))).toBe(false);

    const soSkill = rodar(skills, grupoDe(skills));
    expect(soSkill.findings.some((f) => f.kind === "shadowed")).toBe(true);
  });
});

/**
 * A FIAÇÃO, não o conceito. O describe acima monta os grupos à mão e prova que
 * o audit reage certo; ele passava verde com a correção do comando desligada.
 * Este mede `recorteParaAudit`, que é o que `capabilities()` de fato chama.
 */
describe("recorteParaAudit: o que --kind entrega ao audit", () => {
  const item = (id: string, kind: string, source: string, name: string, hash: string) =>
    ({ id, kind, source, name, file: `/x/${id}.md`, body: "", enabled: true, invocation: "auto", listing_chars: 10, content_hash: hash }) as never;

  const catalogo = {
    items: [
      item("skill:personal:dup", "skill", "personal", "dup", "h1"),
      item("skill:project:dup", "skill", "project", "dup", "h2"),
      item("agent:personal:solo", "agent", "personal", "solo", "h3"),
    ],
    duplicates: [],
    variants: [
      {
        name: "dup",
        items: [
          { id: "skill:personal:dup", file: "/x/skill:personal:dup.md", source: "personal", content_hash: "h1" },
          { id: "skill:project:dup", file: "/x/skill:project:dup.md", source: "project", content_hash: "h2" },
        ],
      },
    ],
  } as never as Parameters<typeof recorteParaAudit>[0];

  it("sem --kind devolve o catálogo inteiro, grupos incluídos", () => {
    const r = recorteParaAudit(catalogo, undefined);
    expect(r.items).toHaveLength(3);
    expect(r.variants).toHaveLength(1);
    expect(r.incluiSkillsInvisiveis).toBe(true);
  });

  it("--kind agent NÃO carrega o grupo de skill (era o vazamento)", () => {
    const r = recorteParaAudit(catalogo, "agent");
    expect(r.items.map((i) => i.id)).toEqual(["agent:personal:solo"]);
    expect(r.variants).toHaveLength(0);
    expect(r.duplicates).toHaveLength(0);
    expect(r.incluiSkillsInvisiveis).toBe(false);
  });

  it("--kind skill recomputa o grupo sobre o recorte e preserva a disputa", () => {
    const r = recorteParaAudit(catalogo, "skill");
    expect(r.items).toHaveLength(2);
    expect(r.variants).toHaveLength(1);
    expect(r.variants[0]?.items.map((i) => i.id).sort()).toEqual(["skill:personal:dup", "skill:project:dup"]);
    expect(r.incluiSkillsInvisiveis).toBe(true);
  });

  it("o audit sobre o recorte de agent não produz achado de skill", () => {
    const r = recorteParaAudit(catalogo, "agent");
    const rel = auditarCapabilities(
      { items: r.items as never, duplicates: r.duplicates, variants: r.variants, nexosFiles: new Map(), invisibleSkills: [] },
      () => true
    );
    expect(rel.findings.filter((f) => f.id?.startsWith("skill:"))).toHaveLength(0);
  });
});
