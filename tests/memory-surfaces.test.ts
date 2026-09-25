/**
 * MEMORY SURFACES — o detector acha o que existe E não inventa o que não existe.
 *
 *   DIRECTORY EXISTS != MEMORY IS ALIVE
 *
 * `claudeDir`/`nexosHome` são injetados: sem isso o teste leria o
 * `~/.claude/agent-memory` REAL do executor, e o contrafactual negativo
 * ("projeto sem essa memória") passaria a depender da máquina — exatamente o
 * erro que o teste existe para excluir. A camada `user` da cadeia de settings
 * continua vindo de `constants.ts` (mesmo teto declarado em
 * `memory-authority.test.ts`), e por isso todo caso aqui fixa
 * `autoMemoryEnabled` no `project`, nunca deixando a cadeia cair no `user`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  scanMemorySurfaces,
  isWriteOnly,
  isFrozen,
  type MemorySurface,
  type MemorySurfaceId,
} from "../src/lib/host/memory-surfaces.js";
import { claudeProjectSlug } from "../src/lib/host/memory-surfaces.js";

let ws: string;
let claudeDir: string;
let nexosHome: string;
let root: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "msurf-"));
  claudeDir = path.join(ws, "home", ".claude");
  nexosHome = path.join(ws, "home", ".nexos");
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
});
afterEach(async () => {
  await fs.remove(ws);
});

const opts = () => ({ claudeDir, nexosHome });

function get(surfaces: readonly MemorySurface[], id: MemorySurfaceId): MemorySurface {
  const found = surfaces.find((s) => s.id === id);
  if (!found) throw new Error(`superfície ${id} sumiu do scan`);
  return found;
}

async function setAutoMemory(enabled: boolean): Promise<void> {
  await fs.outputJson(path.join(root, ".claude", "settings.json"), { autoMemoryEnabled: enabled });
}

async function writeAgent(dir: string, name: string, scope: string | null): Promise<void> {
  const fm = scope ? `---\nname: ${name}\nmemory: ${scope}\n---\n` : `---\nname: ${name}\n---\n`;
  await fs.outputFile(path.join(dir, `${name}.md`), `${fm}\ncorpo do agente\n`);
}

describe("scanMemorySurfaces · contrafactual negativo", () => {
  it("projeto pelado: toda superfície é reportada, nenhuma existe, zero itens", async () => {
    await setAutoMemory(false);
    const scan = await scanMemorySurfaces(root, opts());

    expect(scan.surfaces).toHaveLength(6);
    expect(scan.surfaces.every((s) => !s.exists)).toBe(true);
    expect(scan.surfaces.every((s) => s.items === 0)).toBe(true);
    expect(scan.quarantined).toEqual([]);
    expect(scan.subagentMemoryDeclarations).toEqual({ user: 0, project: 0, local: 0 });
    // Nada com conteúdo ⇒ nada write-only e nada congelado. Um detector que
    // grita em projeto vazio é ruído, não sinal.
    expect(scan.surfaces.some(isWriteOnly)).toBe(false);
    expect(scan.surfaces.some(isFrozen)).toBe(false);
  });

  /**
   * T9 (plano de memória em camadas v3.2, §7/§9) — guard de regressão. O
   * Store (`<root>/.nexos/records`, GLOBAL ou de projeto) NÃO é memória
   * paralela: classificá-lo como tal faria o próprio doctor reportar o
   * acervo canônico como acervo concorrente (§7, literal). `MemorySurfaceId`
   * tem seis ids hoje e nenhum aponta para `records/` — este teste falha se
   * um sétimo id aparecer, ou se algum dos seis apontar para o Store.
   */
  it("T9 · continua com exatamente 6 ids — Store nunca ganha um 7º id de memória paralela", async () => {
    const scan = await scanMemorySurfaces(root, opts());
    const ids = scan.surfaces.map((s) => s.id).slice().sort();
    expect(ids).toEqual([
      "agent-memory-local",
      "agent-memory-project",
      "agent-memory-user",
      "host-auto-memory",
      "instincts",
      "project-markdown",
    ]);

    const apontaParaOStore = scan.surfaces.some((s) => s.path.endsWith(path.join(".nexos", "records")));
    expect(apontaParaOStore).toBe(false);
  });

  it("sem projectId, instincts é INLOCALIZÁVEL — não conta o acervo dos outros projetos", async () => {
    await setAutoMemory(false);
    // Dois projetos alheios com acervo. Um fallback para
    // `~/.nexos/instincts/projects/` os contaria como memória DESTE projeto.
    await fs.outputFile(path.join(nexosHome, "instincts", "projects", "outro-a", "i.json"), "{}");
    await fs.outputFile(path.join(nexosHome, "instincts", "projects", "outro-b", "i.json"), "{}");

    const s = get((await scanMemorySurfaces(root, opts())).surfaces, "instincts");
    expect(s.items).toBe(0);
    expect(s.exists).toBe(false);
    expect(s.note).toMatch(/inlocaliz/i);
  });

  it("diretório existente porém VAZIO não vira memória viva", async () => {
    await setAutoMemory(false);
    await fs.ensureDir(path.join(root, ".claude", "agent-memory", "algum-agente"));

    const s = get((await scanMemorySurfaces(root, opts())).surfaces, "agent-memory-project");
    expect(s.exists).toBe(true);
    expect(s.items).toBe(0);
    expect(isWriteOnly(s)).toBe(false);
  });
});

describe("scanMemorySurfaces · contrafactual positivo", () => {
  it("acha as memórias que existem e conta os arquivos, recursivo", async () => {
    await setAutoMemory(false);
    await fs.outputFile(path.join(root, ".claude", "agent-memory", "a", "MEMORY.md"), "# a");
    await fs.outputFile(path.join(root, ".claude", "agent-memory", "a", "topico.md"), "detalhe");
    await fs.outputFile(path.join(root, ".claude", "agent-memory", "b", "MEMORY.md"), "# b");
    await fs.outputFile(path.join(root, ".nexos", "memory", "project", "gotchas.md"), "# g");
    await fs.outputFile(
      path.join(nexosHome, "instincts", "projects", "pid-1", "instincts", "i.json"),
      "{}"
    );

    const scan = await scanMemorySurfaces(root, { ...opts(), projectId: "pid-1" });
    expect(get(scan.surfaces, "agent-memory-project").items).toBe(3);
    expect(get(scan.surfaces, "project-markdown").items).toBe(1);
    expect(get(scan.surfaces, "instincts").items).toBe(1);
    // Escopo errado não é achado por acaso: o instincts de OUTRO projeto não
    // entra na conta deste.
    expect(
      get((await scanMemorySurfaces(root, { ...opts(), projectId: "pid-2" })).surfaces, "instincts").items
    ).toBe(0);
  });

  it("write-only é medido, não assumido: agent-memory tem conteúdo e nenhum leitor", async () => {
    await setAutoMemory(true);
    await writeAgent(path.join(root, ".claude", "agents"), "dev", "project");
    await fs.outputFile(path.join(root, ".claude", "agent-memory", "dev", "MEMORY.md"), "# dev");

    const s = get((await scanMemorySurfaces(root, opts())).surfaces, "agent-memory-project");
    expect(s.readBy).toBeNull();
    expect(s.writable).toBe(true); // auto memory ON + declaração ⇒ alguém escreve
    expect(isWriteOnly(s)).toBe(true);
    expect(isFrozen(s)).toBe(false);
  });
});

describe("scanMemorySurfaces · o campo `memory` do subagente segue o auto memory", () => {
  it("conta declarações por escopo, só no frontmatter", async () => {
    await setAutoMemory(true);
    const dir = path.join(root, ".claude", "agents");
    await writeAgent(dir, "a", "project");
    await writeAgent(dir, "b", "user");
    await writeAgent(dir, "c", "local");
    await writeAgent(dir, "d", null);
    // `memory:` no CORPO é prosa, não configuração — o host não a lê.
    await fs.outputFile(path.join(dir, "e.md"), "---\nname: e\n---\n\nmemory: project\n");
    // `.bak` não é subagente: o host carrega `*.md`.
    await fs.outputFile(path.join(dir, "f.md.bak"), "---\nname: f\nmemory: project\n---\n");

    const scan = await scanMemorySurfaces(root, opts());
    expect(scan.subagentMemoryDeclarations).toEqual({ user: 1, project: 1, local: 1 });
  });

  it("auto memory OFF congela o acervo: conteúdo existe, nada mais escreve", async () => {
    await setAutoMemory(false);
    await writeAgent(path.join(root, ".claude", "agents"), "dev", "project");
    await fs.outputFile(path.join(root, ".claude", "agent-memory", "dev", "MEMORY.md"), "# dev");

    const scan = await scanMemorySurfaces(root, opts());
    expect(scan.autoMemoryEnabled).toBe(false);
    expect(scan.subagentMemoryDeclarations.project).toBe(1);
    const s = get(scan.surfaces, "agent-memory-project");
    // sub-agents.md: com auto memory desligado o campo `memory` "has no effect".
    expect(s.writable).toBe(false);
    expect(isFrozen(s)).toBe(true);
  });

  it("declaração sem auto memory não inventa escrita em diretório inexistente", async () => {
    await setAutoMemory(false);
    await writeAgent(path.join(root, ".claude", "agents"), "dev", "local");

    const s = get((await scanMemorySurfaces(root, opts())).surfaces, "agent-memory-local");
    expect(s.exists).toBe(false);
    expect(s.writable).toBe(false);
    expect(isFrozen(s)).toBe(false);
  });
});

describe("scanMemorySurfaces · auto memory nativa do host", () => {
  it("acha a auto memory no path padrão derivado da raiz do projeto", async () => {
    await setAutoMemory(true);
    const memDir = path.join(claudeDir, "projects", claudeProjectSlug(root), "memory");
    await fs.outputFile(path.join(memDir, "MEMORY.md"), "# index");

    const s = get((await scanMemorySurfaces(root, opts())).surfaces, "host-auto-memory");
    expect(s.path).toBe(memDir);
    expect(s.items).toBe(1);
    expect(s.readBy).not.toBeNull(); // o HOST lê MEMORY.md em toda sessão
    expect(isWriteOnly(s)).toBe(false);
  });

  it("autoMemoryDirectory redireciona o path — sem isso o detector daria falso negativo", async () => {
    const custom = path.join(ws, "memoria-custom");
    await fs.outputJson(path.join(root, ".claude", "settings.json"), {
      autoMemoryEnabled: true,
      autoMemoryDirectory: custom,
    });
    await fs.outputFile(path.join(custom, "MEMORY.md"), "# index");

    const s = get((await scanMemorySurfaces(root, opts())).surfaces, "host-auto-memory");
    expect(s.path).toBe(custom);
    expect(s.items).toBe(1);
  });

  it("quarentena: diretório com MEMORY.md renomeado para fora do path do host é ACHADO", async () => {
    await setAutoMemory(false);
    const projDir = path.join(claudeDir, "projects", claudeProjectSlug(root));
    await fs.outputFile(path.join(projDir, "LEGACY_FOREIGN_AUTO_MEMORY", "MEMORY.md"), "# alheio");
    // Ruído que NÃO pode virar falso positivo: pasta de sessão sem MEMORY.md.
    await fs.outputFile(path.join(projDir, "abc-123", "algo.json"), "{}");

    const scan = await scanMemorySurfaces(root, opts());
    expect(scan.quarantined).toEqual([path.join(projDir, "LEGACY_FOREIGN_AUTO_MEMORY")]);
    // A superfície oficial continua ausente — quarentena não é auto memory ativa.
    expect(get(scan.surfaces, "host-auto-memory").exists).toBe(false);
  });

  it("não confunde a auto memory ATIVA com quarentena", async () => {
    await setAutoMemory(true);
    const projDir = path.join(claudeDir, "projects", claudeProjectSlug(root));
    await fs.outputFile(path.join(projDir, "memory", "MEMORY.md"), "# ativa");

    expect((await scanMemorySurfaces(root, opts())).quarantined).toEqual([]);
  });
});

/**
 * CONTAMINAÇÃO CROSS-PROJECT — o vetor que já causou dano neste host.
 *
 *   QUARANTINED != CLEAN
 *
 * A quarentena `LEGACY_FOREIGN_AUTO_MEMORY` só foi achável porque um humano
 * renomeou o diretório. Estes casos exercitam o detector sobre o CONTEÚDO, que
 * é o que sobra quando ninguém renomeou nada. O `homeDir` é injetado pelo mesmo
 * motivo que `claudeDir`: sem isso o negativo dependeria do home de quem roda.
 */
describe("scanMemorySurfaces · conteúdo de outro projeto", () => {
  let home: string;
  let projRoot: string;

  beforeEach(async () => {
    // Layout fiel ao real: raiz do projeto DENTRO do home, como `~/NEXOS/nexos-cli`.
    home = path.join(ws, "home");
    projRoot = path.join(home, "NEXOS", "proj-a");
    await fs.ensureDir(projRoot);
    await fs.outputJson(path.join(projRoot, ".claude", "settings.json"), {
      autoMemoryEnabled: false,
    });
  });

  const foreignOpts = () => ({ claudeDir, nexosHome, homeDir: home });
  const memoryDir = () => path.join(claudeDir, "projects", claudeProjectSlug(projRoot), "memory");

  it("POSITIVO: acha a citação de path alheio na memória ATIVA — sem depender de quarentena", async () => {
    // Forma literal do caso real (`acme_project.md` deste host).
    await fs.outputFile(
      path.join(memoryDir(), "outro_projeto.md"),
      "---\ntype: project\n---\n- **Path local**: `~/Desktop/ACME/app-frontend`\n"
    );

    const scan = await scanMemorySurfaces(projRoot, foreignOpts());
    expect(scan.quarantined).toEqual([]); // ninguém renomeou nada — e mesmo assim:
    expect(scan.crossProjectReferences).toEqual([
      {
        file: path.join(memoryDir(), "outro_projeto.md"),
        citedPath: path.join(home, "Desktop", "ACME", "app-frontend"),
        // `otherRoot` null: o host NUNCA abriu sessão nesse path, logo não há
        // slug. É o critério FRACO sustentando sozinho a contaminação
        // histórica — a prova de que os dois critérios são união, não troca.
        otherRoot: null,
      },
    ]);
  });

  it("POSITIVO: acha também dentro do diretório posto em quarentena à mão", async () => {
    const q = path.join(claudeDir, "projects", claudeProjectSlug(projRoot), "LEGACY_FOREIGN_AUTO_MEMORY");
    await fs.outputFile(path.join(q, "MEMORY.md"), "# índice alheio\n");
    await fs.outputFile(path.join(q, "outro.md"), `path: ${path.join(home, "Desktop", "ACME")}\n`);

    const scan = await scanMemorySurfaces(projRoot, foreignOpts());
    expect(scan.quarantined).toEqual([q]);
    expect(scan.crossProjectReferences.map((c) => c.citedPath)).toEqual([
      path.join(home, "Desktop", "ACME"),
    ]);
  });

  it("NEGATIVO: memória que só cita o PRÓPRIO projeto e paths de ferramenta sai limpa", async () => {
    // Sem este caso, um detector que sempre acusa passaria por correto. Todos os
    // padrões abaixo aparecem em memória legítima de projeto NexOS — os dotfiles
    // eram 5 das 24 citações medidas nos projetos reais deste host.
    await fs.outputFile(
      path.join(memoryDir(), "proprio.md"),
      [
        `raiz: ${projRoot}`,
        `arquivo: ${path.join(projRoot, "src", "lib", "host", "memory-surfaces.ts")}`,
        `settings do host: ${path.join(claudeDir, "settings.json")}`,
        `store: ${path.join(nexosHome, "store.db")}`,
        "shell: ~/.zshrc",
        `railway: ${path.join(home, ".railway", "config.json")}`,
      ].join("\n")
    );

    expect((await scanMemorySurfaces(projRoot, foreignOpts())).crossProjectReferences).toEqual([]);
  });

  it("NEGATIVO: projeto sem memória nenhuma não inventa citação", async () => {
    expect((await scanMemorySurfaces(projRoot, foreignOpts())).crossProjectReferences).toEqual([]);
  });

  it("com autoMemoryEnabled TRUE o detector continua achando — a chave não é o isolamento", async () => {
    // DISABLED != ISOLATED. Este host está com `false`, então o caso ligado só
    // existe por fixture; sem ele, a suíte não cobriria a configuração padrão
    // do host (memory.md: "Auto memory is on by default").
    await fs.outputJson(path.join(projRoot, ".claude", "settings.json"), {
      autoMemoryEnabled: true,
    });
    await fs.outputFile(
      path.join(memoryDir(), "outro_projeto.md"),
      `- Path local: ${path.join(home, "Desktop", "ACME", "app-frontend")}\n`
    );

    const scan = await scanMemorySurfaces(projRoot, foreignOpts());
    expect(scan.autoMemoryEnabled).toBe(true);
    expect(scan.crossProjectReferences).toHaveLength(1);
  });

  it("não olha arquivo que não é .md e não repete a mesma citação duas vezes", async () => {
    const alheio = path.join(home, "Desktop", "ACME");
    await fs.outputFile(path.join(memoryDir(), "ruido.json"), JSON.stringify({ p: alheio }));
    await fs.outputFile(path.join(memoryDir(), "dup.md"), `${alheio}\n${alheio}\n${alheio}\n`);

    const scan = await scanMemorySurfaces(projRoot, foreignOpts());
    expect(scan.crossProjectReferences).toHaveLength(1);
  });
});

/**
 * RAIZ QUE NÃO EXCLUI NADA — o ponto cego que o critério "fora da raiz" tem por
 * construção, e que este host exercitou de verdade: `$HOME` é cwd de sessão,
 * `~/.claude/projects/-Users-dono/memory/` tem 15 arquivos e 6 falam de
 * `nexos-cli`, e `scanMemorySurfaces(HOME)` media 0.
 *
 *   OUTSIDE MY ROOT != ANOTHER PROJECT
 *   SLUG DIR EXISTS ⟹ O HOST JÁ ABRIU SESSÃO NAQUELE CWD
 *
 * O sinal que sobra é o diretório de projeto do host: `<claudeDir>/projects/
 * <slug(path)>` existir prova que aquele path é raiz de sessão, não pasta
 * qualquer. Roundtrip medido em 87/87 slugs deste host.
 */
describe("scanMemorySurfaces · raiz que é o próprio home", () => {
  let home: string;
  let otherRoot: string;

  /** Cria o diretório de projeto do host para `p` — é o que dá "existência" à raiz. */
  const declareHostProject = (p: string) =>
    fs.ensureDir(path.join(claudeDir, "projects", claudeProjectSlug(p)));
  const memoryOf = (p: string) =>
    path.join(claudeDir, "projects", claudeProjectSlug(p), "memory");

  beforeEach(async () => {
    home = path.join(ws, "home");
    otherRoot = path.join(home, "NEXOS", "nexos-cli");
    await fs.ensureDir(otherRoot);
    await fs.outputJson(path.join(home, ".claude", "settings.json"), { autoMemoryEnabled: false });
    await declareHostProject(home);
    await declareHostProject(otherRoot);
  });

  const homeOpts = () => ({ claudeDir, nexosHome, homeDir: home });

  it("POSITIVO: com a raiz no home, acha a memória que fala de OUTRO projeto do host", async () => {
    await fs.outputFile(
      path.join(memoryOf(home), "nexos-completion-gate.md"),
      `o gate mora em ${path.join(otherRoot, "src", "lib", "capsule", "store.ts")}\n`
    );

    const scan = await scanMemorySurfaces(home, homeOpts());
    expect(scan.crossProjectReferences).toEqual([
      {
        file: path.join(memoryOf(home), "nexos-completion-gate.md"),
        citedPath: path.join(otherRoot, "src", "lib", "capsule", "store.ts"),
        otherRoot, // o ancestral mais profundo com slug — não o home
      },
    ]);
  });

  it("NEGATIVO: citar pasta comum sob o próprio home NÃO vira contaminação", async () => {
    // `~/Documents/notas` não é cwd de sessão nenhuma → sem slug → sem sinal.
    // Sem esta guarda, "raiz = home" acenderia em todo path do usuário.
    await fs.outputFile(
      path.join(memoryOf(home), "notas.md"),
      `rascunho em ${path.join(home, "Documents", "notas")}\n`
    );

    expect((await scanMemorySurfaces(home, homeOpts())).crossProjectReferences).toEqual([]);
  });

  it("NEGATIVO: worktree irmão sem sessão no host não conta como outro projeto", async () => {
    // O caso que derrubou 8 hits para 1 em `~/PROJETO-A`: `PROJETO-A-AI`,
    // `-DEEPSEEK`, `-PILOT` existem em disco e NÃO são cwd de sessão.
    const proj = path.join(home, "PROJETO-A");
    await fs.ensureDir(proj);
    await fs.outputJson(path.join(proj, ".claude", "settings.json"), { autoMemoryEnabled: false });
    await declareHostProject(proj);
    await fs.outputFile(
      path.join(memoryOf(proj), "frentes-worktree.md"),
      `frente 2 em ${path.join(home, "PROJETO-A-AI")}\n`
    );

    // Na MESMA memória, uma citação de projeto que É cwd de sessão. Sem os dois
    // no mesmo fixture o teste não distingue "o detector separa" de "o detector
    // devolve null pra tudo".
    await fs.appendFile(
      path.join(memoryOf(proj), "frentes-worktree.md"),
      `e o CLI vive em ${path.join(otherRoot, "src")}\n`
    );

    const scan = await scanMemorySurfaces(proj, { claudeDir, nexosHome, homeDir: home });
    // O critério FRACO reporta os dois (ambos fora da raiz); só o segundo ganha
    // `otherRoot`, e é isso que tira a citação legítima da amostra do doctor.
    expect(scan.crossProjectReferences.map((c) => [path.basename(c.citedPath), c.otherRoot])).toEqual([
      ["PROJETO-A-AI", null],
      ["src", otherRoot],
    ]);
  });
});

/**
 * O VETOR INVERSO — memória de OUTRO projeto citando ESTE.
 *
 *   SESSION CWD != SUBJECT OF THE CONVERSATION
 *
 * Varrer a memória DESTE projeto nunca acharia isto: os arquivos moram no
 * diretório de projeto do outro cwd. Medido neste host: 78 diretórios `memory/`,
 * 205 `.md`, 472 KB, 49 ms — e 4 arquivos de `$HOME` citando `nexos-cli`.
 * Fora do caminho quente (doctor), nunca em hook de sessão.
 */
describe("scanMemorySurfaces · memória alheia citando este projeto", () => {
  let home: string;
  let projRoot: string;
  let foreignRoot: string;

  const declareHostProject = (p: string) =>
    fs.ensureDir(path.join(claudeDir, "projects", claudeProjectSlug(p)));
  const memoryOf = (p: string) =>
    path.join(claudeDir, "projects", claudeProjectSlug(p), "memory");

  beforeEach(async () => {
    home = path.join(ws, "home");
    projRoot = path.join(home, "NEXOS", "nexos-cli");
    foreignRoot = home; // o caso real: a sessão foi aberta NO home
    await fs.ensureDir(projRoot);
    await fs.outputJson(path.join(projRoot, ".claude", "settings.json"), {
      autoMemoryEnabled: false,
    });
    await declareHostProject(projRoot);
    await declareHostProject(foreignRoot);
  });

  const projOpts = () => ({ claudeDir, nexosHome, homeDir: home });

  it("POSITIVO: acha o arquivo de memória de outro cwd que cita a raiz deste projeto", async () => {
    await fs.outputFile(
      path.join(memoryOf(foreignRoot), "nexos-completion-gate.md"),
      `gate implementado em ${path.join(projRoot, "src")}\n`
    );

    const scan = await scanMemorySurfaces(projRoot, projOpts());
    expect(scan.crossProjectReferences).toEqual([]); // varrer a si mesmo não vê nada
    expect(scan.foreignMemoryCiting).toEqual([
      {
        projectDir: path.join(claudeDir, "projects", claudeProjectSlug(foreignRoot)),
        file: path.join(memoryOf(foreignRoot), "nexos-completion-gate.md"),
        citedPath: path.join(projRoot, "src"),
      },
    ]);
  });

  it("NEGATIVO: projeto limpo não vira alarme", async () => {
    await fs.outputFile(
      path.join(memoryOf(foreignRoot), "outra-coisa.md"),
      `nada a ver: ${path.join(home, "Documents")}\n`
    );

    expect((await scanMemorySurfaces(projRoot, projOpts())).foreignMemoryCiting).toEqual([]);
  });

  it("NEGATIVO: a memória do PRÓPRIO projeto nunca conta como alheia", async () => {
    await fs.outputFile(
      path.join(memoryOf(projRoot), "propria.md"),
      `raiz: ${path.join(projRoot, "src")}\n`
    );

    expect((await scanMemorySurfaces(projRoot, projOpts())).foreignMemoryCiting).toEqual([]);
  });

  it("NEGATIVO: citação de projeto ANINHADO não é debitada do projeto pai", async () => {
    // `~/Solar` e `~/Solar/Saas-Solar-Agente` são ambos cwd de sessão neste
    // host. Sem a regra "raiz conhecida MAIS PROFUNDA", toda citação do filho
    // acenderia no pai — e um projeto que contém outros (o próprio `$HOME`)
    // colheria o host inteiro (medido: 16 hits com `isUnder` puro, 8 com raiz
    // profunda).
    const nested = path.join(projRoot, "packages", "sub");
    await fs.ensureDir(nested);
    await declareHostProject(nested);
    await fs.outputFile(
      path.join(memoryOf(foreignRoot), "fala-do-filho.md"),
      `mexi em ${path.join(nested, "index.ts")}\n`
    );

    expect((await scanMemorySurfaces(projRoot, projOpts())).foreignMemoryCiting).toEqual([]);
  });
});
