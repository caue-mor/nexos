/**
 * C2.3 — a proposta de bootstrap ganha CONSUMIDOR REAL.
 *
 *   CODE EXISTS != WIRED
 *   CANNOT READ != DOES NOT EXIST
 *   UNKNOWN NEVER SILENTLY BECOMES DEFAULT
 *   PROPOSAL != MUTATION
 *
 * `buildBootstrapProposal` (C2.1) e `collectRepositorySignals` (C2.2) existiam
 * com importador APENAS em teste — a definição exata de código não-ligado. Esta
 * suíte prova que `nexos boot` passou a consumi-los, e que a colheita própria
 * que o boot fazia antes (com `catch { return {} }`) não volta por outro nome.
 *
 * Fixtures em `/tmp` com `HOME` isolado, mesma cautela de `boot.test.ts`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { runBoot } from "../src/commands/boot.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const TMP = fs.realpathSync(os.tmpdir());

/**
 * A linha do relatório que prova "não gravei nada". A primeira versão deste
 * arquivo afirmava o código cru `Store: NO_TRANSITION`; a régua de nomenclatura
 * traduziu a saída e as DUAS asserções negativas ficaram verdes por sumiço da
 * string, não por comportamento — `NOT PRESENT != NOT HAPPENED`. O que segura
 * as negativas é a contagem de arquivos ao lado delas; o que segura a string é
 * a asserção POSITIVA, que quebra se o texto mudar. As três leem a mesma
 * constante justamente para não poderem divergir de novo.
 *
 * Não existe simétrico "gravei": `PUBLISHED` é silencioso de propósito — o
 * relatório tem teto de 1800 chars e anunciar a escrita mediu 1825.
 */
const SEM_GRAVACAO = "Memória do projeto: nada foi gravado";
let ws: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "boot-proposal-"));
  const fakeHome = path.join(ws, "__home__");
  await fs.ensureDir(fakeHome);
  prevHome = process.env.HOME;
  prevUserProfile = process.env.USERPROFILE;
  process.env.HOME = fakeHome;
  process.env.USERPROFILE = fakeHome;
});

afterEach(async () => {
  if (prevHome === undefined) delete process.env.HOME;
  else process.env.HOME = prevHome;
  if (prevUserProfile === undefined) delete process.env.USERPROFILE;
  else process.env.USERPROFILE = prevUserProfile;
  await fs.remove(ws);
});

/**
 * D1 (decisão do dono do produto) — `nexos boot` não adota mais um projeto
 * `ABSENT` sozinho; esta suíte testa a proposta de bootstrap, que só é
 * colhida/persistida sobre uma Capsule já CANÔNICA. `initializeCapsule` faz
 * aqui o papel que o auto-init do boot fazia antes — setup de fixture, não o
 * comportamento sob teste.
 */
async function mkProject(name: string): Promise<string> {
  const root = path.join(ws, name);
  await fs.ensureDir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  await initializeCapsule(root, { projectName: name });
  return root;
}

describe("boot consome a BootstrapProposal", () => {
  it("comandos medidos aparecem no relatório, com os cinco nomes que a Capsule precisa", async () => {
    const root = await mkProject("comandos");
    await fs.writeJson(path.join(root, "package.json"), {
      name: "comandos",
      scripts: { test: "vitest run", typecheck: "tsc --noEmit", build: "tsup", lint: "eslint .", format: "prettier -w ." },
    });

    const r = await runBoot({ cwd: root });

    expect(r.blocked).toBe(false);
    expect(r.text).toContain('test="npm run test"');
    expect(r.text).toContain('typecheck="npm run typecheck"');
    expect(r.text).toContain('build="npm run build"');
    expect(r.text).toContain('lint="npm run lint"');
    expect(r.text).toContain('format="npm run format"');
  });

  /**
   * O DEFEITO que esta slice matou. O `detectScripts` anterior fazia
   * `catch { return {} }`: um `package.json` corrompido produzia um relatório
   * IDÊNTICO ao de um projeto sem scripts. Duas realidades opostas, uma saída.
   */
  it("package.json ilegível vira issue visível, nunca 'projeto sem comandos'", async () => {
    const root = await mkProject("corrompido");
    await fs.writeFile(path.join(root, "package.json"), "{ isto não é json ");

    const r = await runBoot({ cwd: root });

    expect(r.blocked).toBe(false);
    expect(r.text).toContain("Sinal não lido: package.json");
    expect(r.text).toMatch(/Sinal não lido: package\.json — ilegível/);
    // E não inventa comando nenhum a partir de um arquivo que não deu para ler.
    expect(r.text).not.toContain("Comandos:");
  });

  it("ausência real de package.json não produz issue — ausência não é falha de leitura", async () => {
    const root = await mkProject("vazio");

    const r = await runBoot({ cwd: root });

    expect(r.text).not.toContain("Sinal não lido: package.json");
    expect(r.text).not.toContain("Comandos:");
  });

  /**
   * O contrato proíbe converter conflito em default. Dois remotos é escolha
   * DURA: pegar o primeiro faria a ordem de listagem do git virar autoridade
   * sobre a identidade do projeto.
   */
  it("dois remotos expõem a decisão dura, com pergunta e motivo — não escolhe sozinho", async () => {
    const root = await mkProject("dois-remotos");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:a/b.git"], { cwd: root });
    execFileSync("git", ["remote", "add", "upstream", "git@github.com:c/d.git"], { cwd: root });

    const r = await runBoot({ cwd: root });

    expect(r.text).toContain("BLOCKED_ON_HARD_DECISION");
    expect(r.text).toContain("[hard] repo.remote");
    expect(r.text).toContain("git@github.com:a/b.git | git@github.com:c/d.git");
    expect(r.text).toContain("ordem de listagem do git");
  });

  it("remoto único é fato medido, não pergunta", async () => {
    const root = await mkProject("um-remoto");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:a/b.git"], { cwd: root });

    const r = await runBoot({ cwd: root });

    expect(r.text).not.toContain("[hard] repo.remote");
    expect(r.text).not.toContain("BLOCKED_ON_HARD_DECISION");
  });

  /**
   * Idempotência do contrato: "rodar de novo não duplica bloco, não sobrescreve
   * conteúdo do usuário, não converte conflito em default". A segunda execução
   * mantém a MESMA decisão pendente — não a resolve por cansaço.
   */
  it("rodar duas vezes não duplica linha nem resolve a decisão sozinho", async () => {
    const root = await mkProject("idempotente");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:a/b.git"], { cwd: root });
    execFileSync("git", ["remote", "add", "upstream", "git@github.com:c/d.git"], { cwd: root });
    await fs.writeJson(path.join(root, "package.json"), { name: "i", scripts: { test: "vitest" } });

    const primeira = await runBoot({ cwd: root });
    const segunda = await runBoot({ cwd: root });

    const contaDuras = (texto: string) => texto.split("\n").filter((l) => l.includes("[hard] repo.remote")).length;
    expect(contaDuras(primeira.text)).toBe(1);
    expect(contaDuras(segunda.text)).toBe(1);
    expect(segunda.text).toContain("[hard] repo.remote");
    expect(segunda.text).toContain('test="npm run test"');
  });

  it("boot não muta o repositório ao montar a proposta — PROPOSAL != MUTATION", async () => {
    const root = await mkProject("sem-mutacao");
    await fs.writeFile(path.join(root, "CLAUDE.md"), "conteúdo do usuário\n");
    await fs.writeFile(path.join(root, "AGENTS.md"), "outro host\n");
    const antes = await fs.readFile(path.join(root, "CLAUDE.md"), "utf-8");

    await runBoot({ cwd: root });

    expect(await fs.readFile(path.join(root, "CLAUDE.md"), "utf-8")).toBe(antes);
    expect(await fs.readFile(path.join(root, "AGENTS.md"), "utf-8")).toBe("outro host\n");
  });
});

// ─── D1 · a proposta é PERSISTIDA, e o teto continua de pé ─────────────────

/**
 *   PROPOSAL != MUTATION
 *   PERSISTIR A PERGUNTA NÃO É RESPONDÊ-LA
 *   PROPOSTA É ESTADO, NÃO HISTÓRICO
 *
 * D1 autorizou o boot a escrever no Store. O que ela NÃO autorizou — e o que
 * estes testes protegem — é o boot aplicar configuração: fato medido entra como
 * fato; escolha humana entra como PERGUNTA na fila, com o motivo da recusa.
 */
describe("D1 · persistência da proposta", () => {
  async function propostaDoStore(root: string) {
    const r = await readCurrentRecords(root, { kind: "bootstrap_proposal" });
    if (!r.ok || r.records.length === 0) return undefined;
    return (r.records[0]!.record as { content?: Record<string, unknown> }).content;
  }

  it("fatos medidos viajam com evidência e origem", async () => {
    const root = await mkProject("persistencia");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });

    await runBoot({ cwd: root });

    const c = await propostaDoStore(root);
    expect(c).toBeDefined();
    const facts = c!["facts"] as Array<Record<string, string>>;
    const comando = facts.find((f) => f.key === "command.test");
    expect(comando?.value).toBe("npm run test");
    expect(comando?.source).toBe("measured");
    /** A evidência é reencontrável — não "porque sim". */
    expect(comando?.evidence).toContain("package.json");
  });

  /** O teto de D1: a escolha dura é GRAVADA como pendente, jamais resolvida. */
  it("decisão dura entra na fila como PENDENTE, com pergunta e motivo", async () => {
    const root = await mkProject("fila");
    execFileSync("git", ["remote", "add", "origin", "git@github.com:a/b.git"], { cwd: root });
    execFileSync("git", ["remote", "add", "upstream", "git@github.com:c/d.git"], { cwd: root });

    await runBoot({ cwd: root });

    const c = await propostaDoStore(root);
    expect(c!["proposal_state"]).toBe("BLOCKED_ON_HARD_DECISION");
    const fila = c!["pending_decisions"] as Array<Record<string, unknown>>;
    expect(fila).toHaveLength(1);
    expect(fila[0]!["key"]).toBe("repo.remote");
    expect(fila[0]!["severity"]).toBe("hard");
    expect(fila[0]!["options"]).toEqual(["git@github.com:a/b.git", "git@github.com:c/d.git"]);
    expect(String(fila[0]!["why_not_automatic"])).toContain("ordem de listagem do git");

    /** E NENHUM fato de remoto foi escolhido — a pergunta segue aberta. */
    const facts = c!["facts"] as Array<Record<string, string>>;
    expect(facts.find((f) => f.key === "repo.remote")).toBeUndefined();
  });

  /**
   * `PROPOSTA É ESTADO, NÃO HISTÓRICO`. Acumular uma por boot transformaria o
   * Store em diário de execuções, e "o que está pendente AGORA?" exigiria
   * varrer o histórico para descobrir qual linha ainda vale.
   */
  it("boots sucessivos SUPERSEDEM — uma proposta corrente, não uma pilha", async () => {
    const root = await mkProject("supersede");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });

    await runBoot({ cwd: root });
    await runBoot({ cwd: root });
    await runBoot({ cwd: root });

    const r = await readCurrentRecords(root, { kind: "bootstrap_proposal" });
    expect(r.ok && r.records).toHaveLength(1);
  });

  it("a proposta reflete a realidade NOVA quando o repositório muda", async () => {
    const root = await mkProject("mudou");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });
    await runBoot({ cwd: root });

    await fs.writeJson(path.join(root, "package.json"), {
      name: "p",
      scripts: { test: "vitest", build: "tsup" },
    });
    await runBoot({ cwd: root });

    const c = await propostaDoStore(root);
    const facts = c!["facts"] as Array<Record<string, string>>;
    expect(facts.find((f) => f.key === "command.build")?.value).toBe("npm run build");
  });
});

// ─── C2 · drift desde o boot anterior ──────────────────────────────────────

/**
 *   AUSENTE != DIVERGENTE
 *
 * Só possível porque D1 persistiu a proposta: sem contra-parte no Store, "o que
 * mudou desde a última vez" seria pergunta sem resposta.
 */
describe("drift desde o boot anterior", () => {
  it("primeiro boot não reporta drift — não há com o que comparar", async () => {
    const root = await mkProject("primeiro");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });

    const r = await runBoot({ cwd: root });
    expect(r.text).not.toContain("Drift desde o boot anterior");
  });

  it("boot sem mudança não polui o relatório", async () => {
    const root = await mkProject("estavel");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });

    await runBoot({ cwd: root });
    const segunda = await runBoot({ cwd: root });
    expect(segunda.text).not.toContain("Drift desde o boot anterior");
  });

  it("script novo no package.json aparece como drift", async () => {
    const root = await mkProject("mudou-drift");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });
    await runBoot({ cwd: root });

    await fs.writeJson(path.join(root, "package.json"), {
      name: "p",
      scripts: { test: "vitest", build: "tsup", lint: "eslint ." },
    });
    const depois = await runBoot({ cwd: root });

    expect(depois.text).toContain("Drift desde o boot anterior");
    expect(depois.text).toMatch(/Drift desde o boot anterior: [1-9]\d* fato\(s\) mudaram/);
  });
});

// ─── idempotência de escrita ──────────────────────────────────────

/**
 *   WRITE ON TRANSITION, NOT ON EXECUTION
 *
 * Supersessão por `source_ref` fixo mantém UMA proposta corrente, mas cada
 * publicação nasce como arquivo YAML de nome ULID NOVO. Com o boot rodando no
 * começo de toda sessão, isso sujava a árvore de trabalho em toda sessão — e
 * como o nome é imprevisível, nenhuma allowlist literal o cobre.
 *
 * Os dois contrafactuais andam em par de propósito: sozinho, o negativo passaria
 * para uma implementação que nunca escreve nada.
 */
describe("idempotência da persistência da proposta", () => {
  async function yamlsDeKnowledge(root: string): Promise<string[]> {
    const dir = path.join(root, ".nexos", "records", "knowledge");
    const arquivos = await fs.readdir(dir);
    return arquivos.filter((f) => f.endsWith(".yaml")).sort();
  }

  async function idCorrente(root: string): Promise<string | undefined> {
    const r = await readCurrentRecords(root, { kind: "bootstrap_proposal" });
    if (!r.ok || r.records.length === 0) return undefined;
    return r.records[0]!.record.id;
  }

  it("boot repetido sem mudança semântica NÃO publica record novo", async () => {
    const root = await mkProject("idempotente");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });

    await runBoot({ cwd: root });
    const antes = await yamlsDeKnowledge(root);
    const idAntes = await idCorrente(root);
    expect(antes).toHaveLength(1); // o primeiro boot publica — se não publicasse, o teste seguinte seria vácuo

    const segunda = await runBoot({ cwd: root });

    /** O número que prova: mesma lista de arquivos, mesmo head. */
    expect(await yamlsDeKnowledge(root)).toEqual(antes);
    expect(await idCorrente(root)).toBe(idAntes);
    /** E o relatório DIZ que pulou — silêncio seria indistinguível de "escreveu". */
    expect(segunda.text).toContain(SEM_GRAVACAO);
  });

  it("fato alterado volta a publicar e SUPERSEDE — pular não vira nunca escrever", async () => {
    const root = await mkProject("transicao");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });

    await runBoot({ cwd: root });
    const antes = await yamlsDeKnowledge(root);
    const idAntes = await idCorrente(root);

    await fs.writeJson(path.join(root, "package.json"), {
      name: "p",
      scripts: { test: "vitest", build: "tsup" },
    });
    const depois = await runBoot({ cwd: root });

    expect(await yamlsDeKnowledge(root)).toHaveLength(antes.length + 1);
    expect(depois.text).not.toContain(SEM_GRAVACAO);

    /** Supersessão de verdade: uma proposta corrente, encadeada na anterior. */
    const r = await readCurrentRecords(root, { kind: "bootstrap_proposal" });
    expect(r.ok && r.records).toHaveLength(1);
    const corrente = r.ok ? (r.records[0]!.record as { id: string; supersedes?: string }) : undefined;
    expect(corrente?.id).not.toBe(idAntes);
    expect(corrente?.supersedes).toBe(idAntes);
  });

  it("decisão pendente nova é transição, mesmo com os fatos intactos", async () => {
    const root = await mkProject("decisao-nova");
    await fs.writeJson(path.join(root, "package.json"), { name: "p", scripts: { test: "vitest" } });
    execFileSync("git", ["remote", "add", "origin", "git@github.com:a/b.git"], { cwd: root });

    await runBoot({ cwd: root });
    const antes = await yamlsDeKnowledge(root);

    /** Segundo remoto: o fato `repo.remote` SAI e vira pergunta pendente. */
    execFileSync("git", ["remote", "add", "upstream", "git@github.com:c/d.git"], { cwd: root });
    const depois = await runBoot({ cwd: root });

    expect(await yamlsDeKnowledge(root)).toHaveLength(antes.length + 1);
    expect(depois.text).not.toContain(SEM_GRAVACAO);
  });
});
