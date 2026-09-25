/**
 * nexos://decision/statusline-global-terminal-observability — snapshot
 * barato que a statusline global lê em `.nexos/.local/runtime/statusline.json`.
 * Read-merge-write, best-effort: `nexos state`/`nexos checkpoint` já
 * publicaram no Store antes de chamar isto — uma falha aqui nunca pode
 * derrubar o comando principal.
 */
import { describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { forProject } from "../src/lib/capsule/paths.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { writeStatuslineSnapshot, readProjectNameForSnapshot } from "../src/lib/statusline-snapshot.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());

async function freshRoot(prefix: string): Promise<string> {
  return fs.mkdtemp(path.join(TMP_BASE, prefix));
}

describe("writeStatuslineSnapshot", () => {
  it("cria o snapshot com os campos passados + generated_at", async () => {
    const root = await freshRoot("statusline-snapshot-create-");
    await writeStatuslineSnapshot(root, { project_name: "meu-projeto", state_title: "implementando X" });

    const snapshot = await fs.readJson(forProject(root).runtimeStatusline());
    expect(snapshot.project_name).toBe("meu-projeto");
    expect(snapshot.state_title).toBe("implementando X");
    expect(typeof snapshot.generated_at).toBe("string");
    expect(new Date(snapshot.generated_at).toString()).not.toBe("Invalid Date");
  });

  it("read-merge-write: uma chamada com só checkpoint_state preserva state_title da chamada anterior", async () => {
    const root = await freshRoot("statusline-snapshot-merge-");
    await writeStatuslineSnapshot(root, { project_name: "p", state_title: "estado anterior" });
    await writeStatuslineSnapshot(root, { checkpoint_state: "RUNNING" });

    const snapshot = await fs.readJson(forProject(root).runtimeStatusline());
    expect(snapshot.project_name).toBe("p");
    expect(snapshot.state_title).toBe("estado anterior");
    expect(snapshot.checkpoint_state).toBe("RUNNING");
  });

  it("generated_at sempre reflete a chamada mais recente, mesmo sem mudar outros campos", async () => {
    const root = await freshRoot("statusline-snapshot-touch-");
    await writeStatuslineSnapshot(root, { project_name: "p" });
    const first = await fs.readJson(forProject(root).runtimeStatusline());

    await new Promise((r) => setTimeout(r, 5));
    await writeStatuslineSnapshot(root, { checkpoint_state: "SUCCEEDED" });
    const second = await fs.readJson(forProject(root).runtimeStatusline());

    expect(second.generated_at).not.toBe(first.generated_at);
    expect(second.project_name).toBe("p"); // preservado
  });

  it("snapshot existente corrompido — próxima escrita substitui por JSON válido, sem lançar", async () => {
    const root = await freshRoot("statusline-snapshot-corrupt-");
    const snapshotPath = forProject(root).runtimeStatusline();
    await fs.ensureDir(path.dirname(snapshotPath));
    await fs.writeFile(snapshotPath, "{ isso nao e json");

    await expect(writeStatuslineSnapshot(root, { project_name: "p" })).resolves.toBeUndefined();

    const snapshot = await fs.readJson(snapshotPath);
    expect(snapshot.project_name).toBe("p");
  });

  it("root sem `.nexos` ainda — não lança (best-effort)", async () => {
    const root = await freshRoot("statusline-snapshot-no-nexos-");
    await expect(writeStatuslineSnapshot(root, { project_name: "p" })).resolves.toBeUndefined();
  });
});

describe("readProjectNameForSnapshot", () => {
  it("devolve o nome do manifest quando a Capsule existe", async () => {
    const root = await freshRoot("statusline-snapshot-name-");
    await initializeCapsule(root, { projectName: "meu-projeto-canonico" });

    expect(await readProjectNameForSnapshot(root)).toBe("meu-projeto-canonico");
  });

  it("devolve undefined quando não há manifest", async () => {
    const root = await freshRoot("statusline-snapshot-name-absent-");
    expect(await readProjectNameForSnapshot(root)).toBeUndefined();
  });

  it("devolve undefined quando o manifest é ilegível", async () => {
    const root = await freshRoot("statusline-snapshot-name-corrupt-");
    await fs.ensureDir(path.join(root, ".nexos"));
    await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), "{ nao e yaml valido: [");

    expect(await readProjectNameForSnapshot(root)).toBeUndefined();
  });
});
