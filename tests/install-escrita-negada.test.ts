/**
 * DIAGNÓSTICO DE ESCRITA NEGADA NO DESTINO.
 *
 *   ERRO LEGÍVEL != ERRO ÚTIL
 *
 * O caso real: `nexos install` numa sessão do Claude Code com sandbox ligado
 * morria em `EPERM: operation not permitted, mkdir ~/.claude/backups/...`, e
 * mais nada. A mensagem era verdadeira e inútil — não dizia de quem era o
 * bloqueio, nem que o NexOS não tem como levantá-lo, nem que a saída é o prompt
 * `!`. Este teste fixa as três coisas que o diagnóstico precisa dizer, e as
 * duas em que ele precisa ficar calado.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { diagnosticarEscritaNegada, install } from "../src/commands/install.js";
import { CLAUDE_DIR } from "../src/lib/constants.js";

/**
 * `FUNÇÃO TESTADA != FUNÇÃO CHAMADA PELO COMANDO`.
 *
 * Três vezes nesta base um teste verde acompanhou uma função que ninguém
 * chamava. O bloco no fim deste arquivo é o antídoto: força `safeInstall` a
 * estourar EPERM e confere que o TEXTO do diagnóstico sai no `console.error`
 * do comando real. Apagar a chamada no `catch` derruba esse teste.
 */
vi.mock("../src/lib/safe-install.js", () => ({
  safeInstall: vi.fn(() => {
    const e = new Error("EPERM: operation not permitted, mkdir") as NodeJS.ErrnoException;
    e.code = "EPERM";
    e.path = `${CLAUDE_DIR}/backups/pre-nexos-install`;
    throw e;
  }),
}));
vi.mock("../src/lib/detector.js", () => ({ detectClaudeCode: vi.fn(async () => true) }));

const DESTINO = "/home/alguem/.claude";

/** `errno` de verdade: `code` + `path`, como o Node entrega. */
function erroDeEscrita(code: string, path?: string): NodeJS.ErrnoException {
  const e = new Error(`${code}: operation not permitted, mkdir '${path ?? "?"}'`) as NodeJS.ErrnoException;
  e.code = code;
  if (path !== undefined) e.path = path;
  return e;
}

const original = process.env["CLAUDECODE"];
afterEach(() => {
  if (original === undefined) delete process.env["CLAUDECODE"];
  else process.env["CLAUDECODE"] = original;
});

describe("diagnosticarEscritaNegada", () => {
  it("cala a boca quando o erro não é de permissão — mensagem crua já é a certa", () => {
    const enoent = erroDeEscrita("ENOENT", `${DESTINO}/agents`);
    expect(diagnosticarEscritaNegada(enoent, DESTINO)).toBeNull();
    expect(diagnosticarEscritaNegada(new Error("qualquer outra coisa"), DESTINO)).toBeNull();
    expect(diagnosticarEscritaNegada(undefined, DESTINO)).toBeNull();
  });

  it("cala a boca quando o EPERM é FORA do destino — não é o nosso problema", () => {
    const fora = erroDeEscrita("EPERM", "/var/db/outro-lugar");
    expect(diagnosticarEscritaNegada(fora, DESTINO)).toBeNull();
  });

  it("dentro do Claude Code: nomeia o caminho, isenta o NexOS e dá a saída executável", () => {
    process.env["CLAUDECODE"] = "1";
    const texto = diagnosticarEscritaNegada(erroDeEscrita("EPERM", `${DESTINO}/backups/x`), DESTINO);
    expect(texto).not.toBeNull();
    expect(texto!).toContain(`${DESTINO}/backups/x`);
    expect(texto!).toContain("NÃO é permissão do NexOS");
    expect(texto!).toContain("! nexos install");
    // O ponto que custou três tentativas para descobrir precisa estar escrito.
    expect(texto!).toMatch(/allowWrite/);
    expect(texto!).toMatch(/excludedCommands/);
  });

  it("fora do Claude Code: não inventa sandbox, manda conferir dono e modo", () => {
    delete process.env["CLAUDECODE"];
    const texto = diagnosticarEscritaNegada(erroDeEscrita("EACCES", `${DESTINO}/agents/a.md`), DESTINO);
    expect(texto).not.toBeNull();
    expect(texto!).toContain("ls -ld");
    expect(texto!).not.toContain("! nexos install");
    expect(texto!).not.toMatch(/sandbox/i);
  });

  it("EACCES é tratado igual a EPERM — o sintoma muda com o SO, a causa não", () => {
    process.env["CLAUDECODE"] = "1";
    expect(diagnosticarEscritaNegada(erroDeEscrita("EACCES", `${DESTINO}/x`), DESTINO)).not.toBeNull();
  });

  it("erro sem `path` ainda diagnostica — o code basta, o caminho é opcional", () => {
    process.env["CLAUDECODE"] = "1";
    const texto = diagnosticarEscritaNegada(erroDeEscrita("EPERM"), DESTINO);
    expect(texto).not.toBeNull();
    expect(texto!).toContain("! nexos install");
  });
});

describe("o comando install REALMENTE imprime o diagnóstico", () => {
  it("EPERM vindo de safeInstall sai com a saída executável, não só com o errno", async () => {
    process.env["CLAUDECODE"] = "1";
    const escrito: string[] = [];
    const spy = vi.spyOn(console, "error").mockImplementation((...a: unknown[]) => {
      escrito.push(a.map(String).join(" "));
    });
    const exitAntes = process.exitCode;
    try {
      await install({ dryRun: false });
    } finally {
      spy.mockRestore();
      process.exitCode = exitAntes;
    }

    const tudo = escrito.join("\n");
    expect(tudo, "o errno cru precisa continuar aparecendo").toContain("EPERM");
    expect(tudo, "sem isto o usuário não sabe o que fazer").toContain("! nexos install");
    expect(tudo).toContain("NÃO é permissão do NexOS");
  });
});
