/**
 * `scripts/scan-secrets.mjs` — coverage for the three confirmed bypasses an
 * independent verifier reproduced against the real script:
 *
 *   - `.ENV` (case) escaped both the dotenv-name regex and the extension list
 *   - `backup.env` (dot-suffixed, not dot-prefixed) escaped the name regex
 *   - a symlink to a secret-bearing file was skipped outright
 *
 * Runs the real script as a subprocess against temp fixtures under
 * `os.tmpdir()` — never the real repo tree — so a passing test here proves
 * the shipped script behaves, not a reimplementation of its logic.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { spawnSync } from "node:child_process";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";

const SCRIPT = path.resolve(__dirname, "../scripts/scan-secrets.mjs");
const TMP = fs.realpathSync(os.tmpdir());

const SK_SECRET = `sk-proj-${"A".repeat(30)}`;
const JWT_SECRET = `eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9.${"B".repeat(60)}`;

let fixture: string;

beforeEach(async () => {
  fixture = await fs.mkdtemp(path.join(TMP, "scan-secrets-"));
});
afterEach(async () => {
  await fs.remove(fixture);
});

/**
 * `HOME` isolado por padrão — este script não lê mais `~/.nexos/governance/`
 * (SECRET BOUNDARY V0 slice B moveu esse walk para
 * `scripts/scan-local-secrets.mjs`, ver `tests/scan-local-secrets.test.ts`),
 * mas isolar continua sendo a higiene certa: nenhum teste desta suite deve
 * depender do `$HOME` de quem roda.
 */
function run(env: NodeJS.ProcessEnv = {}): { status: number | null; stdout: string; stderr: string } {
  const result = spawnSync("node", [SCRIPT], {
    cwd: fixture,
    encoding: "utf-8",
    env: { ...process.env, HOME: path.join(fixture, ".isolated-home"), ...env },
  });
  return { status: result.status, stdout: result.stdout, stderr: result.stderr };
}

describe("scan-secrets · bypasses closed", () => {
  it("template with only a placeholder PASSES", async () => {
    await fs.writeFile(path.join(fixture, ".env.example"), "API_KEY=your-key-here\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("secret scan passed");
  });

  it("same template name holding a real-shaped secret FAILS", async () => {
    await fs.writeFile(path.join(fixture, ".env.example"), `API_KEY=${SK_SECRET}\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(".env.example");
  });

  it("non-template dot-env file FAILS by name, even without a secret", async () => {
    await fs.writeFile(path.join(fixture, ".env"), "API_KEY=whatever\n");
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(".env");
  });

  it("uppercase .ENV with a secret FAILS", async () => {
    await fs.writeFile(path.join(fixture, ".ENV"), `TOKEN=${SK_SECRET}\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain(".ENV");
  });

  it("backup.env (dot-suffixed) with a secret FAILS", async () => {
    await fs.writeFile(path.join(fixture, "backup.env"), `TOKEN=${JWT_SECRET}\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("backup.env");
  });

  it("symlink to a secret-bearing file FAILS — resolved and scanned, not skipped", async () => {
    await fs.ensureDir(path.join(fixture, "vault"));
    // Real target has a non-scanned extension on its own — proves the link
    // (not the target's own extension) drives the decision to scan.
    const realSecret = path.join(fixture, "vault", "real-secret.txt");
    await fs.writeFile(realSecret, `TOKEN=${SK_SECRET}\n`);
    await fs.symlink(realSecret, path.join(fixture, "app.ts"));
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("app.ts");
  });

  it("symlink escaping the repo root FAILS closed instead of being silently skipped", async () => {
    const outside = await fs.mkdtemp(path.join(TMP, "scan-secrets-outside-"));
    try {
      const outsideSecret = path.join(outside, "real-secret.txt");
      await fs.writeFile(outsideSecret, `TOKEN=${SK_SECRET}\n`);
      await fs.symlink(outsideSecret, path.join(fixture, "escape.ts"));
      const r = run();
      expect(r.status).toBe(1);
      expect(r.stderr).toContain("escape.ts");
    } finally {
      await fs.remove(outside);
    }
  });

  it("secret in a .ts file FAILS", async () => {
    await fs.writeFile(path.join(fixture, "index.ts"), `const token = "${SK_SECRET}";\n`);
    const r = run();
    expect(r.status).toBe(1);
    expect(r.stderr).toContain("index.ts");
  });

  it("clean repo-like tree PASSES", async () => {
    await fs.ensureDir(path.join(fixture, "src"));
    await fs.writeFile(path.join(fixture, "src", "index.ts"), "export const hello = () => 'hi';\n");
    await fs.writeJson(path.join(fixture, "package.json"), { name: "fixture", version: "1.0.0" });
    await fs.writeFile(path.join(fixture, ".env.example"), "API_KEY=your-key-here\n");
    await fs.writeFile(path.join(fixture, "README.md"), "# fixture\n");
    const r = run();
    expect(r.status).toBe(0);
    expect(r.stdout).toContain("secret scan passed");
  });
});

/**
 * PARTE B — formatos ampliados. Medido: só `sk-proj-` e um header JWT HS256
 * cobriam o repo inteiro (`knw_01M0JV5R55C3P3N9SQ7R45GEXB`). Cada formato
 * abaixo precisa FALHAR sozinho — contrafactual por formato, não um teste
 * agregado que passaria mesmo se um padrão específico nunca disparasse.
 */
describe("PARTE B · scan-secrets — formatos ampliados de credencial", () => {
  const NOVOS_FORMATOS: ReadonlyArray<[label: string, valor: string]> = [
    ["sk-ant- (Anthropic)", `sk-ant-${"A".repeat(24)}`],
    ["ghp_ (GitHub PAT classic)", `ghp_${"A".repeat(36)}`],
    ["gho_ (GitHub OAuth)", `gho_${"A".repeat(36)}`],
    ["github_pat_ (GitHub fine-grained)", `github_pat_${"A".repeat(24)}`],
    ["AKIA (AWS access key)", `AKIA${"B".repeat(16)}`],
    ["AIza (Google API key)", `AIza${"C".repeat(35)}`],
    ["npm_ (npm token)", `npm_${"D".repeat(36)}`],
    ["glpat- (GitLab PAT)", `glpat-${"E".repeat(20)}`],
    ["xoxb- (Slack bot token)", `xoxb-${"0".repeat(12)}-${"F".repeat(20)}`],
    [
      "bloco de chave privada PEM",
      // ponytail: header construído por `.repeat()`, não como literal — um
      // "-----BEGIN...KEY-----" escrito por extenso no CÓDIGO-FONTE deste
      // arquivo dispararia o próprio scanner ao varrer `tests/`. O runtime
      // ainda produz o texto exato que o padrão espera.
      `${"-".repeat(5)}BEGIN RSA PRIVATE KEY${"-".repeat(5)}\nFAKEFAKEFAKEFAKEFAKEFAKE\n${"-".repeat(5)}END RSA PRIVATE KEY${"-".repeat(5)}`,
    ],
  ];

  for (const [label, valor] of NOVOS_FORMATOS) {
    it(`${label} em .ts FAILS`, async () => {
      await fs.writeFile(path.join(fixture, "config.ts"), `const token = "${valor}";\n`);
      const r = run();
      expect(r.status, r.stderr).toBe(1);
      expect(r.stderr).toContain("config.ts");
    });
  }

  /**
   * Achado real ao rodar `npm run scan:secrets` contra o repo (não hipótese):
   * `AKIA[0-9A-Z]{16}` bateu em `engine/tests/test_security.py` e
   * `engine/tests/test_memory.py`, que usam de propósito o access key ID de
   * EXEMPLO publicado pela própria documentação da AWS
   * (`AKIAIOSFODNN7EXAMPLE`) para testar o scanner interno do `engine/`. Não
   * é segredo — é o placeholder que o vendor manda usar. A allowlist em
   * `scripts/scan-secrets.mjs` existe por causa deste achado, não por
   * hipótese.
   */
  it("placeholder oficial da AWS (AKIAIOSFODNN7EXAMPLE) NÃO dispara falso positivo", async () => {
    await fs.writeFile(
      path.join(fixture, "docs-example.py"),
      'aws_access_key = "AKIAIOSFODNN7EXAMPLE"\n'
    );
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("secret scan passed");
  });

  it("chave no formato AKIA mas DIFERENTE do placeholder oficial continua FAILS — allowlist não é permissiva demais", async () => {
    await fs.writeFile(path.join(fixture, "creds.py"), `aws_access_key = "AKIA${"Z".repeat(16)}"\n`);
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain("creds.py");
  });
});

/**
 * PARTE B — `.nexos/records/` (Store portátil) entra no scan mesmo com
 * `.nexos` inteiro no SKIP geral. Medido: 156 records chegaram ao remote
 * nesta sessão sem o gate ter lido nenhum (`.nexos` inteiro pulado —
 * `knw_01M0JV5R55C3P3N9SQ7R45GEXB`). O contrafactual precisa provar as DUAS
 * metades: o que é PORTÁVEL (`records/`, `manifest.yaml`) entra no scan; o
 * que é LOCAL (`logs/`, `memory/` — nunca commitado, `.gitignore` garante)
 * continua fora, porque escanear 3+ MB que nunca chega ao remoto não fecha
 * risco nenhum.
 */
describe("PARTE B · scan-secrets — .nexos/records/ (Store portátil) entra no scan", () => {
  it("segredo em .nexos/records/**/*.yaml FAILS — antes desta mudança, .nexos inteiro era pulado", async () => {
    await fs.ensureDir(path.join(fixture, ".nexos", "records", "knowledge"));
    await fs.writeFile(
      path.join(fixture, ".nexos", "records", "knowledge", "knw_fake.yaml"),
      `content:\n  secret: ${SK_SECRET}\n`
    );
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(path.join(".nexos", "records", "knowledge", "knw_fake.yaml"));
  });

  it("segredo em .nexos/manifest.yaml FAILS", async () => {
    await fs.ensureDir(path.join(fixture, ".nexos"));
    await fs.writeFile(path.join(fixture, ".nexos", "manifest.yaml"), `token: ${SK_SECRET}\n`);
    const r = run();
    expect(r.status, r.stderr).toBe(1);
    expect(r.stderr).toContain(path.join(".nexos", "manifest.yaml"));
  });

  it("segredo em .nexos/logs (LOCAL, nunca chega ao remote) continua fora do scan", async () => {
    await fs.ensureDir(path.join(fixture, ".nexos", "logs"));
    await fs.writeFile(path.join(fixture, ".nexos", "logs", "session.jsonl"), `${SK_SECRET}\n`);
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("secret scan passed");
  });

  it("clean .nexos/records (sem segredo) PASSES", async () => {
    await fs.ensureDir(path.join(fixture, ".nexos", "records", "knowledge"));
    await fs.writeFile(
      path.join(fixture, ".nexos", "records", "knowledge", "knw_ok.yaml"),
      "content:\n  note: nada sensivel aqui\n"
    );
    const r = run();
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toContain("secret scan passed");
  });
});

/**
 * `~/.nexos/governance/` (e as demais superfícies globais do NexOS) NÃO são
 * varridas por este script — SECRET BOUNDARY V0 (slice B) moveu esse walk
 * para `scripts/scan-local-secrets.mjs`. Ver `tests/scan-local-secrets.test.ts`
 * para a cobertura equivalente (agora com três estados, não pass/fail).
 */
describe("scan-secrets — superfície global ~/.nexos/ fica FORA do contrato", () => {
  it("segredo em ~/.nexos/governance/events.jsonl NÃO reprova scan:secrets (superfície de scan:local-secrets)", async () => {
    const fakeHome = await fs.mkdtemp(path.join(TMP, "scan-secrets-fakehome-"));
    try {
      await fs.ensureDir(path.join(fakeHome, ".nexos", "governance"));
      await fs.writeFile(path.join(fakeHome, ".nexos", "governance", "events.jsonl"), `{"file":"${SK_SECRET}"}\n`);
      const r = run({ HOME: fakeHome });
      expect(r.status, r.stderr).toBe(0);
      expect(r.stdout).toContain("secret scan passed");
    } finally {
      await fs.remove(fakeHome);
    }
  });
});
