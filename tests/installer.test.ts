import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  fileHash,
  getAllFiles,
  deepEqualJsonValue,
  projectHooksSettings,
  projectStatusLineSettings,
  decidePackageOrphans,
  expandirHomeNoJson,
} from "../src/lib/installer.js";

const TEST_DIR = path.join(os.tmpdir(), `nexos-test-${Date.now()}`);

// ─── expandirHomeNoJson — $HOME do asset vira string JSON e argumento de shell ───

describe("expandirHomeNoJson", () => {
  const raw = fs.readFileSync(path.join(__dirname, "..", "assets", "settings.json"), "utf-8");

  it("home do Windows (relato da comunidade, 7.0.3): parse não quebra e o caminho sai com barra normal", () => {
    const s = JSON.parse(expandirHomeNoJson(raw, "C:\\Users\\fulano", "\\")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
    };
    const comandos = Object.values(s.hooks)
      .flat()
      .flatMap((g) => g.hooks.map((h) => h.command));
    expect(comandos.length).toBeGreaterThan(0);
    for (const c of comandos) expect(c, c).not.toContain("\\");
    expect(comandos.some((c) => c.includes("C:/Users/fulano/.claude/hooks/"))).toBe(true);
  });

  it("home com padrão de replace ($&) e aspas sai literal", () => {
    expect(JSON.parse(expandirHomeNoJson('{"c":"node $HOME/x"}', '/Users/a$&"b', "/"))).toEqual({
      c: 'node /Users/a$&"b/x',
    });
  });
});

// ─── projectHooksSettings — projeção pura de hooks (P1.3i) ─────────────────

describe("projectHooksSettings — host fresco (existing = null)", () => {
  it("devolve só { hooks: assetHooks }, nada mais", () => {
    const assetHooks = { SessionStart: [{ hooks: [{ type: "command", command: "nexos claude-session-start", timeout: 10 }] }] };
    expect(projectHooksSettings(null, assetHooks)).toEqual({ hooks: assetHooks });
  });
});

describe("projectHooksSettings — host existente", () => {
  it("preserva chaves não-hook intocadas e handlers não-NexOS na posição original", () => {
    const foreign = { matcher: "resume", hooks: [{ type: "command", command: "foreign-start", timeout: 5 }] };
    const existing = {
      language: "english",
      env: { FOO: "bar" },
      hooks: { SessionStart: [foreign], Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }] },
    };
    const assetHooks = { SessionStart: [{ hooks: [{ type: "command", command: "nexos claude-session-start", timeout: 10 }] }] };

    const projected = projectHooksSettings(existing, assetHooks);

    expect(projected.language).toBe("english");
    expect(projected.env).toEqual({ FOO: "bar" });
    expect(projected.hooks).toEqual({
      SessionStart: [foreign, { hooks: [{ type: "command", command: "nexos claude-session-start", timeout: 10 }] }],
      Stop: existing.hooks.Stop,
    });
  });

  it("nunca muta o objeto existing recebido", () => {
    const existing = { hooks: { Stop: [{ hooks: [{ type: "command", command: "foreign-stop" }] }] } };
    const snapshot = JSON.stringify(existing);
    projectHooksSettings(existing, { SessionStart: [{ hooks: [{ type: "command", command: "nexos claude-session-start" }] }] });
    expect(JSON.stringify(existing)).toBe(snapshot);
  });

  it("mesmo conjunto de grupos em outra ordem → devolve o existing intacto (hooks rodam em paralelo)", () => {
    // Caso real (23/09): o pixel-agents acrescenta o grupo dele DEPOIS do do
    // NexOS; strip + reapêndice empurrava o NexOS para o fim e o install
    // acusava settings.json desatualizado a cada sessão.
    const nexos = { hooks: [{ type: "command", command: "nexos claude-session-start", timeout: 10 }] };
    const alheio = { hooks: [{ type: "command", command: "pixel-agents session-start" }] };
    const existing = { hooks: { SessionStart: [nexos, alheio] } };

    const projected = projectHooksSettings(existing, { SessionStart: [nexos] });

    expect(projected).toEqual(existing);
  });

  it("é idempotente — projetar o resultado de novo devolve o mesmo conteúdo", () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "bash /home/x/.claude/hooks/nexos-permission-gate.sh" }] }],
        SomeEvent: [{ hooks: [{ type: "command", command: "keep-me" }] }],
      },
    };
    const assetHooks = { SessionStart: [{ hooks: [{ type: "command", command: "nexos claude-session-start", timeout: 10 }] }] };

    const first = projectHooksSettings(existing, assetHooks);
    const second = projectHooksSettings(first, assetHooks);
    expect(second).toEqual(first);
  });

  it("refusa hooks malformado (não-objeto / evento não-array) sem escrever nada", () => {
    expect(() => projectHooksSettings({ hooks: [] }, {})).toThrow("configuração preservada");
    expect(() => projectHooksSettings({ hooks: { SessionStart: "invalid" } }, {})).toThrow("configuração preservada");
  });
});

// ─── LEGADO 6.3.2 (knw_01M2G9KQAD4KPJSC4MNPDNN7P7) ──────────────────────────
//
// `nexos-memory-sync.sh` (POST direto em /rest/v1/ com SERVICE KEY) foi
// desativado no asset atual e removido do pacote (nexos://decision/
// p1-0-remover-authorization-layer). O regime antigo (`removeKnownInsecureLegacyHooks`,
// subtração nominal de UM script) foi substituído por um regime genérico:
// TODO handler NexOS-owned (`.claude/hooks/nexos-*` ou `nexos <cmd>`) é
// removido e reescrito do asset a cada instalação — a ativação legada nunca
// tem chance de sobreviver, porque nada é "preservado" no lado NexOS.

describe("projectHooksSettings — legado 6.3.2 real (npm latest medido 08/08)", () => {
  it("a ativação de memory-sync do host 6.3.2 NÃO sobrevive a uma instalação, mesmo o asset não a declarando mais", () => {
    const legacySettings632 = {
      env: { NEXOS_SUPABASE_SERVICE_KEY_HINT: "set-in-.nexos/.env" },
      permissions: { allow: ["Read", "Edit"] },
      hooks: {
        PostToolUse: [
          {
            matcher: "Write|Edit",
            hooks: [{ type: "command", command: "bash $HOME/.claude/hooks/nexos-memory-sync.sh", timeout: 30 }],
          },
          {
            matcher: "*",
            hooks: [{ type: "command", command: "node /other/tool.js" }],
          },
        ],
      },
    };
    const currentAssetHooks = {
      PostToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "node $HOME/.claude/hooks/nexos-exec-log.js" }] }],
    };

    const projected = projectHooksSettings(legacySettings632, currentAssetHooks);
    const postToolUse = (projected.hooks as Record<string, unknown>).PostToolUse as Array<{ hooks: Array<{ command: string }> }>;
    const allCommands = postToolUse.flatMap((g) => g.hooks.map((h) => h.command));

    expect(allCommands.some((c) => c.includes("nexos-memory-sync.sh"))).toBe(false);
    expect(allCommands.some((c) => c.includes("/other/tool.js"))).toBe(true); // não-NexOS, preservado
    expect(allCommands.some((c) => c.includes("nexos-exec-log.js"))).toBe(true); // do asset atual
  });

  it("grupo esvaziado (todo handler era NexOS-owned) some inteiro — evento some se ficar vazio", () => {
    const existing = {
      hooks: {
        PreToolUse: [{ matcher: "*", hooks: [{ type: "command", command: "bash /x/.claude/hooks/nexos-permission-gate.sh" }] }],
      },
    };
    const projected = projectHooksSettings(existing, {});
    expect((projected.hooks as Record<string, unknown>).PreToolUse).toBeUndefined();
  });

  it("fresh install (existing = null) nunca introduz um handler NexOS-owned que não veio do asset atual", () => {
    const projected = projectHooksSettings(null, {
      PostToolUse: [{ hooks: [{ type: "command", command: "bash /x/.claude/hooks/nexos-exec-log.js" }] }],
    });
    const postToolUse = (projected.hooks as Record<string, unknown>).PostToolUse as unknown[];
    expect(postToolUse).toHaveLength(1);
  });
});

// ─── projectStatusLineSettings — projeção pura de statusLine, dono único ───
//
// nexos://decision/statusline-global-terminal-observability — SEPARADA de
// `projectHooksSettings` de propósito: nunca a mesma função decide hooks e
// statusLine.

const NEXOS_COMMAND = '"/usr/local/bin/node" "/Users/x/.claude/statusline/nexos-statusline.mjs"';

describe("projectStatusLineSettings", () => {
  it("statusLine ausente (undefined) — cria com o comando desejado, zero conflito", () => {
    const result = projectStatusLineSettings(undefined, NEXOS_COMMAND);
    expect(result).toEqual({ statusLine: { type: "command", command: NEXOS_COMMAND }, conflict: null });
  });

  it("statusLine já NexOS-owned e idêntica — ressincroniza para o mesmo valor, zero conflito", () => {
    const existing = { type: "command", command: NEXOS_COMMAND };
    const result = projectStatusLineSettings(existing, NEXOS_COMMAND);
    expect(result).toEqual({ statusLine: { type: "command", command: NEXOS_COMMAND }, conflict: null });
  });

  it("statusLine NexOS-owned mas divergente (ex.: node path mudou) — substitui exato pelo comando atual", () => {
    const existing = { type: "command", command: '"/opt/old/node" "/Users/x/.claude/statusline/nexos-statusline.mjs"', padding: 3 };
    const result = projectStatusLineSettings(existing, NEXOS_COMMAND);
    expect(result).toEqual({ statusLine: { type: "command", command: NEXOS_COMMAND }, conflict: null });
  });

  /** 21 das 25 versões publicadas (1.0.2–6.3.2) gravavam este comando — medido 25/09. */
  it("statusLine das versões 1.x–6.x (hooks/nexos-status-line.sh) é do NexOS — troca pelo renderer atual", () => {
    for (const command of [
      "bash /Users/x/.claude/hooks/nexos-status-line.sh",
      "bash C:\\Users\\x\\.claude\\hooks\\nexos-status-line.sh",
    ]) {
      const result = projectStatusLineSettings({ type: "command", command }, NEXOS_COMMAND);
      expect(result, command).toEqual({ statusLine: { type: "command", command: NEXOS_COMMAND }, conflict: null });
    }
  });

  it("statusLine de outro dono (comando não referencia o renderer NexOS) — PRESERVA byte a byte, reporta conflito", () => {
    const existing = { type: "command", command: "~/.claude/statusline.sh", padding: 2 };
    const result = projectStatusLineSettings(existing, NEXOS_COMMAND);
    expect(result).toEqual({ statusLine: existing, conflict: "~/.claude/statusline.sh" });
  });

  it("statusLine malformada (não é objeto) — preserva o valor cru, conflito é o JSON dele", () => {
    const result = projectStatusLineSettings("plain-string-statusline", NEXOS_COMMAND);
    expect(result).toEqual({ statusLine: "plain-string-statusline", conflict: '"plain-string-statusline"' });
  });

  it("statusLine === null — preserva null, conflito reporta o JSON de null", () => {
    const result = projectStatusLineSettings(null, NEXOS_COMMAND);
    expect(result).toEqual({ statusLine: null, conflict: "null" });
  });

  it("é idempotente — projetar o resultado de novo devolve o mesmo conteúdo", () => {
    const first = projectStatusLineSettings(undefined, NEXOS_COMMAND);
    const second = projectStatusLineSettings(first.statusLine, NEXOS_COMMAND);
    expect(second).toEqual(first);
  });

  describe("com a derivação de contexto (nexos://decision/aviso-de-contexto-por-statusline)", () => {
    /** Forma ANTIGA (pré rodada 3) — sem `|| cat`: `node`/tap ausente fechava o pipe, o renderer alheio lia EOF. */
    const TAP_LEGADO = 'node "/Users/x/.claude/statusline/nexos-context-tap.mjs"';
    /** Forma ATUAL — o que `buildContextTapCommand()` produz de verdade (MEDIUM #6, rodada 3). */
    const TAP = `{ ${TAP_LEGADO} || cat; }`;

    it("renderer de outro dono ganha a derivação na frente; chaves extras e o comando dele intactos", () => {
      const existing = { type: "command", command: "/usr/local/bin/ccstatusline", padding: 2, refreshInterval: 5 };
      const result = projectStatusLineSettings(existing, NEXOS_COMMAND, TAP);
      expect(result).toEqual({
        statusLine: { type: "command", command: `${TAP} | { /usr/local/bin/ccstatusline\n}`, padding: 2, refreshInterval: 5 },
        conflict: "/usr/local/bin/ccstatusline",
      });
    });

    it("é idempotente — comando que já tem a derivação não ganha outra", () => {
      const first = projectStatusLineSettings({ type: "command", command: "ccstatusline" }, NEXOS_COMMAND, TAP);
      const second = projectStatusLineSettings(first.statusLine, NEXOS_COMMAND, TAP);
      expect(second.statusLine).toEqual(first.statusLine);
    });

    it("comando alheio COMPOSTO recebe o payload inteiro (achado HIGH do verifier, rodado em bash de verdade)", () => {
      const tapReal = `{ node ${JSON.stringify(path.resolve(__dirname, "..", "assets", "statusline", "nexos-context-tap.mjs"))} || cat; }`;
      const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tap-compose-"));
      const payload = JSON.stringify({ session_id: "s", context_window: { used_percentage: 10 } });
      const run = (command: string) =>
        spawnSync("bash", ["-c", command], { input: payload, encoding: "utf8", env: { ...process.env, TMPDIR: tmp } }).stdout;
      const composto = projectStatusLineSettings({ type: "command", command: "cd / && cat # renderer" }, NEXOS_COMMAND, tapReal);
      expect(run((composto.statusLine as { command: string }).command)).toBe(payload);
      // Contrafactual: a concatenação ingênua liga o pipe só ao `cd` — o renderer lê vazio.
      expect(run(`${tapReal} | cd / && cat`)).toBe("");
    });

    /**
     * MEDIUM #6 (rodada 3) — a prova de verdade do `|| cat`: `node` inexistente
     * (PATH sem ele) tem que deixar o payload passar intacto para o renderer
     * alheio, não fechar o pipe com EOF. Sem `|| cat` este teste falha com
     * stdout vazio — é o contrafactual que mostra que o fallback importa.
     */
    it("`node` ausente do PATH: `|| cat` repassa o payload cru — sem fallback o renderer leria EOF", () => {
      const tapComNodeAusente = `{ node ${JSON.stringify(path.resolve(__dirname, "..", "assets", "statusline", "nexos-context-tap.mjs"))} || cat; }`;
      const tmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "tap-no-node-"));
      const payload = JSON.stringify({ session_id: "s", context_window: { used_percentage: 10 } });
      const composto = projectStatusLineSettings({ type: "command", command: "cat # renderer" }, NEXOS_COMMAND, tapComNodeAusente);
      const comando = (composto.statusLine as { command: string }).command;
      // PATH só com coreutils (onde `cat` mora) — sem o diretório de `node`, ele não é achável.
      const semNode = "/usr/bin:/bin";
      const run = (cmd: string) => spawnSync("bash", ["-c", cmd], { input: payload, encoding: "utf8", env: { PATH: semNode, TMPDIR: tmp } }).stdout;
      expect(run(comando)).toBe(payload);
      // Contrafactual: sem `|| cat`, o mesmo cenário fecha o pipe e o renderer não recebe nada.
      const semFallback = comando.replace(" || cat", "");
      expect(run(semFallback)).toBe("");
    });

    it("instalação anterior ao grupo (tap | cmd) migra para tap | { cmd } e depois fica estável", () => {
      const antiga = { type: "command", command: `${TAP} | cd / && cat`, padding: 1 };
      const migrada = projectStatusLineSettings(antiga, NEXOS_COMMAND, TAP);
      expect(migrada).toEqual({ statusLine: { type: "command", command: `${TAP} | { cd / && cat\n}`, padding: 1 }, conflict: "cd / && cat" });
      expect(projectStatusLineSettings(migrada.statusLine, NEXOS_COMMAND, TAP).statusLine).toEqual(migrada.statusLine);
    });

    /**
     * MEDIUM #6 (rodada 3) — instalação de ANTES desta fatia gravou o tap SEM
     * `|| cat`. `tapCommand` chega na forma NOVA (é o que `planSettings` passa
     * de verdade); a projeção tem que reconhecer o prefixo antigo e trocar só
     * o tap, preservando o comando alheio já agrupado e as chaves extras.
     */
    it("instalação com o tap ANTIGO (sem `|| cat`), já agrupada, migra só o tap e fica estável", () => {
      const antiga = { type: "command", command: `${TAP_LEGADO} | { cd / && cat\n}`, padding: 1 };
      const migrada = projectStatusLineSettings(antiga, NEXOS_COMMAND, TAP);
      expect(migrada).toEqual({ statusLine: { type: "command", command: `${TAP} | { cd / && cat\n}`, padding: 1 }, conflict: "cd / && cat" });
      expect(projectStatusLineSettings(migrada.statusLine, NEXOS_COMMAND, TAP).statusLine).toEqual(migrada.statusLine);
    });

    /** As DUAS formas antigas juntas (tap sem `|| cat` E sem o grupo `{ }`) — migra as duas de uma vez, não só uma. */
    it("instalação com o tap ANTIGO e SEM grupo migra as duas formas antigas numa passada só", () => {
      const antiga = { type: "command", command: `${TAP_LEGADO} | cd / && cat`, padding: 1 };
      const migrada = projectStatusLineSettings(antiga, NEXOS_COMMAND, TAP);
      expect(migrada).toEqual({ statusLine: { type: "command", command: `${TAP} | { cd / && cat\n}`, padding: 1 }, conflict: "cd / && cat" });
      expect(projectStatusLineSettings(migrada.statusLine, NEXOS_COMMAND, TAP).statusLine).toEqual(migrada.statusLine);
    });

    it("valor sem comando string fica como está — não há onde pôr a derivação", () => {
      expect(projectStatusLineSettings(null, NEXOS_COMMAND, TAP)).toEqual({ statusLine: null, conflict: "null" });
      const semComando = { type: "command", padding: 1 };
      expect(projectStatusLineSettings(semComando, NEXOS_COMMAND, TAP).statusLine).toBe(semComando);
    });
  });

  it("nunca confunde um comando de outro dono que só CONTÉM a palavra nexos-statusline fora do path exato", () => {
    const existing = { type: "command", command: "echo nexos-statusline-fake" };
    const result = projectStatusLineSettings(existing, NEXOS_COMMAND);
    expect(result.conflict).toBe("echo nexos-statusline-fake");
  });
});

// ─── deepEqualJsonValue ──────────────────────────────────────────────────

describe("deepEqualJsonValue", () => {
  it("ignora ordem de chaves", () => {
    expect(deepEqualJsonValue({ a: 1, b: 2 }, { b: 2, a: 1 })).toBe(true);
  });
  it("compara arrays por posição, não por conjunto", () => {
    expect(deepEqualJsonValue([1, 2], [2, 1])).toBe(false);
    expect(deepEqualJsonValue([1, 2], [1, 2])).toBe(true);
  });
  it("detecta divergência aninhada", () => {
    expect(deepEqualJsonValue({ hooks: { Stop: [{ command: "a" }] } }, { hooks: { Stop: [{ command: "b" }] } })).toBe(false);
  });
});

// ─── REAL FUNCTION TESTS ─────────────────────────────────────────────────────

async function createFile(dir: string, name: string, content: string) {
  await fs.ensureDir(dir);
  await fs.writeFile(path.join(dir, name), content);
}

beforeEach(async () => {
  await fs.ensureDir(TEST_DIR);
});

afterEach(async () => {
  await fs.remove(TEST_DIR);
});

describe("fileHash (from installer.ts)", () => {
  it("returns consistent md5 for same content", async () => {
    await createFile(TEST_DIR, "a.txt", "hello world");
    const h1 = await fileHash(path.join(TEST_DIR, "a.txt"));
    const h2 = await fileHash(path.join(TEST_DIR, "a.txt"));
    expect(h1).toBe(h2);
    expect(h1).toHaveLength(32); // md5 hex
  });

  it("returns different hash for different content", async () => {
    await createFile(TEST_DIR, "a.txt", "version 1");
    await createFile(TEST_DIR, "b.txt", "version 2");
    const h1 = await fileHash(path.join(TEST_DIR, "a.txt"));
    const h2 = await fileHash(path.join(TEST_DIR, "b.txt"));
    expect(h1).not.toBe(h2);
  });
});

describe("getAllFiles (from installer.ts)", () => {
  it("lists files recursively with relative paths", async () => {
    await createFile(path.join(TEST_DIR, "a"), "1.md", "x");
    await createFile(path.join(TEST_DIR, "a", "sub"), "2.md", "y");
    await createFile(TEST_DIR, "root.md", "z");

    const files = await getAllFiles(TEST_DIR);
    expect(files).toContain("root.md");
    expect(files).toContain("a/1.md");
    expect(files).toContain("a/sub/2.md");
    expect(files).toHaveLength(3);
  });

  it("returns empty array for empty dir", async () => {
    const emptyDir = path.join(TEST_DIR, "empty");
    await fs.ensureDir(emptyDir);
    const files = await getAllFiles(emptyDir);
    expect(files).toHaveLength(0);
  });
});

// ─── SMART MERGE LOGIC ──────────────────────────────────────────────────────

describe("Smart merge logic (using real fileHash)", () => {
  it("detects unchanged file (hash matches)", async () => {
    const content = "# Original agent";
    await createFile(TEST_DIR, "installed.md", content);
    await createFile(TEST_DIR, "asset.md", content);

    const installedHash = await fileHash(path.join(TEST_DIR, "installed.md"));
    const assetHash = await fileHash(path.join(TEST_DIR, "asset.md"));
    expect(installedHash).toBe(assetHash); // same content = skip
  });

  it("detects customized file (hash diverged)", async () => {
    await createFile(TEST_DIR, "installed.md", "# My custom version");
    await createFile(TEST_DIR, "asset.md", "# Original");

    const installedHash = await fileHash(path.join(TEST_DIR, "installed.md"));
    const assetHash = await fileHash(path.join(TEST_DIR, "asset.md"));
    expect(installedHash).not.toBe(assetHash); // different = preserve
  });

  it("detects updatable file (installed matches previous, asset is new)", async () => {
    const v1 = "# Agent v1";
    const v2 = "# Agent v2";
    await createFile(TEST_DIR, "installed.md", v1);
    const previousHash = await fileHash(path.join(TEST_DIR, "installed.md"));

    await createFile(TEST_DIR, "asset.md", v2);
    const installedHash = await fileHash(path.join(TEST_DIR, "installed.md"));
    const newHash = await fileHash(path.join(TEST_DIR, "asset.md"));

    // installed matches previous → dev didn't touch → safe to update
    expect(installedHash).toBe(previousHash);
    expect(newHash).not.toBe(installedHash);
  });
});

// ─── MEMORY.MD ───────────────────────────────────────────────────────────────

describe("MEMORY.md behavior", () => {
  it("installs when missing", async () => {
    const memDir = path.join(TEST_DIR, "memory");
    await createFile(path.join(TEST_DIR, "assets"), "MEMORY.md", "# Template");

    if (!await fs.pathExists(path.join(memDir, "MEMORY.md"))) {
      await fs.ensureDir(memDir);
      await fs.copy(path.join(TEST_DIR, "assets", "MEMORY.md"), path.join(memDir, "MEMORY.md"));
    }

    expect(await fs.pathExists(path.join(memDir, "MEMORY.md"))).toBe(true);
    expect(await fs.readFile(path.join(memDir, "MEMORY.md"), "utf-8")).toBe("# Template");
  });

  it("preserves existing MEMORY.md", async () => {
    const memDir = path.join(TEST_DIR, "memory");
    await createFile(memDir, "MEMORY.md", "# My data");
    await createFile(path.join(TEST_DIR, "assets"), "MEMORY.md", "# Template");

    if (!await fs.pathExists(path.join(memDir, "MEMORY.md"))) {
      await fs.copy(path.join(TEST_DIR, "assets", "MEMORY.md"), path.join(memDir, "MEMORY.md"));
    }

    expect(await fs.readFile(path.join(memDir, "MEMORY.md"), "utf-8")).toBe("# My data");
  });
});

// ─── órfãos do pacote: manifesto × pacote × disco ──────────────────────────

describe("decidePackageOrphans — o que o NexOS gravou e o pacote não tem mais", () => {
  const manifesto = {
    "skills/development--testing-patterns/SKILL.md": "hash-antigo",
    "skills/nexos/SKILL.md": "hash-atual",
    "hooks/nexos-host-memory-check.sh": "hash-hook",
    "rules/minha-regra.md": "hash-regra",
    "agents/nexos-devops.md": "hash-agente",
  };

  it("reporta o que saiu do pacote e continua no disco, com untouched × modified", () => {
    const orfaos = decidePackageOrphans(
      manifesto,
      new Set(["skills/nexos/SKILL.md"]),
      new Map([
        ["skills/development--testing-patterns/SKILL.md", "hash-antigo"],
        ["hooks/nexos-host-memory-check.sh", "hash-hook"],
        ["rules/minha-regra.md", "editado-no-host"],
      ])
    );

    expect(orfaos).toEqual([
      { component: "hooks", path: "nexos-host-memory-check.sh", status: "untouched" },
      { component: "rules", path: "minha-regra.md", status: "modified" },
      { component: "skills", path: "development--testing-patterns/SKILL.md", status: "untouched" },
    ]);
  });

  it("arquivo que o NexOS NUNCA gravou não é órfão — as 242 skills do usuário ficam fora", () => {
    const orfaos = decidePackageOrphans(
      {},
      new Set(),
      new Map([["skills/ai-research--rag-implementation/SKILL.md", "qualquer"]])
    );
    expect(orfaos).toEqual([]);
  });

  it("o que já não está no disco não vira linha, e agents fica com a poda própria", () => {
    const orfaos = decidePackageOrphans(manifesto, new Set(), new Map([["agents/nexos-devops.md", "hash-agente"]]));
    expect(orfaos).toEqual([]);
  });
});
