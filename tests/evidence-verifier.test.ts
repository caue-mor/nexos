/**
 * Evidence Runtime v1 + Independent Verifier v1.
 *
 *   AGENT SAID TESTS PASS != SYSTEM OBSERVED TESTS PASS
 *   BUILDER != VERIFIER
 *   COMMAND OUTPUT != COMMAND SUCCESS
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { runEvidencedCommand, verifyFromEvidence, loadEvidence, redigir } from "../src/lib/evidence.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "ev-"));
});
afterEach(async () => {
  await fs.remove(root);
});

describe("Evidence · observação do sistema", () => {
  it("registra exit 0 como observed_pass", async () => {
    const e = await runEvidencedCommand(root, "ok", "node", ["-e", "process.exit(0)"]);
    expect(e.exit_code).toBe(0);
    expect(e.observed_pass).toBe(true);
    expect(e.gate).toBe("ok");
  });

  /**
   * O caso que define o módulo: o comando IMPRIME sucesso e SAI 1.
   * Quem lê texto conclui que passou; quem lê exit code vê a falha.
   */
  it("output que diz sucesso mas sai 1 NÃO é observed_pass", async () => {
    const e = await runEvidencedCommand(root, "mentiroso", "node", [
      "-e",
      "console.log('All tests passed! 0 errors'); process.exit(1)",
    ]);
    expect(e.stdout_tail).toContain("All tests passed");
    expect(e.exit_code).toBe(1);
    expect(e.observed_pass).toBe(false);
  });

  it("comando inexistente vira exit null, não sucesso", async () => {
    const e = await runEvidencedCommand(root, "fantasma", "comando-que-nao-existe-xyz", []);
    expect(e.observed_pass).toBe(false);
    expect(e.exit_code).toBeNull();
  });

  it("persiste em .nexos/.local/ — operacional, fora do Store canônico", async () => {
    await runEvidencedCommand(root, "ok", "node", ["-e", ""]);
    const dir = path.join(root, ".nexos", ".local", "evidence");
    expect(await fs.pathExists(dir)).toBe(true);
    expect(await fs.pathExists(path.join(root, ".nexos", "records"))).toBe(false);
    const [e] = await loadEvidence(root);
    expect(e!.id.startsWith("ev_")).toBe(true);
  });

  it("SECRETS NEVER ENTER ARTIFACTS", async () => {
    const e = await runEvidencedCommand(root, "vaza", "node", [
      "-e",
      "console.log('token sk-ABCDEFGH12345678 e postgres://u:p@h/db')",
    ]);
    expect(e.stdout_tail).not.toContain("sk-ABCDEFGH12345678");
    expect(e.stdout_tail).toContain("[REDACTED]");
    expect(redigir("Bearer abcdefghijklmnop")).toContain("[REDACTED]");
  });

  /**
   * Regressão do teto de 4000 bytes: em `test:all` (vitest run && pytest -v)
   * o resumo do vitest sai bem ANTES do fim do stdout — o restante do pytest
   * empurra a cauda antiga para fora. Medido no record real
   * `ev_01M2DD7VJYXNEXDPS3KH1NZQQG`: 20212 bytes de pytest depois do resumo.
   * Aqui simulamos com saída > teto antigo (4000) para provar que o resumo
   * sobrevive com o novo `TAIL_BYTES`.
   */
  it("resumo seguido de saída > teto antigo continua na cauda", async () => {
    const resumo = "RESUMO: 4267 passed | 8 skipped | 6 todo";
    const resto = "x".repeat(6000);
    const e = await runEvidencedCommand(root, "grande", "node", [
      "-e",
      `console.log(${JSON.stringify(resumo)}); process.stdout.write(${JSON.stringify(resto)})`,
    ]);
    expect(e.stdout_bytes).toBeGreaterThan(6000);
    expect(e.stdout_tail).toContain(resumo);
  });

  it("captura o commit quando há repo", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: root });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
    execFileSync("git", ["config", "user.name", "t"], { cwd: root });
    await fs.writeFile(path.join(root, "a.txt"), "x");
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-qm", "c1"], { cwd: root });

    const e = await runEvidencedCommand(root, "ok", "node", ["-e", ""]);
    const head = execFileSync("git", ["rev-parse", "HEAD"], { cwd: root }).toString().trim();
    expect(e.commit).toBe(head);
  });
});

describe("Verifier · independente, consome evidência", () => {
  it("gate sem evidência NÃO passa — ausência não é aprovação", async () => {
    const v = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"] });
    expect(v.pass).toBe(false);
    expect(v.findings[0]!.detail).toContain("não foi observado rodar");
  });

  it("aprova só quando o sistema observou exit 0", async () => {
    await runEvidencedCommand(root, "test", "node", ["-e", "process.exit(0)"]);
    const v = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"] });
    expect(v.pass).toBe(true);
  });

  it("reprova quando a evidência mostra falha", async () => {
    await runEvidencedCommand(root, "test", "node", ["-e", "process.exit(2)"]);
    const v = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"] });
    expect(v.pass).toBe(false);
    expect(v.findings[0]!.detail).toContain("exit 2");
  });

  /** Verde antigo não absolve falha nova. */
  it("a execução mais recente manda", async () => {
    await runEvidencedCommand(root, "test", "node", ["-e", "process.exit(0)"]);
    await new Promise((r) => setTimeout(r, 5));
    await runEvidencedCommand(root, "test", "node", ["-e", "process.exit(1)"]);
    const v = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"] });
    expect(v.pass).toBe(false);
  });

  it("evidência de outro commit não vale para este", async () => {
    await runEvidencedCommand(root, "test", "node", ["-e", "process.exit(0)"]);
    const v = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: ["test"],
      commit: "0000000000000000000000000000000000000000",
    });
    expect(v.pass).toBe(false);
    expect(v.findings[0]!.detail).toContain("outro commit");
  });

  it("exige TODOS os gates pedidos", async () => {
    await runEvidencedCommand(root, "typecheck", "node", ["-e", "process.exit(0)"]);
    const v = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: ["typecheck", "build", "test"],
    });
    expect(v.pass).toBe(false);
    expect(v.findings.filter((f) => f.ok)).toHaveLength(1);
  });
});

describe("Verifier · binding estrutural da execução", () => {
  it("aceita somente gate, comando, args, cwd, subject e frescor exatos", async () => {
    const subjectRef = "chk_STRICTBINDING01";
    const record = await runEvidencedCommand(
      root,
      "test",
      process.execPath,
      ["-e", "process.exit(0)"],
      subjectRef
    );
    const requirement = {
      gate: "test",
      command: process.execPath,
      args: ["-e", "process.exit(0)"],
      cwd: root,
      subjectRef,
      maxAgeMs: 60_000,
    } as const;
    const pass = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: [requirement],
      now: new Date(record.finished_at),
    });
    expect(pass.pass).toBe(true);

    const counterfactuals = [
      { ...requirement, command: "/bin/true" },
      { ...requirement, args: ["-e", "process.exit(1)"] },
      { ...requirement, cwd: path.join(root, "other") },
      { ...requirement, subjectRef: "chk_WRONGSUBJECT01" },
    ];
    for (const wrong of counterfactuals) {
      const verdict = await verifyFromEvidence({
        projectRoot: root,
        requiredGates: [wrong],
        now: new Date(record.finished_at),
      });
      expect(verdict.pass).toBe(false);
    }
  });

  it("rejeita evidência velha e timestamp futuro", async () => {
    const record = await runEvidencedCommand(root, "test", process.execPath, ["-e", ""]);
    const requirement = {
      gate: "test",
      command: process.execPath,
      args: ["-e", ""],
      cwd: root,
      maxAgeMs: 1_000,
    } as const;
    const old = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: [requirement],
      now: new Date(new Date(record.finished_at).getTime() + 1_001),
    });
    expect(old.pass).toBe(false);
    expect(old.findings[0]?.detail).toContain("expirada");

    const future = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: [requirement],
      now: new Date(new Date(record.finished_at).getTime() - 5_001),
    });
    expect(future.pass).toBe(false);
    expect(future.findings[0]?.detail).toContain("futuro");
  });
});

describe("Verifier · tree_state — árvore suja não prova o commit que declara", () => {
  const COMMIT = "a".repeat(40);

  /**
   * `runEvidencedCommand` calcula `tree_state` de verdade a partir do git.
   * Aqui o teste precisa CONTROLAR o valor gravado — grava o EvidenceRecord
   * cru, no mesmo formato que `persistObservation` escreveria, sem passar
   * pelo git.
   */
  function registro(treeState: "clean" | "dirty" | undefined): Record<string, unknown> {
    const base: Record<string, unknown> = {
      id: "ev_TREESTATE0001",
      kind: "command_observation",
      gate: "test",
      command: "node",
      args: [],
      cwd: root,
      started_at: new Date().toISOString(),
      finished_at: new Date().toISOString(),
      exit_code: 0,
      observed_pass: true,
      commit: COMMIT,
      stdout_tail: "",
      stderr_tail: "",
      stdout_bytes: 0,
      stderr_bytes: 0,
      producer: "nexos-evidence-v1",
    };
    if (treeState) base.tree_state = treeState;
    return base;
  }

  async function gravar(treeState: "clean" | "dirty" | undefined): Promise<void> {
    const dir = path.join(root, ".nexos", ".local", "evidence");
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, "ev_TREESTATE0001.json"),
      JSON.stringify(registro(treeState), null, 2),
      "utf-8"
    );
  }

  it("PRECONDITION → RED → RESTORE → GREEN: só clean prova o commit", async () => {
    // PRECONDITION: árvore limpa — o record prova o commit que declara.
    await gravar("clean");
    const limpo = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"], commit: COMMIT });
    expect(limpo.pass).toBe(true);

    // RED: MESMO record, árvore suja — deixa de provar, mesmo com observed_pass=true.
    await gravar("dirty");
    const sujo = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"], commit: COMMIT });
    expect(sujo.pass).toBe(false);
    expect(sujo.findings[0]!.detail).toContain("árvore suja");

    // RESTORE: volta a clean — prova de novo. Confirma que o guard reage ao dado, não a um fixture travado.
    await gravar("clean");
    const restaurado = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"], commit: COMMIT });
    expect(restaurado.pass).toBe(true);

    // GREEN adicional: legado sem o campo falha como unknown — ausência nunca é lida como clean.
    await gravar(undefined);
    const legado = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"], commit: COMMIT });
    expect(legado.pass).toBe(false);
    expect(legado.findings[0]!.detail).toContain("legado");
  });

  it("sem req.commit, tree_state não bloqueia — não há commit específico a provar", async () => {
    await gravar("dirty");
    const v = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"] });
    expect(v.pass).toBe(true);
  });
});

/**
 * Cenário reproduzido por um verificador adversarial independente: um record
 * VÁLIDO antigo com `observed_pass: true`, e um record MAIS NOVO — mesmo
 * gate, mesmo commit — cujo `exit_code` está malformado (string, não
 * number). `loadEvidence` derrubava o segundo em silêncio (`catch` vazio),
 * e "a mais recente manda" elegia o PASS antigo como veredito, mesmo a
 * execução de verdade tendo sido a mais nova — cujo resultado real nunca
 * chegou a ser lido.
 *
 * PRECONDITION → RED → RESTORE → GREEN, no mesmo formato do describe acima:
 * prova que o guard reage ao DADO (aparece e desaparece quando o arquivo
 * corrompido aparece e desaparece), não a um fixture travado.
 */
describe("Verifier · record corrompido mais recente NÃO é absolvido por um PASS mais antigo", () => {
  const COMMIT = "b".repeat(40);
  const evidenceDir = () => path.join(root, ".nexos", ".local", "evidence");

  async function gravarValido(id: string, finishedAt: string): Promise<void> {
    const dir = evidenceDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(
        {
          id,
          kind: "command_observation",
          gate: "test",
          command: "npm",
          args: ["run", "test"],
          cwd: root,
          started_at: finishedAt,
          finished_at: finishedAt,
          exit_code: 0,
          observed_pass: true,
          commit: COMMIT,
          tree_state: "clean",
          stdout_tail: "",
          stderr_tail: "",
          stdout_bytes: 0,
          stderr_bytes: 0,
          producer: "nexos-evidence-v1",
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  /** Mesmo gate+commit do record válido, `exit_code` malformado (string). */
  async function gravarMalformado(id: string, finishedAt: string): Promise<void> {
    const dir = evidenceDir();
    await fs.mkdir(dir, { recursive: true });
    await fs.writeFile(
      path.join(dir, `${id}.json`),
      JSON.stringify(
        {
          id,
          kind: "command_observation",
          gate: "test",
          command: "npm",
          args: ["run", "test"],
          cwd: root,
          started_at: finishedAt,
          finished_at: finishedAt,
          exit_code: "1", // malformado de propósito: schema exige number|null
          observed_pass: false,
          commit: COMMIT,
          tree_state: "clean",
          stdout_tail: "",
          stderr_tail: "",
          stdout_bytes: 0,
          stderr_bytes: 0,
          producer: "nexos-evidence-v1",
        },
        null,
        2
      ),
      "utf-8"
    );
  }

  it("PRECONDITION → RED → RESTORE → GREEN: corrupção mais recente derruba o PASS antigo, não o absolve", async () => {
    // PRECONDITION: só o record antigo válido — passa normalmente.
    await gravarValido("ev_OLDPASS0001", "2026-08-01T00:00:00.000Z");
    const precondition = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: ["test"],
      commit: COMMIT,
    });
    expect(precondition.pass).toBe(true);

    // RED: chega um record MAIS NOVO, mesmo gate+commit, malformado.
    // Reproduz literalmente o `records loaded: 1 [{ id: 'ev_OLDPASS0001', ... }]`
    // do verificador — sem o fix, o malformado some em silêncio e o antigo
    // vence sozinho.
    await gravarMalformado("ev_NEWBAD00001", "2026-08-02T00:00:00.000Z");
    const red = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: ["test"],
      commit: COMMIT,
    });
    expect(red.pass).toBe(false);
    expect(red.findings[0]!.detail).toContain("corrompida");
    expect(red.findings[0]!.detail).toContain("ev_NEWBAD00001");

    // RESTORE: o record mais novo é substituído por um válido (a corrupção
    // se resolveu) — volta a passar. Prova reação ao dado, não trava vermelho.
    await gravarValido("ev_NEWBAD00001", "2026-08-02T00:00:00.000Z");
    const restaurado = await verifyFromEvidence({
      projectRoot: root,
      requiredGates: ["test"],
      commit: COMMIT,
    });
    expect(restaurado.pass).toBe(true);
  });

  it("corrupção de OUTRO gate não derruba este — o refuse é por gate+commit, não global", async () => {
    await gravarValido("ev_OLDPASS0002", "2026-08-01T00:00:00.000Z");
    const dir = evidenceDir();
    await fs.mkdir(dir, { recursive: true });
    // Corrupto, mas de um gate diferente ("build") — não deve afetar "test".
    await fs.writeFile(
      path.join(dir, "ev_OTHERGATE01.json"),
      JSON.stringify({
        id: "ev_OTHERGATE01",
        kind: "command_observation",
        gate: "build",
        command: "npm",
        args: ["run", "build"],
        cwd: root,
        started_at: "2026-08-02T00:00:00.000Z",
        finished_at: "2026-08-02T00:00:00.000Z",
        exit_code: "0",
        observed_pass: false,
        commit: COMMIT,
        tree_state: "clean",
        stdout_tail: "",
        stderr_tail: "",
        stdout_bytes: 0,
        stderr_bytes: 0,
        producer: "nexos-evidence-v1",
      }),
      "utf-8"
    );
    const v = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"], commit: COMMIT });
    expect(v.pass).toBe(true);
  });
});
