/** Decisões de continuidade são contexto, nunca grants ou settings do host. */
import { z } from "zod";
import { resolveProject } from "../lib/project-resolver.js";
import { readCurrentRecords, resolveCheckpointHead, checkpointWorkContext } from "../lib/capsule/reader.js";
import { resolveReadRoot } from "../lib/capsule/authority.js";
import { loadIntegrityCache, saveIntegrityCacheIfDirty } from "../lib/capsule/integrity-cache.js";
import { newRecordId } from "../lib/capsule/ids.js";
import { publishSuperseding, StoreBoundaryError } from "../lib/capsule/store.js";
import type { CapsuleRecord } from "../lib/capsule/schemas.js";

type DecisionRecord = Extract<CapsuleRecord, { family: "Decision" }>;
const PREFIX = "nexos://decision/";
const PRODUCER = "nexos-decision";
const Input = z.object({
  cwd: z.string().optional(),
  key: z.string().regex(/^[a-z0-9][a-z0-9_-]{0,79}$/).optional(),
  set: z.string().min(1).max(4000).optional(),
  type: z.enum(["decision", "preference", "constraint"]).optional(),
  source: z.string().min(1).max(1000).optional(),
  applicability: z.string().min(1).max(2000).optional(),
  conditions: z.string().min(1).max(2000).optional(),
  work: z.boolean().optional(),
  expected: z.string().regex(/^dec_[0-9A-Z]{26}$/).optional(),
  revoke: z.string().regex(/^dec_[0-9A-Z]{26}$/).optional(),
  why: z.string().min(1).max(2000).optional(),
});
export type DecisionOptions = z.input<typeof Input>;

export async function publishContextDecision(raw: DecisionOptions): Promise<DecisionRecord> {
  const input = Input.parse(raw);
  if (!!input.set === !!input.revoke) throw new Error("Informe --set ou --revoke, exclusivamente.");
  if (!input.source) throw new Error("--source exige a referência real da fonte relatada; não comprova identidade humana.");
  if (input.revoke && !input.why) throw new Error("--revoke exige --why.");
  if (input.set && (!input.key || !input.type || !input.applicability)) {
    throw new Error("--set exige --key, --type e --applicability.");
  }
  const resolution = await resolveProject({ cwd: input.cwd ?? process.cwd() });
  if (!resolution.canonicalProjectId || !resolution.rootPath) throw new Error("Projeto sem identidade canônica.");
  const root = await resolveReadRoot(resolution.rootPath);
  // Sem o cache, toda escrita reparseava e revalidava a família inteira: 120
  // escritas seguidas custavam O(n²) e estouravam 30s no runner do CI (run
  // 35852583909). Cache é derivado e fail-open — nunca decide o que é head.
  const integrityCache = await loadIntegrityCache(root);
  const read = async (): Promise<DecisionRecord[]> => {
    const result = await readCurrentRecords(root, {
      families: ["Decision"], includeDeprecated: true, failOnAnomaly: true, integrityCache,
    });
    if (!result.ok) throw new StoreBoundaryError("Decision ilegível ou divergente; nenhuma escrita.");
    return result.records.flatMap((r) => r.record.family === "Decision" ? [r.record] : []);
  };
  // Só o --revoke precisa desta leitura; no --set o head vem do readHead sob lock.
  // Lê-la sempre dobrava o custo de toda escrita (O(n) por família, medido 23/09).
  const revoked = input.revoke
    ? (await read()).find((r) => r.id === input.revoke && r.content.continuity)
    : undefined;
  if (input.revoke && !revoked) throw new Error("--revoke exige o head atual de uma decisão de continuidade deste projeto.");
  const sourceRef = revoked?.provenance.source_ref ?? `${PREFIX}${input.key}`;
  const expected = input.revoke ?? input.expected;
  let workRef: string | undefined;
  if (input.work) {
    const work = checkpointWorkContext(await resolveCheckpointHead(root, { families: ["ProjectCheckpoint"] }));
    if (work.kind !== "current") {
      throw new Error("--work exige uma origem atual íntegra; FAILED mantém o trabalho, SUCCEEDED o encerra.");
    }
    workRef = work.origin;
  }
  const id = newRecordId("Decision");
  const now = new Date().toISOString();
  const result = await publishSuperseding(root, {
    family: "Decision", sourceRef,
    readHead: async () => (await read()).find((r) => r.provenance.source_ref === sourceRef),
    buildRecord: (head) => {
      if (head?.id !== expected) throw new StoreBoundaryError("HEAD_CHANGED: releia a decisão e informe --expected; não sobrescreva revogação concorrente.");
      if (head && !head.content.continuity) throw new StoreBoundaryError("A linhagem não é uma decisão de continuidade.");
      const continuity = input.revoke && head?.content.continuity
        ? { ...head.content.continuity, status: "revoked" as const, reported_source_ref: input.source!, revocation_reason: input.why! }
        : {
            type: input.type!, status: "active" as const,
            reported_source_ref: input.source!, applicability: input.applicability!,
            ...(input.conditions ? { conditions: input.conditions } : {}),
            ...(workRef ? { work_ref: workRef } : {}),
          };
      return {
        schema_version: 1, id, project_id: resolution.canonicalProjectId,
        family: "Decision", scope: "project", origin: "agent",
        provenance: { source_ref: sourceRef, producer_id: PRODUCER, submitted_at: now },
        lifecycle: "immutable", portability: "portable", regenerable: false,
        admission: { status: "admitted", approved_by: `policy:${PRODUCER}`, approved_at: now },
        sensitivity: { classification: "internal", checked_at: now, checker_version: `${PRODUCER}-1` },
        created_at: now, version: (head?.version ?? 0) + 1,
        ...(head ? { supersedes: head.id } : {}),
        content: { title: head?.content.title ?? input.key!, decision: input.set ?? head!.content.decision, continuity },
      };
    },
  });
  await saveIntegrityCacheIfDirty(integrityCache);
  if (result.record.family !== "Decision") throw new Error("Store retornou family inesperada.");
  return result.record;
}

export async function decision(options: DecisionOptions = {}): Promise<void> {
  try {
    if (options.set !== undefined || options.revoke !== undefined) {
      const record = await publishContextDecision(options);
      console.log(JSON.stringify({ id: record.id, source_ref: record.provenance.source_ref, status: record.content.continuity?.status, authority: "context-only" }));
      return;
    }
    const resolution = await resolveProject({ cwd: options.cwd ?? process.cwd() });
    if (!resolution.canonicalProjectId || !resolution.rootPath) throw new Error("Projeto sem identidade canônica.");
    const result = await readCurrentRecords(resolution.rootPath, { families: ["Decision"], failOnAnomaly: true });
    if (!result.ok) throw new Error("Decision ilegível ou divergente.");
    const records = result.records.filter((r) => r.record.family === "Decision" && r.record.content.continuity);
    const hasWork = records.some((r) => r.record.family === "Decision" && r.record.content.continuity?.work_ref);
    const work = hasWork ? checkpointWorkContext(await resolveCheckpointHead(resolution.rootPath, { families: ["ProjectCheckpoint"] })) : undefined;
    if (work?.kind === "undetermined") console.error("CONTINUITY_CONTEXT_INCOMPLETE: cadeia de trabalho ilegível ou ausente; a listagem não prova aplicabilidade atual.");
    console.log(JSON.stringify(records.map((r) => {
      const ref = r.record.family === "Decision" ? r.record.content.continuity?.work_ref : undefined;
      const applicability = !ref ? "project" : work?.kind === "undetermined" ? "undetermined" : work?.kind === "current" && work.origin === ref ? "current" : "historical";
      return { id: r.record.id, source_ref: r.sourceRef, content: r.record.content, origin: r.record.origin, applicability, authority: "context-only" };
    })));
  } catch (error) {
    console.error(`[nexos decision] ${error instanceof Error ? error.message : String(error)}`);
    process.exitCode = 1;
  }
}
