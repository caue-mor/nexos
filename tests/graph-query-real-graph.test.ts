/**
 * Project Intelligence V1 — teste HOST-REAL, declarado como tal.
 *
 * Roda `queryRelevantFiles` contra o grafo REAL desta máquina
 * (`graphify-out/graph.json`, 25 MB, gitignored) e o repo REAL. Skipado
 * quando o artefato não existe — clone limpo nunca falha por isto, e
 * `graph-query.test.ts` (fixtures pequenas) já cobre a lógica sem depender
 * de estado local.
 */
import { describe, it, expect } from "vitest";
import { existsSync } from "node:fs";
import path from "node:path";
import { queryRelevantFiles } from "../src/lib/graph-query.js";

const ROOT = process.cwd();
const REAL_GRAPH = path.join(ROOT, "graphify-out", "graph.json");

describe.skipIf(!existsSync(REAL_GRAPH))("queryRelevantFiles — grafo real desta máquina", () => {
  it("responde FRESH ou STALE (nunca trava) e nunca vaza o grafo bruto", async () => {
    const r = await queryRelevantFiles(ROOT, { task: "corrigir o boot da sessão", limit: 10 });
    expect(r.status === "FRESH" || r.status === "STALE").toBe(true);
    if (r.status !== "FRESH" && r.status !== "STALE") return;
    expect(r.built_at_commit.length).toBeGreaterThan(0);
    expect(r.items.length).toBeLessThanOrEqual(10);
    for (const item of r.items) {
      expect(typeof item.path).toBe("string");
      expect(typeof item.reason).toBe("string");
      expect(typeof item.provenance).toBe("string");
      expect(typeof item.relation).toBe("string");
    }
    expect(typeof r.summary.query_ms).toBe("number");
  });

  it("task sem termo reconhecível não inventa candidato", async () => {
    const r = await queryRelevantFiles(ROOT, { task: "xyzqqqnaoexistenocodigo123" });
    if (r.status === "FRESH" || r.status === "STALE") {
      expect(r.items).toEqual([]);
    }
  });
});
