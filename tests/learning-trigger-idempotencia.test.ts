/**
 * Reprocessar o mesmo SUCCEEDED não pode duplicar candidato.
 *
 *   REPLAY != NOVIDADE
 *
 * O gatilho roda em toda transição para SUCCEEDED. Um `--state SUCCEEDED`
 * repetido, um replay de cadeia ou um operador que reexecuta o comando não
 * podem encher o Store com o mesmo fato. A idempotência sai do `dedupeCandidate`
 * que já existe — não de um registro de controle "já processei este
 * checkpoint", que seria um segundo pipeline para um problema que o funil já
 * resolve.
 *
 * Teste de INTEGRAÇÃO, não unitário: monta um projeto real com Evidence
 * red→green cross-commit em disco e chama o gatilho duas vezes.
 */
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { proporAoConcluir } from "../src/lib/learning-trigger.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";

const TMP = fs.realpathSync(os.tmpdir());
let proj: string;
let projectId: string;

const SUBJECT = "chk_SUBJECTDOTESTE0000000000";

async function gravarEvidence(gate: string, pass: boolean, commit: string, quando: string): Promise<void> {
  const dir = path.join(proj, ".nexos", ".local", "evidence");
  await fs.ensureDir(dir);
  const id = `ev_${gate}_${commit}`;
  await fs.writeJson(path.join(dir, `${id}.json`), {
    id,
    kind: "command_observation",
    gate,
    observed_pass: pass,
    commit,
    subject_ref: SUBJECT,
    finished_at: quando,
    producer: "nexos-evidence-v1",
  });
}

beforeAll(async () => {
  proj = await fs.mkdtemp(path.join(TMP, "learn-idem-"));
  execFileSync("git", ["init", "-q", "."], { cwd: proj });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: proj });
  execFileSync("git", ["config", "user.name", "t"], { cwd: proj });
  await fs.writeFile(path.join(proj, "README.md"), "# idem\n");
  execFileSync("git", ["add", "-A"], { cwd: proj });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: proj });
  const cap = await initializeCapsule(proj, { projectName: "learn-idem" });
  projectId = cap.projectId;
  /** O sinal: vermelho num commit, verde em OUTRO. */
  await gravarEvidence("test", false, "aaaaaaaa1111", "2026-09-18T10:00:00Z");
  await gravarEvidence("test", true, "bbbbbbbb2222", "2026-09-18T11:00:00Z");
});

afterAll(async () => {
  if (proj) await fs.remove(proj);
});

describe("learning-trigger · idempotência", () => {
  it("a PRIMEIRA execução propõe exatamente um candidato", async () => {
    const r = await proporAoConcluir(proj, "chk_PRIMEIRA", SUBJECT, "consertou o gate de teste", projectId);
    expect(r.candidatos, r.motivo).toHaveLength(1);
    expect(r.regra).toContain("vermelho");
  });

  it("a SEGUNDA execução do mesmo outcome NÃO duplica", async () => {
    const r = await proporAoConcluir(proj, "chk_SEGUNDA", SUBJECT, "consertou o gate de teste", projectId);
    expect(r.candidatos, "replay não pode criar candidato novo").toHaveLength(0);
    expect(r.motivo).toContain("já existe");
  });

  it("e o Store tem UM candidato ao fim, não dois", async () => {
    const leitura = await readCurrentRecords(proj);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const candidatos = leitura.records.filter(
      (r) => (r.record as unknown as { kind?: string }).kind === "memory_candidate"
    );
    expect(candidatos).toHaveLength(1);
  });

  /**
   * UM SINAL RELATADO != TODOS OS SINAIS OBSERVADOS. Com `lint` e `test`
   * virando verde no mesmo trabalho, a regra do candidato citava só o
   * primeiro e escondia o segundo — quem lesse a memória depois concluiria
   * que apenas um gate estivera quebrado.
   */
  it("a regra cita TODOS os gates que viraram verde, não só o primeiro", async () => {
    /**
     * Projeto PRÓPRIO: no projeto do teste anterior já existe um candidato, e
     * o dedupe — corretamente — reconheceria este como equivalente por
     * sobreposição de termos. Reusar o projeto mediria o dedupe, não a regra.
     */
    const outro = await fs.mkdtemp(path.join(TMP, "learn-multi-"));
    try {
      execFileSync("git", ["init", "-q", "."], { cwd: outro });
      execFileSync("git", ["config", "user.email", "t@t"], { cwd: outro });
      execFileSync("git", ["config", "user.name", "t"], { cwd: outro });
      await fs.writeFile(path.join(outro, "README.md"), "# multi\n");
      execFileSync("git", ["add", "-A"], { cwd: outro });
      execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: outro });
      const cap = await initializeCapsule(outro, { projectName: "learn-multi" });
      const dir = path.join(outro, ".nexos", ".local", "evidence");
      await fs.ensureDir(dir);
      for (const [gate, pass, commit, quando] of [
        ["lint", false, "cccccccc3333", "2026-09-18T12:00:00Z"],
        ["lint", true, "dddddddd4444", "2026-09-18T13:00:00Z"],
        ["build", false, "cccccccc3333", "2026-09-18T12:01:00Z"],
        ["build", true, "dddddddd4444", "2026-09-18T13:01:00Z"],
      ] as [string, boolean, string, string][]) {
        await fs.writeJson(path.join(dir, `ev_${gate}_${commit}.json`), {
          id: `ev_${gate}_${commit}`,
          gate,
          observed_pass: pass,
          commit,
          subject_ref: SUBJECT,
          finished_at: quando,
        });
      }
      const r = await proporAoConcluir(outro, "chk_MULTI", SUBJECT, "consertou dois gates", cap.projectId);
      expect(r.candidatos, r.motivo).toHaveLength(1);
      expect(r.regra).toContain("lint");
      expect(r.regra, "o segundo gate não pode sumir da regra").toContain("build");
    } finally {
      await fs.remove(outro);
    }
  });

  /**
   *   DOIS FATOS NA MESMA FRASE VIRAM UM FATO FALSO
   *
   * A primeira versão soldava o statement do checkpoint com os red→green como
   * se descrevessem o mesmo trabalho. Aconteceu em produção e foi promovido: o
   * statement falava de um bug SILENCIOSO (que nunca acendeu gate algum) e os
   * gates citados vinham de outro ciclo. A memória canônica passou a afirmar
   * que os gates pegaram o bug silencioso — o inverso da verdade.
   *
   * O fato tem de começar pelo que foi OBSERVADO; o statement entra rotulado
   * como contexto conferível, nunca como causa.
   */
  it("o fato começa pela transição observada e rotula o statement como contexto", async () => {
    const dir = path.join(proj, ".nexos", "records", "knowledge");
    const arquivos = await fs.readdir(dir);
    const textos = await Promise.all(arquivos.map((f) => fs.readFile(path.join(dir, f), "utf-8")));
    const candidato = textos.find((t) => t.includes("memory_candidate"));
    expect(candidato, "nenhum memory_candidate no disco").toBeDefined();
    const linhaDoFato = (candidato ?? "").split("\n").find((l) => l.trim().startsWith("fact:")) ?? "";
    expect(linhaDoFato, "o fato tem de ABRIR com a transição observada").toMatch(/fact:\s*"?gate /);
    expect(linhaDoFato, "o statement tem de vir ROTULADO, não soldado como causa").toContain("tarefa aberta como");
  });

  it("CANDIDATE != TRUTH — nada entrou em memória canônica sem humano", async () => {
    const leitura = await readCurrentRecords(proj);
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    const gotchas = leitura.records.filter(
      (r) => (r.record as unknown as { kind?: string }).kind === "gotcha"
    );
    expect(gotchas, "o gatilho propõe; promover é humano").toHaveLength(0);
  });
});
