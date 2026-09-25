/**
 * Critérios 2–5, 7, 9, 10 — prova de PRODUTO, não de repo.
 *
 *   SOURCE GREEN != PRODUCT WORKS
 *   INSTALLED FILE != ACTIVE CAPABILITY
 *
 * Tudo roda com HOME e CLAUDE_CONFIG_DIR temporários. O `~/.claude` e o
 * `~/.nexos` reais NUNCA são tocados, e o Store real do repo não é usado como
 * scratch — `REAL CANONICAL STORE != SCRATCH SPACE`.
 *
 * O binário exercitado é o do PACOTE instalado, nunca `src/` nem `dist/` do
 * worktree: uma dependência oculta do repo passaria despercebida se o teste
 * importasse o source.
 *
 * Uso:  npx tsx scripts/fresh-install-proof.mts
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync, execSync } from "node:child_process";
import YAML from "yaml";

const REPO = process.cwd();
const TMP = fs.realpathSync(os.tmpdir());

let falhas = 0;
const check = (nome: string, ok: boolean, detalhe = ""): void => {
  if (!ok) falhas++;
  console.log(`  ${ok ? "PASS" : "FAIL"}  ${nome}${detalhe ? ` — ${detalhe}` : ""}`);
};
const secao = (s: string): void => console.log(`\n── ${s} ──`);

/** Ambiente isolado: HOME próprio, sem herdar nada da máquina. */
function envIsolado(home: string): NodeJS.ProcessEnv {
  return {
    ...process.env,
    HOME: home,
    USERPROFILE: home,
    CLAUDE_CONFIG_DIR: path.join(home, ".claude"),
    npm_config_prefix: path.join(home, ".npm-global"),
    npm_config_userconfig: path.join(home, ".npmrc"),
    NPM_CONFIG_PREFIX: path.join(home, ".npm-global"),
    /**
     * PATH com o bin do SANDBOX na frente. Sem isto, `command -v nexos` dentro
     * do hook resolvia para o binário REAL da máquina — o proof media a versão
     * instalada do desenvolvedor, não o tarball recém-empacotado.
     *   ISOLATED HOME != ISOLATED PATH
     */
    PATH: `${path.join(home, ".npm-global", "bin")}:${process.env.PATH ?? ""}`,
  };
}

const sandbox = await fs.mkdtemp(path.join(TMP, "nexos-fresh-"));
const HOME = path.join(sandbox, "home");
const env = envIsolado(HOME);
const NEXOS = path.join(HOME, ".npm-global", "bin", "nexos");
await fs.ensureDir(HOME);

const run = (cmd: string, args: string[], cwd: string, envDaVez: NodeJS.ProcessEnv = env): { out: string; code: number } => {
  try {
    const out = execFileSync(cmd, args, { cwd, env: envDaVez, encoding: "utf-8", stdio: "pipe" });
    return { out, code: 0 };
  } catch (e) {
    const err = e as { stdout?: string; stderr?: string; status?: number };
    return { out: `${err.stdout ?? ""}${err.stderr ?? ""}`, code: err.status ?? 1 };
  }
};

try {
  // ─────────────────────────────── CRITÉRIO 2 ───────────────────────────────
  secao("CRITÉRIO 2 · FRESH INSTALL");

  /**
   * `--cache` em scratch: o `~/.npm/_cacache` desta máquina tem entradas
   * root-owned e o `npm pack` morre com EPERM
   * (nexos://gotcha/npm-pack-falha-com-eperm-porque-npm-cacache-tem-entradas-root-owned...).
   * Falha de AMBIENTE, não de build — e uma prova que não roda no host onde a
   * promoção acontece não prova nada.
   */
  const npmCache = path.join(TMP, "npm-cache");
  fs.ensureDirSync(npmCache);
  /**
   * BUILD ANTES DO PACK — `npm pack` NÃO compila.
   *
   *   PACKAGED != CURRENT, uma camada abaixo
   *
   * `prepublishOnly` não roda em `pack`, então o tarball leva o `dist/` que
   * estiver largado no worktree. Medido por uma verificação independente: com
   * uma mutação só em `src/` e SEM rebuild, este proof inteiro devolveu "TODOS
   * OS CHECKS PASSARAM" — carimbando verde num binário que não continha a
   * mudança. Os critérios 3, 4, 4B e 5 exercitam `dist/`, não `src/`: sem esta
   * linha, eles medem o passado.
   */
  execSync("npm run build", { cwd: REPO, stdio: "pipe" });

  /**
   * O nome do tarball vem do STDOUT do `npm pack`, não de varrer o diretório.
   * A versão anterior fazia `readdir().sort().pop()` — ordenação lexicográfica,
   * em que `6.9.0` vence `6.10.0`, e qualquer `.tgz` esquecido no root entrava
   * no páreo (havia um `nexos-cli-6.3.2.tgz` ali). Num script cuja tese é que
   * pacote velho carimba verde, escolher o pacote por string é o mesmo bug.
   */
  const packOut = execSync(`npm pack --silent --cache "${npmCache}"`, {
    cwd: REPO,
    encoding: "utf-8",
  });
  const tgz = packOut.trim().split("\n").filter(Boolean).at(-1) ?? "";
  const tgzPath = path.join(REPO, tgz);
  check("npm pack nomeia o tarball no stdout", tgz.endsWith(".tgz"), tgz);
  check("npm pack gera tarball", await fs.pathExists(tgzPath), tgz);

  const listagem = execSync(`tar -tzf "${tgzPath}"`, { encoding: "utf-8" }).split("\n");
  check("LICENSE no tarball", listagem.includes("package/LICENSE"));
  check(
    "assets no tarball",
    listagem.some((l) => l.startsWith("package/assets/agents/")) &&
      listagem.some((l) => l.startsWith("package/assets/skills/"))
  );
  check(
    "dist no tarball",
    listagem.some((l) => l === "package/dist/index.js")
  );
  check(
    "nenhum .tgz aninhado",
    !listagem.some((l) => l.endsWith(".tgz"))
  );

  /**
   * O papel que o pacote CARREGA, não só o path que ele lista. O check acima
   * prova que existe algo sob `package/assets/agents/`; não prova o conteúdo.
   * Foi por essa fresta que o 6.4.1 saiu com proof verde carregando a versão do
   * papel que proibia o principal de executar qualquer código:
   *
   *   PACKAGED != CURRENT
   *
   * Lido do tarball ANTES do `fs.remove(tgzPath)` logo abaixo — depois dele o
   * arquivo não existe mais.
   */
  const papelNoTarball = execSync(`tar -xzOf "${tgzPath}" package/assets/agents/nexos-master.md`, {
    encoding: "utf-8",
  });
  check(
    "papel do master no tarball traz a régua T0/T1",
    /MAIN != BUILDER/.test(papelNoTarball),
    /MAIN != BUILDER/.test(papelNoTarball) ? "" : "o tarball carrega o papel ANTIGO"
  );
  check(
    "papel do master no tarball sustenta BUILDER != VERIFIER",
    /BUILDER\s*!=\s*VERIFIER|BUILDER CANNOT SELF-VERIFY/.test(papelNoTarball)
  );

  const inst = run("npm", ["install", "-g", "--cache", npmCache, tgzPath], sandbox);
  check("npm install -g no HOME isolado", inst.code === 0, inst.code === 0 ? "" : inst.out.slice(-300));
  await fs.remove(tgzPath);

  check("binário nexos existe no HOME isolado", await fs.pathExists(NEXOS));
  const ver = run(NEXOS, ["--version"], sandbox);
  check("nexos --version responde", ver.code === 0, ver.out.trim());

  /**
   * A prova de que não há dependência oculta do worktree: o comando roda a
   * partir de um cwd que não é o repo, com HOME isolado, e o binário resolvido
   * é o do pacote instalado.
   */
  const real = await fs.realpath(NEXOS);
  check("binário resolve para o pacote instalado, não para o worktree", !real.startsWith(REPO), real);

  /**
   * Fecha `tarball → global → projeção`. `nexos install` lê `ASSETS_DIR`, que
   * resolve para os assets DO PACOTE INSTALADO (`__dirname/../../assets`),
   * nunca para o worktree. Medido no host real em 2026-09-17: com o pacote
   * global uma versão atrás, `install` reprojetava o papel VELHO por cima — e
   * o sucesso do comando era lido como prova de que a correção tinha chegado
   * ao agente. Não tinha.
   */
  const inst2 = run(NEXOS, ["install"], sandbox);
  check("nexos install roda pelo produto", inst2.code === 0, inst2.code === 0 ? "" : inst2.out.slice(-300));

  const papelProjetado = path.join(HOME, ".claude", "agents", "nexos-master.md");
  check("papel do master é projetado em ~/.claude/agents", await fs.pathExists(papelProjetado));
  const papelAtivo = await fs.readFile(papelProjetado, "utf-8");
  check(
    "papel PROJETADO traz a mesma régua do tarball",
    /MAIN != BUILDER/.test(papelAtivo),
    /MAIN != BUILDER/.test(papelAtivo) ? "" : "a projeção ficou com o papel antigo"
  );

  // ─────────────────────────────── CRITÉRIO 3 ───────────────────────────────
  secao("CRITÉRIO 3 · FRESH PROJECT");

  const proj = path.join(sandbox, "meu-projeto");
  await fs.ensureDir(proj);
  execFileSync("git", ["init", "-q", "."], { cwd: proj, env });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: proj, env });
  execFileSync("git", ["config", "user.name", "t"], { cwd: proj, env });
  await fs.writeFile(path.join(proj, ".gitignore"), "node_modules/\n");
  await fs.writeFile(path.join(proj, "package.json"), '{"name":"meu-projeto","version":"1.0.0"}');

  const init = run(NEXOS, ["init"], proj);
  check("nexos init roda pelo produto", init.code === 0, init.code === 0 ? "" : init.out.slice(-300));

  const manifestPath = path.join(proj, ".nexos", "manifest.yaml");
  check("manifest canônico nasce", await fs.pathExists(manifestPath));

  const pid = (YAML.parse(await fs.readFile(manifestPath, "utf-8")) as { project: { id: string } })
    .project.id;
  check("project id é canônico", /^prj_[0-9A-HJKMNP-TV-Z]{26}$/.test(pid), pid);

  run(NEXOS, ["init"], proj);
  const pid2 = (YAML.parse(await fs.readFile(manifestPath, "utf-8")) as { project: { id: string } })
    .project.id;
  check("id estável na segunda invocação", pid === pid2);

  const gi = await fs.readFile(path.join(proj, ".gitignore"), "utf-8");
  const linhas = gi.split("\n").map((l) => l.trim());
  check("gitignore NÃO engole a Capsule", !linhas.includes(".nexos/") && linhas.includes(".nexos/.local/"));

  /** SessionStart pelo produto, com CLAUDE_PROJECT_DIR como o host o passa. */
  const briefEnv = { ...env, CLAUDE_PROJECT_DIR: proj };
  const briefOut = execFileSync(NEXOS, ["claude-session-start"], {
    cwd: proj,
    env: briefEnv,
    input: JSON.stringify({
      session_id: "s1",
      cwd: proj,
      hook_event_name: "SessionStart",
      source: "startup",
    }),
    encoding: "utf-8",
  });
  const hookOut = JSON.parse(briefOut) as {
    hookSpecificOutput: { additionalContext: string };
  };
  /**
   * O envelope do hook é JSON; o BRIEF dentro dele é TEXTO — é o que o modelo
   * lê. Esta prova exigia JSON aqui e quebrava com `SyntaxError` desde que o
   * brief virou texto: prova que codifica contrato velho reprova produto certo
   * (`DECLARED != OBSERVED` aplicado ao próprio gate).
   */
  const brief1 = hookOut.hookSpecificOutput.additionalContext;
  check("SessionStart emite brief", brief1.trim().length > 0, `${brief1.split("\n")[0] ?? ""}`);
  check("brief é o do NexOS", brief1.startsWith("NexOS"), brief1.slice(0, 40));
  check("brief traz o MESMO project id (identidade vem do manifest)", brief1.includes(pid), pid);

  // ─────────────────────────────── CRITÉRIO 4 ───────────────────────────────
  secao("CRITÉRIO 4 · FRESH SESSION CONTINUITY");

  /**
   * Sessão A escreve conhecimento canônico usando o PRODUTO instalado.
   * O script importa o pacote instalado — não o source do repo.
   */
  const pkgRoot = path.join(HOME, ".npm-global", "lib", "node_modules", "nexos-cli");
  const sessaoA = path.join(sandbox, "sessao-a.mjs");
  await fs.writeFile(
    sessaoA,
    `
import { publishCanonical } from "${pkgRoot}/dist/lib/capsule/store.js";
import { newRecordId } from "${pkgRoot}/dist/lib/capsule/ids.js";
import { runEvidencedCommand, verifyFromEvidence } from "${pkgRoot}/dist/lib/evidence.js";

const root = ${JSON.stringify(proj)};
const pid = ${JSON.stringify(pid)};
const NOW = new Date().toISOString();

const ev = await runEvidencedCommand(root, "test", "node", ["-e", "process.exit(0)"]);
const v = await verifyFromEvidence({ projectRoot: root, requiredGates: ["test"] });
if (!v.pass) { console.error("verify falhou"); process.exit(1); }

const mk = (kind, sr, content) => ({
  schema_version: 1, id: newRecordId("KnowledgeRecord"), project_id: pid,
  family: "KnowledgeRecord", kind, scope: "project", origin: "agent",
  provenance: { source_ref: sr, producer_id: "sessaoA", submitted_at: NOW },
  lifecycle: "immutable", portability: "portable", regenerable: false,
  admission: { status: "admitted", approved_by: "human:steve", approved_at: NOW },
  sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
  evidence_refs: [sr], created_at: NOW, version: 1, content,
});

await publishCanonical(root, mk("project_state", "sessao-a#estado", {
  title: "Importador de CSV",
  current_state: "leitura de arquivo pronta, sem tratamento de encoding",
  next_action: "tratar BOM utf-8 antes do parse",
  last_verified: ev.id,
}));
await publishCanonical(root, mk("gotcha", "sessao-a#bom", {
  title: "BOM utf-8 quebra o parse",
  failure_mode: "a primeira coluna vem com caractere invisivel",
  rule: "remover BOM antes de parsear csv",
}));
await publishCanonical(root, mk("gotcha", "sessao-a#ruido", {
  title: "cor do botao",
  failure_mode: "contraste baixo no tema escuro",
}));
console.log("EVIDENCE_ID=" + ev.id);
`
  );
  const rA = run("node", [sessaoA], proj);
  check("sessão A publica com evidência verificada", rA.code === 0, rA.code === 0 ? "" : rA.out.slice(-300));
  check("evidence gravada em .local", await fs.pathExists(path.join(proj, ".nexos", ".local", "evidence")));

  const sessaoB = path.join(sandbox, "sessao-b.mjs");
  await fs.writeFile(
    sessaoB,
    `
import { buildSessionBriefForCwd } from "${pkgRoot}/dist/lib/bootstrap-context.js";
const r = await buildSessionBriefForCwd({ cwd: process.argv[2], intent: "tratar encoding do importador csv" });
console.log(JSON.stringify({ bytes: r.byteLength, brief: r.brief }));
`
  );
  const rB = run("node", [sessaoB, proj], sandbox);
  check("sessão B monta brief", rB.code === 0, rB.code === 0 ? "" : rB.out.slice(-300));

  const b = JSON.parse(rB.out) as {
    bytes: number;
    brief: {
      project: { id: string; identity_source: string };
      knowledge?: { items: { source_ref: string; why: string; fields: Record<string, string> }[] };
    };
  };
  const refs = b.brief.knowledge?.items.map((i) => i.source_ref) ?? [];
  check("brief carrega conhecimento", refs.length > 0, refs.join(", "));
  check("estado vem primeiro", refs[0] === "sessao-a#estado");
  check(
    "next_action recuperado",
    b.brief.knowledge?.items[0]?.fields.next_action === "tratar BOM utf-8 antes do parse"
  );
  check("gotcha relevante entra", refs.includes("sessao-a#bom"));
  check("ruído fica de fora", !refs.includes("sessao-a#ruido"));
  check(
    "todo item informa why",
    (b.brief.knowledge?.items ?? []).every((i) => i.why.length > 0)
  );
  check("contexto é bounded", b.bytes <= 12 * 1024, `${b.bytes} bytes`);

  /** Autoridade: o brief não lê os markdowns legados. */
  await fs.outputFile(path.join(proj, ".nexos", "memory", "project", "state.md"), "MENTIRA LEGADA");
  const rB2 = run("node", [sessaoB, proj], sandbox);
  check(
    "brief NÃO usa state.md como autoridade",
    rB2.code === 0 && !rB2.out.includes("MENTIRA LEGADA")
  );
  await fs.remove(path.join(proj, ".nexos", "memory"));

  // ─────────────────────────────── CRITÉRIO 4B ──────────────────────────────
  secao("CRITÉRIO 4B · CLASSIFICAÇÃO REAL DO DOCTOR");

  /**
   * Até aqui o proof respondia "instala e inicializa?". Nunca perguntou ao
   * Doctor como ele CLASSIFICA — e o 6.4.1 passou por aqui com todos os checks
   * verdes chamando projeto saudável de DEGRADED:
   *
   *   INSTALLS != CLASSIFIES CORRECTLY
   *
   * Teste unitário mede a função; isto mede o CLI instalado, pelo tarball.
   * `TESTED != WIRED`.
   */
  type Relatorio = { state: string; reasons: string[]; evidence: { area: string; detail: string }[] };
  const doctorJson = (cwd: string): Relatorio => JSON.parse(run(NEXOS, ["doctor", "--project", "--json"], cwd).out) as Relatorio;
  const evidenciaDe = (r: Relatorio, area: string): string => r.evidence.find((e) => e.area === area)?.detail ?? "";

  /** Projeto próprio: `proj` carrega estado dos critérios anteriores. */
  const projDoctor = path.join(sandbox, "projeto-doctor");
  await fs.ensureDir(projDoctor);
  execFileSync("git", ["init", "-q", "."], { cwd: projDoctor, env });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: projDoctor, env });
  execFileSync("git", ["config", "user.name", "t"], { cwd: projDoctor, env });
  await fs.writeFile(path.join(projDoctor, "README.md"), "# projeto-doctor\n");
  execFileSync("git", ["add", "-A"], { cwd: projDoctor, env });
  execFileSync("git", ["commit", "-q", "-m", "init"], { cwd: projDoctor, env });
  run(NEXOS, ["init"], projDoctor);

  /**
   * Legado do PROJETO é evidência, nunca veredito. `.nexos/memory/project` é o
   * que todo projeto migrado preserva, e o próprio `lifecycle` o declara
   * "legado preservado, referência, não degrada". Antes do fix, o mesmo
   * relatório o isentava numa linha e o condenava em outra — e um repair que
   * preserva memory/ entregaria os legados já marcados DEGRADED.
   */
  await fs.ensureDir(path.join(projDoctor, ".nexos", "memory", "project"));
  await fs.writeFile(path.join(projDoctor, ".nexos", "memory", "project", "gotchas.md"), "# gotchas\n\n- algo antigo\n");
  execFileSync("git", ["add", "-A"], { cwd: projDoctor, env });
  execFileSync("git", ["commit", "-q", "-m", "memory legado"], { cwd: projDoctor, env });
  run(NEXOS, ["map"], projDoctor);

  const relLegado = doctorJson(projDoctor);
  check("legado do projeto NÃO degrada", relLegado.state === "HEALTHY", `state=${relLegado.state}`);
  check(
    "legado do projeto sai como evidence",
    evidenciaDe(relLegado, "project-memory").includes("project-markdown"),
    evidenciaDe(relLegado, "project-memory").slice(0, 80)
  );
  check("legado do projeto NÃO entra em reasons", !relLegado.reasons.join(" ").includes("project-markdown"));

  /**
   * Higiene da MÁQUINA é evidência, nunca veredito do projeto — regressão do
   * piloto projeto-piloto (2026-09-17). `PROJECT HEALTH != HOST HYGIENE`.
   */
  await fs.ensureDir(path.join(HOME, ".claude", "agent-memory"));
  await fs.writeFile(path.join(HOME, ".claude", "agent-memory", "de-outro-projeto.md"), "acervo da máquina\n");

  const relHost = doctorJson(projDoctor);
  check("sujeira de host NÃO degrada o projeto", relHost.state === "HEALTHY", `state=${relHost.state}`);
  check(
    "sujeira de host sai em host-hygiene",
    evidenciaDe(relHost, "host-hygiene").includes("agent-memory-user"),
    evidenciaDe(relHost, "host-hygiene").slice(0, 80)
  );
  check("sujeira de host NÃO entra em reasons", !relHost.reasons.join(" ").includes("agent-memory-user"));

  /**
   * CONTRAFACTUAL. Sem ele os quatro acima passam num Doctor que NUNCA degrada,
   * e o proof vira carimbo. Memória órfã viva ainda tem que doer. As duas
   * metades de `writable = autoMemoryEnabled && declarations.project > 0` ficam
   * explícitas: default do host não é contrato.
   */
  await fs.ensureDir(path.join(projDoctor, ".claude", "agents"));
  await fs.ensureDir(path.join(projDoctor, ".claude", "agent-memory"));
  await fs.writeJson(path.join(projDoctor, ".claude", "settings.json"), { autoMemoryEnabled: true });
  await fs.writeFile(
    path.join(projDoctor, ".claude", "agents", "escritor.md"),
    "---\nname: escritor\ndescription: escreve memória de projeto\nmemory: project\n---\ncorpo\n"
  );
  await fs.writeFile(path.join(projDoctor, ".claude", "agent-memory", "nota.md"), "anotação viva de agente\n");
  execFileSync("git", ["add", "-A"], { cwd: projDoctor, env });
  execFileSync("git", ["commit", "-q", "-m", "write-only real"], { cwd: projDoctor, env });
  run(NEXOS, ["map"], projDoctor);

  const relAtivo = doctorJson(projDoctor);
  check("memória de projeto VIVA ainda degrada", relAtivo.state === "DEGRADED", `state=${relAtivo.state}`);
  check(
    "e o motivo é a superfície viva, não o legado",
    relAtivo.reasons.join(" ").includes("agent-memory-project"),
    relAtivo.reasons.join(" ").slice(0, 100)
  );

  // ─────────────────────────────── CRITÉRIO 5 ───────────────────────────────
  secao("CRITÉRIO 5 · FRESH CLONE PORTABILITY");

  execFileSync("git", ["add", "-A"], { cwd: proj, env });
  execFileSync("git", ["commit", "-qm", "sessao A"], { cwd: proj, env });

  const HOME2 = path.join(sandbox, "home2");
  await fs.ensureDir(HOME2);
  const env2 = { ...envIsolado(HOME2), CLAUDE_PROJECT_DIR: "" };
  const clone = path.join(sandbox, "clone");
  execFileSync("git", ["clone", "-q", proj, clone], { env: env2 });

  check("manifest atravessa o clone", await fs.pathExists(path.join(clone, ".nexos", "manifest.yaml")));
  // nexos://decision/memoria-nunca-sai-da-maquina: só manifest.yaml, map/ e
  // .nexos/.gitignore são versionados. A identidade atravessa; a memória não.
  check(
    "records NÃO atravessam o clone (memória nunca sai da máquina)",
    !(await fs.pathExists(path.join(clone, ".nexos", "records")))
  );
  check(
    ".local NÃO atravessa",
    !(await fs.pathExists(path.join(clone, ".nexos", ".local")))
  );

  // env2: outra máquina de verdade. Com o `env` da sessão A, o registro de
  // autoridade em HOME1 redireciona o clone para o Store original (mesma
  // máquina, correto por projeto) e o critério não mede portabilidade.
  const rC = run("node", [sessaoB, clone], sandbox, env2);
  check("brief no clone com HOME novo", rC.code === 0, rC.code === 0 ? "" : rC.out.slice(-300));
  // Opcional em profundidade: é saída de outro processo, a forma não é garantida.
  type BriefDoClone = {
    brief?: {
      project?: { id?: string; identity_source?: string };
      knowledge?: { items?: { source_ref: string; fields: Record<string, string> }[] };
    };
  };
  // Brief que falhou vira FAIL nos checks abaixo, nunca stack crua — e nunca
  // pass no vazio: sem brief, "nada vazou" não foi medido.
  let c: BriefDoClone | null = null;
  let semBrief = "sem brief";
  try {
    c = rC.code === 0 ? (JSON.parse(rC.out) as BriefDoClone) : null;
  } catch (error) {
    semBrief = `stdout não é JSON (${error instanceof Error ? error.message : String(error)}): ${rC.out.slice(-200)}`;
  }
  const projeto = c?.brief?.project;
  check("mesma identidade no clone", projeto?.id === pid, projeto?.id ?? semBrief);
  check("identity_source = manifest no clone", projeto?.identity_source === "manifest");
  check(
    "next_action NÃO vaza para o clone",
    projeto !== undefined &&
      !(c?.brief?.knowledge?.items ?? []).some((i) => i.fields.next_action === "tratar BOM utf-8 antes do parse")
  );

  // CRITÉRIO 7 (PLUGIN / PROJECTION) removido por inteiro: chamava
  // `nexos project --execute`, comando que não existe em `src/index.ts`
  // (nenhum consumidor em package.json/CI o invoca — grep confirmou). Ficava
  // um `run()` que sempre falhava e três checks encadeados que só faziam
  // sentido se ele passasse. Sem "project" na CLI atual não há mecanismo de
  // plugin/projection equivalente a reapontar — não é um path errado, é uma
  // capacidade que este script media e que não existe mais.

  const doctor = run(NEXOS, ["doctor"], proj);
  check("nexos doctor roda no HOME isolado", doctor.code === 0 || doctor.out.length > 0);

  // CRITÉRIO 11 (PERMISSION GATE) saiu por inteiro — o produto não tem mais
  // camada de autorização própria (nexos://decision/p1-0-remover-authorization-layer).
  // Sandbox e permissões são do Claude Code, não deste instalador.

} finally {
  await fs.remove(sandbox);
}

console.log(`\n${falhas === 0 ? "TODOS OS CHECKS PASSARAM" : `${falhas} CHECK(S) FALHARAM`}`);
process.exit(falhas === 0 ? 0 : 1);
