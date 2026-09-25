/**
 * C12.5 passo 1 — HeadResolver por source_ref.
 *
 * Os casos que uma implementação ingênua erra têm teste próprio:
 *
 *   RECENCY != AUTHORITY      successor com created_at MAIS VELHO ainda é head
 *   ZERO HEADS != ABSENT      ciclo é MALFORMED, nunca ausência
 *   CANNOT OBSERVE != DOES NOT EXIST   manifest ilegível é UNREADABLE, não ABSENT
 *   SUPERSESSION IS WITHIN A LINEAGE   aresta cruzando source_ref contamina ambos
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import { makeDecision } from "./capsule-fixtures.js";
import {
  resolveHeadsBySource,
  headFor,
  type HeadReport,
  type SourceHeadState,
} from "../src/lib/capsule/head-resolver.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string, projectId: string;

const SRC_A = ".nexos/memory/project/decisions.md#ADR-001";
const SRC_B = ".nexos/memory/project/decisions.md#ADR-002";

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "c125-head-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

interface PutOptions {
  id?: string;
  supersedes?: string;
  createdAt?: string;
}

/** Publica pelo caminho real do Store — que valida schema e admissão, não topologia. */
async function put(sourceRef: string, options: PutOptions = {}): Promise<string> {
  const id = options.id ?? newRecordId("Decision");
  const overrides: Record<string, unknown> = {
    id,
    project_id: projectId,
    provenance: {
      source_ref: sourceRef,
      producer_id: "c12-test",
      submitted_at: "2026-08-14T00:00:00.000Z",
    },
  };
  if (options.supersedes) overrides.supersedes = options.supersedes;
  if (options.createdAt) overrides.created_at = options.createdAt;
  await publishCanonical(root, makeDecision(overrides));
  return id;
}

/** Falha o teste com a causa à vista em vez de devolver `undefined` silencioso. */
function resolved(report: HeadReport): ReadonlyMap<string, SourceHeadState> {
  if (report.state !== "RESOLVED") {
    throw new Error(`esperava RESOLVED, veio UNREADABLE: ${JSON.stringify(report.issues)}`);
  }
  return report.bySource;
}

const resolve = async (): Promise<HeadReport> => resolveHeadsBySource(root, "Decision");

// ─── os três estados de uma partição ────────────────────────────────────────

describe("estados por source_ref", () => {
  it("ABSENT — nenhum record carrega este source_ref", async () => {
    await put(SRC_A);

    const bySource = resolved(await resolve());
    expect(headFor(bySource, SRC_B)).toEqual({ state: "ABSENT" });
  });

  it("ABSENT — stream inteiro vazio ainda RESOLVE (diretório ausente é ENOENT)", async () => {
    const report = await resolve();

    expect(report.state).toBe("RESOLVED");
    expect(headFor(resolved(report), SRC_A)).toEqual({ state: "ABSENT" });
  });

  it("CURRENT — um único record é o head", async () => {
    const id = await put(SRC_A);

    const head = headFor(resolved(await resolve()), SRC_A);
    expect(head.state).toBe("CURRENT");
    if (head.state === "CURRENT") expect(head.record.id).toBe(id);
  });

  it("DIVERGED — dois heads concorrentes sem relação, e NÃO desempata", async () => {
    const first = await put(SRC_A);
    const second = await put(SRC_A);

    const head = headFor(resolved(await resolve()), SRC_A);
    expect(head.state).toBe("DIVERGED");
    if (head.state === "DIVERGED") {
      expect(head.heads).toEqual([first, second].sort());
    }
  });
});

// ─── RECENCY != AUTHORITY ───────────────────────────────────────────────────

describe("supersessão resolve por TOPOLOGIA, nunca por relógio", () => {
  it("successor com created_at MAIS VELHO que o superado ainda é o head", async () => {
    const old = await put(SRC_A, { createdAt: "2026-08-14T23:59:00.000Z" });
    const successor = await put(SRC_A, {
      supersedes: old,
      createdAt: "2026-08-01T00:00:00.000Z",
    });

    const head = headFor(resolved(await resolve()), SRC_A);
    expect(head.state).toBe("CURRENT");
    if (head.state === "CURRENT") {
      /** Ordenar por created_at devolveria `old` — é exatamente o que não pode acontecer. */
      expect(head.record.id).toBe(successor);
    }
  });

  it("o record superado permanece no disco — PHYSICAL COUNT != LOGICAL CURRENT COUNT", async () => {
    const old = await put(SRC_A);
    await put(SRC_A, { supersedes: old });

    const files = await fs.readdir(forProject(root).familyDir("Decision"));
    expect(files.filter((f) => f.endsWith(".yaml"))).toHaveLength(2);

    const bySource = resolved(await resolve());
    expect(bySource.size).toBe(1);
  });

  it("cadeia de três resolve na ponta, com o relógio andando PARA TRÁS", async () => {
    /**
     * created_at decrescente de propósito: v3 é o head e o MAIS VELHO. Com
     * timestamps iguais este caso passa até num resolver "latest wins" — medido
     * no contrafactual. A inversão é o que lhe dá poder de discriminação.
     */
    const v1 = await put(SRC_A, { createdAt: "2026-08-14T03:00:00.000Z" });
    const v2 = await put(SRC_A, { supersedes: v1, createdAt: "2026-08-14T02:00:00.000Z" });
    const v3 = await put(SRC_A, { supersedes: v2, createdAt: "2026-08-14T01:00:00.000Z" });

    const head = headFor(resolved(await resolve()), SRC_A);
    if (head.state === "CURRENT") expect(head.record.id).toBe(v3);
    else throw new Error(`esperava CURRENT, veio ${head.state}`);
  });

  it("successor com ULID MENOR (lido primeiro do disco) ainda é o head", async () => {
    /**
     * Arquivos são `<id>.yaml` e `listYaml` ordena — então ULID menor é lido
     * ANTES. Aqui o successor é justamente o menor: nem ordem de filesystem nem
     * ordem de ULID podem decidir o head.
     */
    const [low, high] = [newRecordId("Decision"), newRecordId("Decision")].sort();
    if (!low || !high) throw new Error("fixture não gerou os dois ids");

    await put(SRC_A, { id: high });
    await put(SRC_A, { id: low, supersedes: high });

    const head = headFor(resolved(await resolve()), SRC_A);
    if (head.state !== "CURRENT") throw new Error(`esperava CURRENT, veio ${head.state}`);
    expect(head.record.id).toBe(low);
  });

  it("L10 — ordem de PUBLICAÇÃO invertida dá a mesma resolução semântica", async () => {
    /**
     * Mesmos ids lógicos, escritos em ordem oposta, em duas capsules. Compara a
     * tripla que define a resposta: status · head id · issue codes ordenados.
     * `FILESYSTEM ORDER != AUTHORITY`.
     */
    const v1 = newRecordId("Decision");
    const v2 = newRecordId("Decision");
    const solto = newRecordId("Decision");
    const quebrado = newRecordId("Decision");
    const alvoInexistente = newRecordId("Decision");

    /** (source, id, supersedes?) — o conjunto lógico, idêntico nas duas ordens. */
    const conjunto: Array<[string, string, string?]> = [
      [SRC_A, v1],
      [SRC_A, v2, v1],
      [SRC_B, solto],
      [SRC_B, quebrado, alvoInexistente],
    ];

    const montar = async (ordem: typeof conjunto): Promise<string> => {
      const dir = await fs.mkdtemp(path.join(TMP_BASE, "c125-ord-"));
      const raiz = path.join(dir, "proj");
      await fs.ensureDir(raiz);
      const pid = (await initializeCapsule(raiz, { projectName: "proj" })).projectId;

      for (const [sourceRef, id, supersedes] of ordem) {
        const overrides: Record<string, unknown> = {
          id,
          project_id: pid,
          provenance: {
            source_ref: sourceRef,
            producer_id: "c12-test",
            submitted_at: "2026-08-14T00:00:00.000Z",
          },
        };
        if (supersedes) overrides.supersedes = supersedes;
        await publishCanonical(raiz, makeDecision(overrides));
      }

      const report = await resolveHeadsBySource(raiz, "Decision");
      if (report.state !== "RESOLVED") throw new Error(`UNREADABLE: ${JSON.stringify(report.issues)}`);

      return JSON.stringify(
        [...report.bySource.entries()]
          .sort(([a], [b]) => a.localeCompare(b))
          .map(([src, s]) => ({
            src,
            status: s.state,
            head: s.state === "CURRENT" ? s.record.id : null,
            codes: s.state === "MALFORMED" ? s.issues.map((i) => i.code) : [],
          }))
      );
    };

    const direta = await montar(conjunto);
    const inversa = await montar([...conjunto].reverse());

    expect(inversa).toBe(direta);
    /** Não é um empate vazio: a resolução tem conteúdo dos dois tipos. */
    expect(direta).toContain('"status":"CURRENT"');
    expect(direta).toContain("SOURCE_DANGLING_SUPERSEDES");
  });

  it("partições são independentes: supersessão em A não move o head de B", async () => {
    const oldA = await put(SRC_A);
    const newA = await put(SRC_A, { supersedes: oldA });
    const onlyB = await put(SRC_B);

    const bySource = resolved(await resolve());
    const a = headFor(bySource, SRC_A);
    const b = headFor(bySource, SRC_B);

    if (a.state !== "CURRENT" || b.state !== "CURRENT") {
      throw new Error(`esperava CURRENT nos dois, veio ${a.state}/${b.state}`);
    }
    expect(a.record.id).toBe(newA);
    expect(b.record.id).toBe(onlyB);
  });
});

// ─── topologia quebrada ─────────────────────────────────────────────────────

describe("MALFORMED — partição não-vazia que não resolve", () => {
  it("ciclo dá MALFORMED, NUNCA ABSENT (ZERO HEADS != ABSENT)", async () => {
    const a = newRecordId("Decision");
    const b = newRecordId("Decision");
    await put(SRC_A, { id: a, supersedes: b });
    await put(SRC_A, { id: b, supersedes: a });

    const head = headFor(resolved(await resolve()), SRC_A);
    expect(head.state).toBe("MALFORMED");
    if (head.state === "MALFORMED") {
      expect(head.issues.map((i) => i.code)).toContain("SOURCE_NO_HEAD");
    }
  });

  it("self-supersedes é MALFORMED", async () => {
    const id = newRecordId("Decision");
    await put(SRC_A, { id, supersedes: id });

    const head = headFor(resolved(await resolve()), SRC_A);
    expect(head.state).toBe("MALFORMED");
    if (head.state === "MALFORMED") {
      expect(head.issues.map((i) => i.code)).toContain("SOURCE_SELF_SUPERSEDES");
    }
  });

  it("supersedes apontando para id inexistente é MALFORMED, não CURRENT", async () => {
    await put(SRC_A, { supersedes: newRecordId("Decision") });

    const head = headFor(resolved(await resolve()), SRC_A);
    expect(head.state).toBe("MALFORMED");
    if (head.state === "MALFORMED") {
      expect(head.issues.map((i) => i.code)).toContain("SOURCE_DANGLING_SUPERSEDES");
    }
  });

  it("aresta cruzando source_ref contamina AMBAS as partições", async () => {
    const inB = await put(SRC_B);
    await put(SRC_A, { supersedes: inB });

    const bySource = resolved(await resolve());
    const a = headFor(bySource, SRC_A);
    const b = headFor(bySource, SRC_B);

    expect(a.state).toBe("MALFORMED");
    /**
     * O ponto do caso: a partição ALVO também recusa. Sem isso, B resolveria
     * CURRENT ignorando uma declaração de supersessão que aponta para dentro
     * dele — head afirmado sobre grafo que o resolver rejeitou.
     */
    expect(b.state).toBe("MALFORMED");
    if (a.state === "MALFORMED" && b.state === "MALFORMED") {
      expect(a.issues.map((i) => i.code)).toContain("SOURCE_SUPERSEDES_FOREIGN_SOURCE");
      expect(b.issues.map((i) => i.code)).toContain("SOURCE_SUPERSEDES_FOREIGN_SOURCE");
    }
  });

  it("supersedes de OUTRA family é wrong-family, não 'não existe'", async () => {
    await put(SRC_A, { supersedes: newRecordId("KnowledgeRecord") });

    const head = headFor(resolved(await resolve()), SRC_A);
    expect(head.state).toBe("MALFORMED");
    if (head.state === "MALFORMED") {
      /**
       * Reportar DANGLING aqui repetiria a classe de erro do GOTCHA-044:
       * afirmar ausência quando o que houve foi o resolver não procurar lá.
       */
      expect(head.issues.map((i) => i.code)).toContain("SOURCE_SUPERSEDES_WRONG_FAMILY");
    }
  });

  it("uma partição quebrada não derruba a partição saudável ao lado", async () => {
    await put(SRC_A, { supersedes: newRecordId("Decision") });
    const healthy = await put(SRC_B);

    const bySource = resolved(await resolve());
    expect(headFor(bySource, SRC_A).state).toBe("MALFORMED");

    const b = headFor(bySource, SRC_B);
    if (b.state === "CURRENT") expect(b.record.id).toBe(healthy);
    else throw new Error(`esperava CURRENT em B, veio ${b.state}`);
  });
});

// ─── invariantes de pertencimento do par predecessor/successor ──────────────

describe("predecessor e successor pertencem ao MESMO project_id/family/source_ref", () => {
  it("L7a — mesmo project_id, mesma family, mesmo source_ref → linhagem VÁLIDA", async () => {
    const old = await put(SRC_A);
    const successor = await put(SRC_A, { supersedes: old });

    const bySource = resolved(await resolve());
    const head = headFor(bySource, SRC_A);
    if (head.state !== "CURRENT") throw new Error(`esperava CURRENT, veio ${head.state}`);
    expect(head.record.id).toBe(successor);

    /** O pertencimento é afirmado, não presumido pelo fato de ter resolvido. */
    const dir = forProject(root).familyDir("Decision");
    for (const id of [old, successor]) {
      const bruto = await fs.readFile(path.join(dir, `${id}.yaml`), "utf8");
      expect(bruto).toContain(`project_id: ${projectId}`);
      expect(bruto).toContain(`family: Decision`);
      expect(bruto).toContain(`source_ref: ${SRC_A}`);
    }
  });

  it("L7b — project_id diferente é RECUSADO antes de virar head", async () => {
    const old = await put(SRC_A);

    /**
     * Fabricado no disco: `publishCanonical` bloqueia isto por
     * `assertBelongsToRoot` (ADMITTED != ADMITTED FOR THIS PROJECT), então o
     * caminho legítimo não consegue produzir o caso.
     */
    const foreign = makeDecision({
      id: newRecordId("Decision"),
      project_id: "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR",
      supersedes: old,
      provenance: {
        source_ref: SRC_A,
        producer_id: "c12-test",
        submitted_at: "2026-08-14T00:00:00.000Z",
      },
    });
    await fs.writeFile(
      path.join(forProject(root).familyDir("Decision"), `${foreign.id}.yaml`),
      serializeCanonical(foreign)
    );

    const report = await resolve();
    /**
     * `LOCATION IN THIS CAPSULE != PROJECT OWNERSHIP` — um record foreign
     * copiado para `records/` continua foreign. O gate é I0 (`WRONG_PROJECT_ID`
     * em loadCanonicalRecord), anterior ao cálculo de arestas: nenhum record de
     * outro projeto chega a participar de uma linhagem. Por isso o resultado é
     * UNREADABLE (recusa global) e não MALFORMED de uma partição — a capsule
     * inteira está comprometida, e afirmar as outras partições seria afirmar
     * sobre um diretório que contém verdade de outro projeto.
     */
    expect(report.state).toBe("UNREADABLE");
    if (report.state === "UNREADABLE") {
      expect(report.issues.map((i) => i.code)).toContain("WRONG_PROJECT_ID");
    }
  });

  it("id cujo prefixo não bate com a family é recusado em I0, não no resolver", async () => {
    /** O contrato id↔family é gate de `loadCanonicalRecord`, citado e não duplicado. */
    const torto = makeDecision({
      id: newRecordId("KnowledgeRecord"),
      project_id: projectId,
      provenance: {
        source_ref: SRC_A,
        producer_id: "c12-test",
        submitted_at: "2026-08-14T00:00:00.000Z",
      },
    });
    await fs.writeFile(
      path.join(forProject(root).familyDir("Decision"), `${torto.id}.yaml`),
      serializeCanonical(torto)
    );

    const report = await resolve();
    expect(report.state).toBe("UNREADABLE");
    if (report.state === "UNREADABLE") {
      expect(report.issues.map((i) => i.code)).toContain("FAMILY_ID_PREFIX_MISMATCH");
    }
  });
});

// ─── DIAGNOSTIC ORDER != SEMANTIC RESULT ────────────────────────────────────

describe("ordem de diagnóstico não carrega semântica", () => {
  it("múltiplas issues na mesma partição saem ordenadas deterministicamente", async () => {
    const auto = newRecordId("Decision");
    await put(SRC_A, { id: auto, supersedes: auto });
    await put(SRC_A, { supersedes: newRecordId("Decision") });
    await put(SRC_A, { supersedes: newRecordId("KnowledgeRecord") });

    const head = headFor(resolved(await resolve()), SRC_A);
    if (head.state !== "MALFORMED") throw new Error(`esperava MALFORMED, veio ${head.state}`);

    const codes = head.issues.map((i) => i.code);
    expect(codes).toEqual([...codes].sort());
    /** Todas as causas presentes — nenhuma escondida pela ordem dos `if`. */
    expect(new Set(codes)).toEqual(
      new Set([
        "SOURCE_DANGLING_SUPERSEDES",
        "SOURCE_SELF_SUPERSEDES",
        "SOURCE_SUPERSEDES_WRONG_FAMILY",
      ])
    );
  });
});

// ─── CANNOT OBSERVE != DOES NOT EXIST ───────────────────────────────────────

describe("leitura que falha nunca vira ausência", () => {
  it("manifest ilegível dá UNREADABLE — não um mapa vazio", async () => {
    await put(SRC_A);
    await fs.writeFile(forProject(root).manifest(), "isto: não é: um manifest válido\n:::");

    const report = await resolve();
    expect(report.state).toBe("UNREADABLE");
    if (report.state === "UNREADABLE") {
      expect(report.issues.map((i) => i.code)).toContain("MANIFEST_UNREADABLE");
    }
  });

  it("record corrompido dá UNREADABLE global — não ABSENT na partição dele", async () => {
    await put(SRC_A);
    const dir = forProject(root).familyDir("Decision");
    const [file] = (await fs.readdir(dir)).filter((f) => f.endsWith(".yaml"));
    if (!file) throw new Error("fixture não publicou nenhum record");
    await fs.writeFile(path.join(dir, file), "conteúdo: [que não é um record\n");

    const report = await resolve();
    /**
     * Não dá para atribuir um record ilegível a uma partição — seu source_ref é
     * justamente o que não pôde ser lido. Contaminar seletivamente é impossível,
     * então FAIL CLOSED global é a única resposta honesta.
     */
    expect(report.state).toBe("UNREADABLE");
  });
});
