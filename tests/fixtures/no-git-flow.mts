/**
 * Fluxo completo do Capsule executado em processo com PATH sem git.
 *
 * Roda como SUBPROCESSO (ver A06 em capsule-acceptance.test.ts) porque a
 * ausência de git precisa valer para o processo inteiro — mexer no PATH do
 * runner do vitest contaminaria as outras suítes.
 *
 * `PATH="" ` e `PATH=<dir vazio>` escondem o binário; PATH *ausente* NÃO —
 * o execvp cai no default do sistema (`/usr/bin`) e acha o git. Medido.
 *
 * Emite uma linha JSON em stdout. Qualquer throw vira exit != 0.
 */
import { mkdtemp, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import { execFileSync } from "node:child_process";

import { resolveProject } from "../../src/lib/project-resolver.js";
import { initializeCapsule } from "../../src/lib/capsule/initializer.js";
import { publishCanonical } from "../../src/lib/capsule/store.js";
import { scanIntegrity } from "../../src/lib/capsule/integrity.js";
import { inspectGitBoundary } from "../../src/lib/capsule/git-boundary.js";
import { newRecordId } from "../../src/lib/capsule/ids.js";
import type { CapsuleRecord } from "../../src/lib/capsule/schemas.js";

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`no-git-flow: ${message}`);
}

/** Confirma que a premissa do teste vale — sem isto, um PASS não significa nada. */
function gitReallyAbsent(): boolean {
  try {
    execFileSync("git", ["--version"], { stdio: "ignore" });
    return false;
  } catch {
    return true;
  }
}

function decision(projectId: string): CapsuleRecord {
  const now = "2026-08-12T12:00:00.000Z";
  return {
    schema_version: 1,
    id: newRecordId("Decision"),
    project_id: projectId,
    family: "Decision",
    scope: "project",
    origin: "human",
    provenance: { source_ref: "no-git-flow", producer_id: "human:steve", submitted_at: now },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:steve", approved_at: now },
    sensitivity: { classification: "internal", checked_at: now, checker_version: "0.1.0" },
    created_at: now,
    version: 1,
    content: {
      title: "funciona sem git",
      context: "git é transporte opcional (ADR-044)",
      decision: "o núcleo não depende de git",
      consequences: ["boundary de portabilidade vira inaplicável, não inválida"],
    },
  } as CapsuleRecord;
}

const out: Record<string, unknown> = {};

const ws = await mkdtemp(path.join(tmpdir(), "nogit-"));
const root = path.join(ws, "proj");
await mkdtemp(root).catch(() => {});
const { mkdir } = await import("node:fs/promises");
await mkdir(root, { recursive: true });
await writeFile(path.join(root, "package.json"), '{"name":"nogit"}\n');

out.gitAbsent = gitReallyAbsent();
assert(out.gitAbsent, "premissa falhou: git ainda está acessível no PATH");

// 1 — bootstrap sem capsule
const antes = await resolveProject({ cwd: root });
out.bootstrapWorks = antes.identitySource === "bootstrap" && antes.bootstrapLocator.startsWith("prj_");
out.gitRemoteUndefined = antes.aliases.gitRemote === undefined;

// 2 — initialize
const init = await initializeCapsule(root, { projectName: "nogit" });
out.initializeWorks = init.created === true;

// 3 — identidade canônica
const depois = await resolveProject({ cwd: root });
out.canonicalWorks =
  depois.identitySource === "manifest" && depois.canonicalProjectId === init.projectId;

// 4 — publish
const rec = decision(init.projectId);
const published = await publishCanonical(root, rec);
out.publishWorks = published.outcome === "CREATED";

// 5 — integrity
const scan = await scanIntegrity(root);
out.integrityWorks = scan.ok === true && scan.recordsScanned === 1;

// 6 — git boundary reporta inaplicável, não corrupção
const boundary = await inspectGitBoundary(root);
out.boundaryState = boundary.state;
out.boundaryApplicable = boundary.applicable;
out.boundaryNullMeasurements = boundary.localIgnored === null && boundary.canonicalTrackable === null;

console.log(JSON.stringify(out));
