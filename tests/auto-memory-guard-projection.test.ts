/**
 * AUTO MEMORY GUARD PROJECTION — cobertura que faltava (D5).
 *
 *   `grep -rl "planPermissionGateProjection" tests/` não achava nada; o mesmo
 *   valia para `planAutoMemoryGuardProjection` até este arquivo existir.
 *
 * Mesmo padrão de `tests/agent-projection.test.ts`: `fs.mkdtemp` sobre
 * `fs.realpathSync(os.tmpdir())` (macOS resolve `/tmp` -> `/private/tmp`),
 * clock injetado, idempotência provada pelo RESULTADO devolvido, nunca por
 * mtime.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  planAutoMemoryGuardProjection,
  applyAutoMemoryGuardProjection,
  AUTO_MEMORY_KEY,
  MANIFEST_NAME,
  SettingsUnreadableError,
} from "../src/lib/host/auto-memory-guard-projection.js";

const NOW = "2026-08-20T00:00:00.000Z";
const PRODUCER = "test@1";
let ws: string;
let settingsPath: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "amg-"));
  settingsPath = path.join(ws, ".claude", "settings.json");
});
afterEach(async () => {
  await fs.remove(ws);
});

const plan = () => planAutoMemoryGuardProjection({ settingsPath, producer: PRODUCER, now: NOW });

describe("planAutoMemoryGuardProjection", () => {
  it("caso 1 · .claude/ ausente → plano cria settings.json com a guarda; apply escreve", async () => {
    expect(await fs.pathExists(path.dirname(settingsPath))).toBe(false);

    const p = await plan();
    expect(p.changed).toBe(true);
    expect(p.conflict).toBe(false);
    expect(p.settings[AUTO_MEMORY_KEY]).toBe(false);

    const r = await applyAutoMemoryGuardProjection(p);
    expect(r.written).toBe(true);
    expect(await fs.pathExists(settingsPath)).toBe(true);
    const onDisk = await fs.readJson(settingsPath);
    expect(onDisk[AUTO_MEMORY_KEY]).toBe(false);
    expect(await fs.pathExists(path.join(ws, ".claude", MANIFEST_NAME))).toBe(true);
  });

  it("caso 2 · settings.json com chaves alheias → guarda somada, TODO o resto preservado byte a byte", async () => {
    const original = {
      agent: "nexos-master",
      permissions: { allow: ["Bash(git status)"] },
      hooks: { PreToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "echo hi" }] }] },
    };
    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeJson(settingsPath, original);

    const p = await plan();
    expect(p.changed).toBe(true);
    expect(p.conflict).toBe(false);

    await applyAutoMemoryGuardProjection(p);
    const onDisk = await fs.readJson(settingsPath);

    expect(onDisk[AUTO_MEMORY_KEY]).toBe(false);
    expect(onDisk.agent).toBe(original.agent);
    expect(onDisk.permissions).toEqual(original.permissions);
    expect(onDisk.hooks).toEqual(original.hooks);
  });

  it("caso 3 · segundo apply sobre um plano fresco → NOOP, nada escrito", async () => {
    await applyAutoMemoryGuardProjection(await plan());
    const before = await fs.stat(settingsPath);

    const r2 = await applyAutoMemoryGuardProjection(await plan());
    expect(r2.written).toBe(false);

    const after = await fs.stat(settingsPath);
    expect(after.mtimeMs).toBe(before.mtimeMs);
  });

  it("caso 4 · autoMemoryEnabled:true explícito → conflito reportado, valor NÃO é sobrescrito", async () => {
    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeJson(settingsPath, { [AUTO_MEMORY_KEY]: true, agent: "nexos-master" });

    const p = await plan();
    expect(p.conflict).toBe(true);
    expect(p.changed).toBe(false); // nada a escrever: o humano decidiu, o plano não briga
    expect(p.settings[AUTO_MEMORY_KEY]).toBe(true);

    const r = await applyAutoMemoryGuardProjection(p);
    expect(r.written).toBe(false);
    const onDisk = await fs.readJson(settingsPath);
    expect(onDisk[AUTO_MEMORY_KEY]).toBe(true);
  });

  it("é determinístico: mesmo estado em disco, mesmo plano", async () => {
    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeJson(settingsPath, { agent: "x" });
    const a = await plan();
    const b = await plan();
    expect(JSON.stringify(a.settings)).toBe(JSON.stringify(b.settings));
    expect(a.conflict).toBe(b.conflict);
  });

  /**
   * D11 · settings.json truncado/corrompido — `readSettings` sozinho não
   * pode tratar "ilegível" como "{}": um WRITER que faz isso e depois escreve
   * apagaria em silêncio o que quer que estivesse ali (partial write, merge
   * ruim, edit manual incompleto). `nexos doctor` (read-only, memory-authority.ts)
   * já trata ilegível como ausente com segurança; este módulo ESCREVE e não
   * pode copiar essa regra sem o `throw` — reproduzido com o EXATO byte-string
   * do incidente: `nexos project --local --execute` sobre um settings.json
   * truncado matava o processo com `SyntaxError` cru vindo de `jsonfile`.
   */
  it("caso 5 · settings.json truncado → plan rejeita com erro nomeado, NUNCA um SyntaxError cru, bytes intactos", async () => {
    const corrompido = '{"agent":"nexos-master","autoMemoryEnabled": fal';
    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeFile(settingsPath, corrompido, "utf-8");

    await expect(plan()).rejects.toBeInstanceOf(SettingsUnreadableError);
    // Nunca a SyntaxError crua do jsonfile vazando por cima do erro nomeado.
    await expect(plan()).rejects.not.toThrow(SyntaxError);

    // FAIL CLOSED: o plano nunca chega a existir, então `apply` não tem como
    // rodar sobre ele — o arquivo quebrado nunca é tocado.
    expect(await fs.readFile(settingsPath, "utf-8")).toBe(corrompido);
  });

  it("caso 6 · settings.json com JSON válido mas não-objeto (array) → tratado como vazio, nunca lança", async () => {
    await fs.ensureDir(path.dirname(settingsPath));
    await fs.writeJson(settingsPath, ["nao", "e", "um", "objeto"]);

    const p = await plan();
    expect(p.changed).toBe(true);
    expect(p.settings[AUTO_MEMORY_KEY]).toBe(false);
  });
});
