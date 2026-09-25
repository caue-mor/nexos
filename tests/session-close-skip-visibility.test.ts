/**
 * `runSessionCloseAdapter` — o pulo INESPERADO precisa ser distinguível do
 * sucesso.
 *
 *   INDISTINGUISHABLE SUCCESS
 *
 * MEDIDO em 2026-09-19 por outra sessão: com e sem `CLAUDE_PROJECT_DIR`, o
 * comando saía `exit=0` e escrevia `0 bytes` nos DOIS casos. Fazer o trabalho
 * e não fazer produziam a mesma observação, e o `reason` — uma frase correta e
 * acionável — nunca chegava a lugar nenhum. Pulo silencioso já seria ruim;
 * pulo indistinguível de sucesso é pior, porque nenhum operador tinha como
 * notar a perda.
 *
 * O que este arquivo trava é a DISTINÇÃO, não o canal: `expected` separa o
 * pulo que é o comportamento certo (projeto sem Capsule, a maioria das
 * máquinas) do pulo que descreve ambiente de hook quebrado. Sem essa
 * separação, informar o primeiro poluiria stderr em todo projeto que não usa
 * NexOS — e foi por isso que a primeira versão não informava nada.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { runSessionCloseAdapter } from "../src/host/claude/session-close.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const TMP = fs.realpathSync(os.tmpdir());
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.remove(d);
});

async function projetoAdotado(): Promise<string> {
  const root = await fs.mkdtemp(path.join(TMP, "session-close-"));
  dirs.push(root);
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  await initializeCapsule(root, { projectName: "proj" });
  return root;
}

const ENTRADA = {
  hook_event_name: "SessionEnd",
  session_id: "11111111-2222-3333-4444-555555555555",
  reason: "other",
} as const;

describe("pulo inesperado é distinguível do sucesso", () => {
  it("sem CLAUDE_PROJECT_DIR: SKIPPED com expected=false e razão acionável", async () => {
    const r = await runSessionCloseAdapter({ ...ENTRADA }, {});
    expect(r.state).toBe("SKIPPED");
    if (r.state !== "SKIPPED") return;
    /** O número que prova: o chamador consegue separar este caso do sucesso. */
    expect(r.expected).toBe(false);
    expect(r.reason).toContain("CLAUDE_PROJECT_DIR");
  });

  it("session_id ausente também é pulo INESPERADO — hook sem correlação está quebrado", async () => {
    const r = await runSessionCloseAdapter(
      { hook_event_name: "SessionEnd", reason: "other" },
      { CLAUDE_PROJECT_DIR: "/qualquer" }
    );
    expect(r.state).toBe("SKIPPED");
    if (r.state !== "SKIPPED") return;
    expect(r.expected).toBe(false);
  });

  /**
   * CONTROLE NEGATIVO — sem ele, marcar tudo como `expected: false` passaria
   * nos dois testes acima e encheria de ruído o stderr de toda máquina que
   * não usa NexOS.
   */
  it("projeto sem Capsule: pulo ESPERADO, não fala", async () => {
    const vazio = await fs.mkdtemp(path.join(TMP, "session-close-sem-capsule-"));
    dirs.push(vazio);
    const r = await runSessionCloseAdapter({ ...ENTRADA }, { CLAUDE_PROJECT_DIR: vazio });
    expect(r.state).toBe("SKIPPED");
    if (r.state !== "SKIPPED") return;
    expect(r.expected).toBe(true);
  });

  /** CONTROLE POSITIVO: o caminho feliz continua fechando e publicando. */
  it("com Capsule canônica e env var: CLOSED, e o record de fechamento existe", async () => {
    const root = await projetoAdotado();
    const r = await runSessionCloseAdapter({ ...ENTRADA }, { CLAUDE_PROJECT_DIR: root });
    expect(r.state).toBe("CLOSED");

    const yamls = await fs.readdir(path.join(root, ".nexos/records/sessions"));
    expect(yamls.filter((f) => f.endsWith(".yaml"))).toHaveLength(1);
  });
});
