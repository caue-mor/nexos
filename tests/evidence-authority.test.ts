/**
 * Evidência de gate (`ev_*`) resolve o MESMO root canônico que a authority
 * já resolve para o checkpoint (ADR-070-adj, `authority.ts`).
 *
 * MEDIDO: um verifier rodando de dentro de uma worktree persistia `ev_*` em
 * `<worktree>/.nexos/.local/evidence`, enquanto `advanceCheckpoint`
 * (`capsule/checkpoint.ts`) fechava o checkpoint no root CANÔNICO — duas
 * partições do mesmo projeto que nunca se enxergavam; `nexos doctor` via
 * `CHECKPOINT_EVIDENCE_MISSING` sobre um fechamento honesto.
 *
 * `nexosHome` é sempre passado por PARÂMETRO (mesmo contrato de
 * `capsule-authority.test.ts`) — nunca `process.env`. Nenhum teste aqui toca
 * o `~` real.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { newProjectId } from "../src/lib/capsule/ids.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { resolveActiveRoot } from "../src/lib/capsule/authority.js";
import {
  persistObservation,
  loadEvidence,
  loadEvidenceHere,
  EvidenceAuthorityRefusedError,
  type ObservationInput,
} from "../src/lib/evidence.js";
import { buildVerificationBasis } from "../src/lib/capsule/verification-basis.js";
import {
  resolveVerifiability,
  isTampered,
  descreverVerificabilidade,
} from "../src/lib/capsule/evidence-verifiability.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string;
let nexosHome: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "ev-authority-"));
  nexosHome = path.join(ws, "nexos-home");
  await fs.ensureDir(nexosHome);
});

afterEach(async () => {
  await fs.remove(ws);
});

async function makeRoot(dirName: string, projectId: string): Promise<string> {
  const root = path.join(ws, dirName);
  await fs.ensureDir(root);
  await initializeCapsule(root, { projectName: dirName, generateProjectId: () => projectId });
  return root;
}

function obs(cwd: string, overrides: Partial<ObservationInput> = {}): ObservationInput {
  return {
    gate: "typecheck",
    command: "npm",
    args: ["run", "typecheck"],
    cwd,
    started_at: "2026-09-11T00:00:00.000Z",
    finished_at: "2026-09-11T00:00:01.000Z",
    exit_code: 0,
    stdout: "",
    stderr: "",
    ...overrides,
  };
}

async function evidenceFiles(root: string): Promise<string[]> {
  return (await fs.readdir(path.join(forProject(root).localRoot(), "evidence")).catch(() => [])).sort();
}

describe("evidência de gate — fronteira única de authority", () => {
  it("persistir de dentro de um worktree (B) resolve para o root ativo (A) — nunca escreve em B", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);

    // A já é a authority ativa deste project_id — mesma coisa que
    // `advanceCheckpoint` faria ao fechar o checkpoint no canônico.
    const claim = await resolveActiveRoot(projectId, rootA, { nexosHome });
    expect(claim.outcome).toBe("CLAIMED");

    // Verifier roda de dentro do worktree B.
    const record = await persistObservation(rootB, obs(rootB), { nexosHome });

    expect(await evidenceFiles(rootB)).toEqual([]);
    expect(await evidenceFiles(rootA)).toEqual([`${record.id}.json`]);

    const viaA = await loadEvidence(rootA, { nexosHome });
    const viaB = await loadEvidence(rootB, { nexosHome });
    expect(viaA).toHaveLength(1);
    expect(viaB).toHaveLength(1);
    expect(viaA[0]?.id).toBe(record.id);
    expect(viaB[0]?.id).toBe(record.id);
  });

  it("candidato de OUTRO project_id nunca escreve na authority de outro projeto", async () => {
    const projectIdP = newProjectId();
    const rootA = await makeRoot("A", projectIdP);
    await resolveActiveRoot(projectIdP, rootA, { nexosHome });

    const projectIdQ = newProjectId();
    const rootC = await makeRoot("C", projectIdQ);

    const record = await persistObservation(rootC, obs(rootC), { nexosHome });

    expect(await evidenceFiles(rootA)).toEqual([]);
    expect(await evidenceFiles(rootC)).toEqual([`${record.id}.json`]);
  });

  it("authority precisando ser RECLAMADA → persistência recusa com erro nomeado, nada gravado", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    await resolveActiveRoot(projectId, rootA, { nexosHome });

    // A "desaparece" — mesmo cenário RECLAIMED de `capsule-authority.test.ts`
    // ("A desaparece do disco → publish de B reivindica B").
    await fs.remove(rootA);

    const rootB = await makeRoot("B", projectId);

    await expect(persistObservation(rootB, obs(rootB), { nexosHome })).rejects.toThrow(
      EvidenceAuthorityRefusedError
    );

    expect(await evidenceFiles(rootB)).toEqual([]);
  });

  // Cobertura de "evidência ausente continua FAIL" vive em
  // `tests/evidence-verifier.test.ts` ("gate sem evidência NÃO passa", ~L87) e `tests/doctor-project-isolation.test.ts:179` ("checkpoint SUCCEEDED sem evidência é omissão detectada").

  it("sem duplicação: depois de persistir de B, B continua sem arquivo próprio", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);
    await resolveActiveRoot(projectId, rootA, { nexosHome });

    await persistObservation(rootB, obs(rootB), { nexosHome });
    await persistObservation(rootB, obs(rootB, { gate: "lint" }), { nexosHome });

    expect(await evidenceFiles(rootB)).toEqual([]);
    expect(await evidenceFiles(rootA)).toHaveLength(2);
  });
});

/**
 * A outra pergunta, que a authority responde errado de propósito.
 *
 *     CLEAN ENVIRONMENT != CLEAN MACHINE
 *
 * Os testes acima travam `loadEvidence`: de dentro do worktree B, ela ENXERGA
 * a prova que vive em A, e isso está certo — foi o que consertou as duas
 * partições que faziam `CHECKPOINT_EVIDENCE_MISSING` sobre um fechamento
 * honesto.
 *
 * Mas o eixo `availability` pergunta outra coisa: a prova existe NESTE
 * ambiente? MEDIDO em 2026-09-20 num worktree real deste repositório, antes de
 * `loadEvidenceHere` existir: 112 bases AVAILABLE+MATCH, byte-idêntico ao
 * checkout principal, com `.nexos/.local/evidence` inexistente ali. O eixo
 * lia da MÁQUINA e respondia como se fosse do ambiente, o que tornava
 * `UNVERIFIABLE_HERE` inalcançável em toda máquina com o `project_id`
 * registrado — isto é, em toda máquina de quem desenvolve o projeto.
 *
 * Os dois testes abaixo existem juntos por isso: um sozinho não distingue
 * "escopo certo" de "acervo vazio". Ver
 * `nexos://decision/evidence-availability-por-ambiente`.
 */
describe("availability é do AMBIENTE, não da máquina", () => {
  it("no worktree, `loadEvidenceHere` não vê a prova que `loadEvidence` vê em A", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);
    await resolveActiveRoot(projectId, rootA, { nexosHome });

    const record = await persistObservation(rootB, obs(rootB), { nexosHome });
    expect(await evidenceFiles(rootB)).toEqual([]);

    /** Controle positivo: sem ele, `[]` abaixo poderia ser só acervo vazio. */
    const viaAuthority = await loadEvidence(rootB, { nexosHome });
    expect(viaAuthority.map((e) => e.id)).toEqual([record.id]);

    /** A pergunta do eixo 1: o corpo da prova está AQUI? Não está. */
    expect(await loadEvidenceHere(rootB, { nexosHome })).toEqual([]);

    /** E o ambiente que de fato guarda o corpo continua respondendo que sim. */
    expect((await loadEvidenceHere(rootA, { nexosHome })).map((e) => e.id)).toEqual([record.id]);
  });

  it("a base sobrevive ao ambiente sem a prova: UNVERIFIABLE_HERE com instrução, nunca VERIFIED", async () => {
    const projectId = newProjectId();
    const rootA = await makeRoot("A", projectId);
    const rootB = await makeRoot("B", projectId);
    await resolveActiveRoot(projectId, rootA, { nexosHome });

    const record = await persistObservation(rootB, obs(rootB), { nexosHome });
    const basis = buildVerificationBasis({
      evidence: record,
      verifierDetail: "typecheck: exit 0",
      observedFacts: { finished_at: record.finished_at },
    });

    const v = resolveVerifiability(basis, await loadEvidenceHere(rootB, { nexosHome }));

    expect(v.availability).toBe("MISSING");

    /**
     * `UNVERIFIABLE_HERE != FALSE != FAILED != DIVERGED`, e ausência NUNCA é
     * adulteração: não há corpo com que discordar do hash.
     */
    expect(v.claim).toBe("NOT_REVALIDATED");
    expect(isTampered(v)).toBe(false);
    expect(descreverVerificabilidade(v)).toContain("UNVERIFIABLE_HERE");

    /**
     * O record viajou inteiro: sem a prova local ele ainda diz COMO tentar.
     * `REPRODUCIBLE != REPRODUCED != VERIFIED` — por isso a instrução sai em
     * campo próprio, e o status jamais a lê como prova.
     */
    expect(v.reproducible).toBe(true);
    expect([basis.command, ...basis.args].join(" ")).toBe("npm run typecheck");
    expect(descreverVerificabilidade(v)).not.toContain("VERIFIED");

    /** O mesmo basis, no ambiente que tem o corpo, confere o hash e bate. */
    const noAmbienteCerto = resolveVerifiability(basis, await loadEvidenceHere(rootA, { nexosHome }));
    expect(noAmbienteCerto.availability).toBe("AVAILABLE");
    expect(noAmbienteCerto.integrity).toBe("MATCH");
    /** E nem assim vira verificado: `PROVA ÍNTEGRA != PROVA REEXECUTADA`. */
    expect(noAmbienteCerto.claim).toBe("NOT_REVALIDATED");
  });
});
