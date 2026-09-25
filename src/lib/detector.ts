import fs from "fs-extra";
import path from "node:path";
import { CLAUDE_DIR, NEXOS_MARKER, INSTALL_TARGETS } from "./constants.js";

export interface ExistingInstall {
  exists: boolean;
  version: string | null;
  installedAt: string | null;
  components: {
    agents: number;
    skills: number;
    rules: number;
    hooks: number;
  };
  hasClaudeMd: boolean;
  hasSettings: boolean;
}

export async function detectExistingInstall(): Promise<ExistingInstall> {
  const result: ExistingInstall = {
    exists: false,
    version: null,
    installedAt: null,
    components: { agents: 0, skills: 0, rules: 0, hooks: 0 },
    hasClaudeMd: false,
    hasSettings: false,
  };

  if (!await fs.pathExists(CLAUDE_DIR)) {
    return result;
  }

  result.exists = true;

  // Check NexOS marker
  if (await fs.pathExists(NEXOS_MARKER)) {
    try {
      const marker = await fs.readJson(NEXOS_MARKER);
      result.version = marker.version ?? null;
      result.installedAt = marker.installedAt ?? null;
    } catch {
      // Corrupted marker, treat as unknown version
    }
  }

  // Count components
  for (const [key, dir] of Object.entries(INSTALL_TARGETS)) {
    if (await fs.pathExists(dir)) {
      try {
        const entries = await fs.readdir(dir);
        result.components[key as keyof typeof result.components] = entries.length;
      } catch {
        // Permission issue or not a directory
      }
    }
  }

  result.hasClaudeMd = await fs.pathExists(path.join(CLAUDE_DIR, "CLAUDE.md"));
  result.hasSettings = await fs.pathExists(path.join(CLAUDE_DIR, "settings.json"));

  return result;
}

export async function detectClaudeCode(): Promise<boolean> {
  // Check if Claude Code CLI is available
  try {
    const { execSync } = await import("node:child_process");
    // `2>NUL` só é /dev/null no cmd.exe; em sh cria um arquivo chamado NUL no cwd
    // quando `which` falha — medido no CI, onde não há `claude` no PATH.
    execSync(process.platform === "win32" ? "where claude" : "command -v claude", {
      stdio: "pipe",
    });
    return true;
  } catch {
    return false;
  }
}
