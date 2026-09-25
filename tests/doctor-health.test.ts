import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import { execFileSync } from "node:child_process";
import path from "node:path";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";
import {
  doctorExitCode,
  expectedAgentCount,
  medirStoreCanonico,
  medirTamperPosAdmissao,
} from "../src/commands/doctor.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-25T12:00:00.000Z";

let workspace: string;
let root: string;
let projectId: string;

beforeEach(async () => {
  workspace = await fs.mkdtemp(path.join(TMP, "doctor-truth-"));
  root = path.join(workspace, "project");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "doctor-truth" })).projectId;
});

afterEach(async () => {
  await fs.remove(workspace);
});

function knowledge(): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "agent",
    provenance: {
      source_ref: "nexos://doctor/conflicting-lineage",
      producer_id: "doctor-test",
      submitted_at: NOW,
    },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "policy:doctor-test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "test" },
    evidence_refs: ["test:doctor-truth"],
    created_at: NOW,
    version: 1,
    content: { title: "conflict", failure_mode: "dois heads sem supersessão" },
  } as CapsuleRecord;
}

describe("doctor truthfulness", () => {
  it("Store canônico estritamente legível passa", async () => {
    const check = await medirStoreCanonico(root);
    expect(check.status).toBe("pass");
    expect(check.code).toBe("CANONICAL_STORE_READABLE");
  });

  it("Store com lineage realmente divergente falha — nunca healthy", async () => {
    await publishCanonical(root, knowledge());
    await publishCanonical(root, knowledge());

    const check = await medirStoreCanonico(root);
    expect(check.status).toBe("fail");
    expect(check.code).toBe("CANONICAL_STORE_UNREADABLE");
    expect(check.message).toContain("DIVERGED");
    expect(doctorExitCode([check])).toBe(1);
  });

});

/**
 * O CHECK QUE NÃO EXISTIA — `scanForPostAdmissionTamper` era descrita no
 * comentário do permission gate como "a defesa real contra o conteúdo forjado"
 * e tinha ZERO call sites de produção: definição, teste unitário e dois
 * comentários. `nexos doctor` não a chamava; nenhum comando chamava.
 *
 *   UNIT TEST OF UNUSED FUNCTION != ENFORCEMENT
 *
 * Estes casos são a ligação: se alguém remover a chamada de `doctor()`, o
 * primeiro deles fica vermelho.
 */
describe("medirTamperPosAdmissao — a defesa que existia e ninguém chamava", () => {
  let gitRoot: string;

  const commitAll = (msg: string): void => {
    execFileSync("git", ["add", "-A"], { cwd: gitRoot });
    execFileSync("git", ["commit", "-q", "-m", msg], { cwd: gitRoot });
  };

  beforeEach(async () => {
    gitRoot = path.join(workspace, "git-project");
    await fs.ensureDir(gitRoot);
    execFileSync("git", ["init", "-q"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: gitRoot });
    execFileSync("git", ["config", "user.name", "t"], { cwd: gitRoot });
    await initializeCapsule(gitRoot, { projectName: "tamper-doctor" });
    commitAll("store inicial");
  });

  it("Store íntegro passa e conta os records medidos", async () => {
    const check = await medirTamperPosAdmissao(gitRoot);
    expect(check.status).toBe("pass");
    expect(check.code).toBe("STORE_TAMPER_CLEAN");
    expect(doctorExitCode([check])).toBe(0);
  });

  /**
   * O vetor que o permission gate não vê: `node -e "...writeFileSync()"` sobre
   * um record canônico é classificado como `read`. YAML válido passaria por
   * `medirStoreCanonico` sem um arranhão — só o witness git acusa.
   */
  it("record commitado reescrito fora do publishCanonical derruba o doctor", async () => {
    const p = forProject(gitRoot);
    const alvo = path.join(p.familyDir("KnowledgeRecord"), "knw_01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml");
    await fs.ensureDir(path.dirname(alvo));
    await fs.writeFile(alvo, "schema_version: 1\nid: knw_01ARZ3NDEKTSV4RRFFQ69G5FAV\n");
    commitAll("record admitido");

    await fs.writeFile(alvo, "schema_version: 1\nid: forjado\n");

    const check = await medirTamperPosAdmissao(gitRoot);
    expect(check.status).toBe("fail");
    expect(check.code).toBe("STORE_TAMPER_DETECTED");
    expect(check.message).toContain("knw_01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml");
    expect(doctorExitCode([check])).toBe(1);
  });

  /**
   * O vetor que o gate classifica como `read` E que o scanner não via: `rm`.
   * Medido antes do fix, em cópia do Store real — `git status` mostrando
   * ` D <path>` e o check saindo `pass` com `0 adulterações`. Duas defesas
   * falhando no MESMO comando.
   */
  it("record commitado APAGADO derruba o doctor, e a mensagem não o chama de adulterado", async () => {
    const p = forProject(gitRoot);
    const alvo = path.join(p.familyDir("KnowledgeRecord"), "knw_01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml");
    await fs.ensureDir(path.dirname(alvo));
    await fs.writeFile(alvo, "schema_version: 1\nid: knw_01ARZ3NDEKTSV4RRFFQ69G5FAV\n");
    commitAll("record admitido");

    await fs.remove(alvo);

    const check = await medirTamperPosAdmissao(gitRoot);
    expect(check.status).toBe("fail");
    expect(check.code).toBe("STORE_TAMPER_DETECTED");
    expect(check.message).toContain("APAGADO(s)");
    expect(check.message).toContain("knw_01ARZ3NDEKTSV4RRFFQ69G5FAV.yaml [DELETED]");
    expect(check.message).not.toContain("adulterado(s)");
    expect(doctorExitCode([check])).toBe(1);
  });

  /**
   * `INAPLICÁVEL != SAUDÁVEL`, mas também `INAPLICÁVEL != DEFEITO`: git é
   * transporte OPCIONAL (ADR-044) e reprovar o doctor de quem não usa git
   * trocaria uma defesa por um bloqueio. O motivo vai na mensagem, para que
   * "não medi" nunca se leia como "medi e está limpo".
   */
  /**
   * `FUNCTION TESTED != FUNCTION CALLED BY THE COMMAND` — a mesma doença um
   * nível acima, medida: com os três casos acima verdes, apagar a linha
   * `checks.push(await medirTamperPosAdmissao(...))` de `doctor()` deixava a
   * suíte INTEIRA verde (2164/2164). O check existia, era testado, e o comando
   * não o rodava — que é literalmente o defeito que este nó veio consertar.
   *
   * ponytail: asserção sobre o TEXTO do módulo, não sobre a execução de
   * `doctor()`. Teto: pega remoção e comentário da chamada, NÃO pegaria a
   * chamada movida para um ramo inalcançável. Upgrade path quando isso importar:
   * extrair a montagem da lista de checks de `doctor()` para uma função pura e
   * asseverar o array. Não vale hoje — `doctor()` lê o host inteiro e o teste
   * viraria um `nexos doctor` de 5 s dentro da suíte.
   */
  it("`doctor()` realmente empurra o check — remover a linha não pode ficar verde", async () => {
    const fonte = await fs.readFile(
      path.join(process.cwd(), "src", "commands", "doctor.ts"),
      "utf-8"
    );
    expect(fonte).toMatch(/checks\.push\(await medirTamperPosAdmissao\(/);
  });

  it("projeto fora de repositório git sai N/A com o motivo à mostra, não fail", async () => {
    const check = await medirTamperPosAdmissao(root);
    expect(check.status).toBe("pass");
    expect(check.code).toBe("STORE_TAMPER_NOT_APPLICABLE");
    expect(check.message).toContain("sem witness git");
    expect(doctorExitCode([check])).toBe(0);
  });
});

describe("doctor agent count — derivado dos assets, nunca fixo", () => {
  it("conta os .md em <assetsDir>/agents, ignorando arquivos que não são agente", async () => {
    const assetsDir = path.join(workspace, "assets");
    await fs.ensureDir(path.join(assetsDir, "agents"));
    await fs.writeFile(path.join(assetsDir, "agents", "a.md"), "");
    await fs.writeFile(path.join(assetsDir, "agents", "b.md"), "");
    await fs.writeFile(path.join(assetsDir, "agents", "README.txt"), "");

    expect(await expectedAgentCount(assetsDir)).toBe(2);
  });

  it("assets/agents ausente devolve 0, não lança", async () => {
    expect(await expectedAgentCount(path.join(workspace, "sem-assets"))).toBe(0);
  });

  it("regressão do defeito real: pacote com 5 agentes (devops removido) não é mais reprovado por um 6 fixo", async () => {
    const assetsDir = path.join(workspace, "assets-real");
    await fs.ensureDir(path.join(assetsDir, "agents"));
    for (const nome of ["nexos-master", "nexos-dev", "nexos-verifier", "nexos-architect", "nexos-analyst"]) {
      await fs.writeFile(path.join(assetsDir, "agents", `${nome}.md`), "");
    }

    const installedAgents = 5;
    const expected = await expectedAgentCount(assetsDir);
    expect(expected).toBe(5);
    // A mesma lógica de status que doctor() aplica ao check "Agents".
    const status = installedAgents >= expected ? "pass" : installedAgents > 0 ? "warn" : "fail";
    expect(status).toBe("pass");
  });
});
