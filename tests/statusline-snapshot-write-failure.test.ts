/**
 * nexos://decision/statusline-global-terminal-observability — o snapshot da
 * statusline é BEST-EFFORT (`statusline-snapshot.ts`): `nexos state`/`nexos
 * checkpoint` já publicaram no Store ANTES de tentar gravá-lo. Este teste
 * prova a falha REAL (diretório sem permissão de escrita, não um mock) e
 * confirma que os comandos continuam saindo 0 — a escrita canônica no Store
 * não pode depender do sucesso de um cache de exibição.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { init } from "../src/commands/init.js";
import { state } from "../src/commands/state.js";
import { checkpoint } from "../src/commands/checkpoint.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { readCurrentRecords, contentOf } from "../src/lib/capsule/reader.js";
import { resolveCheckpointHead } from "../src/lib/capsule/checkpoint.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;

const silencioso = <T>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  vi.spyOn(console, "error").mockImplementation(() => {});
  return fn().finally(() => vi.restoreAllMocks());
};

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "sl-write-fail-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  await silencioso(() => init({ cwd: root, registerGlobally: false }));
  process.exitCode = undefined;
});

afterEach(async () => {
  // Restaura permissão ANTES de remover — cleanup nunca deve depender do
  // estado que o próprio teste quebrou de propósito.
  const runtimeDir = path.dirname(forProject(root).runtimeStatusline());
  if (await fs.pathExists(runtimeDir)) {
    await fs.chmod(runtimeDir, 0o755).catch(() => undefined);
  }
  vi.restoreAllMocks();
  process.exitCode = undefined;
  await fs.remove(ws);
});

/**
 * SÓ `.nexos/.local/runtime` (destino do snapshot) fica sem permissão de
 * escrita — `.local` em si (e `head-claims/`, que a publicação canônica via
 * CAS usa) continua gravável. Restringir `.local` inteiro quebraria a
 * publicação no Store por um motivo TOTALMENTE alheio ao que este teste
 * prova (medido: `claimHeadTransition` também escreve em `.local/`).
 */
async function tornarRuntimeSomenteLeitura(): Promise<void> {
  const runtimeDir = path.dirname(forProject(root).runtimeStatusline());
  await fs.ensureDir(runtimeDir);
  await fs.chmod(runtimeDir, 0o555); // r-xr-xr-x — sem escrita, ainda navegável para o cleanup
}

describe("writeStatuslineSnapshot — falha real de escrita não derruba o comando principal", () => {
  it("`nexos state --set` publica no Store e sai 0 mesmo com .nexos/.local/runtime somente-leitura", async () => {
    await tornarRuntimeSomenteLeitura();

    await expect(
      silencioso(() => state({ cwd: root, set: "parser pronto", next: "tratar BOM", title: "Importador" }))
    ).resolves.toBeUndefined();

    expect(process.exitCode ?? 0).toBe(0);

    // A escrita CANÔNICA aconteceu — o Store não depende do snapshot.
    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok).toBe(true);
    if (r.ok) {
      const rec = r.records.find((x) => x.sourceRef === "nexos://project-state");
      expect(contentOf(rec!.record).current_state).toBe("parser pronto");
    }

    // O snapshot-alvo nunca foi criado (a falha foi real, não simulada por mock).
    expect(await fs.pathExists(forProject(root).runtimeStatusline())).toBe(false);
  });

  it("`nexos checkpoint --state PENDING` publica no Store e sai 0 mesmo com .nexos/.local/runtime somente-leitura", async () => {
    await tornarRuntimeSomenteLeitura();

    await expect(
      silencioso(() => checkpoint({ cwd: root, state: "PENDING", statement: "primeiro checkpoint" }))
    ).resolves.toBeUndefined();

    expect(process.exitCode ?? 0).toBe(0);

    // A escrita CANÔNICA do checkpoint aconteceu — o Store não depende do snapshot.
    const head = await resolveCheckpointHead(root);
    expect(head.kind).toBe("HEAD");
    if (head.kind === "HEAD") {
      expect(head.state).toBe("PENDING");
    }

    expect(await fs.pathExists(forProject(root).runtimeStatusline())).toBe(false);
  });
});
