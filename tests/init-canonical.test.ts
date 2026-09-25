/**
 * N0 — um projeto NexOS nasce CANÔNICO.
 *
 *   CREATE != RECONCILE
 *   PORTABLE KNOWLEDGE != OPERATIONAL STATE
 *
 * Defeitos que estes testes travam, ambos medidos em 14/08:
 *   · `init` não criava manifest ⇒ 33/33 projetos em `bootstrap`/`UNAVAILABLE`
 *   · `init` acrescentava `.nexos/` ao `.gitignore` ⇒ a Capsule morria no clone
 *
 * Tudo roda em tmpdir, com `registerGlobally: false`: o catálogo em
 * `~/.nexos/projects.json` é do usuário e não é área de teste.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { init } from "../src/commands/init.js";
import { classifyCapsule, initializeCapsule } from "../src/lib/capsule/initializer.js";
import { classifyForReconciliation } from "../src/lib/capsule/migration-classifier.js";
import { forProject } from "../src/lib/capsule/paths.js";

let dir: string;

const initAqui = (extra: Record<string, unknown> = {}): Promise<void> =>
  init({ cwd: dir, registerGlobally: false, ...extra });

const manifestDe = async (raiz: string): Promise<{ project: { id: string; name: string } }> => {
  const YAML = await import("yaml");
  return YAML.parse(await fs.readFile(forProject(raiz).manifest(), "utf-8")) as {
    project: { id: string; name: string };
  };
};

beforeEach(async () => {
  dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "n0-"));
  vi.spyOn(console, "log").mockImplementation(() => {});
});

afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(dir);
});

describe("N0 · init cria Capsule canônica", () => {
  it("D · o manifest nasce, com project.id canônico", async () => {
    await initAqui();
    const p = forProject(dir);
    expect(await fs.pathExists(p.manifest())).toBe(true);

    const m = await manifestDe(dir);
    expect(m.project.id).toMatch(/^prj_[0-9A-HJKMNP-TV-Z]{26}$/);
    expect((await classifyCapsule(dir)).state).toBe("VALID_TARGET");
  });

  it("E · segunda invocação resolve o MESMO id e não reescreve", async () => {
    await initAqui();
    const antes = await manifestDe(dir);
    const bytesAntes = await fs.readFile(forProject(dir).manifest());

    await initAqui();
    expect((await manifestDe(dir)).project.id).toBe(antes.project.id);
    expect(await fs.readFile(forProject(dir).manifest())).toEqual(bytesAntes);
  });

  it("E · --force NÃO troca a identidade canônica", async () => {
    await initAqui();
    const antes = await manifestDe(dir);
    await initAqui({ force: true });
    expect((await manifestDe(dir)).project.id).toBe(antes.project.id);
  });

  /**
   * nexos://decision/claude-md-bloco-gerenciado: o conteúdo do usuário nunca é
   * sobrescrito — `init` só ANEXA o bloco gerenciado, e os bytes originais
   * continuam como prefixo exato do arquivo.
   */
  it("G · nenhum arquivo do usuário é sobrescrito (CLAUDE.md só ganha o bloco gerenciado anexado)", async () => {
    await fs.writeFile(path.join(dir, "CLAUDE.md"), "MEU CONTEUDO");
    await fs.writeFile(path.join(dir, "README.md"), "readme do usuario");
    await initAqui();
    const claudeMd = await fs.readFile(path.join(dir, "CLAUDE.md"), "utf-8");
    expect(claudeMd.startsWith("MEU CONTEUDO")).toBe(true);
    expect(claudeMd).toContain("<!-- NEXOS:BEGIN managed sha256=");
    expect(await fs.readFile(path.join(dir, "README.md"), "utf-8")).toBe("readme do usuario");
  });

  /**
   * H foi dividido em dois pela fatia 2 (contrato de reconciliação, C12.5):
   * `initializeCapsule` (STRICT) continua recusando QUALQUER legado — isso não
   * mudou. O que mudou é o COMANDO: quando o legado é CONHECIDO (C12.4), `init`
   * agora cai para `initializeForReconciliation` em vez de só reportar recusa.
   * Legado DESCONHECIDO continua FAIL CLOSED — ver H2 abaixo.
   */
  it("H1 · `.nexos` legado CONHECIDO — init reconcilia, legado sobrevive intocado", async () => {
    await fs.ensureDir(path.join(dir, ".nexos", "memory", "project"));
    await fs.writeFile(path.join(dir, ".nexos", "memory", "project", "state.md"), "legado");

    await initAqui();

    expect(await fs.pathExists(forProject(dir).manifest())).toBe(true);
    /**
     * `classifyCapsule` (modo STRICT) continua recusando legado ao lado do
     * canônico — por design, ver C12.4/M6. Quem reconhece "canônico válido +
     * legado tolerado" é a fina, `classifyForReconciliation`.
     */
    expect((await classifyCapsule(dir)).state).toBe("CONFLICTING_EXISTING");
    const pre = await classifyForReconciliation(dir);
    expect(pre.hasCanonical).toBe(true);
    expect(pre.conflicting).toEqual([]);
    expect(await fs.readFile(path.join(dir, ".nexos", "memory", "project", "state.md"), "utf-8")).toBe(
      "legado"
    );
  });

  /**
   * V1 (direcionamento consolidado §8/§10-F, achado do orquestrador) —
   * `init.ts` chamava `writeFreshProjectMap` incondicionalmente no ramo
   * `CONFLICTING_EXISTING`, mesmo quando `initializeForReconciliation`
   * devolvia `created: false` (manifest já existente) — reescrevendo os 6
   * arquivos de `.nexos/map` (hashes e `generated_at` mudavam) numa segunda
   * `nexos init` que não deveria tocar em nada. Prova mecânica: sha256 de
   * cada arquivo de `.nexos/map` idêntico entre a 2ª e a 3ª chamada (a 1ª
   * ainda CRIA de verdade — `created: true` — por isso a comparação começa
   * depois dela).
   */
  it("H1 V1 · segunda `nexos init` sobre `.nexos` já reconciliado não reescreve `.nexos/map` (mesma rota do VALID_TARGET)", async () => {
    const crypto = await import("node:crypto");
    await fs.ensureDir(path.join(dir, ".nexos", "memory", "project"));
    await fs.writeFile(path.join(dir, ".nexos", "memory", "project", "state.md"), "legado");

    await initAqui(); // 1ª chamada: reconciliação genuína — cria manifest.yaml + .nexos/map

    const mapDir = path.join(dir, ".nexos", "map");
    const hashDir = async (): Promise<Record<string, string>> => {
      const out: Record<string, string> = {};
      for (const f of (await fs.readdir(mapDir)).sort()) {
        out[f] = crypto.createHash("sha256").update(await fs.readFile(path.join(mapDir, f))).digest("hex");
      }
      return out;
    };
    const hashesAntes = await hashDir();
    expect(Object.keys(hashesAntes).length).toBeGreaterThan(0);

    vi.mocked(console.log).mockClear();
    await initAqui(); // 2ª chamada: manifest.yaml JÁ existe (created: false)

    const hashesDepois = await hashDir();
    expect(hashesDepois).toEqual(hashesAntes);

    const saida = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
    expect(saida).not.toContain("+ .nexos/manifest.yaml"); // não é criação — já existia
    expect(saida).toContain("já existia");
  });

  /**
   * D2 (decisão do dono do produto) — `nexos init` NÃO cria mais
   * `.claude/settings.json` de forma alguma: nem `autoMemoryEnabled` (já
   * retirado antes), nem `agent:` (a declaração de agente principal foi
   * removida — ver describe C2 abaixo). Auto Memory ligado nunca foi um
   * `HOST_MEMORY_AUTHORITY_CONFLICT` a corrigir — é o comportamento padrão
   * do host.
   */
  it("I · init NÃO cria .claude/settings.json — Auto Memory não é conflito, sem agente a declarar", async () => {
    await initAqui();
    const settingsPath = path.join(dir, ".claude", "settings.json");
    expect(await fs.pathExists(settingsPath)).toBe(false);
    expect(await fs.pathExists(path.join(dir, ".claude", "nexos-auto-memory-guard.manifest.json"))).toBe(false);
  });

  /**
   * D2 — sem nenhum passo de `init` lendo `.claude/settings.json`, um arquivo
   * truncado/inválido ali não pode mais derrubar nem desviar o comando: ele
   * termina normalmente (sem exitCode 1 por causa disto) e o arquivo do
   * usuário sobrevive byte a byte, nunca parseado.
   */
  it("I · settings.json truncado → init termina normalmente, arquivo intocado", async () => {
    await fs.ensureDir(path.join(dir, ".claude"));
    const settingsPath = path.join(dir, ".claude", "settings.json");
    const corrompido = '{"agent":"nexos-master","autoMemoryEnabled": fal';
    await fs.writeFile(settingsPath, corrompido, "utf-8");

    const exitCodeAntes = process.exitCode;
    try {
      await expect(initAqui()).resolves.toBeUndefined();
      expect(process.exitCode).toBe(exitCodeAntes);
    } finally {
      process.exitCode = exitCodeAntes;
    }

    expect(await fs.pathExists(forProject(dir).manifest())).toBe(true);
    expect(await fs.readFile(settingsPath, "utf-8")).toBe(corrompido); // bytes intactos, nunca parseado
  });

  it("I · um autoMemoryEnabled:true humano explícito sobrevive ao init", async () => {
    await fs.ensureDir(path.join(dir, ".claude"));
    await fs.writeJson(path.join(dir, ".claude", "settings.json"), { autoMemoryEnabled: true });
    await initAqui();
    expect((await fs.readJson(path.join(dir, ".claude", "settings.json"))).autoMemoryEnabled).toBe(true);
  });

  it("H2 · `.nexos` legado DESCONHECIDO é FAIL CLOSED — não inicializa por cima", async () => {
    await fs.ensureDir(path.join(dir, ".nexos", "mystery"));
    await fs.writeFile(path.join(dir, ".nexos", "mystery", "x.md"), "legado desconhecido");

    await initAqui();

    expect(await fs.pathExists(forProject(dir).manifest())).toBe(false);
    expect(await fs.readFile(path.join(dir, ".nexos", "mystery", "x.md"), "utf-8")).toBe(
      "legado desconhecido"
    );
  });
});

describe("N0 · a Capsule sobrevive ao clone", () => {
  /**
   * O teste que pega o defeito real: `.gitignore` com `.nexos/` faz o git nunca
   * reentrar no diretório, e nem o `.nexos/.gitignore` interno salva o manifest.
   */
  it("init NÃO ignora a Capsule inteira; ignora só o estado operacional", async () => {
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n");
    await initAqui();

    const gi = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    const linhas = gi.split("\n").map((l) => l.trim());
    expect(linhas).not.toContain(".nexos/");
    expect(linhas).not.toContain(".nexos");
    expect(linhas).toContain(".nexos/.local/");
    // memoria nunca sai da maquina (nexos://decision/memoria-nunca-sai-da-maquina)
    expect(linhas).toContain(".nexos/records/");
  });

  it("F · manifest atravessa um clone REAL; records e .local/ não", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n");

    await initAqui();

    /** Estado operacional: precisa NÃO atravessar. */
    await fs.outputFile(path.join(dir, ".nexos", ".local", "sessao.json"), "{}");
    /** Memória: nexos://decision/memoria-nunca-sai-da-maquina — também não atravessa. */
    await fs.outputFile(path.join(dir, ".nexos", "records", "decisions", "dec_teste.yaml"), "x: 1\n");

    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "capsule"], { cwd: dir });

    const clone = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "n0-clone-"));
    execFileSync("git", ["clone", "-q", dir, clone]);

    expect(await fs.pathExists(forProject(clone).manifest())).toBe(true);
    expect((await manifestDe(clone)).project.id).toBe((await manifestDe(dir)).project.id);
    expect((await classifyCapsule(clone)).state).toBe("VALID_TARGET");
    expect(await fs.pathExists(path.join(clone, ".nexos", ".local", "sessao.json"))).toBe(false);
    expect(await fs.pathExists(path.join(clone, ".nexos", "records", "decisions", "dec_teste.yaml"))).toBe(
      false
    );

    await fs.remove(clone);
  });

  /**
   * Achado CRITICAL do security-reviewer (24/09): sem `.gitignore` prévio o
   * init saía calado e o primeiro `git add -A` levava records/ e memory/.
   */
  it("projeto SEM .gitignore: init cria o arquivo e git add -A não leva memória", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    await initAqui();

    const linhas = (await fs.readFile(path.join(dir, ".gitignore"), "utf-8")).split("\n");
    for (const l of [".nexos/.local/", ".nexos/logs/", ".nexos/records/", ".nexos/memory/", ".nexos/evidence/"]) {
      expect(linhas).toContain(l);
    }
    await fs.outputFile(path.join(dir, ".nexos", "records", "decisions", "dec_x.yaml"), "x: 1\n");
    await fs.outputFile(path.join(dir, ".nexos", "memory", "m.md"), "m\n");
    await fs.outputFile(path.join(dir, ".nexos", "evidence", "e.json"), "{}\n");
    execFileSync("git", ["add", "-A"], { cwd: dir });
    const staged = execFileSync("git", ["diff", "--cached", "--name-only"], { cwd: dir, encoding: "utf-8" });
    expect(staged).toContain(".nexos/manifest.yaml");
    expect(staged).not.toMatch(/\.nexos\/(records|memory|evidence)\//);
  });

  it("compara por linha ATIVA: comentário não conta, barra final não duplica, cada linha sozinha, idempotente", async () => {
    await fs.writeFile(
      path.join(dir, ".gitignore"),
      "# .nexos/records/ decidir depois\n.nexos/memory\n.nexos/.local/\n"
    );
    await initAqui();
    const depois1 = await fs.readFile(path.join(dir, ".gitignore"), "utf-8");
    const ativas = depois1.split("\n").filter((l) => l && !l.startsWith("#"));
    expect(ativas).toContain(".nexos/records/"); // o comentário não enganou
    expect(ativas).toContain(".nexos/logs/"); // .local/ presente não implica logs/
    expect(ativas).toContain(".nexos/evidence/");
    expect(ativas.filter((l) => l.replace(/\/$/, "") === ".nexos/memory")).toHaveLength(1); // sem duplicar
    expect(ativas.filter((l) => l === ".nexos/.local/")).toHaveLength(1);

    await initAqui();
    expect(await fs.readFile(path.join(dir, ".gitignore"), "utf-8")).toBe(depois1);
  });

  /**
   * Contrafactual do gate acima: com `.nexos/` no gitignore o clone perde o
   * manifest. Sem este teste, o anterior passaria por acidente se o `init`
   * parasse de mexer no `.gitignore` — e o defeito voltaria calado.
   */
  it("contrafactual: `.nexos/` no gitignore MATA a portabilidade", async () => {
    execFileSync("git", ["init", "-q", "."], { cwd: dir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: dir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: dir });
    await fs.writeFile(path.join(dir, ".gitignore"), "node_modules/\n.nexos/\n");

    await initAqui();

    execFileSync("git", ["add", "-A"], { cwd: dir });
    execFileSync("git", ["commit", "-qm", "com gitignore amplo"], { cwd: dir });

    const clone = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "n0-bad-"));
    execFileSync("git", ["clone", "-q", dir, clone]);

    expect(await fs.pathExists(forProject(dir).manifest())).toBe(true);
    expect(await fs.pathExists(forProject(clone).manifest())).toBe(false);

    await fs.remove(clone);
  });
});

describe("N1 · Dockerfile não pode levar .nexos para a imagem", () => {
  it("sem Dockerfile — init não cria .dockerignore", async () => {
    await initAqui();
    expect(await fs.pathExists(path.join(dir, ".dockerignore"))).toBe(false);
  });

  it("com Dockerfile e SEM .dockerignore — cria um excluindo .nexos", async () => {
    await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:22\nCOPY . .\n");
    await initAqui();

    const di = await fs.readFile(path.join(dir, ".dockerignore"), "utf-8");
    expect(di.split("\n").map((l) => l.trim())).toContain(".nexos");
  });

  it("com Dockerfile e .dockerignore JÁ existente — acrescenta .nexos sem apagar linha do usuário", async () => {
    await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:22\n");
    await fs.writeFile(path.join(dir, ".dockerignore"), "node_modules\n.git\n");
    await initAqui();

    const di = await fs.readFile(path.join(dir, ".dockerignore"), "utf-8");
    const linhas = di.split("\n").map((l) => l.trim());
    expect(linhas).toContain("node_modules");
    expect(linhas).toContain(".git");
    expect(linhas).toContain(".nexos");
  });

  it("idempotente — já tem .nexos (com barra) não duplica nem reescreve", async () => {
    await fs.writeFile(path.join(dir, "Dockerfile"), "FROM node:22\n");
    await fs.writeFile(path.join(dir, ".dockerignore"), "node_modules\n.nexos/\n");
    const antes = await fs.readFile(path.join(dir, ".dockerignore"), "utf-8");

    await initAqui();

    const depois = await fs.readFile(path.join(dir, ".dockerignore"), "utf-8");
    expect(depois).toBe(antes);
  });
});

describe("F15 · init recusa Capsule aninhada quando já existe um ancestral canônico", () => {
  /**
   *   SUBDIRECTORY OF SAME REPO  -> pode herdar Capsule da raiz
   *   DISTINCT NESTED GIT REPO   -> nunca herda Capsule do ancestral
   *
   * `nexos init` dentro de um projeto já governado por um ancestral NÃO pode
   * criar uma segunda Capsule em silêncio — fail closed, nada escrito.
   */
  it("ancestral canônico presente -> exitCode 1, nenhum manifest criado, nada mais tocado", async () => {
    // P1.1 (nexos://decision/p1-1-resolver-fronteira-e-binding): fronteira
    // antes de identidade — o check de ancestral usa resolveProject a partir
    // do PAI de `nested`, que só encontra o manifest de `dir` subindo se
    // `dir` tiver um marcador próprio (`.git` ou marker).
    await fs.writeJson(path.join(dir, "package.json"), { name: "ancestral" });
    await initAqui(); // `dir` vira o ancestral canônico
    const nested = path.join(dir, "vendor", "nested-project");
    await fs.ensureDir(nested);

    const exitCodeAntes = process.exitCode;
    try {
      await init({ cwd: nested, registerGlobally: false });
      expect(process.exitCode).toBe(1);
    } finally {
      process.exitCode = exitCodeAntes;
    }

    expect(await fs.pathExists(forProject(nested).manifest())).toBe(false);
    expect(await fs.pathExists(path.join(nested, "CLAUDE.md"))).toBe(false);
  });

  it("SEM ancestral governado: init continua funcionando normalmente", async () => {
    await initAqui();
    expect(await fs.pathExists(forProject(dir).manifest())).toBe(true);
  });

  it("nested já tem sua PRÓPRIA Capsule válida (VALID_TARGET): ancestral não bloqueia", async () => {
    await initAqui(); // `dir` vira o ancestral canônico
    const nested = path.join(dir, "vendor", "nested-project");
    await fs.ensureDir(nested);
    // Capsule aninhada pré-existente (ex.: criada antes desta regra existir) —
    // via `initializeCapsule` direto, não via `init()`, porque o comando em si
    // agora recusa CRIAR uma capsule aninhada nova sob um ancestral governado.
    await initializeCapsule(nested, { projectName: "nested-project" });
    const idAntes = (await manifestDe(nested)).project.id;

    await init({ cwd: nested, registerGlobally: false }); // reexecução: VALID_TARGET, nada muda

    expect((await manifestDe(nested)).project.id).toBe(idAntes);
  });
});

/**
 * D2 (decisão do dono do produto) — `nexos init` NÃO declara mais agente
 * principal. A flag `--main-agent` e `lib/host/main-agent-declaration.ts`
 * foram removidos: era o único caminho restante que criava/reescrevia
 * `.claude/settings.json`, e nenhum outro consumidor real dependia dele
 * (agentes continuam disponíveis como subagents via installer/doctor).
 */
describe("C2 · init não declara mais agente principal — .claude/settings.json nunca nasce nem é reescrito", () => {
  it("settings.json AUSENTE — init não cria .claude/settings.json", async () => {
    await initAqui();
    expect(await fs.pathExists(path.join(dir, ".claude", "settings.json"))).toBe(false);
  });

  /** Prova mecânica: sha256 idêntico antes/depois, não só "parece igual" por `toEqual` no JSON parseado. */
  it("settings.json pré-existente (sem agent:) sobrevive byte a byte", async () => {
    const settingsPath = path.join(dir, ".claude", "settings.json");
    await fs.ensureDir(path.join(dir, ".claude"));
    const original = JSON.stringify({ model: "opus", permissions: { allow: ["Bash(pnpm test)"] } });
    await fs.writeFile(settingsPath, original, "utf-8");
    const crypto = await import("node:crypto");
    const shaAntes = crypto.createHash("sha256").update(await fs.readFile(settingsPath)).digest("hex");

    await initAqui();

    const shaDepois = crypto.createHash("sha256").update(await fs.readFile(settingsPath)).digest("hex");
    expect(shaDepois).toBe(shaAntes);
    expect(await fs.readFile(settingsPath, "utf-8")).toBe(original);
  });

  it("settings.json com agent: humano já declarado também sobrevive intocado", async () => {
    const settingsPath = path.join(dir, ".claude", "settings.json");
    await fs.ensureDir(path.join(dir, ".claude"));
    await fs.writeJson(settingsPath, { agent: "nexos-devops" });
    await initAqui();
    expect((await fs.readJson(settingsPath)).agent).toBe("nexos-devops");
  });
});

/**
 * P1.3i (B2) — `nexos init` num worktree git LINKED (`git worktree add`)
 * cujo checkout PRINCIPAL já tem `.nexos/manifest.yaml` para o MESMO
 * histórico (`git_root_commit` idêntico — invariante entre worktrees do
 * mesmo repositório). Ponta a ponta pelo comando real, não só
 * `detectLinkedWorktreeMainIdentity` isolado — a garantia é "zero escrita",
 * e só `init()` decide se escreve.
 */
describe("B2 · nexos init recusa identidade duplicada em worktree git ligado", () => {
  let mainDir: string;
  let worktreeDir: string;

  beforeEach(async () => {
    mainDir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "n0-b2-main-"));
    execFileSync("git", ["init", "-q", "."], { cwd: mainDir });
    execFileSync("git", ["config", "user.email", "t@t"], { cwd: mainDir });
    execFileSync("git", ["config", "user.name", "t"], { cwd: mainDir });
    await fs.writeFile(path.join(mainDir, "README.md"), "# x\n");
    execFileSync("git", ["add", "README.md"], { cwd: mainDir });
    execFileSync("git", ["commit", "-qm", "init"], { cwd: mainDir });
    await init({ cwd: mainDir, registerGlobally: false });

    worktreeDir = path.join(fs.realpathSync(os.tmpdir()), `n0-b2-wt-${Date.now()}`);
    execFileSync("git", ["worktree", "add", "-q", "-b", "b2-wt-branch", worktreeDir], { cwd: mainDir });
  });

  afterEach(async () => {
    await fs.remove(mainDir);
    await fs.remove(worktreeDir);
  });

  it("recusa com exit code != 0, zero escrita, e mensagem cita o checkout principal + project.id", async () => {
    const mainManifest = await manifestDe(mainDir);
    const exitCodeAntes = process.exitCode;
    try {
      await init({ cwd: worktreeDir, registerGlobally: false });
      expect(process.exitCode).not.toBe(0);
      expect(process.exitCode).toBeDefined();
    } finally {
      process.exitCode = exitCodeAntes;
    }

    expect(await fs.pathExists(path.join(worktreeDir, ".nexos"))).toBe(false);

    const saida = vi.mocked(console.log).mock.calls.flat().map(String).join("\n");
    expect(saida).toContain(mainDir);
    expect(saida).toContain(mainManifest.project.id);
  });

  it("SessionStart/boot no worktree citam a identidade do principal na lifecycleLine (não sugerem `nexos init`)", async () => {
    const { classifyProjectLifecycleFor, formatLifecycleLine } = await import(
      "../src/lib/capsule/project-lifecycle.js"
    );
    const lifecycle = await classifyProjectLifecycleFor(worktreeDir);
    expect(lifecycle.situation).toBe("NEW");
    expect(lifecycle.linkedWorktreeMain?.mainCheckoutPath).toBe(mainDir);
    const line = formatLifecycleLine(lifecycle);
    expect(line).toContain(mainDir);
    // Cita `nexos init` só para dizer que ele SERIA RECUSADO — nunca como
    // sugestão de ação (diferente da frase NEW comum, "Adotar ... `nexos init`.").
    expect(line).toContain("seria recusado");
    expect(line).not.toContain("Adotar não altera código");
  });
});

/**
 * C3 (fatia C, orquestrador) — `~/.nexos/projects.json` (`lib/registry.ts`)
 * tem ZERO leitores em `src/bin/assets`: nada resolve projeto a partir dele.
 * `nexos init` não deve mais gravar nesse catálogo. `NEXOS_HOME` já é
 * isolado globalmente para toda a suíte (`tests/isolate-nexos-home.ts`,
 * `setupFiles`) — o teste chama `init` SEM `registerGlobally: false` de
 * propósito (o default do comando é o caminho que este teste prova seguro).
 */
describe("C3 · nexos init não escreve mais em ~/.nexos/projects.json", () => {
  it("init (registerGlobally default) não cria projects.json no HOME isolado de teste", async () => {
    const { NEXOS_HOME } = await import("../src/lib/constants.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "n0-c3-"));
    try {
      await init({ cwd: dir });
      expect(await fs.pathExists(path.join(NEXOS_HOME, "projects.json"))).toBe(false);
    } finally {
      await fs.remove(dir);
    }
  });

  it("se um projects.json JÁ existir (versão anterior), init nunca o apaga nem o modifica", async () => {
    const { NEXOS_HOME } = await import("../src/lib/constants.js");
    const dir = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "n0-c3b-"));
    const registryPath = path.join(NEXOS_HOME, "projects.json");
    await fs.ensureDir(NEXOS_HOME);
    const conteudoPrevio = JSON.stringify({ version: 1, projects: [{ path: "/algum/outro/projeto" }] });
    await fs.writeFile(registryPath, conteudoPrevio);
    try {
      await init({ cwd: dir });
      expect(await fs.readFile(registryPath, "utf-8")).toBe(conteudoPrevio);
    } finally {
      await fs.remove(dir);
      await fs.remove(registryPath);
    }
  });
});

