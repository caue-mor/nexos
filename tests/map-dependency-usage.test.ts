/**
 * V4 (direcionamento consolidado §8/§10-H2, achado do orquestrador) —
 * dependência de RUNTIME (`dependencies`, nunca `devDependencies`)
 * REALMENTE importada por código incluído e sem detector próprio
 * (framework/orm/integration/auth/test_framework) não virava fato nenhum —
 * hoje o exemplo medido é `inngest` (Fintech usa em `src/lib/inngest.ts` e
 * `src/app/api/inngest/route.ts`, nenhum vira fato). Fixture GENÉRICA, no
 * FORMATO observado — nunca hardcode de nome de fornecedor real.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { scanProjectStructure } from "../src/lib/map/map-scan.js";
import { generateArchitectureMd } from "../src/lib/map/architecture.js";

const tmpDirs: string[] = [];

async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), prefix));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop();
    if (d) await fs.remove(d);
  }
});

describe("V4 · dependency_used — dependência de produção usada por código, sem detector próprio", () => {
  it("fixture tipo Fintech: lib de eventos importada em 2 arquivos vira UM fato com os 2 consumidores", async () => {
    const dir = await makeTmpDir("nexos-v4-");
    await fs.outputJson(path.join(dir, "package.json"), {
      name: "app",
      dependencies: { "events-lib": "^3.0.0", react: "^18.0.0", "unused-lib": "^1.0.0" },
      devDependencies: { "dev-only-lib": "^1.0.0" },
    });
    await fs.outputFile(
      path.join(dir, "src/lib/events.ts"),
      'import { EventsClient } from "events-lib";\nexport const client = new EventsClient({ id: "app" });\n'
    );
    await fs.outputFile(
      path.join(dir, "src/app/api/events/route.ts"),
      'import { client } from "../../../lib/events";\nimport { serve } from "events-lib";\nexport const { GET, POST } = serve({ client, functions: [] });\n'
    );
    // "react" é framework classificado — mesmo importado, não pode duplicar como dependency_used.
    await fs.outputFile(path.join(dir, "src/app/page.tsx"), 'import React from "react";\nexport default function Page() { return null; }\n');
    // devDependency importada em código — nunca vira dependency_used (só `dependencies`).
    await fs.outputFile(path.join(dir, "src/tool.ts"), 'import x from "dev-only-lib";\nexport const y = x;\n');

    const scan = await scanProjectStructure(dir);

    expect(scan.dependencyFacts).toHaveLength(1);
    const fact = scan.dependencyFacts[0];
    expect(fact).toMatchObject({ fact: "dependency_used", value: "events-lib", certainty: "OBSERVED", fileCount: 2 });
    expect(fact?.files?.slice().sort()).toEqual(["src/app/api/events/route.ts", "src/lib/events.ts"]);

    const values = scan.dependencyFacts.map((f) => f.value);
    expect(values).not.toContain("react"); // já é fato de framework
    expect(values).not.toContain("unused-lib"); // declarada, nunca importada
    expect(values).not.toContain("dev-only-lib"); // devDependencies não conta
  });

  it("declarada e não importada em NENHUM arquivo não vira fato de uso", async () => {
    const dir = await makeTmpDir("nexos-v4-unused-");
    await fs.outputJson(path.join(dir, "package.json"), { name: "app", dependencies: { "sitting-lib": "^1.0.0" } });
    await fs.outputFile(path.join(dir, "src/index.ts"), "export const x = 1;\n");

    const scan = await scanProjectStructure(dir);
    expect(scan.dependencyFacts).toEqual([]);
  });

  it("mais de 5 consumidores: files tem teto de 5, fileCount guarda o total real", async () => {
    const dir = await makeTmpDir("nexos-v4-many-");
    await fs.outputJson(path.join(dir, "package.json"), { name: "app", dependencies: { "shared-lib": "^1.0.0" } });
    for (let i = 0; i < 7; i++) {
      await fs.outputFile(path.join(dir, `src/consumer${i}.ts`), 'import x from "shared-lib";\nexport const y = x;\n');
    }

    const scan = await scanProjectStructure(dir);
    expect(scan.dependencyFacts).toHaveLength(1);
    expect(scan.dependencyFacts[0]?.files).toHaveLength(5);
    expect(scan.dependencyFacts[0]?.fileCount).toBe(7);
  });

  it("architecture.md seção 10 lista a dependência como 'usada pelo código (biblioteca ou serviço, não classificado)'", () => {
    const md = generateArchitectureMd({
      projectName: "app",
      facts: [
        {
          fact: "dependency_used",
          value: "events-lib",
          certainty: "OBSERVED" as const,
          provenance: { file: "src/lib/events.ts", field: "import" },
          files: ["src/lib/events.ts", "src/app/api/events/route.ts"],
          fileCount: 2,
          id: "STACK-1",
        },
      ],
      routes: [],
      database: [],
      graph: [],
      generatedAt: "2026-01-01T00:00:00.000Z",
    });
    expect(md).toContain("## 10. Integrações externas");
    expect(md).toContain("dependência `events-lib`: usada pelo código (biblioteca ou serviço, não classificado)");
    expect(md).toContain("STACK-1");
    expect(md).not.toContain("UNKNOWN — nenhum SDK de integração");
  });
});
