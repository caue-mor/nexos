/**
 * Auditoria das superfícies nativas — `INSTALLED != USABLE`.
 *
 * Medido em 2026-09-17 nesta máquina: 639 capabilities, 139.550 caracteres de
 * listagem, e no mesmo dia uma skill DO PACOTE mandava rodar 13 scripts Python
 * inexistentes. O que este teste protege são as três decisões que separam
 * achado real de ruído: ausência TOLERADA (`2>/dev/null`), exemplo com
 * placeholder, e custo contado por peça (nunca por achado).
 */
import { describe, it, expect } from "vitest";
import {
  auditarCapabilities,
  referenciasCitadas,
  classificarProveniencia,
  acaoPara,
  type AuditInput,
} from "../src/lib/capabilities/audit.js";

const HOME = "/home/fulano";
const ARQUIVO = "/home/fulano/.claude/skills/exemplo/SKILL.md";

const item = (over: Partial<AuditInput["items"][number]> = {}) => ({
  id: "skill:personal::exemplo",
  name: "exemplo",
  kind: "skill",
  source: "personal",
  file: ARQUIVO,
  listing_chars: 100,
  ...over,
});

const semNada = () => false;
const tudoExiste = () => true;

describe("referenciasCitadas — o que o texto manda abrir ou executar", () => {
  it("pega comando com caminho e caminho relativo em crase", () => {
    const body = [
      "Rode `python scripts/audit.py .` para medir.",
      "Depois leia `./referencias/regras.md`.",
    ].join("\n");
    expect(referenciasCitadas(body, ARQUIVO, HOME).map((r) => r.citado)).toEqual([
      "scripts/audit.py",
      "./referencias/regras.md",
    ]);
  });

  it("resolve `~/` contra o HOME e o relativo contra o diretório da skill", () => {
    const body = "cat ~/.claude/skills/outra/SKILL.md\ncat scripts/x.sh";
    expect(referenciasCitadas(body, ARQUIVO, HOME).map((r) => r.resolvido)).toEqual([
      "/home/fulano/.claude/skills/outra/SKILL.md",
      "/home/fulano/.claude/skills/exemplo/scripts/x.sh",
    ]);
  });

  it("ausência declarada como tolerada (2>/dev/null) não é referência", () => {
    // `cat` está na lista de comandos: sem o filtro de tolerância, isto vira achado.
    expect(referenciasCitadas("cat ~/.claude/skills/expertise/x.md 2>/dev/null", ARQUIVO, HOME)).toEqual([]);
  });

  it("placeholder é exemplo, não alvo — e o filtro é no CAMINHO, nunca na linha", () => {
    const body = [
      "cat ~/.claude/skills/expertise/<dominio>/refs.md",
      "python scripts/[modulo].py",
      "| **negrito** | x | `python scripts/real.py` |",
    ].join("\n");
    // A linha do exemplo sai pelo placeholder; a linha com `**negrito**`
    // continua sendo medida (asterisco de markdown já escondeu script morto).
    expect(referenciasCitadas(body, ARQUIVO, HOME).map((r) => r.citado)).toEqual(["scripts/real.py"]);
  });
});

describe("auditarCapabilities", () => {
  it("cita caminho ausente → quebrada; tudo no lugar → nenhum achado", () => {
    const entrada: AuditInput = {
      items: [item({ body: "Rode `python scripts/audit.py .`" })],
      duplicates: [],
      variants: [],
    };

    const quebrada = auditarCapabilities(entrada, semNada, HOME);
    expect(quebrada.findings).toHaveLength(1);
    expect(quebrada.findings[0]!.kind).toBe("broken-reference");
    expect(quebrada.findings[0]!.detail).toContain("scripts/audit.py");

    expect(auditarCapabilities(entrada, tudoExiste, HOME).findings).toEqual([]);
  });

  it("duplicata e variante viram achado por membro, com o custo de cada um", () => {
    const entrada: AuditInput = {
      items: [
        item({ id: "a", name: "docx", listing_chars: 900 }),
        item({ id: "b", name: "docx", listing_chars: 40 }),
      ],
      duplicates: [{ items: [{ id: "a", source: "personal" }, { id: "b", source: "plugin" }] }],
      variants: [],
    };

    const r = auditarCapabilities(entrada, tudoExiste, HOME);
    expect(r.findings.map((f) => [f.id, f.kind, f.listingChars])).toEqual([
      ["a", "duplicate", 900],
      ["b", "duplicate", 40],
    ]);
    expect(r.findings[0]!.detail).toContain("personal × plugin");
  });

  it("cópia DESLIGADA não disputa: duplicata ou variante só conta entre peças carregadas", () => {
    // Medido 23/09: as 16 "duplicatas" do host eram todas contra o plugin
    // document-skills, fora de enabledPlugins — no disco, fora da sessão.
    const par = [{ id: "a", source: "personal" }, { id: "b", source: "plugin" }];
    const entrada = (bEnabled: boolean): AuditInput => ({
      items: [
        item({ id: "a", name: "xlsx", listing_chars: 900 }),
        item({ id: "b", name: "document-skills:xlsx", listing_chars: 900, enabled: bEnabled }),
      ],
      duplicates: [{ items: par }],
      variants: [{ items: par }],
    });

    expect(auditarCapabilities(entrada(false), tudoExiste, HOME).findings).toEqual([]);
    expect(auditarCapabilities(entrada(true), tudoExiste, HOME).findings).toHaveLength(4);
  });

  it("ordena pelo que mais pesa na janela, com id como desempate determinístico", () => {
    const entrada: AuditInput = {
      items: [
        item({ id: "z", listing_chars: 10, body: "`python scripts/a.py`" }),
        item({ id: "m", listing_chars: 500, body: "`python scripts/b.py`" }),
        item({ id: "a", listing_chars: 10, body: "`python scripts/c.py`" }),
      ],
      duplicates: [],
      variants: [],
    };
    expect(auditarCapabilities(entrada, semNada, HOME).findings.map((f) => f.id)).toEqual(["m", "a", "z"]);
  });

  it("custo com achado conta a PEÇA uma vez, mesmo com dois achados nela", () => {
    const entrada: AuditInput = {
      items: [item({ id: "a", listing_chars: 300, body: "`python scripts/x.py`" })],
      duplicates: [{ items: [{ id: "a", source: "personal" }, { id: "b", source: "plugin" }] }],
      variants: [],
    };
    const r = auditarCapabilities(entrada, semNada, HOME);
    expect(r.findings.filter((f) => f.id === "a")).toHaveLength(2); // quebrada + duplicada
    expect(r.totals.surfaceCharsComAchado).toBe(300); // não 600
    expect(r.totals.surfaceChars).toBe(300);
  });

  it("peça sem corpo legível não vira achado inventado", () => {
    const entrada: AuditInput = { items: [item({ body: undefined })], duplicates: [], variants: [] };
    expect(auditarCapabilities(entrada, semNada, HOME).findings).toEqual([]);
  });
});

describe("proveniência — CONHECIDO != CRIADO", () => {
  it("o manifesto decide NEXOS_OWNED; origem decide o resto; nada vira órfão por não ser nosso", () => {
    expect(classificarProveniencia(item({ nexosOwned: true, source: "personal" }))).toBe("NEXOS_OWNED");
    expect(classificarProveniencia(item({ source: "personal" }))).toBe("USER_MANAGED");
    expect(classificarProveniencia(item({ source: "project" }))).toBe("PROJECT_MANAGED");
    expect(classificarProveniencia(item({ source: "plugin" }))).toBe("PLUGIN_MANAGED");
    expect(classificarProveniencia(item({ source: "sincronizada-de-outro-lugar" }))).toBe("UNCLASSIFIED");
  });

  it("conta por proveniência todas as peças, não só as com achado", () => {
    const entrada: AuditInput = {
      items: [item({ id: "a", source: "personal" }), item({ id: "b", source: "plugin" }), item({ id: "c", nexosOwned: true })],
      duplicates: [],
      variants: [],
    };
    const r = auditarCapabilities(entrada, tudoExiste, HOME);
    expect(r.totals.porProveniencia).toEqual({
      NEXOS_OWNED: 1,
      PROJECT_MANAGED: 0,
      PLUGIN_MANAGED: 1,
      USER_MANAGED: 1,
      UNCLASSIFIED: 0,
    });
    expect(r.findings).toEqual([]);
  });
});

describe("sombreamento — a precedência de SKILL é o inverso da de subagente", () => {
  it("personal vence project: a do projeto é a sombreada", () => {
    const entrada: AuditInput = {
      items: [
        item({ id: "p", name: "deploy", source: "personal", listing_chars: 10 }),
        item({ id: "j", name: "deploy", source: "project", listing_chars: 10 }),
      ],
      duplicates: [],
      variants: [{ items: [{ id: "p", source: "personal" }, { id: "j", source: "project" }] }],
    };
    const r = auditarCapabilities(entrada, tudoExiste, HOME);
    const porId = Object.fromEntries(r.findings.map((f) => [f.id, f]));
    expect(porId["j"]!.kind).toBe("shadowed");
    expect(porId["j"]!.detail).toContain("NÃO é a que roda");
    expect(porId["p"]!.kind).toBe("variant");
  });

  it("plugin é namespaced: convive, não sombreia", () => {
    const entrada: AuditInput = {
      items: [
        item({ id: "p", name: "docx", source: "personal", listing_chars: 10 }),
        item({ id: "g", name: "docx", source: "plugin", listing_chars: 10 }),
      ],
      duplicates: [],
      variants: [{ items: [{ id: "p", source: "personal" }, { id: "g", source: "plugin" }] }],
    };
    const r = auditarCapabilities(entrada, tudoExiste, HOME);
    expect(r.findings.every((f) => f.kind === "variant")).toBe(true);
    expect(r.totals.porTipo.shadowed).toBe(0);
  });
});

describe("frescor — FRESCOR É DO CONTEÚDO, NÃO DA DATA", () => {
  const comTripla = (t: { manifest: string; package: string | null; disk: string }): AuditInput => ({
    items: [item({ nexosOwned: true })],
    duplicates: [],
    variants: [],
    nexosFiles: new Map([[ARQUIVO, t]]),
  });

  it("disco igual ao manifesto e pacote com outro conteúdo → stale/UPDATE", () => {
    const r = auditarCapabilities(comTripla({ manifest: "h1", package: "h2", disk: "h1" }), tudoExiste, HOME);
    expect(r.findings.map((f) => [f.kind, f.action])).toEqual([["stale", "UPDATE"]]);
    expect(r.findings[0]!.detail).toContain("hash, não data");
  });

  it("mesmo conteúdo nos três → nenhum achado e a peça conta como KEEP", () => {
    const r = auditarCapabilities(comTripla({ manifest: "h1", package: "h1", disk: "h1" }), tudoExiste, HOME);
    expect(r.findings).toEqual([]);
    expect(r.totals.porAcao.KEEP).toBe(1);
  });

  it("host editou depois de instalado → modified/REVIEW, nunca stale (não se sobrescreve trabalho alheio)", () => {
    const r = auditarCapabilities(comTripla({ manifest: "h1", package: "h2", disk: "editado" }), tudoExiste, HOME);
    expect(r.findings.map((f) => [f.kind, f.action])).toEqual([["modified", "REVIEW"]]);
  });

  it("saiu do pacote: intocado → REMOVE; editado → REVIEW", () => {
    const intocado = auditarCapabilities(comTripla({ manifest: "h1", package: null, disk: "h1" }), tudoExiste, HOME);
    expect(intocado.findings.map((f) => [f.kind, f.action])).toEqual([["orphaned", "REMOVE"]]);

    const editado = auditarCapabilities(comTripla({ manifest: "h1", package: null, disk: "x" }), tudoExiste, HOME);
    expect(editado.findings.map((f) => [f.kind, f.action])).toEqual([["orphaned", "REVIEW"]]);
  });

  it("peça sem canônico conhecido (não é nossa) nunca vira stale", () => {
    const r = auditarCapabilities(
      { items: [item({ source: "personal" })], duplicates: [], variants: [] },
      tudoExiste,
      HOME
    );
    expect(r.findings).toEqual([]);
    expect(r.totals.porTipo.stale).toBe(0);
  });
});

describe("ação — tabela fechada, derivada de achado × proveniência", () => {
  it("quebrada nossa conserta; quebrada alheia revisa", () => {
    expect(acaoPara("broken-reference", "NEXOS_OWNED")).toBe("REPAIR");
    expect(acaoPara("broken-reference", "USER_MANAGED")).toBe("REVIEW");
    expect(acaoPara("broken-reference", "PLUGIN_MANAGED")).toBe("REVIEW");
  });

  it("conflito de nome é sempre revisão — quem sobrevive é decisão de quem usa", () => {
    for (const k of ["duplicate", "variant", "shadowed", "modified"] as const) {
      expect(acaoPara(k, "NEXOS_OWNED")).toBe("REVIEW");
    }
  });

  it("uma skill quebrada do usuário aparece com REVIEW, não com REPAIR", () => {
    const r = auditarCapabilities(
      { items: [item({ source: "personal", body: "`python scripts/x.py`" })], duplicates: [], variants: [] },
      semNada,
      HOME
    );
    expect(r.findings[0]!.action).toBe("REVIEW");
    expect(r.findings[0]!.provenance).toBe("USER_MANAGED");
  });
});

/**
 *   SHADOWED É POR NOME, NUNCA POR CONTEÚDO
 *
 * `duplicates` é agrupado pelo inventário por CONTENT_HASH; `variants`, por
 * NAME. O loop que emite achados trata os dois com a mesma lógica e chama
 * `vencedorDoNome` em ambos — então um grupo de conteúdo idêntico com nomes
 * DIFERENTES produzia `shadowed`, que é falso: a precedência de skill é por
 * nome (skills.md, "Same name in"), e duas skills de nomes distintos coexistem
 * ativas, por mais idêntico que seja o corpo.
 *
 * Medido no Store real desta máquina antes da correção: 4 dos 17 grupos de
 * duplicate tinham nomes divergentes e produziam 5 dos 20 findings `shadowed`
 * — todos falsos, entre eles `doc-coauthoring` × `productivity--doc-coauthoring`
 * e `frontend-design` × `creative-design--frontend-design`. Um relatório que
 * marca peça viva como "NÃO é a que roda" leva a remover capability em uso.
 */
describe("shadowed só nasce de disputa pelo MESMO nome", () => {
  const base = (id: string, name: string, source: string) => ({
    id,
    name,
    kind: "skill",
    source,
    file: `/home/fulano/.claude/x/${name}/SKILL.md`,
    listing_chars: 10,
  });

  it("nomes DIFERENTES com mesmo conteúdo não se sombreiam", () => {
    const entrada: AuditInput = {
      items: [
        base("skill:personal::productivity--doc", "productivity--doc", "personal"),
        base("skill:project::doc", "doc", "project"),
      ],
      duplicates: [
        {
          items: [
            { id: "skill:personal::productivity--doc", source: "personal" },
            { id: "skill:project::doc", source: "project" },
          ],
        },
      ],
      variants: [],
    };
    const kinds = auditarCapabilities(entrada, tudoExiste).findings.map((f) => f.kind);
    expect(kinds, "conteúdo igual com nomes distintos é duplicata, nunca sombreamento").toEqual([
      "duplicate",
      "duplicate",
    ]);
  });

  it("mesmo nome em personal e project continua sombreando o project", () => {
    const entrada: AuditInput = {
      items: [
        base("skill:personal::doc", "doc", "personal"),
        base("skill:project::doc", "doc", "project"),
      ],
      duplicates: [
        {
          items: [
            { id: "skill:personal::doc", source: "personal" },
            { id: "skill:project::doc", source: "project" },
          ],
        },
      ],
      variants: [],
    };
    const f = auditarCapabilities(entrada, tudoExiste).findings;
    const sombreado = f.filter((x) => x.kind === "shadowed");
    expect(sombreado.map((x) => x.id), "quem perde a precedência é o project").toEqual([
      "skill:project::doc",
    ]);
  });

  /**
   * O caso que o dono pediu explicitamente: plugin + project SEM personal não
   * pode reportar "vence personal". Plugin é namespaced e não disputa nome.
   */
  it("plugin + project sem personal não reporta winner personal", () => {
    const entrada: AuditInput = {
      items: [
        base("skill:plugin:pack:doc", "doc", "plugin"),
        base("skill:project::doc", "doc", "project"),
      ],
      duplicates: [],
      variants: [
        {
          items: [
            { id: "skill:plugin:pack:doc", source: "plugin" },
            { id: "skill:project::doc", source: "project" },
          ],
        },
      ],
    };
    const f = auditarCapabilities(entrada, tudoExiste).findings;
    expect(f.some((x) => x.kind === "shadowed"), "sem personal não há quem sombreie").toBe(false);
    expect(f.every((x) => !x.detail.includes("vence personal")), "nenhum detail pode citar personal").toBe(true);
  });
  /**
   * O caso que quebrou a primeira versão da guarda: plugin namespaced entra no
   * grupo de conteúdo, mas não concorre por nome. Olhar o nome do grupo INTEIRO
   * fazia o plugin vetar o sombreamento legítimo entre personal e project — e
   * zerava os 20 sombreados do Store real em vez dos 5 falsos.
   */
  it("plugin namespaced no grupo não impede o sombreamento entre personal e project", () => {
    const entrada: AuditInput = {
      items: [
        base("skill:personal::doc", "doc", "personal"),
        base("skill:project::doc", "doc", "project"),
        base("skill:plugin:pack:doc", "pack:doc", "plugin"),
      ],
      duplicates: [
        {
          items: [
            { id: "skill:personal::doc", source: "personal" },
            { id: "skill:project::doc", source: "project" },
            { id: "skill:plugin:pack:doc", source: "plugin" },
          ],
        },
      ],
      variants: [],
    };
    const f = auditarCapabilities(entrada, tudoExiste).findings;
    expect(f.filter((x) => x.kind === "shadowed").map((x) => x.id)).toEqual(["skill:project::doc"]);
  });
});

/**
 *   CONTAGEM DE TRABALHO É POR PEÇA, ACHADO É POR ACHADO
 *
 * `porAcao.KEEP` sempre deduplicou por id (`items.length - Set(ids)`), mas as
 * outras chaves somavam findings brutos — dois números com unidades diferentes
 * no mesmo objeto. A mesma peça cai em `duplicates` E em `variants` e emite um
 * finding em cada, então quem lê `REVIEW: 102` dimensiona 102 unidades de
 * trabalho quando são 87 peças. Medido no Store real desta máquina: 102 findings
 * contra 87 ids distintos, 15 de sobrecontagem.
 *
 * `porTipo` continua contando ACHADOS de propósito — ali a pergunta é "quantos
 * sombreamentos existem", não "quantas peças tocar".
 */
describe("porAcao conta PEÇAS distintas, porTipo conta ACHADOS", () => {
  it("peça com dois achados da mesma ação conta uma vez em porAcao e duas em porTipo", () => {
    const peca = (id: string, name: string, source: string) => ({
      id,
      name,
      kind: "skill",
      source,
      file: `/home/fulano/.claude/x/${name}/SKILL.md`,
      listing_chars: 10,
    });
    /** `doc` aparece nos dois grupos — é o padrão real de xlsx, mcp-builder etc. */
    const entrada: AuditInput = {
      items: [peca("skill:personal::doc", "doc", "personal"), peca("skill:project::doc", "doc", "project")],
      duplicates: [
        {
          items: [
            { id: "skill:personal::doc", source: "personal" },
            { id: "skill:project::doc", source: "project" },
          ],
        },
      ],
      variants: [
        {
          items: [
            { id: "skill:personal::doc", source: "personal" },
            { id: "skill:project::doc", source: "project" },
          ],
        },
      ],
    };
    const { totals, findings } = auditarCapabilities(entrada, tudoExiste);
    expect(findings.length, "quatro achados: duas peças em dois grupos").toBe(4);
    expect(totals.porAcao.REVIEW, "mas só DUAS peças a revisar").toBe(2);
    expect(
      totals.porTipo.shadowed + totals.porTipo.duplicate + totals.porTipo.variant,
      "porTipo continua somando achados"
    ).toBe(4);
  });
});
