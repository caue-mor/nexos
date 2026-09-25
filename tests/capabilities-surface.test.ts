/**
 * SUPERFÍCIE REAL DO HOST — o audit media disco e chamava de capability.
 *
 *   DISK != LISTED != INVOCABLE
 *   OFF != BROKEN · NO OVERRIDE != PROVEN WORKING
 *
 * E a lição da primeira versão, que o verificador independente reprovou:
 *
 *   REUSE > CREATE
 *
 * `scan.ts` já resolvia `skillOverrides` por peça (e já aplicava a regra do
 * host: vale para skill pessoal/projeto, não para plugin). A primeira versão
 * re-resolveu contra o mapa cru e marcou `plugin:nanobanana@opc-skills` e
 * `plugin:requesthunt@opc-skills` — `enabled: true`, `health: "connected"` —
 * como NÃO invocáveis, por colisão de nome de diretório. 63 "off" onde o scan
 * resolve 52. O vício original invertido: capability LIGADA dada como morta.
 */
import { describe, it, expect } from "vitest";
import { resolveSurface, overridesGovernam } from "../src/lib/capabilities/surface.js";
import { resumirSuperficie, type AuditItem } from "../src/lib/capabilities/audit.js";
import type { OverrideValue } from "../src/lib/capabilities/types.js";

const AS_14 = [
  "brand-guidelines", "canvas-design", "doc-coauthoring", "docx", "internal-comms",
  "mcp-builder", "pdf", "pptx", "skill-creator", "slack-gif-creator", "theme-factory",
  "web-artifacts-builder", "webapp-testing", "xlsx",
] as const;

function skill(name: string, override?: OverrideValue): AuditItem {
  return {
    id: `skill:project::${name}`, name, kind: "skill", source: "project",
    file: `/repo/.agents/skills/${name}/SKILL.md`, ...(override ? { override } : {}),
  };
}
function plugin(name: string): AuditItem {
  return { id: `plugin:${name}@opc-skills`, name, kind: "plugin", source: "plugin" };
}

describe("resolveSurface — os quatro valores do vocabulário do host", () => {
  it("off => o modelo NÃO invoca, e é config, não defeito", () => {
    const s = resolveSurface("skill", "off");
    expect(s.invocable).toBe("NO");
    expect(s.invocableBasis).toBe("DERIVED_FROM_CONFIG");
    expect(s.detail).toContain("OFF != BROKEN");
  });

  /**
   *   RECUSAR A INVOCAÇÃO NÃO MEDE A LISTAGEM
   *
   * Este teste afirmava `listed === "UNKNOWN"` e passava — codificando uma
   * inferência de UM salto: o host recusou uma invocação citando
   * `skillOverrides`, e disso se concluiu que a listagem seguia intacta. A doc
   * oficial (skills.md, "Override skill visibility from settings") responde em
   * tabela: `off` é oculta na listagem E no menu. Teste verde sobre premissa
   * errada é pior que teste vermelho — ele defendia a premissa.
   */
  it("off some da listagem E do menu — é a via reversível de cortar contexto", () => {
    const s = resolveSurface("skill", "off");
    expect(s.listed).toBe("NO");
    expect(s.listedBasis).toBe("DOCUMENTED");
    expect(s.invocable).toBe("NO");
    expect(s.detail).toContain("NÃO custa contexto");
  });

  /** CONTROLE NEGATIVO: `on` e `name-only` continuam listadas — se `listed`
   *  virasse "NO" para todo mundo, o teste acima passaria por acidente. */
  it("on e name-only CONTINUAM listadas — name-only só perde a descrição", () => {
    expect(resolveSurface("skill", "on").listed).toBe("YES");
    const nameOnly = resolveSurface("skill", "name-only");
    expect(nameOnly.listed).toBe("YES");
    expect(nameOnly.detail).toContain("SEM descrição");
  });

  /** E o que os overrides NÃO governam continua sem resposta — a doc é
   *  explícita: plugin se controla por /plugin. */
  it("plugin não ganha veredito de listagem por tabelinha de skill", () => {
    const s = resolveSurface("plugin", "off");
    expect(s.listedBasis).toBe("NOT_APPLICABLE");
    expect(s.listed).toBe("UNKNOWN");
  });

  /** O valor que a primeira versão nem modelava — tratava como "fora do vocabulário". */
  it("user-invocable-only => usuário invoca, MODELO não", () => {
    const s = resolveSurface("skill", "user-invocable-only");
    expect(s.invocable).toBe("NO");
    expect(s.invocableBasis).toBe("DERIVED_FROM_CONFIG");
    expect(s.listed).toBe("NO"); // oculta para o modelo, visível no menu /
    expect(s.detail).toContain("USUÁRIO invoca");
  });

  it("name-only é reduzida, não desligada; invocabilidade sem prova", () => {
    const s = resolveSurface("skill", "name-only");
    expect(s.invocable).toBe("UNKNOWN");
    expect(s.detail).toContain("NAME-ONLY != BROKEN");
  });

  it("on é decisão explícita, e ainda assim não é prova de que funciona", () => {
    const s = resolveSurface("skill", "on");
    expect(s.invocable).toBe("UNKNOWN");
    expect(s.invocableBasis).toBe("UNKNOWN");
  });

  it("sem override NÃO vira 'funciona' — preserva UNKNOWN", () => {
    const s = resolveSurface("skill", undefined);
    expect(s.invocable).toBe("UNKNOWN");
    expect(s.invocableBasis).toBe("UNKNOWN");
  });
});

describe("skillOverrides NÃO governa tudo — o defeito que o verificador pegou", () => {
  it("plugin NUNCA é julgado por skillOverrides, mesmo com nome homônimo", () => {
    const s = resolveSurface("plugin", undefined);
    expect(s.invocableBasis).toBe("NOT_APPLICABLE");
    expect(s.invocable).toBe("UNKNOWN");
    expect(s.detail).toContain("/plugin");
  });

  it.each(["plugin", "mcp", "lsp", "agent"])("%s não é governado por overrides", (kind) => {
    expect(overridesGovernam(kind)).toBe(false);
    expect(resolveSurface(kind, undefined).invocableBasis).toBe("NOT_APPLICABLE");
  });

  /**
   *   COMMAND FILE É SKILL EM FORMATO ANTIGO
   *
   * `command` estava na lista acima, afirmando que não se desliga por
   * settings. MEDIDO: um bloco de 470 `off` casou 195 peças porque os 167
   * arquivos de `commands/` eram dados como fora de alcance. A doc
   * (skills.md) diz que os dois formatos "work the same way".
   */
  it("command É governado — commands/ é o formato antigo da mesma coisa", () => {
    expect(overridesGovernam("command")).toBe(true);
    const s = resolveSurface("command", "off");
    expect(s.listed).toBe("NO");
    expect(s.invocable).toBe("NO");
    expect(s.invocableBasis).toBe("DERIVED_FROM_CONFIG");
  });

  it("skill é o único kind governado", () => {
    expect(overridesGovernam("skill")).toBe(true);
  });

  /**
   * REGRESSÃO DIRETA do defeito medido: dois plugins ligados e conectados
   * saíram como `invocable: NO` porque o nome batia com uma skill desligada.
   */
  it("plugin ligado NÃO entra em notInvocable nem que exista skill homônima off", () => {
    const s = resumirSuperficie({
      items: [plugin("nanobanana"), plugin("requesthunt"), skill("nanobanana", "off")],
      duplicates: [], variants: [],
    });
    expect(s.notInvocable.map((n) => n.id)).toEqual(["skill:project::nanobanana"]);
    expect(s.naoGovernadas).toBe(2);
  });
});

describe("resumirSuperficie — acceptance", () => {
  const items = [
    ...AS_14.map((n) => skill(n, "off")),
    skill("llm-council", "name-only"),
    skill("nexos-god-mode", "name-only"),
    skill("so-usuario", "user-invocable-only"),
    skill("ligada", "on"),
    skill("ad-creative"),
    plugin("nanobanana"),
  ];
  const input = { items, duplicates: [], variants: [] };

  it("as 14 PROJECT_MANAGED são explicadas 14/14 por off", () => {
    const s = resumirSuperficie(input);
    const offs = s.notInvocable.filter((n) => n.override === "off");
    expect(offs).toHaveLength(14);
    expect(new Set(offs.map((n) => n.name))).toEqual(new Set(AS_14));
  });

  it("as off são classificadas SEM virar broken", () => {
    for (const n of resumirSuperficie(input).notInvocable) {
      expect(n.detail).toMatch(/OFF != BROKEN|NÃO é defeito/);
    }
  });

  it("name-only reconhecidas como reduzidas, não desligadas", () => {
    const s = resumirSuperficie(input);
    expect(s.reduced).toHaveLength(2);
    expect(s.porOverride["name-only"]).toBe(2);
  });

  it("user-invocable-only conta como não-invocável pelo MODELO", () => {
    const s = resumirSuperficie(input);
    expect(s.notInvocable.filter((n) => n.override === "user-invocable-only")).toHaveLength(1);
    expect(s.notInvocable).toHaveLength(15);
  });

  it("DISK != LISTED != INVOCABLE: descoberto não é oferecido", () => {
    const s = resumirSuperficie(input);
    expect(s.discovered).toBe(items.length);
    expect(s.naoGovernadas).toBe(1);
    expect(s.invocabilidadeDesconhecida).toBe(items.length - 15);
  });

  it("distingue FATO MEDIDO de UNKNOWN: nada passa por aqui como medido", () => {
    const s = resumirSuperficie(input);
    expect(s.medidasDiretamente).toBe(0);
    for (const n of s.notInvocable) expect(n.basis).toBe("DERIVED_FROM_CONFIG");
  });

  /** MUTATION EXIGIDA: ignorar o override precisa quebrar. */
  it("MUTATION: ignorar item.override derruba o acceptance", () => {
    const cego = resumirSuperficie({ ...input, items: items.map((i) => ({ ...i, override: undefined })) });
    expect(cego.notInvocable).toHaveLength(0);
    expect(cego.reduced).toHaveLength(0);
    expect(cego.porOverride.off).toBe(0);
  });
});

/**
 * INTEGRAÇÃO — o teste que faltava.
 *
 *   UNIT GREEN != WIRED
 *
 * MEDIDO: com `comCorpo()` deixando de copiar `item.override` do catálogo para
 * o `AuditItem`, o audit passou a reportar `off 0` e `0/14 explicadas` — e os
 * 21 testes unitários acima seguiram verdes, porque todos constroem
 * `AuditItem` à mão e nunca atravessam esse mapeamento. Um campo esquecido no
 * fio zera a superfície inteira em silêncio.
 */
describe("propagação catálogo -> audit", () => {
  it("AuditItem aceita override e resumirSuperficie o enxerga", () => {
    const s = resumirSuperficie({
      items: [skill("vinda-do-catalogo", "off")],
      duplicates: [],
      variants: [],
    });
    expect(s.notInvocable).toHaveLength(1);
    expect(s.porOverride.off).toBe(1);
  });

  it("override PERDIDO no caminho zera a superfície — é o sintoma a reconhecer", () => {
    const comCampo = skill("x", "off");
    const semCampo: AuditItem = { id: comCampo.id, name: comCampo.name, kind: comCampo.kind, source: comCampo.source };
    const cego = resumirSuperficie({ items: [semCampo], duplicates: [], variants: [] });
    expect(cego.notInvocable).toHaveLength(0);
    expect(cego.porOverride.off).toBe(0);
    expect(cego.invocabilidadeDesconhecida).toBe(1);
  });
});

/**
 * INTEGRAÇÃO DE VERDADE — atravessa `comCorpo`, o elo que quebrou.
 *
 * O bloco "propagação catálogo -> audit" acima NÃO é integração: monta
 * `AuditItem` à mão. Um verificador independente apagou a linha do `override`
 * em `commands/capabilities.ts` e os 1931 testes passaram verdes, porque
 * nenhum arquivo de teste importava aquele módulo. Estes importam.
 */
describe("comCorpo — projeção catálogo -> AuditItem (o elo sem cobertura)", () => {
  it("propaga override do CapabilityItem para o AuditItem", async () => {
    const { comCorpo } = await import("../src/commands/capabilities.js");
    const out = await comCorpo([
      {
        kind: "skill", id: "skill:personal::theme-factory", name: "theme-factory",
        source: "personal", invocation: "Skill tool", description: "", listing_chars: 10,
        enabled: false, override: "off",
      },
    ] as never);
    expect(out).toHaveLength(1);
    expect(out[0]?.override).toBe("off");
    expect(out[0]?.enabled).toBe(false);
  });

  it("item SEM override chega sem o campo — ABSENCE = FIELD ABSENT", async () => {
    const { comCorpo } = await import("../src/commands/capabilities.js");
    const out = await comCorpo([
      {
        kind: "skill", id: "skill:personal::ad-creative", name: "ad-creative",
        source: "personal", invocation: "Skill tool", description: "", listing_chars: 10, enabled: true,
      },
    ] as never);
    expect(out[0]?.override).toBeUndefined();
  });

  /** O caminho inteiro: catálogo -> comCorpo -> resumirSuperficie. */
  it("catálogo com override vira notInvocable no relatório final", async () => {
    const { comCorpo } = await import("../src/commands/capabilities.js");
    const items = await comCorpo([
      { kind: "skill", id: "skill:personal::a", name: "a", source: "personal",
        invocation: "Skill tool", description: "", listing_chars: 5, enabled: false, override: "off" },
      { kind: "plugin", id: "plugin:b@m", name: "b", source: "plugin",
        invocation: "/plugin", description: "", listing_chars: 5, enabled: true },
    ] as never);
    const s = resumirSuperficie({ items, duplicates: [], variants: [] });
    expect(s.notInvocable.map((n) => n.id)).toEqual(["skill:personal::a"]);
    expect(s.naoGovernadas).toBe(1);
  });
});
