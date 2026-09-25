import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import {
  classifyHostCapability,
  type HostToolCatalog,
} from "../src/lib/host/tool-classification.js";

const CATALOG_PATH = path.join(process.cwd(), "assets/policies/host-tool-catalog.json");

/** Catálogo real, medido em 2.1.235 — as mesmas amostras citadas no header do módulo. */
async function realCatalog(): Promise<HostToolCatalog> {
  return (await fs.readJson(CATALOG_PATH)) as HostToolCatalog;
}

/** Catálogo sintético só para exercitar os planos que o catálogo real de hoje não tem (virtual vazio). */
const SYNTHETIC_CATALOG: HostToolCatalog = {
  host: "synthetic-test",
  generated_at: "2026-01-01T00:00:00Z",
  derivation: "fixture de teste, não deriva de host real",
  native: ["Read"],
  deferred: ["WebFetch"],
  mcp_prefixes: ["mcp__"],
  virtual: ["nexos-handoff"],
  unavailable: ["Grep"],
};

describe("classifyHostCapability — host reality, agnóstica de agente", () => {
  it("resolve os quatro planos de presença", () => {
    expect(classifyHostCapability("Read", SYNTHETIC_CATALOG)).toBe("HOST_NATIVE_TOOL");
    expect(classifyHostCapability("WebFetch", SYNTHETIC_CATALOG)).toBe("HOST_DEFERRED_TOOL");
    expect(classifyHostCapability("mcp__docker-gateway__foo", SYNTHETIC_CATALOG)).toBe("HOST_MCP_TOOL");
    expect(classifyHostCapability("nexos-handoff", SYNTHETIC_CATALOG)).toBe("HOST_VIRTUAL_CAPABILITY");
  });

  it("Grep -> HOST_UNAVAILABLE, medido ausente em toda superfície, catálogo real", async () => {
    const cat = await realCatalog();
    expect(classifyHostCapability("Grep", cat)).toBe("HOST_UNAVAILABLE");
  });

  it("ferramenta ausente do catálogo inteiro -> HOST_UNKNOWN, nunca HOST_UNAVAILABLE", async () => {
    const cat = await realCatalog();
    const verdict = classifyHostCapability("SomeFutureToolNeverMeasured", cat);
    expect(verdict).toBe("HOST_UNKNOWN");
    expect(verdict).not.toBe("HOST_UNAVAILABLE");
  });
});
