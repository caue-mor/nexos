/**
 * T1 hardening — Entrega D: `scripts/decision-publish.ts` refatorado para
 * `publishDecision(root, {now})` testável + idempotência FAIL-CLOSED contra
 * segunda raiz. `family: Decision` está em `RETIRED_LEGACY_PRODUCERS`
 * (integrity.ts) — não há CAS de `publishSuperseding` disponível para esta
 * family, então o gate de idempotência precisa ser ler-antes-de-escrever,
 * explícito, no próprio script.
 *
 *   SECOND CALL WITH SAME source_ref != SECOND ROOT
 *
 * Nenhum teste aqui roda `scripts/decision-publish.ts` como processo — importa
 * `publishDecision` diretamente contra uma capsule TEMPORÁRIA (nunca o
 * `SOURCE_REF` real do repositório).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { publishDecision } from "../scripts/decision-publish.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { resolveHeadsBySource } from "../src/lib/capsule/head-resolver.js";
import { scanIntegrity } from "../src/lib/capsule/integrity.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-09-08T12:00:00.000Z";
let ws: string;
let root: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "decpub-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  await initializeCapsule(root, { projectName: "proj" });
});
afterEach(async () => {
  await fs.remove(ws);
});

const contagemDecision = async (): Promise<number> => {
  const r = await readCurrentRecords(root, { families: ["Decision"] });
  expect(r.ok).toBe(true);
  if (!r.ok) return -1;
  return r.records.length;
};

describe("publishDecision — idempotência fail-closed contra segunda raiz", () => {
  it("1ª execução publica 1 record válido", async () => {
    const { id } = await publishDecision(root, { now: NOW });
    expect(id).toMatch(/^dec_/);
    expect(await contagemDecision()).toBe(1);
  });

  // Cobre só o caso SEQUENCIAL (duas chamadas no mesmo processo, uma após a
  // outra) — corrida entre DOIS PROCESSOS concorrentes é o teto declarado no
  // bloco "TETO" do cabeçalho de scripts/decision-publish.ts, não coberto aqui.
  it("2ª execução para o MESMO source_ref falha fechada — sem segunda raiz, sem DIVERGED", async () => {
    await publishDecision(root, { now: NOW });
    expect(await contagemDecision()).toBe(1);

    await expect(publishDecision(root, { now: NOW })).rejects.toThrow(
      /já tem head publicado.*fail-closed contra segunda raiz/
    );

    // contagem da family NÃO muda — a 2ª chamada não escreveu nada.
    expect(await contagemDecision()).toBe(1);

    // resolveHeadsBySource nunca vê duas raízes não referenciadas para este
    // source_ref — seria DIVERGED se o guard de idempotência não existisse.
    const report = await resolveHeadsBySource(root, "Decision");
    expect(report.state).toBe("RESOLVED");
    if (report.state !== "RESOLVED") return;
    const head = report.bySource.get(".nexos/memory/project/decisions.md#ADR-072");
    expect(head?.state).toBe("CURRENT");

    // e a capsule inteira continua íntegra — nenhuma issue nova pelo lado.
    const integridade = await scanIntegrity(root);
    expect(integridade.issues).toEqual([]);
  });
});
