/**
 * C2.2.5b — cálculo de paths do Capsule.
 *
 * `PATH CALCULATION != PROJECT RESOLUTION`. Este módulo recebe um root JÁ
 * RESOLVIDO e apenas calcula. Nunca sobe ancestrais, nunca olha git, nunca lê
 * `process.cwd()`. Descobrir o projeto é do ProjectResolver.
 *
 * `PATH != IDENTITY` (D7): o path deriva da identidade do record; jamais o
 * contrário.
 */
import path from "node:path";
import { parseRecordId, type RecordFamily } from "./ids.js";

/** As families canônicas ARMAZENÁVEIS como record. ProjectIdentity vive no manifest. */
const FAMILY_DIR: Record<RecordFamily, string> = {
  ProjectContract: "contracts",
  ProjectCheckpoint: "checkpoints",
  Decision: "decisions",
  KnowledgeRecord: "knowledge",
  Research: "research",
  Session: "sessions",
};

export const CANONICAL_FAMILIES = Object.keys(FAMILY_DIR) as RecordFamily[];

export class CapsulePathError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CapsulePathError";
  }
}

export interface CapsulePaths {
  readonly root: string;

  /** Envelope de bootstrap. NÃO é um record — daí API própria. */
  manifest(): string;
  capsuleDir(): string;
  capsuleGitignore(): string;

  recordsRoot(): string;
  familyDir(family: RecordFamily): string;
  /** Path canônico de um record. Rejeita family não-armazenável e prefixo divergente. */
  recordPath(family: RecordFamily, recordId: string): string;

  localRoot(): string;
  proposals(): string;
  rejectedProposals(): string;
  /**
   * Pós-MVP — passo 0-2 da migração não destrutiva (`legacy-archive.ts`).
   * `.nexos/.local/legacy-archive/<timestamp>/<caminho>` recebe a CÓPIA
   * verificada (sha256) de todo legado que `nexos init --repair` tira do
   * lugar (memory/, logs/, famílias fora do schema) — nunca a origem
   * removida sem cópia provada primeiro. Sob `.local/`: nunca versionado.
   */
  legacyArchiveRoot(): string;
  /** Staging de publicação. Operational, NUNCA sob records/ — um `.tmp` lá seria
   *  confundido por scanner, git ou observador com um record canônico. */
  publishStaging(): string;
  runtimeState(): string;
  /**
   * Terminal Observability (nexos://decision/statusline-global-terminal-observability)
   * — snapshot barato lido pelo renderer da statusline global instalado por
   * `nexos install` (`assets/statusline/nexos-statusline.mjs`). Gravado por
   * `nexos state`/`nexos checkpoint` ao fim de cada escrita bem-sucedida.
   * Nunca um record canônico — mesma classe operacional de `runtimeState`.
   */
  runtimeStatusline(): string;
  derived(): string;
  host(targetHost?: string): string;

  /**
   * P1.3 (nexos://decision/p1-3-bootstrap-e-migrate-repair) — o Project Map.
   * Portável (versionado), nunca sob `.local/`: `.nexos/map/project.json` são
   * os fatos OBSERVED com proveniência. `.nexos/project.yaml` (projeção
   * legível do manifest) saiu no P1.3c — `manifest.yaml` é o único contrato.
   */
  mapRoot(): string;
  mapProjectJson(): string;
  /** P1.4 (nexos://decision/p1-4-map-v1-routes-db-graph) — os demais artefatos do Project Map. */
  mapRoutesJson(): string;
  mapDatabaseJson(): string;
  mapGraphJson(): string;
  mapArchitectureMd(): string;
}

/**
 * `rootPath` aqui é um root JÁ RESOLVIDO — esta função só CALCULA paths sobre
 * ele, nunca decide qual root é o certo (ver docstring do módulo acima).
 *
 * `RESOLVED` tem DUAS camadas independentes, ambas fora daqui:
 *   1. ProjectResolver decide QUAL projeto (`resolveProject`).
 *   2. `resolveReadRoot`/`peekActiveRoot`/`resolveActiveRoot` (`authority.ts`)
 *      decidem QUAL CHECKOUT desse projeto é a authority — dois checkouts do
 *      MESMO `project_id` calculam paths DIFERENTES aqui se receberem roots
 *      diferentes, e nada NESTA função detecta ou corrige isso.
 *
 * `LEITURA DE RECORDS CANÔNICOS DEVE PASSAR PELO HELPER, NÃO POR `forProject`
 * DIRETO SOBRE UM ROOT CRU`: chamar `forProject(candidateRoot)` para listar/
 * ler uma family (`familyDir`/`recordPath` usados para varrer um diretório)
 * sem primeiro resolver `candidateRoot` via `resolveReadRoot` (`authority.ts`)
 * é o defeito medido em 2026-09-05 — seis módulos faziam exatamente isso e um
 * checkout não-authority via a própria partição vazia/órfã em vez da verdade
 * do projeto. Escrita já passa por `resolveActiveRoot` dentro de
 * `publishCanonical`/`publishSuperseding`; leitura fora de
 * `readCurrentRecords` (`reader.ts`) precisa chamar `resolveReadRoot` primeiro
 * — este arquivo não tem como impor isso, só avisar.
 */
export function forProject(rootPath: string): CapsulePaths {
  if (!rootPath || !path.isAbsolute(rootPath)) {
    throw new CapsulePathError(
      `forProject exige um root absoluto já resolvido; recebeu: ${JSON.stringify(rootPath)}`
    );
  }
  const capsule = path.join(rootPath, ".nexos");
  const records = path.join(capsule, "records");
  const local = path.join(capsule, ".local");

  return {
    root: rootPath,

    manifest: () => path.join(capsule, "manifest.yaml"),
    capsuleDir: () => capsule,
    capsuleGitignore: () => path.join(capsule, ".gitignore"),

    recordsRoot: () => records,
    familyDir: (family) => path.join(records, requireFamilyDir(family)),
    recordPath: (family, recordId) => {
      const dir = requireFamilyDir(family);
      assertIdMatchesFamily(recordId, family);
      return path.join(records, dir, `${recordId}.yaml`);
    },

    localRoot: () => local,
    proposals: () => path.join(local, "proposals"),
    rejectedProposals: () => path.join(local, "proposals", "rejected"),
    legacyArchiveRoot: () => path.join(local, "legacy-archive"),
    publishStaging: () => path.join(local, "publish"),
    runtimeState: () => path.join(local, "runtime", "state"),
    runtimeStatusline: () => path.join(local, "runtime", "statusline.json"),
    derived: () => path.join(local, "derived"),
    host: (targetHost) =>
      targetHost ? path.join(local, "host", targetHost) : path.join(local, "host"),

    mapRoot: () => path.join(capsule, "map"),
    mapProjectJson: () => path.join(capsule, "map", "project.json"),
    mapRoutesJson: () => path.join(capsule, "map", "routes.json"),
    mapDatabaseJson: () => path.join(capsule, "map", "database.json"),
    mapGraphJson: () => path.join(capsule, "map", "graph.json"),
    mapArchitectureMd: () => path.join(capsule, "map", "architecture.md"),
  };
}

function requireFamilyDir(family: string): string {
  const dir = FAMILY_DIR[family as RecordFamily];
  if (!dir) {
    throw new CapsulePathError(
      `family "${family}" não tem storage canônico. ` +
        `RuntimeState e RuntimeEvent são LOCAIS; ProjectIdentity vive no manifest. ` +
        `Canônicas armazenáveis: ${CANONICAL_FAMILIES.join(", ")}`
    );
  }
  return dir;
}

/**
 * O id declara a family pelo prefixo. Divergência é erro ANTES de gerar path —
 * não se espera o schema pegar depois: um `dec_…` gravado em `knowledge/` já
 * seria violação de I0 em disco.
 */
function assertIdMatchesFamily(recordId: string, family: RecordFamily): void {
  const parsed = parseRecordId(recordId);
  if (!parsed) {
    throw new CapsulePathError(`record id malformado: ${JSON.stringify(recordId)}`);
  }
  if (parsed.family !== family) {
    throw new CapsulePathError(
      `prefixo "${parsed.prefix}_" pertence a ${parsed.family}, mas family declarada é ${family}`
    );
  }
}
