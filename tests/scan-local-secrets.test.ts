/**
 * `scripts/scan-local-secrets.mjs` — três estados (CLEAN / HISTORICAL DEBT /
 * CURRENT LEAK), nunca pass/fail — sobre as TRÊS superfícies NOMEADAS do
 * NexOS: `~/.nexos/governance/`, `~/.nexos/instincts/`, `<repo>/.nexos/logs/`.
 *
 * SECRET BOUNDARY V0 (slice B) — este script é a superfície que MOVEU para
 * fora de `scan-secrets.mjs` (ver `tests/scan-secrets.test.ts`). `HOME` e
 * `cwd` são sempre isolados em tmpdirs — nunca o `$HOME`/repo de quem roda o
 * teste, que neste host carrega `~/.nexos/governance/events.jsonl` com
 * credencial HISTÓRICA real (a mesma que a REGRA ABSOLUTA desta fatia proíbe
 * tocar).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import { createRequire } from "node:module";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../scripts/scan-local-secrets.mjs");
const TMP = fs.realpathSync(os.tmpdir());

/**
 * `nexos-secret-patterns.cjs` não tem `.d.cts` — um `import` estático daria
 * TS7016 (`noImplicitAny`) sob `tsconfig.check.json` (`tests/**` é coberto,
 * `assets/` não). `createRequire` + guard evita o `any` implícito sem exigir
 * uma declaração ambiente só para este teste; o resultado passa por
 * `isPlaceholderModule` antes de qualquer uso, nunca é tratado como `any`.
 */
const requireCjs = createRequire(__filename);
function isPlaceholderModule(value: unknown): value is { KNOWN_PLACEHOLDERS: Set<string> } {
  return (
    typeof value === "object" &&
    value !== null &&
    "KNOWN_PLACEHOLDERS" in value &&
    (value as { KNOWN_PLACEHOLDERS: unknown }).KNOWN_PLACEHOLDERS instanceof Set
  );
}
const secretPatternsModule: unknown = requireCjs("../assets/hooks/nexos-secret-patterns.cjs");
if (!isPlaceholderModule(secretPatternsModule)) {
  throw new Error("nexos-secret-patterns.cjs não exporta KNOWN_PLACEHOLDERS como Set<string>");
}
const KNOWN_PLACEHOLDERS = secretPatternsModule.KNOWN_PLACEHOLDERS;

/**
 * `GENERIC_FAKE_JWT` — formato JWT plausível, mas SEM ser o placeholder
 * canônico da suíte (ver `KNOWN_PLACEHOLDER_JWT` mais abaixo). Usado em TODO
 * teste que só precisa de "algo no formato de credencial", não de provar
 * comportamento de placeholder — separado do placeholder canônico desde o
 * fechamento do SECRET BOUNDARY V0 (item 2/3): antes desta fatia, este
 * arquivo reusava o MESMO literal que `nexos-secret-patterns.cjs` agora
 * reconhece como fixture pública conhecida, e os testes de
 * HIGH_CONFIDENCE/HISTORICAL/CURRENT abaixo teriam parado de bater — não
 * porque o comportamento quebrou, mas porque o fixture escolhido deixou de
 * representar "vazamento genérico" no momento em que passou a representar
 * "placeholder conhecido".
 */
const GENERIC_FAKE_JWT = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJvdXRybyJ9.${"Z".repeat(20)}`;
/** O MESMO literal exato que `nexos-secret-patterns.cjs` (`KNOWN_PLACEHOLDERS`)
 * e as suítes de redação (`tests/*-redaction.test.ts`) chamam de `FAKE_JWT` —
 * precisa ser IDÊNTICO byte a byte para exercitar a comparação por igualdade
 * exata (`Set.has`), nunca por substring. */
const KNOWN_PLACEHOLDER_JWT = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.eyJzdWIiOiJmYWtlIn0.${"F".repeat(20)}`;

/**
 * `KNOWN_GITHUB_PLACEHOLDER` — extraído de `KNOWN_PLACEHOLDERS`
 * (`nexos-secret-patterns.cjs`, a authority canônica), nunca reconstruído
 * aqui: duplicar a EXPRESSÃO que gera o literal
 * (`'ghp_' + 'a1B2c3D4e5'.repeat(4)`) teria o mesmo risco de divergência
 * silenciosa que duplicar o literal em si — authority e teste podem mudar em
 * paralelo sem que nada acuse.
 */
const KNOWN_GITHUB_PLACEHOLDER = [...KNOWN_PLACEHOLDERS].find((value) => value.startsWith("ghp_"));
if (!KNOWN_GITHUB_PLACEHOLDER) {
  throw new Error("KNOWN_PLACEHOLDERS não contém nenhum placeholder ghp_ — authority mudou?");
}

let home: string;
let repo: string;

beforeEach(async () => {
  home = await fs.mkdtemp(path.join(TMP, "local-secrets-home-"));
  repo = await fs.mkdtemp(path.join(TMP, "local-secrets-repo-"));
});
afterEach(async () => {
  await fs.remove(home);
  await fs.remove(repo);
});

function run(): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [SCRIPT], {
    cwd: repo,
    encoding: "utf-8",
    env: { ...process.env, HOME: home },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

async function writeLine(surface: string, filename: string, obj: Record<string, unknown>) {
  const dir =
    surface === "governance"
      ? path.join(home, ".nexos", "governance")
      : surface === "instincts"
        ? path.join(home, ".nexos", "instincts", "projects", "prj_fake")
        : path.join(repo, ".nexos", "logs");
  await fs.ensureDir(dir);
  await fs.appendFile(path.join(dir, filename), `${JSON.stringify(obj)}\n`);
}

describe("scan-local-secrets · CLEAN", () => {
  it("nenhuma das três superfícies existe -> CLEAN", () => {
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
  });

  it("as três superfícies existem mas sem nenhum formato de credencial -> CLEAN", async () => {
    await writeLine("governance", "events.jsonl", { type: "ok", ts: new Date().toISOString() });
    await writeLine("instincts", "observations.jsonl", { tool: "Read", ts: new Date().toISOString() });
    await writeLine("exec-log", "sess.jsonl", { tool: "Read", ok: true, ts: new Date().toISOString() });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
  });
});

describe("scan-local-secrets · HISTORICAL DEBT", () => {
  it("linha com `ts` ANTES do corte de redação -> HISTORICAL DEBT (exit != 0, nunca normalizada como verde)", async () => {
    await writeLine("governance", "events.jsonl", {
      type: "sensitive_file_access",
      file: GENERIC_FAKE_JWT,
      ts: "2025-01-01T00:00:00.000Z", // claramente anterior ao corte
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("HISTORICAL DEBT");
    expect(r.stderr).toContain("governance");
  });

  it("cada uma das três superfícies é varrida de forma independente", async () => {
    await writeLine("instincts", "observations.jsonl", {
      tool: "Bash",
      context: { command: GENERIC_FAKE_JWT },
      ts: "2025-01-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("instincts");
  });

  it("<repo>/.nexos/logs/ (não $HOME) também é coberto", async () => {
    await writeLine("exec-log", "sess.jsonl", {
      tool: "Bash",
      summary: GENERIC_FAKE_JWT,
      ts: "2025-01-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("logs");
  });
});

describe("scan-local-secrets · CURRENT LEAK", () => {
  it("linha com `ts` NO INSTANTE do corte (ou depois) -> CURRENT LEAK, mais severo que debt", async () => {
    await writeLine("governance", "events.jsonl", {
      type: "sensitive_file_access",
      file: GENERIC_FAKE_JWT,
      ts: "2026-08-31T00:00:00.000Z", // exatamente no corte — não é "antes"
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("CURRENT LEAK");
  });

  it("linha SEM `ts` legível -> CURRENT LEAK (fail-closed: não há como provar que é histórica)", async () => {
    const dir = path.join(home, ".nexos", "governance");
    await fs.ensureDir(dir);
    // Não é JSON válido — `ts` nunca é extraído.
    await fs.appendFile(path.join(dir, "events.jsonl"), `linha solta com ${GENERIC_FAKE_JWT}\n`);
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("CURRENT LEAK");
  });

  it("CURRENT LEAK e HISTORICAL DEBT coexistindo — reporta os dois, nunca esconde o debt atrás do leak", async () => {
    await writeLine("governance", "events.jsonl", { file: GENERIC_FAKE_JWT, ts: "2025-01-01T00:00:00.000Z" });
    await writeLine("instincts", "observations.jsonl", { context: { command: GENERIC_FAKE_JWT }, ts: "2026-09-01T00:00:00.000Z" });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("CURRENT LEAK");
    expect(r.stderr).toContain("HISTORICAL DEBT");
  });
});

describe("scan-local-secrets · confiança (SECRET BOUNDARY V0 closeout) — nome de padrão + ts, com o valor casado consultado SÓ para excluir placeholder conhecido (nunca reportado)", () => {
  it("sbp_ falso não-placeholder (supabase_key) CURRENT -> HIGH_CONFIDENCE_LEAK, exit != 0", async () => {
    await writeLine("governance", "events.jsonl", {
      file: `sbp_${"a".repeat(40)}`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("JWT falso não-placeholder CURRENT -> HIGH_CONFIDENCE_LEAK, exit != 0", async () => {
    await writeLine("governance", "events.jsonl", { file: GENERIC_FAKE_JWT, ts: "2026-09-01T00:00:00.000Z" });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("GitHub token falso não-placeholder CURRENT -> HIGH_CONFIDENCE_LEAK, exit != 0", async () => {
    await writeLine("governance", "events.jsonl", {
      file: `ghp_${"a".repeat(36)}`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("HIGH_CONFIDENCE_LEAK");
  });

  /**
   * `bearer_token` entrou em HIGH_CONFIDENCE_PATTERN_NAMES no fechamento do
   * SECRET BOUNDARY V0 (item 3) — antes desta fatia, um Bearer opaco caía em
   * LOW_CONFIDENCE_FINDING junto com `generic_secret`/`database_url`.
   */
  it("Bearer opaco não-placeholder CURRENT -> HIGH_CONFIDENCE_LEAK, exit != 0", async () => {
    await writeLine("governance", "events.jsonl", {
      file: `Bearer ${"z9Y8x7W6v5U4".repeat(2)}`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("HIGH_CONFIDENCE_LEAK");
  });

  /**
   * `PATTERN NAME IS NOT PROVENANCE` — os quatro testes abaixo são o
   * contraponto obrigatório dos quatro acima: MESMO shape de credencial,
   * mas o valor casado é EXATAMENTE um placeholder/fixture pública conhecida
   * (`KNOWN_PLACEHOLDERS`, canônico em `nexos-secret-patterns.cjs`) — nunca
   * HIGH, nunca sequer um finding (a linha some por completo, como se o
   * padrão nunca tivesse casado — ver cabeçalho de `scan-local-secrets.mjs`).
   */
  it("AKIAIOSFODNN7EXAMPLE (placeholder oficial da AWS) CURRENT -> CLEAN, NUNCA HIGH_CONFIDENCE_LEAK", async () => {
    await writeLine("governance", "events.jsonl", { file: "AKIAIOSFODNN7EXAMPLE", ts: "2026-09-01T00:00:00.000Z" });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("FAKE_JWT (placeholder canônico da suíte) CURRENT -> CLEAN, NUNCA HIGH_CONFIDENCE_LEAK", async () => {
    await writeLine("governance", "events.jsonl", { file: KNOWN_PLACEHOLDER_JWT, ts: "2026-09-01T00:00:00.000Z" });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("FAKE_SUPABASE_TOKEN (placeholder canônico da suíte) CURRENT -> CLEAN, NUNCA HIGH_CONFIDENCE_LEAK", async () => {
    await writeLine("governance", "events.jsonl", {
      file: `sbp_${"a1b2c3d4e5".repeat(4)}`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("Bearer placeholder (FAKE_BEARER canônico da suíte) CURRENT -> CLEAN, NUNCA HIGH_CONFIDENCE_LEAK", async () => {
    await writeLine("governance", "events.jsonl", {
      file: `Bearer ${"a1B2c3D4e5F6".repeat(2)}`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("GitHub token placeholder (FAKE_GITHUB_TOKEN canônico da suíte) CURRENT -> CLEAN, NUNCA HIGH_CONFIDENCE_LEAK", async () => {
    await writeLine("governance", "events.jsonl", { file: KNOWN_GITHUB_PLACEHOLDER, ts: "2026-09-01T00:00:00.000Z" });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("generic_secret continua LOW mesmo depois do fechamento do bearer_token — NÃO foi promovido junto", async () => {
    // Aspas SIMPLES de propósito: `JSON.stringify` escapa aspas duplas
    // (`\"`), o que quebra `["']` logo após `[:=]` no regex de
    // `generic_secret` — aspas simples sobrevivem literais na linha
    // persistida (mesma técnica do teste "texto benigno" acima).
    await writeLine("governance", "events.jsonl", {
      note: `api_key: 'benign-example-value'`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("LOW_CONFIDENCE_FINDING");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
  });

  it("texto benigno (nome de variável, config de exemplo) CURRENT -> LOW_CONFIDENCE_FINDING, NUNCA rotulado HIGH/CURRENT LEAK", async () => {
    await writeLine("governance", "events.jsonl", {
      note: `api_key: 'example-placeholder'`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("LOW_CONFIDENCE_FINDING");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
    expect(r.stderr).not.toContain("CURRENT LEAK");
  });

  it("database URL de fixture CURRENT (sem marcador de provedor) -> LOW_CONFIDENCE_FINDING, exit 0 (advisory) — contrato desta fatia", async () => {
    await writeLine("governance", "events.jsonl", {
      conn: "postgres://user:pass@localhost:5432/fixture_db",
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stderr).toContain("LOW_CONFIDENCE_FINDING");
  });

  it("LOW_CONFIDENCE atual convivendo com HISTORICAL DEBT -> exit != 0 pelo debt, LOW_CONFIDENCE ainda reportado (nunca escondido)", async () => {
    await writeLine("governance", "events.jsonl", { file: GENERIC_FAKE_JWT, ts: "2025-01-01T00:00:00.000Z" });
    await writeLine("governance", "events.jsonl", {
      note: `api_key: 'example-placeholder'`,
      ts: "2026-09-01T00:00:00.000Z",
    });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("HISTORICAL_DEBT");
    expect(r.stderr).toContain("LOW_CONFIDENCE_FINDING");
  });

  it("fixture histórica (HIGH-confidence pattern, ts antigo) -> HISTORICAL_DEBT, distinto de CLEAN e de HIGH_CONFIDENCE_LEAK", async () => {
    await writeLine("governance", "events.jsonl", { file: GENERIC_FAKE_JWT, ts: "2025-01-01T00:00:00.000Z" });
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("HISTORICAL_DEBT");
    expect(r.stdout).not.toContain("CLEAN");
    expect(r.stderr).not.toContain("HIGH_CONFIDENCE_LEAK");
  });
});

describe("scan-local-secrets · nunca varre $HOME genérico", () => {
  it("segredo em ~/.outro-lugar/ (fora das três superfícies nomeadas) não é encontrado", async () => {
    const outro = path.join(home, "outro-lugar");
    await fs.ensureDir(outro);
    await fs.writeFile(path.join(outro, "arquivo.txt"), `${GENERIC_FAKE_JWT}\n`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("CLEAN");
  });
});
