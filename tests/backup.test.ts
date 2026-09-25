/**
 * C6.3.4-L7A — backup hardening.
 *
 *   BACKUP EXISTS != BACKUP IS RESTORABLE
 *
 * `createBackup`/`restoreBackup` usam CLAUDE_DIR/BACKUP_DIR de `constants.ts`,
 * computados de `os.homedir()` no load do módulo — mockamos `node:os` para
 * apontar para um HOME de teste antes de importar, sem tocar `~/.claude` real.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";

const TEST_HOME = path.join(fs.realpathSync(os.tmpdir()), `nexos-backup-test-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  // Node's ESM default export for core modules equals the module's own named
  // exports object, so spreading `actual` (not `actual.default`, which the
  // `node:os` type declarations don't expose) produces the same default shape.
  return { ...actual, default: { ...actual, homedir: () => TEST_HOME }, homedir: () => TEST_HOME };
});

const { createBackup, restoreBackup } = await import("../src/lib/backup.js");
const { CLAUDE_DIR } = await import("../src/lib/constants.js");

async function readManifest(backupPath: string): Promise<{ hashes?: Record<string, string> }> {
  return fs.readJson(path.join(backupPath, "manifest.json"));
}

beforeEach(async () => {
  await fs.remove(TEST_HOME);
  await fs.ensureDir(CLAUDE_DIR);
  await fs.writeFile(path.join(CLAUDE_DIR, "CLAUDE.md"), "hello\n");
  await fs.outputFile(path.join(CLAUDE_DIR, "agents", "dex.md"), "# dex\n");
});

afterEach(async () => {
  await fs.remove(TEST_HOME);
});

describe("L7A · roundtrip normal grava hash e restaura byte-idêntico", () => {
  it("manifest.hashes cobre os alvos existentes; restore repõe o conteúdo original", async () => {
    const backupPath = await createBackup();
    const manifest = await readManifest(backupPath);
    expect(manifest.hashes?.["CLAUDE.md"]).toBeTruthy();
    expect(manifest.hashes?.agents).toBeTruthy();

    await fs.writeFile(path.join(CLAUDE_DIR, "CLAUDE.md"), "mutated\n");
    await restoreBackup(backupPath);
    expect(await fs.readFile(path.join(CLAUDE_DIR, "CLAUDE.md"), "utf-8")).toBe("hello\n");
  });
});

describe("L7A · backup corrompido depois de gravado → restore recusa", () => {
  it("hash divergente lança e NÃO sobrescreve o estado atual", async () => {
    const backupPath = await createBackup();

    // Corrupção depois do backup: alguém mexeu no arquivo já gravado.
    await fs.writeFile(path.join(backupPath, "CLAUDE.md"), "adulterado\n");

    await fs.writeFile(path.join(CLAUDE_DIR, "CLAUDE.md"), "estado bom atual\n");
    await expect(restoreBackup(backupPath)).rejects.toThrow(/hash/);

    // Tudo-ou-nada: o estado bom não foi tocado pelo restore recusado.
    expect(await fs.readFile(path.join(CLAUDE_DIR, "CLAUDE.md"), "utf-8")).toBe("estado bom atual\n");
  });
});

describe("L7A · symlink no caminho → recusa, não segue", () => {
  it("createBackup recusa quando o alvo é symlink", async () => {
    await fs.remove(path.join(CLAUDE_DIR, "agents"));
    const outsideTarget = path.join(TEST_HOME, "outside-agents");
    await fs.outputFile(path.join(outsideTarget, "evil.md"), "fora do CLAUDE_DIR\n");
    await fs.symlink(outsideTarget, path.join(CLAUDE_DIR, "agents"), "dir");

    await expect(createBackup()).rejects.toThrow(/symlink/);
  });

  it("restoreBackup recusa quando o backup foi adulterado com symlink", async () => {
    const backupPath = await createBackup();

    const outsideTarget = path.join(TEST_HOME, "outside-restore");
    await fs.outputFile(path.join(outsideTarget, "evil.md"), "fora do CLAUDE_DIR\n");
    await fs.remove(path.join(backupPath, "agents"));
    await fs.symlink(outsideTarget, path.join(backupPath, "agents"), "dir");

    await expect(restoreBackup(backupPath)).rejects.toThrow(/symlink/);
  });
});

describe("L7A · backup legado sem hashes ainda restaura (sem verificação retroativa)", () => {
  it("manifest sem campo hashes não bloqueia restore", async () => {
    const backupPath = await createBackup();
    const manifestPath = path.join(backupPath, "manifest.json");
    const manifest = await fs.readJson(manifestPath);
    delete manifest.hashes;
    await fs.writeJson(manifestPath, manifest);

    await fs.writeFile(path.join(CLAUDE_DIR, "CLAUDE.md"), "mutated\n");
    await restoreBackup(backupPath);
    expect(await fs.readFile(path.join(CLAUDE_DIR, "CLAUDE.md"), "utf-8")).toBe("hello\n");
  });
});
