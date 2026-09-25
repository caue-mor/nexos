/**
 * P1.3e — higiene pré-promoção global (checkpoint chk_01M2N1QEZKPXYC3SRAMANV5YDW).
 *
 * Contrato entre a superfície instalável (`assets/settings.json` +
 * `assets/hooks`) e o texto visível do CLI, travado em código:
 *
 *   ZERO PreToolUse. TODO SCRIPT REFERENCIADO EXISTE E NÃO BLOQUEIA. NENHUM
 *   SUBCOMANDO INEXISTENTE. `nexos install` COM HOME TEMPORÁRIO PROJETA
 *   EXATAMENTE O QUE O ASSET DECLARA — NUNCA PLUGIN, NUNCA hooks.json LEGADO.
 *   COPY VISÍVEL SEM CONCEITOS DE PRODUTO ANTIGO (AI Software House, N
 *   agents, governance, hook profiles, harness, AgentOS, Capsule).
 *
 * `os.homedir()` é mockado para o arquivo INTEIRO (mesmo padrão de
 * `backup.test.ts`) — os testes estáticos abaixo não chamam `os.homedir()`
 * (leem `assets/` via `process.cwd()`), então convivem sem conflito com o
 * teste dinâmico de instalação, que precisa do HOME isolado.
 */
import { describe, it, expect, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";

const ROOT = process.cwd();
const ASSETS_SETTINGS_PATH = path.join(ROOT, "assets", "settings.json");
const ASSETS_HOOKS_DIR = path.join(ROOT, "assets", "hooks");
const INDEX_TS_PATH = path.join(ROOT, "src", "index.ts");
const BIN_ENTRY = path.join(ROOT, "bin", "nexos.js");
const DIST_ENTRY = path.join(ROOT, "dist", "index.js");
const HAS_DIST = fs.existsSync(DIST_ENTRY) && fs.existsSync(BIN_ENTRY);

const TEST_HOME = path.join(fs.realpathSync(os.tmpdir()), `nexos-install-contract-${Date.now()}`);

vi.mock("node:os", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:os")>();
  return { ...actual, default: { ...actual, homedir: () => TEST_HOME }, homedir: () => TEST_HOME };
});

const { computeInstallPlan, applyInstallPlan } = await import("../src/lib/installer.js");
const { CLAUDE_DIR } = await import("../src/lib/constants.js");

interface RawHookHandler {
  type: string;
  command: string;
}
interface RawHookGroup {
  matcher?: string;
  hooks: RawHookHandler[];
}

function loadAssetSettings(): Record<string, unknown> {
  return fs.readJsonSync(ASSETS_SETTINGS_PATH);
}

/** Achata `hooks: { EVENT: [{ hooks: [{command}] }] }` -> `{event, command}[]`. */
function flatten(settings: Record<string, unknown>): Array<{ event: string; command: string }> {
  const hooks = (settings.hooks ?? {}) as Record<string, RawHookGroup[]>;
  const out: Array<{ event: string; command: string }> = [];
  for (const [event, groups] of Object.entries(hooks)) {
    for (const group of groups ?? []) {
      for (const handler of group.hooks ?? []) out.push({ event, command: handler.command });
    }
  }
  return out;
}

/** `bash $HOME/.claude/hooks/X.sh ...` -> `X.sh`; outros comandos -> null. */
function scriptBasename(command: string): string | null {
  const m = command.match(/\$HOME\/\.claude\/hooks\/(\S+)/);
  return m ? m[1] : null;
}

const BLOCKING_PATTERNS: RegExp[] = [
  /permissionDecision/,
  /"decision"\s*:\s*"block"/,
  /'decision'\s*:\s*'block'/,
  /claude-permission-gate/,
  /\bexit\s+2\b/,
];

const BANNED_COPY_TERMS: RegExp[] = [
  /AI Software House/i,
  /\bhook[- ]profiles?\b/i,
  /\bgovernance\b/i,
  /\bharness\b/i,
  /\bAgentOS\b/i,
  /\bauthorization\b/i,
  /\bCapsule\b/,
  /\b\d+\+?\s+(specialist\s+)?agents\b/i,
];

/**
 * Extrai o corpo de cada chamada `<marker>...)` por contagem de parênteses
 * balanceada — uma regex não-gulosa até o próximo `\n\s*\)` erra sempre que a
 * chamada é de uma linha só (ex.: `.description("Install NexOS...")`): sem
 * newline antes do `)` dela, o non-greedy varre para FRENTE até achar o
 * padrão em alguma chamada seguinte, engolindo tudo (comentários inclusive)
 * entre as duas — MEDIDO aqui: capturou o arquivo quase inteiro.
 */
function extractBalancedCalls(source: string, marker: string): string[] {
  const out: string[] = [];
  let searchFrom = 0;
  for (;;) {
    const start = source.indexOf(marker, searchFrom);
    if (start === -1) break;
    const openParen = start + marker.length - 1;
    let depth = 1;
    let i = openParen + 1;
    for (; i < source.length && depth > 0; i++) {
      if (source[i] === "(") depth++;
      else if (source[i] === ")") depth--;
    }
    out.push(source.slice(openParen + 1, i - 1));
    searchFrom = i;
  }
  return out;
}

function assertNoBannedTerms(label: string, text: string): void {
  for (const pattern of BANNED_COPY_TERMS) {
    expect(text, `${label} contém termo banido ${pattern}`).not.toMatch(pattern);
  }
}

describe("install surface contract — assets/settings.json (fonte)", () => {
  const settings = loadAssetSettings();
  const entries = flatten(settings);

  it("declara zero PreToolUse", () => {
    expect((settings.hooks as Record<string, unknown>).PreToolUse).toBeUndefined();
    expect(entries.some((e) => e.event === "PreToolUse")).toBe(false);
  });

  it("todo script `bash $HOME/.claude/hooks/*` referenciado existe em assets/hooks", () => {
    const referenced = [...new Set(entries.map((e) => scriptBasename(e.command)).filter((s): s is string => s !== null))];
    expect(referenced.length).toBeGreaterThan(0);
    for (const script of referenced) {
      expect(fs.existsSync(path.join(ASSETS_HOOKS_DIR, script)), `${script} ausente em assets/hooks`).toBe(true);
    }
  });

  it("nenhum script referenciado bloqueia (permissionDecision / decision:block / claude-permission-gate / exit 2)", () => {
    const referenced = [...new Set(entries.map((e) => scriptBasename(e.command)).filter((s): s is string => s !== null))];
    for (const script of referenced) {
      const content = fs.readFileSync(path.join(ASSETS_HOOKS_DIR, script), "utf-8");
      for (const pattern of BLOCKING_PATTERNS) {
        expect(content, `${script} corresponde a ${pattern}`).not.toMatch(pattern);
      }
    }
  });

  it("todo `nexos <subcomando>` (direto no settings.json ou chamado de dentro de um script referenciado) está registrado em src/index.ts", () => {
    const indexSrc = fs.readFileSync(INDEX_TS_PATH, "utf-8");
    const registered = new Set([...indexSrc.matchAll(/\.command\("([a-z-]+)"\)/g)].map((m) => m[1]));

    const directCommands = entries
      .map((e) => e.command.match(/^nexos\s+([a-z-]+)/))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => m[1]);

    const referencedScripts = [...new Set(entries.map((e) => scriptBasename(e.command)).filter((s): s is string => s !== null))];
    const scriptCommands = referencedScripts.flatMap((script) => {
      const content = fs.readFileSync(path.join(ASSETS_HOOKS_DIR, script), "utf-8");
      return [...content.matchAll(/"\$NEXOS_BIN"\s+([a-z-]+)/g)].map((m) => m[1]);
    });

    for (const cmd of [...directCommands, ...scriptCommands]) {
      expect(registered.has(cmd), `subcomando '${cmd}' não registrado em src/index.ts`).toBe(true);
    }
  });
});

describe("install surface contract — copy visível (fonte, sem build)", () => {
  it("TAGLINE (src/lib/brand.ts) não afirma conceitos de produto antigo", () => {
    const brandSrc = fs.readFileSync(path.join(ROOT, "src", "lib", "brand.ts"), "utf-8");
    const taglineMatch = brandSrc.match(/export const TAGLINE = pc\.dim\("([^"]*)"\)/);
    expect(taglineMatch, "TAGLINE não encontrada em brand.ts").not.toBeNull();
    assertNoBannedTerms("TAGLINE", taglineMatch![1]);
  });

  it("package.json description não afirma conceitos de produto antigo", () => {
    const pkg = fs.readJsonSync(path.join(ROOT, "package.json"));
    assertNoBannedTerms("package.json description", pkg.description);
  });

  it("descrições de comando em src/index.ts não afirmam conceitos de produto antigo", () => {
    const indexSrc = fs.readFileSync(INDEX_TS_PATH, "utf-8");
    const calls = extractBalancedCalls(indexSrc, ".description(");
    expect(calls.length).toBeGreaterThan(0);
    for (const call of calls) assertNoBannedTerms("descrição de comando", call);
  });

  it("nexos install --advanced não afirma 'hook profile'/governance nem grava efeito colateral sem leitor (.zshrc/.bashrc, NEXOS_HOOK_PROFILE)", () => {
    const installSrc = fs.readFileSync(path.join(ROOT, "src", "commands", "install.ts"), "utf-8");
    assertNoBannedTerms("src/commands/install.ts", installSrc);
    expect(installSrc, "install.ts não deve gravar em .zshrc/.bashrc").not.toMatch(/\.zshrc|\.bashrc/);
    expect(installSrc, "install.ts não deve referenciar NEXOS_HOOK_PROFILE").not.toMatch(/NEXOS_HOOK_PROFILE/);
  });
});

describe.skipIf(!HAS_DIST)("install surface contract — `--help` real (dist buildado)", () => {
  it("saída de `nexos --help` não contém termos de produto antigo", () => {
    const help = execFileSync(process.execPath, [BIN_ENTRY, "--help"], { encoding: "utf-8" });
    assertNoBannedTerms("nexos --help", help);
  });
});

describe("install surface contract — `nexos install` com HOME temporário", () => {
  it("projeta hooks idênticos ao asset, zero PreToolUse, sem plugin/hooks.json legado", async () => {
    await fs.remove(TEST_HOME);
    try {
      const plan = await computeInstallPlan();
      await applyInstallPlan(plan);

      const settingsPath = path.join(CLAUDE_DIR, "settings.json");
      expect(await fs.pathExists(settingsPath)).toBe(true);
      const written = await fs.readJson(settingsPath);

      expect((written.hooks as Record<string, unknown>).PreToolUse).toBeUndefined();

      const writtenEntries = flatten(written);
      const expectedEntries = flatten(loadAssetSettings()).map((e) => ({
        event: e.event,
        command: e.command.replace(/\$HOME/g, TEST_HOME),
      }));
      expect(writtenEntries).toEqual(expectedEntries);

      // Todo script bash referenciado foi de fato projetado em ~/.claude/hooks.
      for (const entry of writtenEntries) {
        const script = scriptBasename(entry.command.replace(TEST_HOME, "$HOME"));
        if (script) expect(await fs.pathExists(path.join(CLAUDE_DIR, "hooks", script))).toBe(true);
      }

      // Nenhuma projeção de plugin/hooks.json legado em lugar nenhum sob CLAUDE_DIR.
      const allFiles = await fs.readdir(CLAUDE_DIR, { recursive: true }).catch(() => [] as string[]);
      const legacyArtifacts = (allFiles as string[]).filter(
        (f) => f.endsWith("hooks.json") || f.includes(".claude-plugin")
      );
      expect(legacyArtifacts).toEqual([]);

      // Segunda passagem: convergente — recalcular o plano não acha mais
      // nenhuma operação mutante (create/update/remove).
      const verifyPlan = await computeInstallPlan();
      const residual = verifyPlan.ops.filter((op) => op.action !== "unchanged" && op.action !== "preserve");
      expect(residual).toEqual([]);
    } finally {
      await fs.remove(TEST_HOME);
    }
  });

  it("projeta hooks mesmo com um `.claude-plugin/plugin.json` legado presente (regressão do bug corrigido)", async () => {
    await fs.remove(TEST_HOME);
    try {
      await fs.outputJson(path.join(CLAUDE_DIR, "skills", "nexos", ".claude-plugin", "plugin.json"), {
        name: "nexos",
      });

      const plan = await computeInstallPlan();
      await applyInstallPlan(plan);

      const written = await fs.readJson(path.join(CLAUDE_DIR, "settings.json"));
      const writtenEntries = flatten(written);
      // Igualdade exata com o fresh install SEM marcador (teste anterior): o
      // bug corrigido fazia só `SessionStart` sobreviver — `length > 0`
      // sozinho passaria com 1 entrada só, sem provar que os outros handlers
      // voltaram.
      const expectedEntries = flatten(loadAssetSettings()).map((e) => ({
        event: e.event,
        command: e.command.replace(/\$HOME/g, TEST_HOME),
      }));
      expect(writtenEntries).toEqual(expectedEntries);
      expect((written.hooks as Record<string, unknown>).PreToolUse).toBeUndefined();
    } finally {
      await fs.remove(TEST_HOME);
    }
  });
});
