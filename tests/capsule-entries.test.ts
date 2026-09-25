/**
 * ROUND 3 cleanup — fonte única de entradas reconhecidas em `.nexos/`
 * (gotcha knw_01M1FV7223Y2N3JJGCF9HEJ3JE).
 *
 * `initializer.ts` (`ALLOWED_ENTRIES`) e `migration-classifier.ts`
 * (`CANONICAL_ENTRIES`/`LOCAL_ENTRIES`) consultam os MESMOS objetos
 * (`src/lib/capsule/entries.ts`) — `initializer.ts` faz `.has()` direto
 * neles, nunca um snapshot unido no load do módulo.
 *
 * `project-effects.yaml` (ADR-071) saiu de `entries.ts` no corte
 * presence/capability/observations
 * (nexos://decision/p0-corte-presence-capability-observations) — era o
 * formato do TaskGrant/remote-authorization, removido por inteiro. Os
 * testes (a)/(b) deste arquivo, que provavam sua aceitação/rejeição
 * simétrica nos dois classificadores, saíram junto.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { classifyCapsule, initializeCapsule } from "../src/lib/capsule/initializer.js";
import { classifyRootEntry } from "../src/lib/capsule/migration-classifier.js";

const TMP = fs.realpathSync(os.tmpdir());

let ws: string | undefined;
afterEach(async () => {
  if (ws) await fs.remove(ws);
  ws = undefined;
});

async function mkGitProject(): Promise<string> {
  const root = await fs.mkdtemp(path.join(TMP, "capsule-entries-"));
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  return root;
}

describe("capsule entries — fonte única (initializer.ts + migration-classifier.ts)", () => {
  it("nome desconhecido continua CONFLICTING_EXISTING nos dois caminhos (guarda o comportamento existente, não só o novo)", async () => {
    ws = await mkGitProject();
    await initializeCapsule(ws, { projectName: "entries-unknown" });
    await fs.writeFile(path.join(ws, ".nexos", "arquivo-desconhecido.txt"), "x");

    expect(classifyRootEntry("arquivo-desconhecido.txt")).toBe("CONFLICTING_EXISTING");
    const viaInitializer = await classifyCapsule(ws);
    expect(viaInitializer.state).toBe("CONFLICTING_EXISTING");
    expect(viaInitializer.reason).toContain("arquivo-desconhecido.txt");
  });
});
