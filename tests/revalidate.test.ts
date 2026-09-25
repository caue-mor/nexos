/**
 * Revalidação — reconferir um fato que já teve prova.
 *
 *   EVIDENCE ANCHORED != EVIDENCE RE-RUN
 *
 * A disciplina de gravação está entre 79% e 93%: quase todo fato numerado
 * carrega a prova. Mesmo assim seis afirmações do Store envelheceram em
 * silêncio num único dia, todas com âncora correta para o instante em que
 * foram escritas. O gap nunca foi gravar — é reconferir.
 *
 * A allowlist é SEGURANÇA, não conveniência: o comando vem de um record, e
 * record é escrito por agente. Executar string gravada sem filtro transforma
 * erro de gravação em execução arbitrária. Por isso os controles negativos
 * aqui são mais numerosos que os positivos.
 */
import { describe, it, expect } from "vitest";
import { comandoPermitido, revalidarUm, revalidarTodos } from "../src/lib/capsule/revalidate.js";

describe("comandoPermitido — a allowlist de leitura pura", () => {
  it.each([
    "grep -c foo src/index.ts",
    "rg --count padrao",
    "find . -name '*.ts'",
    "wc -l arquivo",
    "ls .nexos/records",
    "git log --oneline -1",
    "git status --porcelain",
    "node dist/index.js capabilities --json",
    "npm run typecheck",
  ])("permite leitura pura: %s", (cmd) => {
    expect(comandoPermitido(cmd)).toBe(true);
  });

  /**
   * CONTROLE NEGATIVO — cada um destes começaria com verbo permitido ou
   * pareceria inofensivo. `>` depois de um `grep` legítimo é o caso que uma
   * allowlist ingênua deixa passar: o comando CASA a lista e escreve mesmo
   * assim. Por isso a barreira de sintaxe roda ANTES da allowlist.
   */
  it.each([
    ["escrita por redirect", "grep foo x > saida.txt"],
    ["append por redirect", "cat a >> b"],
    ["encadeia destrutivo", "grep foo x && rm y"],
    ["substituição de comando", "grep $(whoami) x"],
    ["crase", "ls `pwd`"],
    ["remoção", "rm -rf /"],
    ["move", "mv a b"],
    ["rede", "curl http://exemplo"],
    ["instala", "npm install pacote"],
    ["git que ESCREVE", "git checkout main"],
    ["git que escreve 2", "git commit -m x"],
    ["vazio", "   "],
    ["verbo fora da lista", "python3 script.py"],
  ])("recusa %s", (_rotulo, cmd) => {
    expect(comandoPermitido(cmd)).toBe(false);
  });

  /** `git log` entra e `git checkout` não: a lista é por SUBCOMANDO, não por binário. */
  it("git é permitido por subcomando, nunca por binário", () => {
    expect(comandoPermitido("git diff")).toBe(true);
    expect(comandoPermitido("git reset --hard")).toBe(false);
    expect(comandoPermitido("git push")).toBe(false);
  });
});

describe("revalidarUm — os cinco estados", () => {
  it("CONFIRMED quando a saída contém o esperado", async () => {
    const r = await revalidarUm({ recordId: "r", command: "ls package.json", expect: "package.json" }, process.cwd());
    expect(r.state).toBe("CONFIRMED");
  });

  /**
   * DIVERGED é o resultado ÚTIL — quem roda revalidação quer achar o que
   * envelheceu. Um sistema que só sabe dizer CONFIRMED não serve para nada.
   */
  it("DIVERGED quando a saída não contém o esperado", async () => {
    const r = await revalidarUm(
      { recordId: "r", command: "ls package.json", expect: "esse-texto-nao-existe" },
      process.cwd()
    );
    expect(r.state).toBe("DIVERGED");
    expect(r.detail).toContain("envelheceu");
  });

  it("REFUSED nunca executa — e é resultado, não falha silenciosa", async () => {
    const r = await revalidarUm({ recordId: "r", command: "rm -rf /tmp/qualquer" }, process.cwd());
    expect(r.state).toBe("REFUSED");
    expect(r.durationMs).toBe(0);
  });

  it("FAILED quando o comando sai com código != 0", async () => {
    const r = await revalidarUm({ recordId: "r", command: "grep -c zzz-inexistente package.json" }, process.cwd());
    expect(r.state).toBe("FAILED");
  });

  /** Sem `expect`, exit 0 basta: serve de guarda, não de medição de número. */
  it("sem esperado declarado, exit 0 confirma — e o detalhe diz isso", async () => {
    const r = await revalidarUm({ recordId: "r", command: "ls package.json" }, process.cwd());
    expect(r.state).toBe("CONFIRMED");
    expect(r.detail).toContain("nenhum esperado");
  });
});

describe("revalidarTodos — ordenação por utilidade", () => {
  it("DIVERGED primeiro, CONFIRMED por último", async () => {
    const r = await revalidarTodos(
      [
        { recordId: "c", command: "ls package.json" },
        { recordId: "d", command: "ls package.json", expect: "nao-existe-isso" },
        { recordId: "x", command: "rm -rf /" },
      ],
      process.cwd()
    );
    expect(r.map((x) => x.state)).toEqual(["DIVERGED", "REFUSED", "CONFIRMED"]);
  });
});
