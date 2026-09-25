/**
 * Detecção de nome/stack/memória de um projeto a partir do diretório.
 *
 *   MECANISMO SEM CONSUMIDOR É METADE DE ABSTRAÇÃO
 *
 * Este arquivo se chamava `registry.ts` e trazia um registro GLOBAL de
 * projetos em `~/.nexos/projects.json`: `loadRegistry`, `saveRegistry`,
 * `registerProject`, `unregisterProject`, `getProject`, `listProjects`,
 * `updateProjectStatus` e dois tipos. MEDIDO em 2026-09-19: nenhuma das
 * sete tinha um único chamador. A única citação de `registerProject` fora
 * do arquivo era um comentário em `init.ts` dizendo que ele NUNCA a chama —
 * MENÇÃO != USO, e o arquivo nunca escreveu esse JSON.
 *
 * Não era só código morto: era uma SEGUNDA AUTORIDADE sobre "quais projetos
 * existem", paralela ao manifest que `project-resolver.ts` resolve. O nome
 * também colidia com `lib/agent/registry.ts`, que é vivo e exporta um
 * `loadRegistry` de verdade — duas funções homônimas, uma real e uma que
 * ninguém chamava, foi o que manteve a morta invisível.
 *
 * Sobrou o que tem consumidor: `detectProjectInfo`, usada por `boot.ts`,
 * `init.ts` e `capsule/repair.ts`.
 */
import fs from "fs-extra";
import path from "node:path";

/** Auto-detect project info from CWD */
export async function detectProjectInfo(projectPath: string): Promise<{
  name: string;
  stack: string;
  memoryPath: string;
}> {
  let name = path.basename(projectPath);
  let stack = "unknown";
  let memoryPath = "";

  // Detect stack from package.json
  const pkgPath = path.join(projectPath, "package.json");
  if (await fs.pathExists(pkgPath)) {
    try {
      const pkg = await fs.readJson(pkgPath);
      name = pkg.name || name;
      const deps = { ...pkg.dependencies, ...pkg.devDependencies };
      if ("next" in deps) stack = "Next.js";
      else if ("react" in deps) stack = "React";
      else if ("vue" in deps) stack = "Vue";
      else if ("svelte" in deps) stack = "Svelte";
      else stack = "Node.js";
    } catch {
      // ignore
    }
  } else if (await fs.pathExists(path.join(projectPath, "Cargo.toml"))) {
    stack = "Rust";
  } else if (await fs.pathExists(path.join(projectPath, "pyproject.toml"))) {
    stack = "Python";
  } else if (await fs.pathExists(path.join(projectPath, "go.mod"))) {
    stack = "Go";
  }

  // Find memory path
  const nexosMemory = path.join(projectPath, ".nexos", "memory", "project");
  if (await fs.pathExists(nexosMemory)) {
    memoryPath = nexosMemory;
  } else {
    // Try Claude Code auto-memory
    const claudeKey = projectPath.replace(/\//g, "-");
    const claudeMemory = path.join(
      process.env.HOME || "",
      ".claude",
      "projects",
      claudeKey,
      "memory"
    );
    if (await fs.pathExists(claudeMemory)) {
      memoryPath = claudeMemory;
    }
  }

  return { name, stack, memoryPath };
}
