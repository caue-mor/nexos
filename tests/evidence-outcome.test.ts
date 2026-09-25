/**
 * Duas categorias não bastam para dizer o que aconteceu com um gate.
 *
 *   O PRODUTOR SABE; O EXIT CODE ESQUECE
 *
 * MEDIDO em 2026-09-18, reproduzindo gates de um commit antigo num worktree
 * limpo: `npm run typecheck` devolveu 127 (`tsc: command not found`) por falta
 * de dependência, e `npm test` devolveu 1 com ZERO testes executados porque o
 * runner morreu no startup. Comparando só `exit_code`, os dois seriam lidos
 * como "o gate REPROVA neste commit" — reprovação confiante de código íntegro,
 * que é pior que evidência ausente porque ninguém revisa reprovação confiante.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { classifyOutcome, loadEvidence } from "../src/lib/evidence.js";

describe("classifyOutcome", () => {
  it("0 é passed", () => {
    expect(classifyOutcome(0)).toBe("passed");
  });

  it("127 e 126 são did_not_run — comando não encontrado e não executável não são veredito sobre o código", () => {
    expect(classifyOutcome(127)).toBe("did_not_run");
    expect(classifyOutcome(126)).toBe("did_not_run");
  });

  it("falha de spawn (exit null) é did_not_run — o processo não chegou a existir", () => {
    expect(classifyOutcome(null)).toBe("did_not_run");
  });

  it("o resto é failed — o ÚNICO estado que acusa o código", () => {
    expect(classifyOutcome(1)).toBe("failed");
    expect(classifyOutcome(2)).toBe("failed");
    expect(classifyOutcome(255)).toBe("failed");
  });

  /**
   * LIMITE DECLARADO, e este teste existe para que ele não seja esquecido: um
   * runner que SOBE e morre com 1 é indistinguível, por exit code, de um teste
   * que falhou. Classificá-lo exigiria parsear `stdout`, e parsear saída para
   * classificar é exatamente a porta que este campo existe para não abrir —
   * `stdout_tail` chega a 156 KB de conteúdo arbitrário e fica fora do
   * subconjunto portável por segurança.
   */
  it("LIMITE: exit 1 de runner que não subiu é indistinguível de teste que falhou", () => {
    expect(classifyOutcome(1)).toBe("failed");
    // se algum dia isto virar "did_not_run", alguém passou a ler stdout —
    // e essa decisão precisa ser deliberada, não um efeito colateral.
  });
});

const TMP = fs.realpathSync(os.tmpdir());

/**
 * Forma EXATA de um record do acervo anterior ao campo — sem `outcome`. Mesmo
 * molde de `tests/evidence-deliberately-unbound.test.ts`; o que muda aqui é o
 * exit code, porque é ele que separa DERIVAR de ASSUMIR: aquele arquivo só
 * exercita `exit_code: 0`, cujo resultado (`passed`) é idêntico ao de um
 * leitor que não derivasse nada.
 */
async function outcomeLido(over: Record<string, unknown>): Promise<string | undefined> {
  const root = await fs.mkdtemp(path.join(TMP, "ev-outcome-legado-"));
  try {
    const dir = path.join(root, ".nexos", ".local", "evidence");
    await fs.mkdir(dir, { recursive: true });
    const exitCode = over.exit_code === undefined ? 0 : over.exit_code;
    await fs.writeJson(path.join(dir, "ev_LEGADO0000000000000002.json"), {
      id: "ev_LEGADO0000000000000002",
      kind: "command_observation",
      gate: "test",
      command: "npm",
      args: ["run", "test"],
      cwd: "/tmp/legado",
      started_at: "2026-09-01T00:00:00.000Z",
      finished_at: "2026-09-01T00:00:01.000Z",
      observed_pass: exitCode === 0,
      stdout_tail: "",
      stderr_tail: "",
      stdout_bytes: 0,
      stderr_bytes: 0,
      producer: "nexos-evidence-v1",
      ...over,
    });
    const records = await loadEvidence(root);
    expect(records).toHaveLength(1);
    return records[0]?.outcome;
  } finally {
    await fs.remove(root);
  }
}

/**
 * `classifyOutcome` estar coberta NÃO prova que o leitor a chama.
 *
 *   FUNÇÃO COBERTA != CAMINHO QUE A USA COBERTO
 *
 * MEDIDO em 2026-09-19 (verificação independente): trocando a derivação de
 * `loadEvidenceDiagnostics` por `parsed.data.outcome ?? "passed"` — o que
 * marca TODO record legado como aprovado sem olhar o exit code — `npx vitest
 * run tests/evidence-{outcome,authority,verifier,deliberately-unbound}.test.ts`
 * seguiu com 29 testes verdes. Os 5 testes de `classifyOutcome` acima não
 * caem porque a função continua correta; o que ninguém exercitava era o
 * caminho de LEITURA do legado, e é ele que decide o que o acervo inteiro
 * relata hoje.
 */
describe("loadEvidence · o leitor do legado DERIVA do exit code, nunca assume", () => {
  it("NEGATIVE CONTROL: legado sem `outcome` nunca vira passed — exit 1 sai failed, 127 e falha de spawn saem did_not_run", async () => {
    expect(await outcomeLido({ exit_code: 1 })).toBe("failed");
    expect(await outcomeLido({ exit_code: 127 })).toBe("did_not_run");
    expect(await outcomeLido({ exit_code: null })).toBe("did_not_run");
  });

  it("`outcome` gravado no disco vence a derivação — o produtor observou o que o exit code não carrega", async () => {
    expect(await outcomeLido({ exit_code: 1, outcome: "did_not_run" })).toBe("did_not_run");
  });
});
