/**
 * FALSO POSITIVO DE `broken-reference` — a terceira camada de isenção.
 *
 *   INSTRUMENTO QUE GRITA LOBO É INSTRUMENTO QUE SE IGNORA
 *
 * `audit.ts` já tinha duas isenções, ambas derivadas de medição: placeholder no
 * próprio caminho (19% de falso positivo medido em 2026-09-20) e caminho fora
 * do layout da capability (3 de 7 classes, 2026-09-21).
 *
 * MEDIDO em 2026-09-22, investigando as 14 `broken-reference` do host real:
 * **pelo menos 4 eram falso positivo**, e nenhuma cabia nas duas isenções
 * existentes porque o sinal não estava NO CAMINHO — estava no resto do
 * documento:
 *
 *   obsidian-cli                       `cat > /tmp/obs.js` duas linhas antes
 *   automation--workflow-orchestrator  `cd /path/to/project && node workflow-engine.js`
 *   create-prompt                      ``(e.g., `./prompts/005-…`)``
 *   deployment--rollback-deploy        `-- Django: python manage.py migrate …`
 *
 * Depois desta camada: 14 → 10 no host real.
 *
 * O TETO, declarado: sobra saída de exemplo SEM marcador ("✓ Saved prompt to
 * ./prompts/005-…"). Não foi absolvida de propósito — a regra que a pegaria
 * teria de isentar linha por parecer output, e é exatamente a isenção larga
 * demais que `agents-dependencies.test.ts` já provou esconder dependência
 * morta de verdade.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import { referenciasCitadas } from "../src/lib/capabilities/audit.js";

const ARQUIVO = path.join(os.tmpdir(), "peca-fixture", "SKILL.md");
const citados = (body: string): string[] => referenciasCitadas(body, ARQUIVO).map((r) => r.citado);

describe("isenção 3 · o sinal está no documento, não no caminho", () => {
  it("caminho que o PRÓPRIO doc cria com heredoc não é dependência ausente", () => {
    const body = ["```bash", "cat > /tmp/obs.js << 'JS'", "console.log(1)", "JS", 'obsidian eval code="$(cat /tmp/obs.js)"', "```"].join("\n");
    expect(citados(body)).not.toContain("/tmp/obs.js");
  });

  it.each([
    ["touch", "touch scripts/gerado.py\npython scripts/gerado.py", "scripts/gerado.py"],
    ["redireção", "echo oi > scripts/saida.txt\ncat scripts/saida.txt", "scripts/saida.txt"],
    ["mkdir -p", "mkdir -p scripts/out\nls scripts/out", "scripts/out"],
  ])("%s também conta como produção", (_nome, body, alvo) => {
    expect(citados(body)).not.toContain(alvo);
  });

  it("placeholder no IRMÃO da linha absolve o snippet inteiro", () => {
    const body = "0 2 * * * cd /path/to/project && node workflow-engine.js run backup.json";
    expect(citados(body)).not.toContain("workflow-engine.js");
  });

  it.each([
    "- Example: `./prompts/001-implement-user-authentication.md`",
    "If you created ONE prompt (e.g., `./prompts/005-implement-feature.md`):",
    "For example, run `scripts/demo-que-nao-existe.py`",
  ])("marcador de exemplo na linha absolve: %s", (linha) => {
    expect(citados(linha)).toEqual([]);
  });

  /**
   * CONTROLES NEGATIVOS — a isenção não pode virar anistia geral. Sem estes,
   * o guard passaria com `return []` e ninguém saberia.
   */
  it("dependência REAL do layout continua sendo capturada", () => {
    expect(citados("Leia `scripts/validate_report.py` antes de rodar.")).toContain("scripts/validate_report.py");
  });

  it("a palavra 'example' SOLTA não absolve — só a forma de marcador", () => {
    // "example" sem dois-pontos, sem e.g., sem for: é prosa comum, não marcação.
    expect(citados("This skill handles example payloads via `scripts/parse.py`")).toContain("scripts/parse.py");
  });

  it("produção de um caminho não absolve OUTRO caminho da mesma peça", () => {
    const body = "cat > /tmp/gerado.js << 'JS'\nJS\nLeia `scripts/real.py`";
    const r = citados(body);
    expect(r).not.toContain("/tmp/gerado.js");
    expect(r).toContain("scripts/real.py");
  });
});

/**
 * ISENÇÃO 4 — caminho relativo que SOBE acima da árvore da peça.
 *
 *   FORA DA ÁRVORE DA PEÇA != DEPENDÊNCIA DA PEÇA
 *
 * MEDIDO em 2026-09-22: `cua-driver` era a ÚNICA `broken-reference` ATIVA do
 * host. A citação é prosa para o leitor — "the full wire contract is in
 * `../../../docs/action-result-contract.md`" — e o arquivo pertence ao repo de
 * onde a skill foi copiada. Depois desta camada: 1 ativa -> 0.
 *
 * O corte é em DOIS níveis, não um: `../shared/x.md` ainda pode ser layout de
 * plugin com referências compartilhadas, e absolver isso seria o falso negativo
 * que a regra deveria impedir.
 */
describe("isenção 4 · o caminho escapa a árvore da peça", () => {
  it("dois ou mais `../` não são dependência da peça", () => {
    expect(citados("Ver `../../../docs/action-result-contract.md` para o contrato.")).toEqual([]);
    expect(citados("Detalhes em `../../docs/x.md`.")).toEqual([]);
  });

  it("CONTROLE: UM nível acima continua sendo capturado", () => {
    // Plugin com `references/` compartilhado entre skills irmãs é layout legítimo.
    expect(citados("Leia `../shared/contrato.md` antes.")).toContain("../shared/contrato.md");
  });

  it("CONTROLE: o layout da própria peça continua capturado", () => {
    expect(citados("Rode `python scripts/validate.py`.")).toContain("scripts/validate.py");
    expect(citados("Leia `./referencia.md`.")).toContain("./referencia.md");
  });
});
