import fs from "fs-extra";
import path from "node:path";
import { createHash } from "node:crypto";
import { CLAUDE_DIR, BACKUP_DIR } from "./constants.js";

interface BackupManifest {
  createdAt: string;
  targets: string[];
  reason: string;
  /** Ausente = backup pré-hardening (legado); sem hash gravado não há o que verificar. */
  hashes?: Record<string, string>;
}

/** `lstat`, nunca `stat` — não pode seguir o link para decidir se é link. */
async function assertNoSymlink(target: string): Promise<void> {
  const stat = await fs.lstat(target);
  if (stat.isSymbolicLink()) {
    throw new Error(`backup recusado: "${target}" é symlink — o alvo real fica fora do caminho esperado`);
  }
  if (stat.isDirectory()) {
    for (const entry of await fs.readdir(target)) {
      await assertNoSymlink(path.join(target, entry));
    }
  }
}

/** sha256 recursivo determinístico: nome+hash por entrada, ordenado — não depende do path absoluto. */
async function hashPath(target: string): Promise<string> {
  const stat = await fs.lstat(target);
  if (stat.isDirectory()) {
    const hash = createHash("sha256");
    for (const entry of [...(await fs.readdir(target))].sort()) {
      hash.update(entry).update(await hashPath(path.join(target, entry)));
    }
    return hash.digest("hex");
  }
  return createHash("sha256").update(await fs.readFile(target)).digest("hex");
}

export async function createBackup(): Promise<string> {
  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `pre-nexos-${timestamp}`);

  await fs.ensureDir(backupPath);

  // Backup only the files we'll modify
  const targets = ["CLAUDE.md", "settings.json", "agents", "skills", "commands", "rules", "hooks", "agent-memory"];
  const hashes: Record<string, string> = {};

  for (const target of targets) {
    const src = path.join(CLAUDE_DIR, target);
    if (await fs.pathExists(src)) {
      await assertNoSymlink(src);
      const dest = path.join(backupPath, target);
      await fs.copy(src, dest, { overwrite: true });
      hashes[target] = await hashPath(dest);
    }
  }

  // Write backup manifest
  const manifest: BackupManifest = {
    createdAt: new Date().toISOString(),
    targets,
    reason: "pre-nexos-install",
    hashes,
  };
  await fs.writeJson(path.join(backupPath, "manifest.json"), manifest);

  return backupPath;
}

export async function restoreBackup(backupPath: string): Promise<void> {
  const manifest = (await fs.readJson(path.join(backupPath, "manifest.json"))) as BackupManifest;

  // Verifica TUDO (symlink + hash) antes de escrever qualquer coisa — restore é tudo-ou-nada,
  // nunca deixa CLAUDE_DIR pela metade se um alvo estiver corrompido ou adulterado.
  for (const target of manifest.targets) {
    const src = path.join(backupPath, target);
    if (!(await fs.pathExists(src))) continue;
    await assertNoSymlink(src);

    const recorded = manifest.hashes?.[target];
    if (recorded !== undefined) {
      const actual = await hashPath(src);
      if (actual !== recorded) {
        throw new Error(
          `restore recusado: "${target}" não bate com o hash gravado no backup ` +
            `(esperado ${recorded}, achado ${actual}) — corrompido ou adulterado desde a criação`
        );
      }
    }
  }

  for (const target of manifest.targets) {
    const src = path.join(backupPath, target);
    if (await fs.pathExists(src)) {
      const dest = path.join(CLAUDE_DIR, target);
      await fs.copy(src, dest, { overwrite: true });
    }
  }
}

interface PathBackupManifest {
  createdAt: string;
  /** Paths relativos a CLAUDE_DIR — exatamente o que o plano ia sobrescrever/remover. */
  paths: string[];
  reason: string;
  hashes: Record<string, string>;
}

/**
 * Backup escopado aos paths EXATOS que um plano de install vai sobrescrever
 * ou remover — nunca a árvore inteira de um componente (P1.3i-fix,
 * chk_01M2NT7Q7QE93GM00VW5AAZG8M). `createBackup()` acima copia
 * `agents/skills/.../hooks/` inteiros e `assertNoSymlink` trava em QUALQUER
 * symlink em qualquer lugar dessas árvores — inclusive um totalmente alheio
 * ao que o plano ia tocar (ex.: `~/.claude/skills/cua-driver`, symlink do
 * dono). `nexos install` usa ESTA função; `nexos uninstall` continua usando
 * `createBackup()`/`restoreBackup()` acima, sem mudança.
 *
 * VALIDA TUDO (existência + symlink) ANTES de criar o diretório de backup —
 * um symlink em QUALQUER alvo recusa a operação inteira, sem escrever nada,
 * nem `backups/`.
 */
export async function createPathBackup(absolutePaths: readonly string[]): Promise<string> {
  const existing: string[] = [];
  for (const target of absolutePaths) {
    if (await fs.pathExists(target)) existing.push(target);
  }

  for (const target of existing) {
    await assertNoSymlink(target);
  }

  const timestamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  const backupPath = path.join(BACKUP_DIR, `pre-nexos-install-${timestamp}`);
  await fs.ensureDir(backupPath);

  const relPaths: string[] = [];
  const hashes: Record<string, string> = {};
  for (const target of existing) {
    const rel = path.relative(CLAUDE_DIR, target);
    const dest = path.join(backupPath, rel);
    await fs.ensureDir(path.dirname(dest));
    await fs.copy(target, dest, { overwrite: true });
    hashes[rel] = await hashPath(dest);
    relPaths.push(rel);
  }

  const manifest: PathBackupManifest = {
    createdAt: new Date().toISOString(),
    paths: relPaths,
    reason: "pre-nexos-install (plan-scoped)",
    hashes,
  };
  await fs.writeJson(path.join(backupPath, "manifest.json"), manifest);

  return backupPath;
}

export async function restorePathBackup(backupPath: string): Promise<void> {
  const manifest = (await fs.readJson(path.join(backupPath, "manifest.json"))) as PathBackupManifest;

  // Verifica TUDO (symlink + hash) antes de escrever qualquer coisa — restore
  // é tudo-ou-nada, nunca deixa CLAUDE_DIR pela metade.
  for (const rel of manifest.paths) {
    const src = path.join(backupPath, rel);
    if (!(await fs.pathExists(src))) continue;
    await assertNoSymlink(src);

    const recorded = manifest.hashes[rel];
    if (recorded !== undefined) {
      const actual = await hashPath(src);
      if (actual !== recorded) {
        throw new Error(
          `restore recusado: "${rel}" não bate com o hash gravado no backup ` +
            `(esperado ${recorded}, achado ${actual}) — corrompido ou adulterado desde a criação`
        );
      }
    }
  }

  for (const rel of manifest.paths) {
    const src = path.join(backupPath, rel);
    if (await fs.pathExists(src)) {
      const dest = path.join(CLAUDE_DIR, rel);
      await fs.copy(src, dest, { overwrite: true });
    }
  }
}

export async function listBackups(): Promise<string[]> {
  if (!await fs.pathExists(BACKUP_DIR)) return [];
  const entries = await fs.readdir(BACKUP_DIR);
  return entries
    .filter((e) => e.startsWith("pre-nexos-"))
    .sort()
    .reverse();
}
