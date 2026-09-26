/**
 * P1.3f — clean build invariant (checkpoint chk_01M2N6TSN10A9JYTVDNGRB6EJ0).
 *
 * Root cause proved before this test existed: `build` was `tsc` alone
 * (`prebuild` only wrote build-info.json). `tsc` never deletes a `.js` it
 * stopped emitting — a file removed from `src/` leaves its OLD `dist/`
 * output behind forever. MEASURED on this tree before the fix: 134 orphaned
 * dist/**.js with no matching src/**.ts, including a whole removed
 * authorization/TaskGrant subsystem (permission-gate.ts and its siblings —
 * nexos://decision/p1-0-remover-authorization-layer) that `npm pack` shipped
 * into the a66645ce tarball untouched.
 *
 * This test does not trust the source tree on disk (it may already be
 * clean, hiding a regression) — it PLANTS stale canaries into a copy's
 * `dist/` before building, so a build that skips the dist wipe fails this
 * test even when the real repo's `dist/` happens to be clean at test time.
 *
 * Copy scope: only the inputs `npm run build` and `npm pack` actually read
 * (package.json, tsconfig.json, scripts/, src/, assets/, bin/, engine/,
 * agent.yaml, README.md, LICENSE) — not a literal full working-tree copy.
 * This repo carries hundreds of MB of gitignored, build-irrelevant local
 * state outside the "node_modules/.git/dist/.nexos/.claude/.audit/
 * .worktrees" exclusion list (graphify-out/ alone measured ~456MB at
 * authoring time) that a literal "copy everything except those seven"
 * would drag into every test run for zero coverage gain — none of it is
 * `npm pack` input. `node_modules` is a symlink to the real one (needed for
 * `tsc`, never copied — same reasoning, ~97MB of exact duplication for zero
 * coverage gain).
 */
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { execFileSync } from "node:child_process";
import crypto from "node:crypto";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { parse as parseYaml } from "yaml";

const ROOT = process.cwd();
const TMP_BASE = fs.realpathSync(os.tmpdir());

const COPY_ENTRIES = [
  "package.json",
  "tsconfig.json",
  "scripts",
  "src",
  "assets",
  "bin",
  "engine",
  "agent.yaml",
  "README.md",
  "LICENSE",
];

// Stale canaries: files `tsc` never emits this run (the src they came from
// is gone). A build that skips the dist wipe ships these into the tarball
// verbatim — that's exactly what happened in the a66645ce regression this
// test guards against.
const CANARY_FILES = [
  "lib/agent/permission-gate.js",
  "lib/agent/permission-gate.d.ts",
  "lib/agent/permission-gate.js.map",
  "host/claude/permission-gate.js",
];

const BANNED_ENTRY_PATTERN = /permission|authoriz|grant/i;

let workDir: string;
let copyDir: string;
let tarballPath: string;
let tarEntries: string[];

beforeAll(async () => {
  workDir = await fs.mkdtemp(path.join(TMP_BASE, "package-artifact-contract-"));
  copyDir = path.join(workDir, "copy");
  await fs.ensureDir(copyDir);

  for (const entry of COPY_ENTRIES) {
    const from = path.join(ROOT, entry);
    if (await fs.pathExists(from)) await fs.copy(from, path.join(copyDir, entry));
  }
  await fs.symlink(path.join(ROOT, "node_modules"), path.join(copyDir, "node_modules"), "dir");

  for (const rel of CANARY_FILES) {
    const canaryPath = path.join(copyDir, "dist", rel);
    await fs.ensureDir(path.dirname(canaryPath));
    await fs.writeFile(canaryPath, "// stale canary — must not survive `npm run build`\n");
  }

  execFileSync("npm", ["run", "build"], { cwd: copyDir, stdio: "pipe" });

  // Isolated cache dir: this environment's shared npm cache has root-owned
  // entries from an unrelated prior `sudo npm` run, which makes a bare
  // `npm pack` fail with EPERM before it ever touches this package. `--cache`
  // sidesteps that without touching (or requiring sudo on) the shared cache.
  const packCacheDir = path.join(workDir, "npm-cache");
  await fs.ensureDir(packCacheDir);
  const packOut = execFileSync(
    "npm",
    ["pack", "--ignore-scripts", "--json", "--pack-destination", workDir, "--cache", packCacheDir],
    { cwd: copyDir, encoding: "utf-8" }
  );
  const [packResult] = JSON.parse(packOut) as Array<{ filename: string }>;
  tarballPath = path.join(workDir, packResult.filename);

  tarEntries = execFileSync("tar", ["-tf", tarballPath], { encoding: "utf-8" })
    .split("\n")
    .filter((line) => line.length > 0);
}, 120_000);

afterAll(async () => {
  if (workDir) await fs.remove(workDir);
});

function extractFromTarball(entry: string): string {
  return execFileSync("tar", ["-xOf", tarballPath, entry], { encoding: "utf-8" });
}

describe("package artifact contract — o TARBALL publicado nunca carrega dist órfão", () => {
  it("(a) nenhuma entrada permission-gate.{js,d.ts,js.map} nem nexos-permission-gate.sh", () => {
    const matches = tarEntries.filter(
      (e) => /permission-gate\.(js|d\.ts|js\.map)$/.test(e) || e.includes("nexos-permission-gate.sh")
    );
    expect(matches).toEqual([]);
  });

  it("(b) todo package/dist/**/*.js do tarball tem src/**/*.ts correspondente na cópia (bijeção genérica)", () => {
    const distJsEntries = tarEntries.filter((e) => e.startsWith("package/dist/") && e.endsWith(".js"));
    expect(distJsEntries.length).toBeGreaterThan(0);
    const orphans = distJsEntries.filter((e) => {
      const rel = e.slice("package/dist/".length, -".js".length);
      return !fs.existsSync(path.join(copyDir, "src", `${rel}.ts`));
    });
    expect(orphans).toEqual([]);
  });

  it("(confirmação de falso-positivo controlado) src/ atual não tem nenhum arquivo batendo em /permission|authoriz|grant/i", () => {
    const srcMatches: string[] = [];
    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name);
        if (entry.isDirectory()) walk(full);
        else if (BANNED_ENTRY_PATTERN.test(entry.name)) srcMatches.push(path.relative(copyDir, full));
      }
    };
    walk(path.join(copyDir, "src"));
    expect(srcMatches).toEqual([]);
  });

  it("(c) nenhuma entrada em dist/ ou assets/hooks/ do tarball bate em /permission|authoriz|grant/i", () => {
    const matches = tarEntries.filter(
      (e) => (e.startsWith("package/dist/") || e.startsWith("package/assets/hooks/")) && BANNED_ENTRY_PATTERN.test(e)
    );
    expect(matches).toEqual([]);
  });

  it("(d) package/dist/index.js não contém 'claude-permission-gate'", () => {
    expect(tarEntries).toContain("package/dist/index.js");
    const content = extractFromTarball("package/dist/index.js");
    expect(content).not.toMatch(/claude-permission-gate/);
  });

  it("(e) todo script de hook referenciado em assets/settings.json + dist/index.js + bin/nexos.js + dist/build-info.json estão no tarball", () => {
    const settings = fs.readJsonSync(path.join(copyDir, "assets", "settings.json"));
    const hooks = (settings.hooks ?? {}) as Record<string, Array<{ hooks: Array<{ command: string }> }>>;
    const scripts = new Set<string>();
    for (const groups of Object.values(hooks)) {
      for (const group of groups ?? []) {
        for (const handler of group.hooks ?? []) {
          const match = handler.command.match(/\$HOME\/\.claude\/hooks\/([^\s"]+)/);
          if (match) scripts.add(match[1]);
        }
      }
    }
    expect(scripts.size).toBeGreaterThan(0);
    for (const script of scripts) {
      expect(tarEntries, `${script} ausente do tarball`).toContain(`package/assets/hooks/${script}`);
    }
    expect(tarEntries).toContain("package/dist/index.js");
    expect(tarEntries).toContain("package/bin/nexos.js");
    expect(tarEntries).toContain("package/dist/build-info.json");
  });

  it("(f) agent-registry.yaml do tarball não declara authority/human_gates/tools/permissions em nenhum agente, e agent-authority.yaml não existe", () => {
    const authorityEntries = tarEntries.filter((e) => e.includes("agent-authority"));
    expect(authorityEntries).toEqual([]);

    expect(tarEntries).toContain("package/assets/policies/agent-registry.yaml");
    const raw = extractFromTarball("package/assets/policies/agent-registry.yaml");
    const parsed = parseYaml(raw) as { agents?: Record<string, Record<string, unknown>> };
    const agents = parsed.agents ?? {};
    expect(Object.keys(agents).length).toBeGreaterThan(0);
    for (const [agentId, entry] of Object.entries(agents)) {
      for (const bannedKey of ["authority", "human_gates", "tools", "permissions"]) {
        expect(entry, `${agentId}.${bannedKey} não deveria existir`).not.toHaveProperty(bannedKey);
      }
    }
  });

  it("(h) package/assets/settings.json só declara \"hooks\" (P1.3i — env/permissions/language saíram do asset), zero PreToolUse", () => {
    expect(tarEntries).toContain("package/assets/settings.json");
    const raw = extractFromTarball("package/assets/settings.json");
    const parsed = JSON.parse(raw) as Record<string, unknown>;
    expect(Object.keys(parsed)).toEqual(["hooks"]);
    expect((parsed.hooks as Record<string, unknown>).PreToolUse).toBeUndefined();
  });

  // Regra do dono (24/09): memória de projeto, de sistema e de trabalho nunca vai
  // para npm. O 6.3.2 publicou assets/agent-memory/ (34 MEMORY.md) — este caso
  // derruba o pack se qualquer caminho de memória voltar, ou se o home de quem
  // empacota vazar num comentário (grafias /Users/<u> e -Users-<u>).
  it("(i) nenhuma memória de projeto/agente nem caminho pessoal no tarball", () => {
    const MEMORIA = /(^|\/)\.nexos\/|agent-memory\/|(^|\/)records\/|memory\/project\/|(^|\/)\.local\//;
    expect(tarEntries.filter((e) => MEMORIA.test(e))).toEqual([]);

    const user = os.userInfo().username;
    const tudo = execFileSync("tar", ["-xOf", tarballPath], { encoding: "utf-8", maxBuffer: 1 << 28 });
    expect(tudo.includes(`/Users/${user}/`), `/Users/${user}/ no tarball`).toBe(false);
    expect(tudo.includes(`-Users-${user}`), `-Users-${user} no tarball`).toBe(false);
  });

  it("(g) dois `npm run build` consecutivos produzem dist/ byte-idêntico (exceto build-info.json)", () => {
    const hashDist = (): Map<string, string> => {
      const out = new Map<string, string>();
      const distDir = path.join(copyDir, "dist");
      const walk = (dir: string) => {
        for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
          const full = path.join(dir, entry.name);
          if (entry.isDirectory()) walk(full);
          else if (entry.name !== "build-info.json") {
            out.set(path.relative(distDir, full), crypto.createHash("sha256").update(fs.readFileSync(full)).digest("hex"));
          }
        }
      };
      walk(distDir);
      return out;
    };

    const distA = hashDist(); // dist/ do build já rodado em beforeAll
    execFileSync("npm", ["run", "build"], { cwd: copyDir, stdio: "pipe" });
    const distB = hashDist();

    expect(distA.size).toBeGreaterThan(0);
    expect([...distB.keys()].sort()).toEqual([...distA.keys()].sort());
    for (const [rel, hash] of distA) {
      expect(distB.get(rel), `${rel} difere entre builds consecutivos`).toBe(hash);
    }
  }, 60_000);
});
