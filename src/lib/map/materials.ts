/**
 * P1.4 fatia A (A7) — classificação de MATERIAIS: subárvores que existem no
 * repositório mas não são código da app sendo mapeada. PURA: recebe a lista
 * de paths já enumerada por `map-scan.ts` (I/O) + os globs de workspace já
 * lidos do `package.json`/`pnpm-workspace.yaml` da raiz, devolve a
 * classificação — nunca apaga nada, nunca decide sozinha por
 * `vendored_dependency` (isso exige o grafo de imports, ver `upgradeVendored`).
 *
 *   separate_package: subdiretório com manifest próprio que NÃO é workspace
 *   declarado da raiz — ex.: `src/vendor/<sdk>/package.json` sem entrada em
 *   `workspaces`. Medido como defeito real (matriz G): tal subárvore virava
 *   rota da app.
 *
 *   reference_or_example: diretório cujo NOME sozinho sugere material de
 *   apoio (examples, fixtures, vendor por nome sem manifest, etc.) —
 *   confirmado como realmente não-consumido só depois que o grafo de imports
 *   existe (`upgradeVendored`).
 */
import path from "node:path";

export type MaterialKind = "separate_package" | "reference_or_example" | "vendored_dependency";

export interface MaterialEntry {
  readonly path: string;
  readonly kind: MaterialKind;
  readonly reason: string;
  readonly evidence: string;
}

const MANIFEST_BASENAMES = ["package.json", "pyproject.toml", "go.mod", "Cargo.toml"] as const;

const REFERENCE_DIR_NAMES = new Set([
  "examples",
  "example",
  "samples",
  "sample",
  "demo",
  "demos",
  "fixtures",
  "__fixtures__",
  "vendor",
  "third_party",
  "third-party",
  "references",
  "reference",
]);

/** `"packages/*"` → prefixo `"packages"`. Só o prefixo antes do primeiro `*`/`**` — o suficiente para achar se um diretório está DECLARADO como workspace, sem implementar glob completo. */
function globPrefix(glob: string): string {
  const starIndex = glob.indexOf("*");
  const cut = starIndex === -1 ? glob : glob.slice(0, starIndex);
  return cut.replace(/\/$/, "");
}

function isDeclaredWorkspace(dir: string, workspaceGlobs: readonly string[]): boolean {
  return workspaceGlobs.some((glob) => {
    const prefix = globPrefix(glob);
    return prefix === "" || dir === prefix || dir.startsWith(`${prefix}/`);
  });
}

/** Diretório de material mais raso (mais próximo da raiz) cujo nome bate com `REFERENCE_DIR_NAMES`, andando a partir da raiz — o contrato pede o path do subdiretório, não cada arquivo dentro dele. */
function shallowestReferenceDir(filePath: string): string | undefined {
  const segments = filePath.split("/").slice(0, -1); // sem o nome do arquivo
  let acc = "";
  for (const segment of segments) {
    acc = acc ? `${acc}/${segment}` : segment;
    if (REFERENCE_DIR_NAMES.has(segment)) return acc;
  }
  return undefined;
}

/**
 * `files` já vem filtrado (sem node_modules/.git/etc — isso é `map-scan.ts`).
 * `workspaceGlobs` vazio é válido (projeto sem workspaces declarados — todo
 * manifest aninhado vira `separate_package`).
 */
export function classifyMaterials(files: readonly string[], workspaceGlobs: readonly string[]): MaterialEntry[] {
  const entries: MaterialEntry[] = [];
  const seenPaths = new Set<string>();

  for (const file of files) {
    const base = path.posix.basename(file);
    if (!(MANIFEST_BASENAMES as readonly string[]).includes(base)) continue;
    const dir = path.posix.dirname(file);
    if (dir === "." || dir === "") continue; // manifest da raiz — não é material
    if (isDeclaredWorkspace(dir, workspaceGlobs)) continue;
    if (seenPaths.has(dir)) continue;
    seenPaths.add(dir);
    entries.push({
      path: dir,
      kind: "separate_package",
      reason: `manifest próprio (${base}) não declarado em workspaces da raiz`,
      evidence: file,
    });
  }

  const referenceDirs = new Map<string, string>(); // dir -> arquivo de evidência
  for (const file of files) {
    const dir = shallowestReferenceDir(file);
    if (!dir || seenPaths.has(dir)) continue;
    if (!referenceDirs.has(dir)) referenceDirs.set(dir, file);
  }
  for (const [dir, evidence] of referenceDirs) {
    seenPaths.add(dir);
    entries.push({
      path: dir,
      kind: "reference_or_example",
      reason: "nome de diretório sugere material de referência/exemplo, não código da app",
      evidence,
    });
  }

  return entries.sort((a, b) => a.path.localeCompare(b.path));
}

/**
 * PURA: recebe as entradas candidatas + o conjunto de diretórios que o grafo
 * de imports PRÓPRIO provou serem importados por um arquivo de FORA do
 * próprio diretório — reclassifica `reference_or_example` confirmado como
 * consumido para `vendored_dependency`. `separate_package` nunca muda aqui
 * (é sobre ter manifest próprio, não sobre ser importado).
 */
export function upgradeVendored(materials: readonly MaterialEntry[], importedDirs: ReadonlySet<string>): MaterialEntry[] {
  return materials.map((m) =>
    m.kind === "reference_or_example" && importedDirs.has(m.path)
      ? { ...m, kind: "vendored_dependency" as const, reason: "importado pelo código da app — fora de rotas/banco, arestas mantidas" }
      : m
  );
}

/** `true` quando `filePath` cai dentro de algum material EXCLUÍDO de routes/database/graph (tudo, exceto `vendored_dependency` — que mantém arestas de grafo, só fica fora de routes/database). */
export function isUnderExcludedMaterial(filePath: string, materials: readonly MaterialEntry[], includeVendored: boolean): boolean {
  return materials.some((m) => {
    if (m.kind === "vendored_dependency" && !includeVendored) return false;
    return filePath === m.path || filePath.startsWith(`${m.path}/`);
  });
}
