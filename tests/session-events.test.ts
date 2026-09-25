/**
 * `writeSessionStarted`/`writeSessionClosed` (session-events.ts) — os dois
 * escritores do registro de sessão (18/09). Cobre: forma exata do record
 * publicado, `scope.kind==="session"` com `ref` correto (R15), e o contrato
 * FAIL-OPEN ABSOLUTO — nenhuma das duas funções pode lançar.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { writeSessionStarted, writeSessionClosed } from "../src/lib/capsule/session-events.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { loadFamilyForResolution } from "../src/lib/capsule/head-resolver.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;
let projectId: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "session-events-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  const init = await initializeCapsule(root, { projectName: "proj" });
  projectId = init.projectId;
});

afterEach(async () => {
  await fs.remove(root);
});

describe("writeSessionStarted", () => {
  it("publica um record Session/started com scope.kind=session e ref=session_id", async () => {
    const sessionId = "11111111-1111-1111-1111-111111111111";
    const result = await writeSessionStarted({
      rootPath: root,
      projectId,
      sessionId,
      cwd: root,
      agentRef: null,
      checkpointId: null,
    });
    expect(result.ok).toBe(true);

    const loaded = await loadFamilyForResolution(root, "Session");
    expect(loaded.state).toBe("LOADED");
    if (loaded.state !== "LOADED") return;
    expect(loaded.records).toHaveLength(1);
    const record = loaded.records[0]?.record;
    expect(record?.family).toBe("Session");
    if (record?.family !== "Session") return;
    expect(record.kind).toBe("started");
    expect(record.scope).toEqual({ kind: "session", ref: sessionId });
    if (record.kind !== "started") return;
    expect(record.content.host).toBe(os.hostname());
    expect(record.content.cwd).toBe(root);
    expect(record.content.agent_ref).toBeNull();
    expect(record.content.checkpoint_id).toBeNull();
  });

  it("agent_ref e checkpoint_id, quando presentes, saem verbatim", async () => {
    const sessionId = "22222222-2222-2222-2222-222222222222";
    const result = await writeSessionStarted({
      rootPath: root,
      projectId,
      sessionId,
      cwd: root,
      agentRef: "nexos-dev",
      checkpointId: "chk_01M2VABCDEFGHJKMNPQRSTVWXY",
    });
    expect(result.ok).toBe(true);

    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    const record = loaded.records[0]?.record;
    if (record?.family !== "Session" || record.kind !== "started") throw new Error("esperado Session/started");
    expect(record.content.agent_ref).toBe("nexos-dev");
    expect(record.content.checkpoint_id).toBe("chk_01M2VABCDEFGHJKMNPQRSTVWXY");
  });

  it("CONTROLE NEGATIVO (fail-open) — rootPath sem Capsule canônica devolve {ok:false}, NUNCA lança", async () => {
    const semCapsule = await fs.mkdtemp(path.join(TMP, "session-events-nocapsule-"));
    try {
      const result = await writeSessionStarted({
        rootPath: semCapsule,
        projectId: "prj_00000000000000000000000000",
        sessionId: "33333333-3333-3333-3333-333333333333",
        cwd: semCapsule,
        agentRef: null,
        checkpointId: null,
      });
      expect(result.ok).toBe(false);
      expect(typeof result.detail).toBe("string");
    } finally {
      await fs.remove(semCapsule);
    }
  });
});

describe("writeSessionClosed", () => {
  it("publica um record Session/closed com o reason verbatim", async () => {
    const sessionId = "44444444-4444-4444-4444-444444444444";
    const result = await writeSessionClosed({ rootPath: root, projectId, sessionId, reason: "other" });
    expect(result.ok).toBe(true);

    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    const record = loaded.records[0]?.record;
    expect(record?.family).toBe("Session");
    if (record?.family !== "Session" || record.kind !== "closed") throw new Error("esperado Session/closed");
    expect(record.scope).toEqual({ kind: "session", ref: sessionId });
    expect(record.content.reason).toBe("other");
  });

  it("reason ausente (null) sai explícito, nunca omitido", async () => {
    const sessionId = "55555555-5555-5555-5555-555555555555";
    const result = await writeSessionClosed({ rootPath: root, projectId, sessionId, reason: null });
    expect(result.ok).toBe(true);

    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    const record = loaded.records[0]?.record;
    if (record?.family !== "Session" || record.kind !== "closed") throw new Error("esperado Session/closed");
    expect("reason" in record.content).toBe(true);
    expect(record.content.reason).toBeNull();
  });

  it("CONTROLE NEGATIVO (fail-open) — rootPath sem Capsule canônica devolve {ok:false}, NUNCA lança", async () => {
    const semCapsule = await fs.mkdtemp(path.join(TMP, "session-events-nocapsule-close-"));
    try {
      const result = await writeSessionClosed({
        rootPath: semCapsule,
        projectId: "prj_00000000000000000000000000",
        sessionId: "66666666-6666-6666-6666-666666666666",
        reason: "other",
      });
      expect(result.ok).toBe(false);
      expect(typeof result.detail).toBe("string");
    } finally {
      await fs.remove(semCapsule);
    }
  });

  it("dois session_id diferentes nunca colidem — cada um sua própria partição por source_ref", async () => {
    await writeSessionStarted({
      rootPath: root,
      projectId,
      sessionId: "77777777-7777-7777-7777-777777777777",
      cwd: root,
      agentRef: null,
      checkpointId: null,
    });
    await writeSessionStarted({
      rootPath: root,
      projectId,
      sessionId: "88888888-8888-8888-8888-888888888888",
      cwd: root,
      agentRef: null,
      checkpointId: null,
    });
    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state !== "LOADED") throw new Error("esperado LOADED");
    expect(loaded.records).toHaveLength(2);
  });
});

/**
 * EVENT-LOG COM SOURCE_REF FIXO VIRA LINHAGEM DIVERGENTE.
 *
 *   ONE SOURCE_REF PER EVENT != ONE SOURCE_REF PER LINEAGE
 *
 * `schemas.ts` declara que cada evento de sessão tem `source_ref` PRÓPRIO,
 * "nunca reusado por outro record", e é por isso que aqui não há chain nem
 * CAS: o orçamento do SessionStart (2700ms) não paga head-resolution para um
 * problema de concorrência que o desenho diz não existir.
 *
 * Só que o `source_ref` era derivado SÓ do `session_id`, e o host dispara
 * SessionStart mais de uma vez para a MESMA sessão. MEDIDO no Store real
 * deste projeto, 5 linhagens com 2 heads cada, em dois cenários distintos:
 *
 *   9 segundos de intervalo, conteúdo IDÊNTICO      → disparo duplo
 *   15 horas de intervalo, checkpoint_id diferente  → resume
 *
 * Nenhum dos dois é corrupção: os records estão corretos. O que quebrou foi a
 * unicidade que o próprio desenho prometeu — e `doctor` passou a reportar
 * `CANONICAL_STORE_UNREADABLE`, um FAIL na base de todo o resto.
 */
describe("registro de sessão é event-log — dois eventos nunca disputam o mesmo source_ref", () => {
  const sessionId = "22222222-2222-2222-2222-222222222222";

  const publicarDuasVezes = async (): Promise<void> => {
    for (const checkpointId of [null, "chk_01M2Y0831HNF38Q9BW9Q34PP34"]) {
      const r = await writeSessionStarted({
        rootPath: root,
        projectId,
        sessionId,
        cwd: root,
        agentRef: null,
        checkpointId,
      });
      expect(r.ok, r.detail).toBe(true);
    }
  };

  it("dois SessionStart da mesma sessão não produzem dois heads no mesmo source_ref", async () => {
    await publicarDuasVezes();

    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state === "UNREADABLE") throw new Error(`Store ilegível: ${JSON.stringify(loaded)}`);

    const porSource = new Map<string, number>();
    for (const { record } of loaded.records) {
      const ref = record.provenance.source_ref;
      porSource.set(ref, (porSource.get(ref) ?? 0) + 1);
    }
    const reusados = [...porSource].filter(([, n]) => n > 1).map(([ref, n]) => `${ref} (${String(n)}x)`);

    expect(reusados, "source_ref reusado por mais de um record — é o que vira DIVERGED no doctor").toEqual([]);
  });

  it("os dois eventos continuam correlacionáveis por scope.ref — a chave de correlação não muda", async () => {
    await publicarDuasVezes();

    const loaded = await loadFamilyForResolution(root, "Session");
    if (loaded.state === "UNREADABLE") throw new Error("Store ilegível");

    const daSessao = loaded.records.filter(
      ({ record }) => (record as { scope?: { ref?: string } }).scope?.ref === sessionId
    );
    expect(daSessao).toHaveLength(2);
  });
});

/**
 * `ONE FAMILY -> ONE HEAD SEMANTICS -> ONE RESOLVER` — o princípio que
 * `reader.ts` já declara para `ProjectCheckpoint` e que `Session` nunca
 * recebeu.
 *
 * `readCurrentRecords` roteia toda family que não seja `ProjectCheckpoint`
 * para `resolveHeadsBySource`, cujo comentário enumera quem usa `source_ref`
 * como identidade lógica: Contract, Decision, Knowledge, Research. `Session`
 * NÃO está nessa lista — é event-log, onde todo evento é corrente e não
 * existe head a resolver — mas cai nesse ramo do mesmo jeito.
 *
 * Consequência: dois eventos que compartilhem `source_ref` viram `DIVERGED`,
 * o Store inteiro é reportado UNREADABLE e o `doctor` acusa FAIL na base de
 * tudo. O mesmo diagnóstico que a docstring de `projectCheckpointHead` faz
 * para a chain de checkpoint: "topologia real saudável", veredito errado.
 *
 * Este teste usa o Store REAL deste repositório, que tem 5 linhagens legadas
 * com `source_ref` repetido — records imutáveis, escritos antes do fix do
 * escritor, que nenhuma migração pode reescrever (`source_ref` é CHAVE DE
 * RECONCILIAÇÃO, estável desde sempre, por `adr-migrator.ts`).
 */
describe("Session é event-log — source_ref repetido não pode tornar o Store ilegível", () => {
  it("dois eventos com o mesmo source_ref não derrubam a leitura do Store", async () => {
    /** Reproduz o legado: dois records da MESMA sessão com o source_ref antigo. */
    const sessionId = "33333333-3333-3333-3333-333333333333";
    const dir = path.join(root, ".nexos", "records", "sessions");
    await fs.ensureDir(dir);
    const antigo = (id: string, at: string): string =>
      [
        "admission:",
        "  approved_at: " + at,
        "  approved_by: policy:nexos-session-start",
        "  status: admitted",
        "content:",
        "  agent_ref: null",
        "  checkpoint_id: null",
        "  cwd: " + root,
        "  host: t",
        "created_at: " + at,
        "family: Session",
        "id: " + id,
        "kind: started",
        "lifecycle: immutable",
        "origin: hook",
        "portability: portable",
        "project_id: " + projectId,
        "provenance:",
        `  producer_id: nexos-session-start`,
        `  source_ref: nexos://session/${sessionId}/started`,
        "  submitted_at: " + at,
        "regenerable: false",
        "schema_version: 1",
        "scope:",
        "  kind: session",
        "  ref: " + sessionId,
        "sensitivity:",
        "  checked_at: " + at,
        "  checker_version: nexos-session-start-1",
        "  classification: internal",
        "version: 1",
        "",
      ].join("\n");
    await fs.writeFile(
      path.join(dir, "ses_01M2YB7VEHPK6CA39E477NZJP3.yaml"),
      antigo("ses_01M2YB7VEHPK6CA39E477NZJP3", "2026-09-20T02:45:03.569Z")
    );
    await fs.writeFile(
      path.join(dir, "ses_01M2YB847SC1J76HMA8HQPSNWS.yaml"),
      antigo("ses_01M2YB847SC1J76HMA8HQPSNWS", "2026-09-20T02:45:12.569Z")
    );

    const { readCurrentRecords } = await import("../src/lib/capsule/reader.js");
    const res = await readCurrentRecords(root);

    expect(res.ok, `Store ilegível: ${JSON.stringify((res as { issues?: unknown }).issues)}`).toBe(true);
    if (res.ok !== true) return;

    /** Os DOIS eventos continuam correntes — event-log não descarta nenhum. */
    const daSessao = res.records.filter(
      (r) => (r.record as { scope?: { ref?: string } }).scope?.ref === sessionId
    );
    expect(daSessao).toHaveLength(2);
  });
});
