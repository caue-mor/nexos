/**
 * 03e (custo da etapa de evidência, medido pelo orquestrador: 160-290ms) —
 * cache de validação por hash de conteúdo para `.nexos/.local/evidence/*.json`,
 * MESMO padrão de `capsule/integrity-cache.ts` (content-addressed, só grava o
 * que já foi provado válido, fail-open total), arquivo PRÓPRIO porque o tipo
 * guardado é outro (`EvidenceRecord`, JSON — não `CapsuleRecord`, YAML) e o
 * escopo de correção é outro (Evidence nunca passa por `isCanonicalForm`,
 * não tem noção de "forma canônica").
 *
 *   DERIVED CACHE != AUTHORITY
 *
 * `loadEvidenceDiagnostics` (`evidence.ts`) precisa da lista INTEIRA (para
 * decidir "record mais recente supersede o nomeado" — `resolveNamedEvidence`
 * usa `records` inteiro, não só o id declarado) — não dá para evitar ler os
 * 600 arquivos do repo real, só o CUSTO de parsear+validar cada um de novo a
 * cada SessionStart quando o conteúdo não mudou (Evidence é write-once: uma
 * vez gravado, um arquivo `ev_*.json` nunca é editado — só arquivos NOVOS
 * aparecem entre uma varredura e outra).
 */
import { readFile } from "node:fs/promises";
import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { forProject } from "./capsule/paths.js";
import type { EvidenceRecord } from "./evidence.js";

/**
 * 03e (iteração 4, orquestrador — "CACHE NÃO É AUTORIDADE") — mesmo
 * princípio de `capsule/integrity-cache.ts` (`validatorFingerprint`, ver a
 * docstring lá para o racional completo): `EVIDENCE_CACHE_VERSION` manual
 * dependia de alguém lembrar de bumpar ao mexer no validador
 * (`evidenceRecordSchema`, `evidence.ts`). Hash do CONTEÚDO de `evidence.ts`
 * em si fecha essa dependência — qualquer byte alterado no validador muda o
 * fingerprint, cache inteiro invalida sozinho.
 */
let validatorFingerprintPromise: Promise<string> | undefined;

async function validatorFingerprint(): Promise<string> {
  validatorFingerprintPromise ??= (async () => {
    const dir = path.dirname(fileURLToPath(import.meta.url));
    const ext = path.extname(fileURLToPath(import.meta.url));
    const raw = await readFile(path.join(dir, `evidence${ext}`), "utf-8");
    return sha1HexOf(raw);
  })();
  return validatorFingerprintPromise;
}

const EVIDENCE_CACHE_VERSION = 1;
const CACHE_FILE_NAME = "evidence-cache.json";

export interface EvidenceCache {
  readonly entries: Map<string, EvidenceRecord>;
  dirty: boolean;
}

export function sha1HexOf(raw: string): string {
  return crypto.createHash("sha1").update(raw, "utf-8").digest("hex");
}

function cachePath(rootPath: string): string {
  return path.join(forProject(rootPath).derived(), CACHE_FILE_NAME);
}

interface OnDiskShape {
  /** `${EVIDENCE_CACHE_VERSION}:${validatorFingerprint}` — ver `validatorFingerprint()` acima. */
  readonly version: string;
  readonly entries: Record<string, EvidenceRecord>;
}

function isOnDiskShape(value: unknown): value is OnDiskShape {
  return (
    typeof value === "object" &&
    value !== null &&
    typeof (value as { version?: unknown }).version === "string" &&
    typeof (value as { entries?: unknown }).entries === "object" &&
    (value as { entries?: unknown }).entries !== null
  );
}

async function currentVersionTag(): Promise<string> {
  return `${EVIDENCE_CACHE_VERSION}:${await validatorFingerprint()}`;
}

/** Fail-open: ausente, JSON inválido ou versão divergente devolve cache VAZIO, nunca lança. */
export async function loadEvidenceCache(rootPath: string): Promise<EvidenceCache> {
  try {
    const raw = await readFile(cachePath(rootPath), "utf-8");
    const parsed: unknown = JSON.parse(raw);
    if (!isOnDiskShape(parsed) || parsed.version !== (await currentVersionTag())) {
      return { entries: new Map(), dirty: false };
    }
    return { entries: new Map(Object.entries(parsed.entries)), dirty: false };
  } catch {
    return { entries: new Map(), dirty: false };
  }
}

/**
 * Escreve só se `cache.dirty`. Escrita atômica: arquivo temporário com
 * sufixo aleatório, depois `rename` — mesmo padrão de `integrity-cache.ts`.
 * NUNCA lança: falha ao persistir custa uma corrida futura mais lenta, nunca
 * o resultado da varredura atual.
 */
export async function saveEvidenceCacheIfDirty(rootPath: string, cache: EvidenceCache): Promise<void> {
  if (!cache.dirty) return;
  try {
    const target = cachePath(rootPath);
    await fs.ensureDir(path.dirname(target));
    const onDisk: OnDiskShape = {
      version: await currentVersionTag(),
      entries: Object.fromEntries(cache.entries),
    };
    const temporary = `${target}.${process.pid}-${crypto.randomBytes(4).toString("hex")}.tmp`;
    await fs.writeFile(temporary, `${JSON.stringify(onDisk)}\n`, "utf-8");
    await fs.rename(temporary, target);
  } catch {
    /* cache é otimização — falha ao gravar não pode custar a varredura que já rodou */
  }
}
