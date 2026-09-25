/**
 * `nexos memory --review` enriquecido (18/09, fila de decisão do dono) —
 * cluster por assunto, sugestão de supersede, evidence linking e scoring
 * explicável. Nada disso promove: o gate de tty (`promover`) não é tocado
 * aqui, nem pelo código, nem pelos testes.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { memory, clusterizarDuplicatas, pontuarCandidato, sugerirSupersede } from "../src/commands/memory.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { buildMemoryCandidate, type ProposedKind } from "../src/lib/capsule/memory-candidate.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;
let projectId: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "memreview-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  const init = await initializeCapsule(root, { projectName: "proj" });
  projectId = init.projectId;
});

afterEach(async () => {
  await fs.remove(root);
});

function daysAgoIso(n: number): string {
  return new Date(Date.now() - n * 86_400_000 - 1000).toISOString();
}

async function publicarCandidato(params: {
  fact: string;
  evidence: string;
  originNote?: string;
  daysAgo: number;
  proposedKind?: ProposedKind;
}): Promise<string> {
  const id = newRecordId("KnowledgeRecord");
  const record = buildMemoryCandidate({
    projectId,
    fact: params.fact,
    originNote: params.originNote ?? "teste",
    evidence: params.evidence,
    proposedKind: params.proposedKind ?? "gotcha",
    recordId: id,
    observedAt: daysAgoIso(params.daysAgo),
  });
  await publishCanonical(root, record);
  return id;
}

interface FilaItemJsonTest {
  id: string;
  days: number | null;
  fact: string;
  evidenceCommandExists: boolean;
  evidenceFileRefExists: boolean;
  clusterId: number;
  score: number;
  scoreReason: string;
  whyItMatters: string;
}
interface ReviewJson {
  queue: FilaItemJsonTest[];
  clusters: { id: number; memberIds: string[]; size: number }[];
  supersedeSuggestions: { newer: string; older: string; reason: string }[];
  stats: { total: number; oldestDays: number; withEvidence: number; withCommandEvidence: number };
}

async function reviewJson(): Promise<ReviewJson> {
  const spy = vi.spyOn(console, "log").mockImplementation(() => {});
  await memory({ cwd: root, review: true, json: true });
  const printed = String(spy.mock.calls[0]?.[0] ?? "");
  spy.mockRestore();
  return JSON.parse(printed) as ReviewJson;
}

describe("clusterizarDuplicatas (unidade)", () => {
  it("agrupa transitivamente — A~B e B~C viram um cluster de 3 mesmo que A~C sozinho não bata o corte", () => {
    const clusters = clusterizarDuplicatas(
      [{ id: "a" }, { id: "b" }, { id: "c" }, { id: "d" }],
      [
        [{ id: "a" }, { id: "b" }, 0.7],
        [{ id: "b" }, { id: "c" }, 0.65],
      ]
    );
    const comABC = clusters.find((c) => c.members.includes("a"));
    expect([...(comABC?.members ?? [])].sort()).toEqual(["a", "b", "c"]);
    expect(clusters.find((c) => c.members.includes("d"))?.members).toEqual(["d"]);
  });

  it("todo candidato pertence a exatamente um cluster — sem par nenhum, cluster de 1", () => {
    const clusters = clusterizarDuplicatas([{ id: "x" }, { id: "y" }], []);
    expect(clusters).toHaveLength(2);
    expect(clusters.every((c) => c.members.length === 1)).toBe(true);
  });
});

describe("pontuarCandidato (unidade) — nota explicável, nunca opinião sem razão", () => {
  it("soma os três sinais e nomeia cada um na razão", () => {
    expect(pontuarCandidato(false, false, false)).toEqual({ score: 0, reason: "sem evidência (+0) = 0" });
    const cheio = pontuarCandidato(true, true, true);
    expect(cheio.score).toBe(5);
    expect(cheio.reason).toContain("evidência presente (+2)");
    expect(cheio.reason).toContain("forma de comando (+1)");
    expect(cheio.reason).toContain("verificado no projeto (+2)");
  });
});

describe("sugerirSupersede (unidade) — CONTROLE NEGATIVO de ambiguidade", () => {
  it("mais recente E mais completo → sugere", () => {
    const s = sugerirSupersede([
      { id: "novo", dias: 1, completeness: 3 },
      { id: "velho", dias: 10, completeness: 1 },
    ]);
    expect(s).toHaveLength(1);
    expect(s[0]?.newer).toBe("novo");
    expect(s[0]?.older).toBe("velho");
  });

  it("mais recente mas MENOS completo → nada (não domina os dois eixos)", () => {
    const s = sugerirSupersede([
      { id: "a", dias: 1, completeness: 1 },
      { id: "b", dias: 10, completeness: 3 },
    ]);
    expect(s).toEqual([]);
  });

  it("empate de completeness → nada (ambiguidade não vira palpite)", () => {
    const s = sugerirSupersede([
      { id: "a", dias: 1, completeness: 2 },
      { id: "b", dias: 10, completeness: 2 },
    ]);
    expect(s).toEqual([]);
  });
});

describe("nexos memory --review --json — integração real, contrato de campos sempre presentes", () => {
  it("CONTROLE — nenhum candidato: clusters e supersedeSuggestions saem [], nunca omitidos", async () => {
    const out = await reviewJson();
    expect(out).toEqual({
      queue: [],
      clusters: [],
      supersedeSuggestions: [],
      stats: { total: 0, oldestDays: 0, withEvidence: 0, withCommandEvidence: 0 },
    });
  });

  it("cluster real por sobreposição de fato (limiar de TEMA, não de duplicata) + sugestão de supersede", async () => {
    // originNote distinto em cada um — só o sinal de TEXTO deve unir 1 e 2 aqui;
    // o sinal de origem tem teste próprio logo abaixo.
    const velhoId = await publicarCandidato({
      fact: "o installer preserva componente aposentado como customizacao do usuario",
      evidence: "observei o comportamento manualmente",
      originNote: "origem A",
      daysAgo: 10,
    });
    const novoId = await publicarCandidato({
      fact: "installer preserva componente aposentado tratando como customizacao usuario",
      evidence: "npm run typecheck confirma",
      originNote: "origem B",
      daysAgo: 1,
    });
    await publicarCandidato({
      fact: "grafo do mapa nao lista nos isolados porque deriva tudo das arestas",
      evidence: "observei o comportamento manualmente",
      originNote: "origem C",
      daysAgo: 5,
    });

    const out = await reviewJson();
    expect(out.clusters).toHaveLength(2);
    const clusterDuplo = out.clusters.find((c) => c.size === 2);
    expect(clusterDuplo?.memberIds.sort()).toEqual([novoId, velhoId].sort());

    expect(out.supersedeSuggestions).toHaveLength(1);
    expect(out.supersedeSuggestions[0]).toMatchObject({ newer: novoId, older: velhoId });
  });

  it("cluster POR ORIGEM — fatos sem relação nenhuma no texto, mas mesma origem específica, agrupam", async () => {
    const aId = await publicarCandidato({
      fact: "npm pack gera lixo de maquina no tarball publicado",
      evidence: "observei manualmente",
      originNote: "estudo de donor maestro 2026-09-11",
      daysAgo: 3,
    });
    const bId = await publicarCandidato({
      fact: "licenca do donor foi medida linha a linha, nao por badge",
      evidence: "observei manualmente",
      originNote: "estudo de donor maestro 2026-09-11",
      daysAgo: 2,
    });
    await publicarCandidato({
      fact: "candidato de outra investigacao qualquer, sem relacao com os dois acima",
      evidence: "observei manualmente",
      originNote: "outra investigacao completamente distinta",
      daysAgo: 1,
    });

    const out = await reviewJson();
    const clusterDuplo = out.clusters.find((c) => c.size === 2);
    expect(clusterDuplo?.memberIds.sort()).toEqual([aId, bId].sort());
  });

  it("CONTROLE NEGATIVO — origin_note SENTINELA ('declarado na linha de comando') nunca agrupa", async () => {
    // Mesmo valor de origem, mas é o DEFAULT do CLI quando --origin não é
    // passado — ausência disfarçada de string, nunca deveria virar cluster.
    await publicarCandidato({
      fact: "instalador preserva arquivo aposentado como customizacao local",
      evidence: "observei manualmente",
      originNote: "declarado na linha de comando",
      daysAgo: 3,
    });
    await publicarCandidato({
      fact: "grafico de dependencias ignora vertices sem aresta declarada",
      evidence: "observei manualmente",
      originNote: "declarado na linha de comando",
      daysAgo: 2,
    });

    const out = await reviewJson();
    expect(out.clusters.every((c) => c.size === 1)).toBe(true);
  });

  it("EVIDENCE LINKING — script de package.json existente vira evidenceCommandExists=true; inexistente fica false", async () => {
    await fs.writeJson(path.join(root, "package.json"), { name: "proj", scripts: { typecheck: "tsc" } });
    await publicarCandidato({ fact: "primeiro candidato do teste de comando", evidence: "npm run typecheck confirmou", daysAgo: 1 });
    await publicarCandidato({ fact: "segundo candidato totalmente distinto aqui", evidence: "npm run scriptquenaoexiste", daysAgo: 1 });

    const out = await reviewJson();
    const a = out.queue.find((q) => q.fact.startsWith("primeiro"));
    const b = out.queue.find((q) => q.fact.startsWith("segundo"));
    expect(a?.evidenceCommandExists).toBe(true);
    expect(b?.evidenceCommandExists).toBe(false);
  });

  it("EVIDENCE LINKING — arquivo:linha existente vira evidenceFileRefExists=true; inexistente fica false", async () => {
    await fs.writeFile(path.join(root, "real.ts"), "// x\n");
    await publicarCandidato({ fact: "primeiro candidato cita arquivo existente", evidence: "ver real.ts:1", daysAgo: 1 });
    await publicarCandidato({ fact: "segundo candidato cita arquivo fantasma", evidence: "ver fantasma.ts:99", daysAgo: 1 });

    const out = await reviewJson();
    const a = out.queue.find((q) => q.fact.startsWith("primeiro"));
    const b = out.queue.find((q) => q.fact.startsWith("segundo"));
    expect(a?.evidenceFileRefExists).toBe(true);
    expect(b?.evidenceFileRefExists).toBe(false);
  });

  it("score/scoreReason/whyItMatters sempre presentes, clusterId aponta para um cluster real", async () => {
    // Evidência não-vazia mas nem forma de comando nem verificável — schema
    // de MemoryCandidate exige evidence não-vazia (min(1)) mesmo pra teste;
    // `hasEvidence=false` já está coberto no unitário de `pontuarCandidato`.
    await publicarCandidato({
      fact: "candidato totalmente isolado sem par nenhum por aqui",
      evidence: "confirmei manualmente que o comportamento é esse",
      daysAgo: 3,
    });
    const out = await reviewJson();
    const item = out.queue[0]!;
    expect(item.score).toBe(2);
    expect(item.scoreReason).toBe("evidência presente (+2) = 2");
    expect(item.whyItMatters.length).toBeGreaterThan(0);
    const cluster = out.clusters[item.clusterId];
    expect(cluster?.memberIds).toContain(item.id);
  });
});
