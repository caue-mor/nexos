/**
 * SECRET BOUNDARY — Fatia D.
 *
 * MEDIDO: `nexos state --set`, `nexos decision --set` e `nexos memory --fact`
 * gravavam um token `ghp_...` em texto puro com `classification: internal` —
 * `assertNoSecretMaterial` (secret-guard.ts) só age quando o record JÁ SE
 * DECLAROU `secret`; conteúdo livre nunca era escaneado.
 *
 *   SENSITIVITY DECLARED != SECRET PROTECTED, NOS DOIS SENTIDOS
 *
 * `assertNoSecretPatternMatch` fecha o buraco: roda em TODO record que passa
 * por `assertPublishable` (`store.ts`), casando `content` contra os padrões
 * canônicos de `assets/hooks/nexos-secret-patterns.cjs` (espelhados aqui pelo
 * mesmo motivo estrutural de `SEGREDO` em `src/lib/evidence.ts` — ver
 * docstring em `secret-guard.ts`).
 */
import { describe, it, expect, beforeEach, afterEach, beforeAll, afterAll, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { createRequire } from "node:module";
import { execFileSync, spawnSync } from "node:child_process";
import { assertNoSecretPatternMatch, CANONICAL_SECRET_PATTERNS, SecretMaterialError } from "../src/lib/capsule/secret-guard.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { makeDecision } from "./capsule-fixtures.js";
import { spawnSemTerminalControlador, provarAusenciaDeTerminalControlador } from "./tty-fixtures.js";
import { init } from "../src/commands/init.js";
import { state } from "../src/commands/state.js";
import { gotcha } from "../src/commands/gotcha.js";
import { memory } from "../src/commands/memory.js";
import { decision } from "../src/commands/decision.js";

/**
 * `memory --promote` passou a exigir humano no terminal controlador
 * (`human-presence.ts`). Os casos IN-PROCESS deste arquivo testam o
 * secret-guard, não o gate, então o mock põe o humano no lugar. Ele NÃO afeta
 * os casos de subprocesso — o subprocesso carrega o módulo de verdade.
 *
 * O caso de subprocesso mais abaixo dizia medir "sem tty" com `spawnSync`, e
 * isso estava errado: pipe no stdio não tira o terminal controlador da sessão,
 * então num terminal de verdade ele imprimia `[y/N]` e travava a suíte. Ele
 * agora usa `tty-fixtures.ts`, que cria o processo sem terminal por `setsid()`
 * e prova o construto antes de medir.
 */
vi.mock("../src/lib/host/human-presence.js", () => ({
  requestHumanApproval: () => ({ approved: true, approvedBy: "human:tty", why: "aprovado (mock de teste)" }),
}));

/** Fixture pública conhecida (`KNOWN_PLACEHOLDERS`, `ghp_` + 36 chars) — nunca
 * uma credencial real. Mesmo literal exato do canônico. */
const FAKE_GITHUB_TOKEN = "ghp_" + "a1B2c3D4e5".repeat(4);
/** Forma válida de github_token que NÃO é o placeholder conhecido — sintética,
 * nunca usada por nenhum serviço real. */
const SYNTHETIC_GITHUB_TOKEN = "ghp_" + "Z9y8X7w6V5".repeat(4);

describe("assertNoSecretPatternMatch — unidade", () => {
  it("texto comum não dispara nada", () => {
    expect(() => assertNoSecretPatternMatch({ content: { next_action: "seguir para o próximo passo" } })).not.toThrow();
  });

  it("content ausente não dispara nada", () => {
    expect(() => assertNoSecretPatternMatch({})).not.toThrow();
  });

  it("github_token sintético em campo de content é recusado, mensagem não ecoa o valor", () => {
    let erro: unknown;
    try {
      assertNoSecretPatternMatch({ content: { current_state: `token: ${SYNTHETIC_GITHUB_TOKEN}` } });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(SecretMaterialError);
    const msg = (erro as Error).message;
    expect(msg).toContain("content.current_state");
    expect(msg).toContain("github_token");
    expect(msg).not.toContain(SYNTHETIC_GITHUB_TOKEN);
  });

  it("placeholder EXATO conhecido (FAKE_GITHUB_TOKEN) não é recusado", () => {
    expect(() => assertNoSecretPatternMatch({ content: { decision: `usar ${FAKE_GITHUB_TOKEN} como exemplo` } })).not.toThrow();
  });

  it(`placeholder oficial da AWS (${"AKIA" + "IOSFODNN7EXAMPLE"}) não é recusado`, () => {
    expect(() =>
      assertNoSecretPatternMatch({ content: { context: "ver docs AWS: " + "AKIA" + "IOSFODNN7EXAMPLE" } })
    ).not.toThrow();
  });

  it("recursa em array e reporta o índice no caminho", () => {
    let erro: unknown;
    try {
      assertNoSecretPatternMatch({ content: { consequences: ["ok", `vaza ${SYNTHETIC_GITHUB_TOKEN}`] } });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(SecretMaterialError);
    expect((erro as Error).message).toContain("content.consequences[1]");
  });

  it("recursa em objeto aninhado (continuity) e reporta o caminho", () => {
    let erro: unknown;
    try {
      assertNoSecretPatternMatch({
        content: { continuity: { applicability: `Bearer ${"Z9y8X7w6V5U4".repeat(2)}` } },
      });
    } catch (e) {
      erro = e;
    }
    expect(erro).toBeInstanceOf(SecretMaterialError);
    expect((erro as Error).message).toContain("content.continuity.applicability");
    expect((erro as Error).message).toContain("bearer_token");
  });

  it("database_url (postgres://) é recusado", () => {
    expect(() =>
      assertNoSecretPatternMatch({ content: { cause: "conexão via " + "postgres" + "://user:pass@host:5432/db" } })
    ).toThrow(SecretMaterialError);
  });

  it("private key PEM é recusada", () => {
    expect(() =>
      assertNoSecretPatternMatch({ content: { evidence: "-----BEGIN " + "RSA PRIVATE KEY-----\nMIIB...\n" } })
    ).toThrow(SecretMaterialError);
  });
});

/**
 * A garantia de que os 8 padrões espelhados em `secret-guard.ts`
 * (`CANONICAL_SECRET_PATTERNS`) não divergiram do canônico morava só no
 * bloco 7 de `scripts/verify-secret-pattern-conformance.mts` — um script
 * standalone que hoje crasha ANTES de chegar naquele bloco (checks 1-3
 * referenciam hooks removidos em `abbcb4d3`, fora de escopo aqui). Esta
 * suíte roda de fato (`npx vitest run`), então a prova migra pra cá: carrega
 * o `.cjs` real via `createRequire` (mesma técnica de
 * `verify-secret-pattern-conformance.mts`) e compara nome + `source` +
 * `flags` de cada padrão — não só o `source` como o script fazia.
 */
describe("CANONICAL_SECRET_PATTERNS — conformidade com assets/hooks/nexos-secret-patterns.cjs", () => {
  const require = createRequire(import.meta.url);
  const { SECRET_PATTERNS: CANONICAL } = require("../assets/hooks/nexos-secret-patterns.cjs") as {
    SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }>;
  };

  it("os 8 padrões espelhados são IDÊNTICOS (nome + source + flags) ao canônico real", () => {
    expect(CANONICAL_SECRET_PATTERNS).toHaveLength(CANONICAL.length);
    const canonicalPorNome = new Map(CANONICAL.map((p) => [p.name, p.pattern] as const));
    for (const espelhado of CANONICAL_SECRET_PATTERNS) {
      const real = canonicalPorNome.get(espelhado.name);
      expect(real, `padrão "${espelhado.name}" (secret-guard.ts) ausente no canônico`).toBeDefined();
      expect(espelhado.pattern.source, `source de "${espelhado.name}" divergiu do canônico`).toBe(real!.source);
      expect(espelhado.pattern.flags, `flags de "${espelhado.name}" divergiram do canônico`).toBe(real!.flags);
    }
  });

  it("contrafactual: padrão alterado no espelho FALHA a comparação — a prova tem dente", () => {
    const real = CANONICAL.find((p) => p.name === "github_token")!;
    // Mutação sintética a partir do valor REAL (nunca um literal fixo — um
    // literal fixo podia coincidir por acidente com uma edição futura
    // legítima do canônico e mascarar o próprio contrafactual). Um caractere
    // a mais garante divergência sempre, qualquer que seja o valor real.
    const driftadoSource = `${real.pattern.source}X`;

    // A MESMA asserção do teste positivo (`.toBe(real.pattern.source)`),
    // aplicada ao valor DRIFTADO, precisa reprovar — é isso que prova que o
    // teste positivo não passaria vazio (sempre-verde) se `secret-guard.ts`
    // divergisse de verdade.
    expect(() => expect(driftadoSource).toBe(real.pattern.source)).toThrow();
  });
});

describe("assertNoSecretPatternMatch — via publishCanonical, independente de classification", () => {
  const TMP_BASE = fs.realpathSync(os.tmpdir());
  let ws: string;
  let root: string;
  let projectId: string;

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(TMP_BASE, "secret-guard-"));
    root = path.join(ws, "proj");
    await fs.ensureDir(root);
    const initResult = await initializeCapsule(root, { projectName: "proj" });
    projectId = initResult.projectId;
  });
  afterEach(async () => {
    await fs.remove(ws);
  });

  it("Decision classification=internal com token em content.decision é recusada — nada escrito", async () => {
    const record = makeDecision({
      project_id: projectId,
      content: { title: "config", decision: `usar ${SYNTHETIC_GITHUB_TOKEN}` },
    });
    await expect(publishCanonical(root, record)).rejects.toThrow(SecretMaterialError);

    const lidos = await readCurrentRecords(root, { families: ["Decision"] });
    expect(lidos.ok).toBe(true);
    if (lidos.ok) expect(lidos.records).toHaveLength(0);
  });
});

describe("secret pattern boundary — as quatro CLIs de escrita canônica, mesmo choke point", () => {
  const TMP_BASE = fs.realpathSync(os.tmpdir());
  let ws: string;
  let root: string;

  const silencioso = async (fn: () => Promise<void>): Promise<unknown> => {
    let erro: unknown;
    const origLog = console.log;
    const origErr = console.error;
    console.log = () => {};
    console.error = () => {};
    try {
      await fn();
    } catch (e) {
      erro = e;
    } finally {
      console.log = origLog;
      console.error = origErr;
    }
    return erro;
  };

  const nadaVazouPara = async (): Promise<void> => {
    const nexosDir = path.join(root, ".nexos");
    const proc = await import("node:child_process");
    const grep = proc.spawnSync("grep", ["-r", SYNTHETIC_GITHUB_TOKEN, nexosDir], { encoding: "utf-8" });
    // grep exit 1 == nenhuma ocorrência. exit 0 == achou (falha do teste).
    expect(grep.status).not.toBe(0);
  };

  beforeEach(async () => {
    ws = await fs.mkdtemp(path.join(TMP_BASE, "secret-guard-cli-"));
    root = path.join(ws, "proj");
    await fs.ensureDir(root);
    await silencioso(() => init({ cwd: root, registerGlobally: false }));
  });
  afterEach(async () => {
    await fs.remove(ws);
  });

  it("nexos state --set com token sintético: recusa limpa (sem throw), exitCode 1, nada escrito", async () => {
    // Antes desta correção o comando RELANÇAVA o SecretMaterialError e o
    // usuário via a stack de secret-guard.js — a recusa estava certa, a
    // apresentação não (mesmo defeito já corrigido em gotcha.ts e memory.ts).
    const anterior = process.exitCode;
    process.exitCode = undefined;
    const erro = await silencioso(() =>
      state({ cwd: root, set: `trabalhando com ${SYNTHETIC_GITHUB_TOKEN}`, next: "seguir mesmo assim" })
    );
    const codigo = process.exitCode;
    process.exitCode = anterior;

    expect(erro).toBeUndefined();
    expect(codigo).toBe(1);

    const lidos = await readCurrentRecords(root, { kind: "project_state" });
    expect(lidos.ok).toBe(true);
    if (lidos.ok) expect(lidos.records).toHaveLength(0);
    await nadaVazouPara();
  });

  /**
   * nexos://gotcha/nexos-gotcha-despeja-stack-crua-quando-o-secret-guard-recusa-o-conteudo
   * — ao contrário de `nexos state` acima (fora do escopo desta correção),
   * `gotcha()`/`memory()` agora capturam `SecretMaterialError` internamente
   * (mesmo padrão já usado por TODA outra recusa de guarda nestas duas
   * funções): a promise RESOLVE, nunca rejeita — `erro` fica `undefined` e a
   * recusa vira `process.exitCode = 1` + mensagem limpa, exatamente como
   * `nexos decision` já fazia. CONTRAFACTUAL: revertendo o catch novo em
   * `commands/gotcha.ts`/`commands/memory.ts`, estes dois testes voltam a
   * ver `erro instanceof SecretMaterialError` (a promise rejeitando) — a
   * prova de que a asserção tem dente.
   */
  it("nexos gotcha com token sintético em --trigger: exitCode=1, nada escrito, nunca rejeita", async () => {
    const anterior = process.exitCode;
    const erro = await silencioso(() =>
      gotcha({ cwd: root, title: "vazamento hipotético", trigger: `rodar com ${SYNTHETIC_GITHUB_TOKEN} exportado` })
    );
    expect(erro).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = anterior;

    const lidos = await readCurrentRecords(root, { kind: "gotcha" });
    expect(lidos.ok).toBe(true);
    if (lidos.ok) expect(lidos.records).toHaveLength(0);
    await nadaVazouPara();
  });

  it("nexos memory --fact com token sintético: exitCode=1, nada escrito, nunca rejeita", async () => {
    const anterior = process.exitCode;
    const erro = await silencioso(() =>
      memory({ cwd: root, fact: `credencial vazada ${SYNTHETIC_GITHUB_TOKEN}`, evidence: "medido em teste" })
    );
    expect(erro).toBeUndefined();
    expect(process.exitCode).toBe(1);
    process.exitCode = anterior;

    const lidos = await readCurrentRecords(root);
    expect(lidos.ok).toBe(true);
    if (lidos.ok) expect(lidos.records).toHaveLength(0);
    await nadaVazouPara();
  });

  /**
   * A cobertura que o caso de subprocesso perdeu quando o gate de autoridade
   * passou a barrá-lo antes do guard. Aqui o humano está no lugar (mock no topo
   * do arquivo), então o comando CHEGA ao secret-guard — e é ele que recusa.
   *
   *   BARRADO PELO GATE != BARRADO PELO GUARD
   *
   * São duas defesas distintas e cada teste mede uma.
   */
  it("nexos memory --promote --to global com credencial em --generality: guard recusa, nada escrito", async () => {
    const anterior = process.exitCode;
    await silencioso(() =>
      memory({
        cwd: root,
        fact: "fato limpo, elegível a global",
        evidence: "medido em teste",
        scope: "global",
        subject: "fixture-secret-guard",
      })
    );
    const propostos = await readCurrentRecords(root);
    if (!propostos.ok) throw new Error("Store ilegível");
    const candidato = propostos.records
      .map((r) => r.record)
      .find((r) => (r as { kind?: string }).kind === "memory_candidate");
    expect(candidato).toBeDefined();

    await silencioso(() =>
      memory({
        cwd: root,
        promote: candidato?.id ?? "",
        to: "global",
        subject: "fixture-secret-guard",
        generality: `vale fora ${SYNTHETIC_GITHUB_TOKEN}`,
        why: "teste",
      })
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = anterior;

    /** O candidato segue candidato: a credencial não virou memória global. */
    const depois = await readCurrentRecords(root, { includeGlobal: true });
    if (!depois.ok) throw new Error("Store ilegível");
    expect(depois.records.map((r) => r.record).filter((r) => (r as { kind?: string }).kind === "gotcha")).toHaveLength(0);
    await nadaVazouPara();
  });

  it("nexos decision --set com token sintético: exitCode=1, nada escrito", async () => {
    const anterior = process.exitCode;
    await silencioso(() =>
      decision({
        cwd: root,
        set: `usar ${SYNTHETIC_GITHUB_TOKEN}`,
        key: "chave-teste",
        type: "decision",
        source: "human:test",
        applicability: "sempre neste projeto",
      })
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = anterior;

    const lidos = await readCurrentRecords(root, { families: ["Decision"] });
    expect(lidos.ok).toBe(true);
    if (lidos.ok) expect(lidos.records).toHaveLength(0);
    await nadaVazouPara();
  });

  it("placeholder conhecido (FAKE_GITHUB_TOKEN) continua gravando normalmente", async () => {
    const erro = await silencioso(() =>
      state({ cwd: root, set: `exemplo público ${FAKE_GITHUB_TOKEN}`, next: "seguir mesmo assim" })
    );
    expect(erro).toBeUndefined();

    const lidos = await readCurrentRecords(root, { kind: "project_state" });
    expect(lidos.ok).toBe(true);
    if (lidos.ok) expect(lidos.records).toHaveLength(1);
  });

  it("texto comum (sem forma de credencial) continua gravando normalmente", async () => {
    const erro = await silencioso(() =>
      state({ cwd: root, set: "seguindo para a próxima fatia do plano", next: "seguir mesmo assim" })
    );
    expect(erro).toBeUndefined();

    const lidos = await readCurrentRecords(root, { kind: "project_state" });
    expect(lidos.ok).toBe(true);
    if (lidos.ok) expect(lidos.records).toHaveLength(1);
  });
});

/**
 * nexos://gotcha/nexos-gotcha-despeja-stack-crua-quando-o-secret-guard-recusa-o-conteudo
 * — BLACK-BOX de propósito (mesmo motivo de `tests/git-facts-single-spawn.test.ts`):
 * os testes acima chamam `gotcha()`/`memory()` diretamente, então nunca
 * passam pelo mecanismo real que produzia a stack crua — um `SecretMaterialError`
 * não capturado escapando do handler `.action()` do Commander como REJECTION
 * não tratada, que o próprio Node imprime (arquivo/linha de `dist/.../secret-guard.js`
 * + bloco `at ...`) antes de sair. Só um subprocesso real reproduz isso.
 */
describe("nexos gotcha / nexos memory --fact via subprocesso real — sem stack crua", () => {
  const ROOT = path.resolve(__dirname, "..");
  const CLI = [path.join(ROOT, "dist/index.js")];
  const REAL_GIT = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();

  let lab: string;
  let home: string;
  let proj: string;

  function gitQuieto(args: readonly string[], cwd: string): void {
    execFileSync(REAL_GIT, [...args], { cwd, stdio: "pipe" });
  }

  beforeAll(async () => {
    lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "secret-guard-subprocess-"));
    home = path.join(lab, "home");
    proj = path.join(lab, "proj");
    await fs.ensureDir(home);
    await fs.ensureDir(proj);

    gitQuieto(["init", "-q"], proj);
    gitQuieto(["config", "user.email", "t@t"], proj);
    gitQuieto(["config", "user.name", "t"], proj);
    await fs.writeFile(path.join(proj, "README.md"), "fixture\n");
    gitQuieto(["add", "-A"], proj);
    gitQuieto(["commit", "-q", "-m", "c1"], proj);

    const init = spawnSync(process.execPath, [...CLI, "init"], {
      cwd: proj,
      encoding: "utf-8",
      env: { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" },
    });
    if (init.status !== 0) throw new Error(`nexos init falhou: ${init.stderr}`);

    /** O caso do gate abaixo só mede o que afirma se o fixture entregar mesmo
     *  um processo sem terminal controlador. Falha dizendo isso, nunca trava. */
    const semTerminal = await provarAusenciaDeTerminalControlador(ROOT);
    if (!semTerminal.startsWith("SEM_TERMINAL:")) {
      throw new Error(`fixture sem terminal controlador quebrou neste host: ${semTerminal}`);
    }
  });
  afterAll(async () => {
    await fs.remove(lab);
  });

  /** Nenhuma linha de stack trace de Node (`    at algumaFuncao (...)`). */
  const SEM_STACK = /^\s*at\s/m;

  it("nexos gotcha com padrão de credencial em --trigger: exit 1, mensagem limpa, sem stack, nada escrito", () => {
    const r = spawnSync(
      process.execPath,
      [...CLI, "gotcha", "--title", "d1 repro", "--trigger", `rodar com ${SYNTHETIC_GITHUB_TOKEN} exportado`],
      { cwd: proj, encoding: "utf-8", env: { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" } }
    );
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status).toBe(1);
    expect(out).toContain("x ");
    expect(out).toContain("content.trigger");
    expect(out).toContain("github_token");
    expect(out).not.toMatch(SEM_STACK);
    expect(out).not.toContain(SYNTHETIC_GITHUB_TOKEN);

    const knowledgeDir = path.join(proj, ".nexos", "records", "knowledge");
    const escritos = fs.existsSync(knowledgeDir) ? fs.readdirSync(knowledgeDir) : [];
    expect(escritos).toHaveLength(0);
  });

  it("nexos memory --fact com padrão de credencial: exit 1, mensagem limpa, sem stack, nada escrito", () => {
    const r = spawnSync(
      process.execPath,
      [...CLI, "memory", "--fact", `credencial vazada ${SYNTHETIC_GITHUB_TOKEN}`, "--evidence", "medido em teste"],
      { cwd: proj, encoding: "utf-8", env: { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" } }
    );
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status).toBe(1);
    expect(out).toContain("content.fact");
    expect(out).toContain("github_token");
    expect(out).not.toMatch(SEM_STACK);
    expect(out).not.toContain(SYNTHETIC_GITHUB_TOKEN);

    const knowledgeDir = path.join(proj, ".nexos", "records", "knowledge");
    const escritos = fs.existsSync(knowledgeDir) ? fs.readdirSync(knowledgeDir) : [];
    expect(escritos).toHaveLength(0);
  });

  it("nexos state --set com padrão de credencial: exit 1, mensagem limpa, sem stack, nada escrito", () => {
    const r = spawnSync(
      process.execPath,
      [...CLI, "state", "--set", `trabalhando com ${SYNTHETIC_GITHUB_TOKEN}`, "--next", "seguir"],
      { cwd: proj, encoding: "utf-8", env: { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" } }
    );
    const out = `${r.stdout}${r.stderr}`;

    expect(r.status).toBe(1);
    expect(out).toContain("content.current_state");
    expect(out).not.toMatch(SEM_STACK);
    expect(out).not.toContain(SYNTHETIC_GITHUB_TOKEN);

    const stateDir = path.join(proj, ".nexos", "records", "project_state");
    const escritos = fs.existsSync(stateDir) ? fs.readdirSync(stateDir) : [];
    expect(escritos).toHaveLength(0);
  });

  /**
 * Este caso MUDOU de alvo. Antes media o secret-guard em `content.generality`;
 * com o gate de autoridade, um subprocesso (que não tem terminal controlador,
 * igual a um agente) é barrado ANTES de chegar ao guard. O que ele prova agora
 * é mais forte: a credencial não chega nem a ser processada, e nada é escrito.
 * A cobertura do guard em `--generality` não se perdeu — foi para o caso
 * in-process logo abaixo.
 */
it("nexos memory --promote por subprocesso sem terminal controlador é barrado pelo gate: exit 1, sem stack, nada global escrito", async () => {
    const env = { HOME: home, PATH: process.env.PATH ?? "", NO_COLOR: "1" };
    const proposta = spawnSync(
      process.execPath,
      [...CLI, "memory", "--fact", "fato limpo para promover", "--evidence", "medido em teste", "--scope", "global", "--subject", "fixture"],
      { cwd: proj, encoding: "utf-8", env }
    );
    const id = /candidato (\S+) proposto/.exec(`${proposta.stdout}${proposta.stderr}`)?.[1];
    expect(id, `${proposta.stdout}${proposta.stderr}`).toBeDefined();

    const r = await spawnSemTerminalControlador(
      [...CLI, "memory", "--promote", id ?? "", "--to", "global", "--subject", "fixture", "--generality", `vale fora ${SYNTHETIC_GITHUB_TOKEN}`, "--why", "teste"],
      { cwd: proj, env }
    );
    const out = r.saida;

    expect(r.status, out).toBe(1);
    expect(out).toContain("sem terminal controlador");
    expect(out).not.toMatch(SEM_STACK);
    expect(out).not.toContain(SYNTHETIC_GITHUB_TOKEN);
    const grep = spawnSync("grep", ["-rl", SYNTHETIC_GITHUB_TOKEN, home, path.join(proj, ".nexos")], { encoding: "utf-8" });
    expect(grep.stdout).toBe("");
  });
});
