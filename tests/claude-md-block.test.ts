import { describe, it, expect } from "vitest";
import crypto from "node:crypto";
import {
  NEXOS_BLOCK_END,
  renderClaudeMdBlock,
  inspectClaudeMdBlock,
  planClaudeMdBlock,
  LEGACY_UNMARKED_SIGNATURES,
} from "../src/lib/claude-md-block.js";

// nexos://decision/claude-md-bloco-gerenciado — o NexOS só gerencia o bloco
// delimitado; tudo fora dele é do usuário/projeto e fica byte a byte. O doctor
// distingue ausente, íntegro, desatualizado, customização externa e conflito.

const BODY_V1 = "## NexOS\n\nregra v1\n";
const BODY_V2 = "## NexOS\n\nregra v2 com mais texto\n";
const sha = (s: string) => crypto.createHash("sha256").update(s).digest("hex");

describe("renderClaudeMdBlock", () => {
  it("delimita o corpo e assina o marcador de abertura com o sha256 do corpo normalizado", () => {
    const block = renderClaudeMdBlock(BODY_V1);
    const body = "## NexOS\n\nregra v1";
    expect(block).toBe(`<!-- NEXOS:BEGIN managed sha256=${sha(body)} -->\n${body}\n${NEXOS_BLOCK_END}`);
  });
});

describe("inspectClaudeMdBlock — estados", () => {
  it("sem marcador e sem assinatura legada → absent", () => {
    const r = inspectClaudeMdBlock("# Meu projeto\n\nregras minhas, cito NexOS de passagem\n", BODY_V1);
    expect(r.state).toBe("absent");
    expect(r.hasExternalContent).toBe(true);
  });

  it("seção NexOS gerada antes dos marcadores → legacy_unmarked (nunca absent, para não duplicar)", () => {
    for (const signature of LEGACY_UNMARKED_SIGNATURES) {
      const r = inspectClaudeMdBlock(`# Projeto\n\n${signature}\n\nmais texto\n`, BODY_V1);
      expect(r.state).toBe("legacy_unmarked");
    }
  });

  it("título do projeto que só COMEÇA como o do template → absent (caso real do nexos-cli, 23/09)", () => {
    const proprio = "# NexOS — Project Brain + Capability Layer for Claude Code\n\n## Product identity\n";
    expect(inspectClaudeMdBlock(proprio, BODY_V1).state).toBe("absent");
  });

  it("bloco escrito pelo NexOS com o corpo esperado → intact", () => {
    const text = `# Projeto\n\n${renderClaudeMdBlock(BODY_V1)}\n`;
    const r = inspectClaudeMdBlock(text, BODY_V1);
    expect(r.state).toBe("intact");
    expect(r.hasExternalContent).toBe(true);
  });

  it("bloco escrito pelo NexOS (assinatura bate) com corpo antigo → outdated", () => {
    const text = renderClaudeMdBlock(BODY_V1);
    expect(inspectClaudeMdBlock(text, BODY_V2).state).toBe("outdated");
    expect(inspectClaudeMdBlock(text, BODY_V2).hasExternalContent).toBe(false);
  });

  it("corpo editado à mão (assinatura não bate) → conflict", () => {
    const text = renderClaudeMdBlock(BODY_V1).replace("regra v1", "regra que eu mudei");
    const r = inspectClaudeMdBlock(text, BODY_V1);
    expect(r.state).toBe("conflict");
    expect(r.reason).toMatch(/editado/);
  });

  it("marcador sem assinatura (copiado à mão) → conflict: não dá para provar que o NexOS escreveu", () => {
    const text = `<!-- NEXOS:BEGIN managed -->\n## NexOS\n\nregra v1\n${NEXOS_BLOCK_END}\n`;
    const r = inspectClaudeMdBlock(text, BODY_V1);
    expect(r.state).toBe("conflict");
    expect(r.reason).toMatch(/assinatura/);
  });

  it.each([
    ["BEGIN sem END", `${renderClaudeMdBlock(BODY_V1).split(NEXOS_BLOCK_END)[0]}fim`, /sem END/],
    ["END sem BEGIN", `texto\n${NEXOS_BLOCK_END}\n`, /sem BEGIN/],
    ["END antes de BEGIN", `${NEXOS_BLOCK_END}\n${renderClaudeMdBlock(BODY_V1).split(NEXOS_BLOCK_END)[0]}`, /antes/],
    ["BEGIN duplicado", `${renderClaudeMdBlock(BODY_V1)}\n${renderClaudeMdBlock(BODY_V1)}`, /mais de um/],
  ])("marcadores malformados: %s → conflict", (_nome, text, reason) => {
    const r = inspectClaudeMdBlock(text, BODY_V1);
    expect(r.state).toBe("conflict");
    expect(r.reason).toMatch(reason);
  });

  it("arquivo só com o bloco → hasExternalContent false", () => {
    expect(inspectClaudeMdBlock(`${renderClaudeMdBlock(BODY_V1)}\n`, BODY_V1).hasExternalContent).toBe(false);
  });
});

describe("planClaudeMdBlock — nunca toca fora do bloco", () => {
  it("arquivo inexistente → create com o bloco", () => {
    const p = planClaudeMdBlock(null, BODY_V1);
    expect(p.action).toBe("create");
    expect(p.content).toBe(`${renderClaudeMdBlock(BODY_V1)}\n`);
  });

  it("absent → insert: os bytes originais continuam como prefixo exato", () => {
    for (const original of ["# Meu projeto\nregras\n", "# Sem newline final", "\r\n# CRLF\r\nlinha\r\n"]) {
      const p = planClaudeMdBlock(original, BODY_V1);
      expect(p.action).toBe("insert");
      expect(p.content?.startsWith(original)).toBe(true);
      expect(inspectClaudeMdBlock(p.content ?? "", BODY_V1).state).toBe("intact");
    }
  });

  it("outdated → update: bytes antes e depois do bloco idênticos, só o corpo muda", () => {
    const before = "# Projeto\n\ntexto do usuário antes\n\n";
    const after = "\n\n## Seção do usuário depois\nnão mexer\n";
    const original = `${before}${renderClaudeMdBlock(BODY_V1)}${after}`;
    const p = planClaudeMdBlock(original, BODY_V2);
    expect(p.action).toBe("update");
    expect(p.content).toBe(`${before}${renderClaudeMdBlock(BODY_V2)}${after}`);
    expect(inspectClaudeMdBlock(p.content ?? "", BODY_V2).state).toBe("intact");
  });

  it("intact → unchanged, sem conteúdo", () => {
    const p = planClaudeMdBlock(`x\n${renderClaudeMdBlock(BODY_V1)}\n`, BODY_V1);
    expect(p.action).toBe("unchanged");
    expect(p.content).toBeNull();
  });

  it("conflict e legacy_unmarked → nunca escrevem (DRIFTED não autoriza sobrescrever)", () => {
    const editado = renderClaudeMdBlock(BODY_V1).replace("regra v1", "minha");
    const legado = `# P\n\n${LEGACY_UNMARKED_SIGNATURES[0]}\n`;
    for (const original of [editado, legado]) {
      const p = planClaudeMdBlock(original, BODY_V2);
      expect(p.action).toBe("conflict");
      expect(p.content).toBeNull();
    }
  });
});
