/**
 * chk_01M2EE9N5EEET94B5PFPHBGTDN — prova do helper que fecha o defeito de
 * instrumento: `waitForWarmerAndKillSurvivor` precisa (1) nunca travar além do
 * teto, (2) reconhecer liberação natural do lock, (3) reconhecer dono morto
 * sem liberar o lock (crash) sem tentar matar um pid já morto, e (4) matar de
 * verdade um sobrevivente vivo pelo pid GRAVADO NO LOCK — nada além disso.
 *
 * `FAKE LOCK HOLDER != PRODUCTION cache-warmer.ts` — este teste nunca importa
 * `runCacheWarmerCli`; escreve o payload `{pid}` no mesmo path que
 * `warmerLockPath` calcula (mesmo `forProject(...).derived()` que a produção
 * usa) e segura o pid com um processo `node` real de verdade, para que
 * `process.kill(pid, 0)`/`SIGKILL` testem contra um pid do SO de fato, não um
 * número inventado.
 */
import { describe, it, expect, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawn, type ChildProcess } from "node:child_process";
import { warmerLockPath, waitForWarmerAndKillSurvivor } from "../scripts/lib/session-start-harness.mjs";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let workspace: string | undefined;
const spawned: ChildProcess[] = [];

afterEach(async () => {
  for (const child of spawned.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill("SIGKILL");
  }
  if (workspace) {
    await fs.remove(workspace);
    workspace = undefined;
  }
});

/** Processo `node` real e vivo — o mesmo tipo de pid que um aquecedor destacado real ocuparia. */
function spawnLongLivedProcess(): ChildProcess {
  const child = spawn(process.execPath, ["-e", "setTimeout(() => {}, 30000)"], { stdio: "ignore" });
  spawned.push(child);
  return child;
}

async function writeLock(root: string, pid: number): Promise<string> {
  const lock = warmerLockPath(root);
  await fs.ensureDir(path.dirname(lock));
  await fs.writeFile(lock, JSON.stringify({ pid, startedAt: Date.now() }));
  return lock;
}

function waitForExit(child: ChildProcess): Promise<void> {
  return new Promise((resolve) => child.once("exit", () => resolve()));
}

describe("waitForWarmerAndKillSurvivor", () => {
  it("nunca observado: sem lock, retorna rápido sem matar nada", async () => {
    workspace = await fs.mkdtemp(path.join(TMP_BASE, "warmer-wait-none-"));
    const outcome = await waitForWarmerAndKillSurvivor(warmerLockPath(workspace), 400, 50);
    expect(outcome).toMatchObject({ observed: false, releasedNaturally: true, killed: false });
    expect(outcome.waitedMs).toBeGreaterThanOrEqual(0);
  });

  /**
   * D3 (chk_01M2EE9N5EEET94B5PFPHBGTDN) — o defeito real: `maxWaitMs` grande
   * (o harness usa 20s, `WARMER_WAIT_TIMEOUT_MS`) e o lock NUNCA aparece.
   * Antes desta correção, `observed` nunca virava `true`, então o retorno
   * antecipado (`if (observed)`) nunca disparava — o loop rodava os 20s
   * INTEIROS. `unobservedTimeoutMs` (explícito e curto aqui, 200ms) prova que
   * o helper desiste bem ANTES de `maxWaitMs`, não perto dele.
   */
  it("D3 · nunca observado com maxWaitMs GRANDE ⇒ desiste no teto curto de 'não observado', não no teto geral", async () => {
    workspace = await fs.mkdtemp(path.join(TMP_BASE, "warmer-wait-none-large-ceiling-"));
    const outcome = await waitForWarmerAndKillSurvivor(warmerLockPath(workspace), 20_000, 20, 200);
    expect(outcome).toMatchObject({ observed: false, releasedNaturally: true, killed: false });
    expect(outcome.waitedMs).toBeLessThan(1_000); // bem abaixo dos 20s de maxWaitMs
  });

  it("liberação natural: lock some antes do teto, nunca mata o pid ainda vivo", async () => {
    workspace = await fs.mkdtemp(path.join(TMP_BASE, "warmer-wait-release-"));
    const child = spawnLongLivedProcess();
    const lock = await writeLock(workspace, child.pid!);
    setTimeout(() => {
      fs.removeSync(lock); // simula `releaseLock` de cache-warmer.ts terminando o trabalho
    }, 150);

    const outcome = await waitForWarmerAndKillSurvivor(lock, 5_000, 50);

    expect(outcome).toMatchObject({ observed: true, releasedNaturally: true, killed: false });
    expect(() => process.kill(child.pid!, 0)).not.toThrow(); // ainda vivo — nunca foi morto
  });

  it("dono morto sem liberar o lock: reconhece sem tentar matar um pid já morto", async () => {
    workspace = await fs.mkdtemp(path.join(TMP_BASE, "warmer-wait-crashed-"));
    const shortLived = spawn(process.execPath, ["-e", "process.exit(0)"], { stdio: "ignore" });
    spawned.push(shortLived);
    await waitForExit(shortLived);

    await writeLock(workspace, shortLived.pid!); // lock nunca liberado (dono já morto) — cenário de crash
    const outcome = await waitForWarmerAndKillSurvivor(warmerLockPath(workspace), 400, 50);

    expect(outcome).toMatchObject({ observed: true, releasedNaturally: true, killed: false });
  });

  it("sobrevivente vivo no teto: mata pelo pid do lock", async () => {
    workspace = await fs.mkdtemp(path.join(TMP_BASE, "warmer-wait-kill-"));
    const child = spawnLongLivedProcess();
    const lock = await writeLock(workspace, child.pid!); // nunca liberado — simula aquecedor lento sobrevivendo ao teto
    const exited = waitForExit(child);

    const outcome = await waitForWarmerAndKillSurvivor(lock, 300, 50);

    expect(outcome).toMatchObject({ observed: true, releasedNaturally: false, killed: true });
    await exited; // prova que o SIGKILL de fato terminou o processo, não só que o helper alegou matar
    expect(child.signalCode).toBe("SIGKILL");
  });
});
