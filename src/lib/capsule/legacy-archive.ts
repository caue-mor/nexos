/**
 * Pós-MVP — passo 0-2 do procedimento de migração não destrutiva
 * (`nexos://decision/migracao-legado-estrutura-base-entrypoints`,
 * `docs/pos-mvp-migracao-legado-inventario.md` §10).
 *
 *   SOURCE PRESERVED DURING MIGRATION
 *   ROLLBACK MINE != DELETE THEIRS
 *
 * `nexos init --repair` nunca mais faz `rm -rf` direto sobre legado
 * (`memory/`, `logs/`, famílias de record fora do schema). Este módulo é o
 * único caminho que tira esse conteúdo do lugar: COPIA para
 * `.nexos/.local/legacy-archive/<timestamp>/<caminho>`, RE-HASH sha256 de
 * 100% dos arquivos (origem == destino) e só ENTÃO remove a origem.
 * Qualquer divergência aborta sem mover nada — a origem nunca é tocada antes
 * da cópia estar provada byte-idêntica. A cópia reprovada fica em disco
 * (nunca apagada às cegas) para inspeção — ver `ArchiveIntegrityError`.
 *
 * `.local/` já é área local declarada (LOCAL_ENTRIES, `entries.ts`) e
 * gitignorada pelo próprio init — o archive nunca é versionado.
 */
import { createHash } from "node:crypto";
import { readdir, readFile, stat } from "node:fs/promises";
import path from "node:path";
import fs from "fs-extra";

/** Caminhos relativos a `dir` de todo ARQUIVO sob a árvore, qualquer profundidade. */
export async function listFilesRecursive(dir: string): Promise<string[]> {
  const out: string[] = [];
  async function walk(current: string, relBase: string): Promise<void> {
    let entries;
    try {
      entries = await readdir(current, { withFileTypes: true });
    } catch {
      return;
    }
    for (const entry of entries) {
      const rel = relBase ? path.join(relBase, entry.name) : entry.name;
      if (entry.isDirectory()) {
        await walk(path.join(current, entry.name), rel);
      } else if (entry.isFile()) {
        out.push(rel);
      }
    }
  }
  await walk(dir, "");
  return out;
}

export interface TreeCount {
  readonly files: number;
  readonly bytes: number;
}

/** Contagem READ-ONLY — usada no PLANO (`planRepair`) para mostrar o que vai ser arquivado. */
export async function countTree(dir: string): Promise<TreeCount> {
  const files = await listFilesRecursive(dir);
  let bytes = 0;
  for (const rel of files) {
    try {
      bytes += (await stat(path.join(dir, rel))).size;
    } catch {
      // arquivo sumiu entre o readdir e o stat — conta como 0 bytes, nunca aborta a contagem.
    }
  }
  return { files: files.length, bytes };
}

async function hashTreeFiles(dir: string): Promise<Map<string, string>> {
  const files = await listFilesRecursive(dir);
  const out = new Map<string, string>();
  for (const rel of files) {
    const buf = await readFile(path.join(dir, rel));
    out.set(rel, createHash("sha256").update(buf).digest("hex"));
  }
  return out;
}

export interface ArchiveVerifyResult {
  readonly ok: boolean;
  /** Caminhos relativos com hash divergente (ou presentes só de um lado). */
  readonly mismatches: readonly string[];
}

/**
 * PURA quanto a efeito — só lê as duas árvores e compara sha256 por arquivo.
 * Arquivo presente só de um lado conta como divergência (nunca "OK por
 * ausência" — ABSENCE = FIELD ABSENT não se aplica a prova de integridade).
 */
export async function verifyArchiveIntegrity(sourceDir: string, destDir: string): Promise<ArchiveVerifyResult> {
  const [sourceHashes, destHashes] = await Promise.all([hashTreeFiles(sourceDir), hashTreeFiles(destDir)]);
  const allRel = new Set<string>([...sourceHashes.keys(), ...destHashes.keys()]);
  const mismatches = [...allRel].filter((rel) => sourceHashes.get(rel) !== destHashes.get(rel)).sort();
  return { ok: mismatches.length === 0, mismatches };
}

export interface ArchiveResult extends TreeCount {
  /** `true` quando `sourceDir` já não existia — no-op idempotente, nada foi tocado. */
  readonly skipped: boolean;
}

/** Nome fixo do sentinela — grava DENTRO de toda cópia reprovada, nunca num nome variável (previsível para quem for auditar `legacy-archive/` depois). */
export const REJECTED_SENTINEL_NAME = ".nexos-archive-rejected.json";

export interface RejectedSentinel {
  readonly reason: "integrity_mismatch";
  readonly mismatches: readonly string[];
  readonly sourceDir: string;
  readonly verifiedAt: string;
}

/**
 * Lançado por `archiveTree` quando a verificação de integridade reprova a
 * cópia. Carrega `sourceDir`/`destDir`/`mismatches` estruturados — quem
 * captura (`applyRepair`) monta a mensagem limpa para o CLI sem precisar
 * reparsear `.message`. `copyRetained` distingue as duas saídas possíveis:
 * cópia marcada com o sentinela e mantida (`true`) vs. sentinela ingravável
 * e cópia removida por segurança (`false`, `destDir` não existe mais).
 */
export class ArchiveIntegrityError extends Error {
  constructor(
    message: string,
    readonly sourceDir: string,
    readonly destDir: string,
    readonly mismatches: readonly string[],
    readonly copyRetained: boolean
  ) {
    super(message);
    this.name = "ArchiveIntegrityError";
  }
}

async function writeRejectedSentinel(destDir: string, sentinel: RejectedSentinel): Promise<void> {
  await fs.writeJson(path.join(destDir, REJECTED_SENTINEL_NAME), sentinel, { spaces: 2 });
}

/**
 * COPIA `sourceDir` -> `destDir`, VERIFICA sha256 de 100% dos arquivos, e só
 * ENTÃO remove `sourceDir`. Divergência de qualquer arquivo aborta SEM MOVER
 * A ORIGEM.
 *
 * A cópia reprovada NUNCA fica em disco SEM MARCADOR — mesmo padrão de
 * caminho de um archive válido (`<timestamp>/<rel>`) faria uma execução
 * seguinte bem-sucedida do MESMO item (`<timestamp2>/<rel>`) tornar as duas
 * indistinguíveis no disco depois que a mensagem de erro (só no terminal)
 * some. Por isso: grava `REJECTED_SENTINEL_NAME` DENTRO de `destDir` antes
 * de lançar — `{reason, mismatches, sourceDir, verifiedAt}`. Se ATÉ o
 * sentinela falhar ao gravar (destino ilegível/sem espaço/permissão), a
 * cópia é removida por segurança — preferir NENHUMA cópia a uma cópia
 * reprovada sem prova de que é reprovada.
 *
 * Idempotente: `sourceDir` ausente (já arquivado por uma chamada anterior,
 * ou nunca existiu) devolve `skipped: true` sem tocar em nada — nunca lança
 * ENOENT por cima de um item que já saiu do lugar.
 */
export async function archiveTree(
  sourceDir: string,
  destDir: string,
  verify: (source: string, dest: string) => Promise<ArchiveVerifyResult> = verifyArchiveIntegrity,
  /**
   * Injeção de teste, mesmo padrão de `verify` acima: produção nunca passa
   * nada (usa `writeRejectedSentinel` real, grava no filesystem).
   */
  writeSentinel: (destDir: string, sentinel: RejectedSentinel) => Promise<void> = writeRejectedSentinel
): Promise<ArchiveResult> {
  if (!(await fs.pathExists(sourceDir))) {
    return { files: 0, bytes: 0, skipped: true };
  }

  await fs.copy(sourceDir, destDir, { overwrite: true, errorOnExist: false });

  const verified = await verify(sourceDir, destDir);
  if (!verified.ok) {
    const sentinel: RejectedSentinel = {
      reason: "integrity_mismatch",
      mismatches: verified.mismatches,
      sourceDir,
      verifiedAt: new Date().toISOString(),
    };

    let copyRetained = true;
    try {
      await writeSentinel(destDir, sentinel);
    } catch {
      copyRetained = false;
      await fs.remove(destDir).catch(() => {});
    }

    const mismatchSummary =
      `verificação de integridade falhou (${verified.mismatches.length} arquivo(s) divergente(s): ` +
      `${verified.mismatches.slice(0, 5).join(", ")}) — nada foi movido, origem intocada em ${sourceDir}; `;
    const copyNote = copyRetained
      ? `cópia NÃO CONFIÁVEL descartada (não usada como archive), mantida em ${destDir} para inspeção — ` +
        `marcada com ${REJECTED_SENTINEL_NAME} (motivo + arquivos divergentes registrados ali).`
      : `cópia NÃO CONFIÁVEL não pôde ser marcada com ${REJECTED_SENTINEL_NAME} (sentinela ingravável) e foi ` +
        `removida por segurança — nenhuma cópia sem marcador fica em disco.`;

    throw new ArchiveIntegrityError(mismatchSummary + copyNote, sourceDir, destDir, verified.mismatches, copyRetained);
  }

  const counted = await countTree(sourceDir);
  await fs.remove(sourceDir);
  return { ...counted, skipped: false };
}

/** `<ISO sem : nem .>` — nome de diretório seguro em qualquer filesystem, ordenável por criação. */
export function newArchiveTimestamp(): string {
  return new Date().toISOString().replace(/[:.]/g, "-");
}
