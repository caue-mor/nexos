/**
 * MASTER ENTRYPOINT V1 — fase B: contrato mecânico do prompt do Master.
 *
 * Um arquivo de agente não roda — não dá pra "testar o prompt" executando-o.
 * O que É mecânico:
 *
 *   1. limite de arqueologia — o arquivo não trata markdown legado
 *      como fonte de estado (só pode citá-lo como projeção/legado)
 *   2. `nexos boot` é referenciado como a fonte de estado
 *   3. a política nomeia todo estado resolvido pelo kernel — derivado do
 *      schema, nunca uma lista literal que pode divergir em silêncio
 *   4. contrafactual de markdown obsoleto, NO KERNEL: `nexos boot` nunca
 *      reflete `state.md`, e mudar só `state.md` nunca muda o output
 *   5. isolamento A/B, inclusive sob cwd hostil
 *   6. todo agente citado existe em `assets/agents/`
 *
 * P0 (MVP Project Brain, bloco h) removeu `assets/commands/` inteiro (slash
 * commands do host, não NexOS) — este arquivo comparava
 * `assets/agents/nexos-master.md` contra `assets/commands/NexOS/agents/
 * nexos-master.md` (o ativador fino do comando); com o segundo lado
 * removido, os checks 1/2/6 passam a rodar só sobre o arquivo de agente.
 *
 * Cada checagem carrega seu próprio controle negativo — GOTCHA conhecido
 * deste projeto é regra declarada e nunca executada (ver
 * `rules/mechanical-verification.md`, "O antipadrão que isso previne").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { runBoot } from "../src/commands/boot.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const REPO_ROOT = process.cwd();
const AGENT_FILE = path.join(REPO_ROOT, "assets/agents/nexos-master.md");
const SCHEMAS_FILE = path.join(REPO_ROOT, "src/lib/capsule/schemas.ts");
const AGENTS_DIR = path.join(REPO_ROOT, "assets/agents");

async function readAgentFile(): Promise<string> {
  return fs.readFile(AGENT_FILE, "utf-8");
}

// ─── 1 · limite de arqueologia ──────────────────────────────────────────────

/**
 * Uma linha que MENCIONA um token legado só passa se estiver enquadrada como
 * projeção/legado nunca-autoridade — não basta a palavra existir. A
 * franquia é DELIBERADAMENTE estreita: exige "NUNCA" + "leia" (a proibição
 * de uso como caminho de boot) E "projeção"/"legado" (o enquadramento). Uma
 * linha que diz só "leia state.md para saber o estado" — a diretiva que este
 * node existe pra fechar — não bate nenhuma das duas exigências e cai como
 * violação.
 */
const LEGACY_TOKENS =
  /state\.md|gotchas\.md|decisions\.md|patterns\.md|PROXIMA-SESSAO|TESES-MORTAS|docs\/stories/;
const FRAMED_AS_LEGACY = /nunca\s+leia/i;
const FRAMED_AS_PROJECTION = /(projeção|legado)/i;

/**
 * Opera por PARÁGRAFO (bloco separado por linha em branco), não por linha
 * física crua — markdown word-wraps uma frase em várias linhas de fonte; a
 * unidade semântica de "está enquadrado como legado" é a frase inteira, não
 * o ponto arbitrário onde o editor quebrou.
 */
function archaeologyViolations(text: string): string[] {
  return text
    .split(/\n\s*\n/)
    .map((block) => block.replace(/\n/g, " "))
    .filter((block) => LEGACY_TOKENS.test(block))
    .filter((block) => !(FRAMED_AS_LEGACY.test(block) && FRAMED_AS_PROJECTION.test(block)));
}

describe("1 · limite de arqueologia — markdown legado nunca é caminho de boot", () => {
  it("assets/agents/nexos-master.md — zero violações", async () => {
    expect(archaeologyViolations(await readAgentFile())).toEqual([]);
  });

  it("controle negativo: diretiva de leitura para decidir estado É pega", () => {
    const bad = "Leia `state.md` para saber o estado atual do projeto antes de continuar.";
    expect(archaeologyViolations(bad)).toEqual([bad]);
  });

  it("controle negativo: menção sem o enquadramento de legado também é pega", () => {
    const bad = "Ver `gotchas.md` e `decisions.md` para mais contexto.";
    expect(archaeologyViolations(bad)).toEqual([bad]);
  });

  it("controle positivo: a franquia aceita exatamente o enquadramento usado no arquivo", () => {
    const good =
      "NUNCA leia `state.md` para decidir estado — onde existir é projeção/legado.";
    expect(archaeologyViolations(good)).toEqual([]);
  });
});

// ─── 2 · `nexos boot` é a fonte de estado citada ────────────────────────────

describe("2 · nexos boot referenciado como fonte de estado", () => {
  it("o arquivo cita `nexos boot`", async () => {
    expect(await readAgentFile()).toContain("nexos boot");
  });
});

// ─── 3 · todo estado resolvido pelo kernel tem branch na política ──────────

/**
 * Derivado do SCHEMA, nunca hardcoded — se `ResolvedWorkState` ganhar um
 * quinto valor amanhã, este array cresce sozinho na próxima execução do
 * teste, e a checagem abaixo vai vermelho sem editar este arquivo.
 */
async function derivedWorkStates(): Promise<string[]> {
  const src = await fs.readFile(SCHEMAS_FILE, "utf-8");
  const m = /export type ResolvedWorkState = ([^;]+);/.exec(src);
  if (!m) throw new Error("ResolvedWorkState não encontrado em schemas.ts — schema mudou de forma");
  return [...m[1]!.matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]!);
}

/**
 * Eixo CAPSULE — não vem de `resolveWorkState` (esse é o eixo WORK), então
 * não há tipo para derivar automaticamente aqui. `ABSENT` e
 * `CONFLICTING_EXISTING` são as duas condições brutas que a política do
 * Master precisa nomear explicitamente (a terceira, `CANONICAL`, já é o
 * caminho feliz sem branch de decisão própria). Fixo por ser exigência
 * explícita da task, não um enum que poderia crescer — se um dia crescer,
 * este comentário é o lugar a atualizar.
 */
const CAPSULE_AXIS_TOKENS = ["ABSENT", "CONFLICTING_EXISTING"];

function missingTokens(text: string, tokens: readonly string[]): string[] {
  return tokens.filter((t) => !new RegExp(`\\b${t}\\b`).test(text));
}

describe("3 · política nomeia todo estado resolvido (derivado do schema)", () => {
  it("assets/agents/nexos-master.md cobre os 4 estados WORK + ABSENT + CONFLICTING_EXISTING", async () => {
    const workStates = await derivedWorkStates();
    expect(workStates.length).toBeGreaterThanOrEqual(4); // prova que a extração não veio vazia
    const text = await readAgentFile();
    expect(missingTokens(text, [...workStates, ...CAPSULE_AXIS_TOKENS])).toEqual([]);
  });

  it("controle negativo: um estado removido do texto é detectado como faltante", async () => {
    const workStates = await derivedWorkStates();
    const text = await readAgentFile();
    const mutated = text.replace(/\bHUMAN_DECISION_REQUIRED\b/g, "REMOVIDO_PARA_TESTE");
    expect(missingTokens(mutated, workStates)).toContain("HUMAN_DECISION_REQUIRED");
  });

  it("controle negativo: um estado hipotético novo (não presente hoje) é detectado como faltante", async () => {
    const workStates = await derivedWorkStates();
    const text = await readAgentFile();
    expect(missingTokens(text, [...workStates, "ESTADO_FUTURO_HIPOTETICO"])).toEqual([
      "ESTADO_FUTURO_HIPOTETICO",
    ]);
  });
});

// ─── 4 · contrafactual de markdown obsoleto, no kernel ──────────────────────

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let prevHome: string | undefined;
let prevUserProfile: string | undefined;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "master-entrypoint-"));
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

const NOW = "2026-08-20T00:00:00.000Z";

async function mkGitProject(name: string): Promise<string> {
  const root = path.join(ws, name);
  await fs.ensureDir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  return root;
}

function projectStateRecordOf(pid: string, content: Record<string, string>): CapsuleRecord {
  const sourceRef = "nexos://project-state";
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: pid,
    family: "KnowledgeRecord",
    kind: "project_state",
    scope: "project",
    origin: "agent",
    provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: NOW },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "policy:test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: NOW,
    version: 1,
    content: { title: "estado", ...content },
  } as unknown as CapsuleRecord;
}

describe("4 · STALE MARKDOWN COUNTERFACTUAL — STATE.MD CHANGE != KERNEL STATE CHANGE", () => {
  it("Store diz CANONICAL_ACTION, state.md legado diz OBSOLETE_ACTION -> boot só mostra o Store", async () => {
    const root = await mkGitProject("stale-md");
    const { projectId } = await initializeCapsule(root, { projectName: "stale-md" });
    await publishCanonical(
      root,
      projectStateRecordOf(projectId, { current_state: "s", next_action: "CANONICAL_ACTION_42" })
    );
    await fs.ensureDir(path.join(root, ".nexos", "memory", "project"));
    await fs.writeFile(
      path.join(root, ".nexos", "memory", "project", "state.md"),
      "# Estado\nProxima acao: OBSOLETE_ACTION_99\n"
    );

    /**
     * Boot de aquecimento: num Store FRIO a primeira execução publica a
     * proposta de bootstrap (transição de estado real) e a seguinte reporta
     * `NO_TRANSITION`. Comparar a primeira com a segunda mediria essa
     * transição, não o que este contrafactual quer medir. Aquecido, o boot é
     * byte-idêntico execução após execução — e a asserção abaixo continua
     * literal, sem normalizar nenhuma linha.
     */
    await runBoot({ cwd: root });
    const result = await runBoot({ cwd: root });

    expect(result.state).toBe("CANONICAL");
    expect(result.text).toContain("CANONICAL_ACTION_42");
    expect(result.text).not.toContain("OBSOLETE_ACTION_99");

    // Mudar SÓ state.md -> output byte-idêntico. Prova que o boot nunca lê o arquivo.
    await fs.writeFile(
      path.join(root, ".nexos", "memory", "project", "state.md"),
      "# Estado completamente reescrito\nProxima acao: TERCEIRA_ACAO_DIFERENTE\n"
    );
    const second = await runBoot({ cwd: root });
    expect(second.text).toBe(result.text);
  });
});

// ─── 5 · isolamento A/B, inclusive sob cwd hostil ───────────────────────────

describe("5 · isolamento A/B — binding explícito, não process.cwd() ambiente", () => {
  it("dois projetos com marcadores distintos -> cada boot mostra só o seu", async () => {
    const rootA = await mkGitProject("iso-a");
    const { projectId: idA } = await initializeCapsule(rootA, { projectName: "iso-a" });
    await publishCanonical(
      rootA,
      projectStateRecordOf(idA, {
        current_state: "s",
        global_goal: "GOAL_A_MARKER",
        next_action: "NEXT_A_MARKER",
      })
    );

    const rootB = await mkGitProject("iso-b");
    const { projectId: idB } = await initializeCapsule(rootB, { projectName: "iso-b" });
    await publishCanonical(
      rootB,
      projectStateRecordOf(idB, {
        current_state: "s",
        global_goal: "GOAL_B_MARKER",
        next_action: "NEXT_B_MARKER",
      })
    );

    /** Aquece A: a 1ª execução publica a proposta, a partir da 2ª nada muda. */
    await runBoot({ cwd: rootA });
    const resultA = await runBoot({ cwd: rootA });
    expect(resultA.text).toContain("GOAL_A_MARKER");
    expect(resultA.text).not.toContain("GOAL_B_MARKER");
    expect(resultA.text).not.toContain(rootB);

    const resultB = await runBoot({ cwd: rootB });
    expect(resultB.text).toContain("GOAL_B_MARKER");
    expect(resultB.text).not.toContain("GOAL_A_MARKER");
    expect(resultB.text).not.toContain(rootA);

    // cwd hostil: o processo está "em" B, mas pedimos boot de A explicitamente.
    const originalCwd = process.cwd();
    process.chdir(rootB);
    try {
      const hostile = await runBoot({ cwd: rootA });
      expect(hostile.text).toBe(resultA.text);
      expect(hostile.projectId).toBe(idA);
    } finally {
      process.chdir(originalCwd);
    }
  });

  it("controle negativo: SEM cwd explícito, runBoot() usa process.cwd() ambiente — prova que o isolamento acima vem do parâmetro, não de acaso", async () => {
    const rootA = await mkGitProject("iso-naive-a");
    const { projectId: idA } = await initializeCapsule(rootA, { projectName: "iso-naive-a" });

    const rootB = await mkGitProject("iso-naive-b");
    const { projectId: idB } = await initializeCapsule(rootB, { projectName: "iso-naive-b" });

    const originalCwd = process.cwd();
    process.chdir(rootB);
    try {
      const naive = await runBoot(); // sem { cwd } — depende do ambiente
      expect(naive.projectId).toBe(idB);
      expect(naive.projectId).not.toBe(idA);
    } finally {
      process.chdir(originalCwd);
    }
  });
});

// ─── 6 · todo agente citado existe no registry ──────────────────────────────

/**
 * `nexos-handoff` e `nexos-project` são SKILLS (frontmatter `skills:`), não
 * agentes — não têm arquivo em `assets/agents/`.
 */
const NON_AGENT_TOKENS = new Set(["nexos-handoff", "nexos-project"]);

function extractAgentTokens(text: string): string[] {
  return [...new Set([...text.matchAll(/\bnexos-[a-z][a-z-]*\b/g)].map((m) => m[0]))];
}

describe("6 · nenhum agente citado que não exista no registry", () => {
  it("todo token nexos-* citado (exceto skills conhecidas) resolve a um arquivo em assets/agents/", async () => {
    for (const [label, text] of [["agent", await readAgentFile()]] as const) {
      const tokens = extractAgentTokens(text).filter((t) => !NON_AGENT_TOKENS.has(t));
      expect(tokens.length, `${label}: nenhum agente nexos-* citado — regex pode ter quebrado`).toBeGreaterThan(0);
      for (const token of tokens) {
        const exists = await fs.pathExists(path.join(AGENTS_DIR, `${token}.md`));
        expect(exists, `${label}: "${token}" citado mas assets/agents/${token}.md não existe`).toBe(true);
      }
    }
  });

  it("controle negativo: um agente inventado (nexos-marketing) não existe no registry", async () => {
    expect(await fs.pathExists(path.join(AGENTS_DIR, "nexos-marketing.md"))).toBe(false);
  });
});

// ─── 5 · a separação builder/verifier é invariante, não convenção ───────────

/**
 * Lacuna encontrada pelo nexos-verifier em 2026-09-17, verificando `ce6fcf4a`:
 * ele apagou do papel do master AS DUAS linhas que sustentam a separação e
 * rodou a suíte inteira — `1814 passed`, idêntico ao controle. Apagar a regra
 * que dá existência ao verificador matava ZERO testes em 1818.
 *
 *   REGRA DECLARADA != REGRA VERIFICADA
 *
 * O commit daquele dia afirmava "preservado intacto: BUILDER != VERIFIER" e
 * oferecia 49 testes verdes como prova. Os 49 passavam — e não mediam isto.
 * Prova oferecida para uma propriedade que ela não cobre é prova de nada.
 *
 * O token literal pode evoluir (`BUILDER CANNOT SELF-VERIFY` virou
 * `BUILDER != VERIFIER` no master, e o verifier mantém a forma antiga): o que
 * este teste segura é a SEPARAÇÃO, por qualquer de suas formas aceitas, mais a
 * proibição explícita de auto-verificação. Some tudo → falha.
 */
const SEPARACAO_ACEITA = [
  /BUILDER\s*!=\s*VERIFIER/,
  /BUILDER CANNOT SELF-VERIFY/,
  /ORCHESTRATOR CANNOT SELF-VERIFY/,
];

function sustentaSeparacao(texto: string): boolean {
  return SEPARACAO_ACEITA.some((re) => re.test(texto));
}

/**
 * A separação builder/verifier é INVARIANTE, e esta guarda é a única coisa que
 * a segura. Sem ela, apagá-la do papel matava zero testes em 1818.
 *
 * Quatro verificações independentes atacaram as três versões anteriores e
 * abriram QUATORZE furos. O padrão é o que importa: cada versão fechava os
 * furos da anterior enumerando mais casos, e a seguinte achava casos novos.
 * A terceira até escreveu "allowlist de forma, não blocklist de palavra" no
 * docblock — e então implementou duas blocklists novas (a âncora de coluna e
 * a lista de conectivos), ambas sobre texto CRU. Tirar o til de "verificação"
 * derrotava uma delas.
 *
 *   ENUMERAR ESCAPES NÃO CONVERGE
 *
 * Então a régua deixou de olhar PARTES da linha. Normaliza a linha INTEIRA —
 * ênfase de markdown (`*`, `_`, backtick), acento, travessão contra hífen,
 * espaço e caixa — e exige que o resultado case, por igualdade, uma das cinco
 * formas aprovadas. Não há coluna sem guarda, não há trecho descartado antes
 * da comparação, e não há palavra a prever: o que não é a forma aprovada é
 * reprovado por não ser ela.
 *
 * Os furos que isso fecha de uma vez, todos medidos, não imaginados:
 * indentação à esquerda, `***T1***`, `_T1_`, `__T1__`, `` `T1` ``, exceção na
 * coluna "quando" (que nunca teve guarda), exceção em "quem executa" com ou
 * sem acento, coluna extra, e exceção depois de `;`/`·` sem repetir a âncora.
 *
 * O custo é o ponto: QUALQUER edição na tabela de tier obriga a editar este
 * arquivo. Afrouxar a política deixa de ser uma linha de markdown que ninguém
 * revisa e passa a exigir uma segunda edição, deliberada, num teste.
 *
 * TETO DECLARADO, medido e aceito — leia antes de confiar nesta guarda.
 *
 * Isto NÃO mede a tabela. Mede que as CINCO linhas aprovadas existem, por
 * igualdade de forma. Uma linha ACRESCENTADA à tabela cuja primeira célula não
 * seja exatamente `T0`–`T4` não é inspecionada e passa verde: `| T1 (revisado) |`,
 * `| T1+ |`, `| tier 1 |`, primeira célula vazia, linha sem pipe inicial (GFM
 * aceita), uma segunda tabela mais abaixo, ou homóglifo/zero-width no rótulo.
 * Sete variantes ASCII e cinco com Unicode invisível foram medidas abertas por
 * verificação independente.
 *
 * A correção estrutural é conhecida e NÃO foi aplicada: tratar o BLOCO como
 * unidade — achar a tabela pelo cabeçalho literal, exigir que exista exatamente
 * uma, normalizar o bloco inteiro e comparar por igualdade. Aí não sobra
 * seletor para escapar.
 *
 * Por que não foi aplicada, e isso é decisão registrada
 * (`nexos://decision/guarda-tier-teto-aceito`): a régua de foco do projeto
 * (`nexos://decision/foco-produto-sobre-meta-trabalho`) dá cinco NÃOs — não
 * impede o uso, não corrompe dado, não bloqueia o release, não é capability do
 * MVP, não está em projeto real. Esta guarda já consumiu 5 commits e 4
 * verificações independentes para proteger markdown de prompt. `ENUMERAR
 * ESCAPES NÃO CONVERGE` vale também para a decisão de continuar enumerando.
 *
 * Também fora do alcance de qualquer detector de string, e igualmente aberto:
 * condição escrita na PROSA fora da tabela, e token preservado com o sentido
 * esvaziado no parágrafo ao lado.
 */
/**
 * O BLOCO é a unidade — não a linha.
 *
 * A versão anterior normalizava a linha inteira e comparava por igualdade, e
 * ainda assim foi furada: sobrava um SELETOR (`^\|\s*t[0-4]\s*\|`) decidindo o
 * que era inspecionado. Toda linha da tabela cuja primeira célula não fosse
 * exatamente `T0`–`T4` simplesmente não era olhada, e a asserção `toBe(5)`
 * contava linhas SELECIONADAS, não linhas da tabela. Doze variantes passaram
 * verdes, medidas por verificação independente: `| T1 (revisado) |`, `| T1+ |`,
 * `| tier 1 |`, primeira célula vazia, linha sem pipe inicial (GFM aceita),
 * uma segunda tabela mais abaixo, homóglifo cirílico, zero-width space,
 * fullwidth, soft hyphen.
 *
 *   ENUMERAR ESCAPES NÃO CONVERGE — INCLUSIVE NA CAMADA QUE SELECIONA
 *
 * Tirar a enumeração do conteúdo da célula e deixá-la intacta na seleção da
 * linha não fecha nada: só muda de camada. Então não há mais seleção. O bloco
 * é achado pelo CABEÇALHO LITERAL, precisa existir exatamente um, e o bloco
 * INTEIRO — cabeçalho, separador e todas as linhas até a linha em branco — é
 * normalizado e comparado por igualdade com o bloco aprovado.
 *
 * Não sobra linha não inspecionada, porque não se escolhem linhas. Não sobra
 * contagem a afrouxar, porque a contagem morreu junto com o seletor. Qualquer
 * linha acrescentada, célula renomeada, pipe omitido ou caractere invisível
 * muda o bloco e quebra a igualdade — sem que ninguém precise ter previsto.
 *
 * O custo é o ponto: QUALQUER edição na tabela obriga a editar este arquivo.
 * Afrouxar a política deixa de ser uma linha de markdown que ninguém revisa.
 *
 * TETO DECLARADO, medido e honesto: isto mede o BLOCO. Uma condição escrita na
 * PROSA fora dele, ou o token preservado com o sentido esvaziado no parágrafo
 * ao lado, continuam passando — nenhum detector de string alcança isso, e
 * ambos foram medidos abertos. A guarda promete o bloco, e entrega o bloco.
 */
const CABECALHO_DA_TABELA = "| tier | quando | quem executa | pipeline |";

/**
 * O bloco aprovado, já normalizado. Igualdade exata contra o texto inteiro —
 * é isso que elimina a categoria "parte não inspecionada".
 */
const BLOCO_APROVADO = [
  CABECALHO_DA_TABELA,
  "|---|---|---|---|",
  "| t0 | trivial, local, reversivel, sem efeito externo | o principal | verify deterministico · sem subagente |",
  "| t1 | uma frente, risco baixo | o principal pode | verifier independente sempre - o executor nao julga se cabe; subagente so se trouxer vantagem real |",
  "| t2 | 2-4 papeis, ou risco moderado | especialista | contrato por no + verifier independente sempre |",
  "| t3 | frentes independentes | varios executores | grafo com paralelismo + verifier independente sempre |",
  "| t4 | auth, pagamento, producao, migracao, dado sensivel | varios + arquitetura | seguranca + verificacao independente sempre + human gate + rollback |",
].join("\n");

/**
 * Normalização do que não muda o SENTIDO: ênfase de markdown, acento,
 * travessão contra hífen, espaço (inclusive os invisíveis que `\s` do JS não
 * cobre) e caixa. `NFKD` em vez de `NFD` porque é a decomposição de
 * COMPATIBILIDADE que colapsa fullwidth `Ｔ` em `T` — `NFD` não faz isso, e foi
 * por aí que um dos ataques entrou.
 */
export function normalizarLinhaDeTier(linha: string): string {
  return linha
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .replace(/[\u200b-\u200d\u2060\ufeff\u00ad]/g, "")
    .replace(/[—–]/g, "-")
    .replace(/[*_`]/g, "")
    .replace(/\s+/g, " ")
    .trim()
    .toLowerCase();
}

/**
 * Todos os blocos do arquivo que começam pelo cabeçalho da tabela de tier.
 * Um bloco vai do cabeçalho até a primeira linha em branco. Achar por
 * cabeçalho literal, e não por forma de linha, é o que fecha a tabela paralela
 * sem precisar prever que ela existiria.
 */
export function blocosDeTier(texto: string): string[] {
  const linhas = texto.split("\n");
  const blocos: string[] = [];
  for (let i = 0; i < linhas.length; i += 1) {
    if (normalizarLinhaDeTier(linhas[i] ?? "") !== CABECALHO_DA_TABELA) continue;
    const corpo: string[] = [];
    for (let j = i; j < linhas.length; j += 1) {
      const atual = linhas[j] ?? "";
      if (atual.trim() === "") break;
      corpo.push(normalizarLinhaDeTier(atual));
    }
    blocos.push(corpo.join("\n"));
  }
  return blocos;
}

/** `null` = conforme. String = o motivo exato da reprovação. */
export function afrouxamentoNaTabelaDeTier(texto: string): string | null {
  const blocos = blocosDeTier(texto);
  if (blocos.length === 0) return "nenhuma tabela de tier encontrada — o cabeçalho canônico sumiu";
  if (blocos.length > 1) {
    return `${blocos.length} tabelas de tier no arquivo — uma segunda tabela pode contradizer a primeira`;
  }
  if (blocos[0] !== BLOCO_APROVADO) {
    return `tabela de tier fora da allowlist:\n${blocos[0]}`;
  }
  return null;
}

describe("5 · separação builder/verifier — invariante com guarda", () => {
  it("o papel do master sustenta a separação", async () => {
    const texto = await readAgentFile();
    expect(sustentaSeparacao(texto), "nenhuma forma aceita de BUILDER != VERIFIER no nexos-master").toBe(true);
    expect(texto, "o master precisa proibir verificar o próprio resultado").toMatch(
      /verificar o próprio resultado\s*→\s*\*\*nexos-verifier\*\*/
    );
  });

  it("o papel do verifier sustenta a separação, inclusive um nível acima", async () => {
    const texto = await fs.readFile(path.join(REPO_ROOT, "assets/agents/nexos-verifier.md"), "utf-8");
    expect(sustentaSeparacao(texto)).toBe(true);
    expect(texto, "o verifier precisa cobrir o orquestrador, não só o builder").toMatch(
      /ORCHESTRATOR CANNOT SELF-VERIFY/
    );
  });

  it("a tabela de tier do papel REAL casa o bloco aprovado", async () => {
    const texto = await readAgentFile();
    expect(blocosDeTier(texto).length, "deve haver exatamente uma tabela de tier").toBe(1);
    expect(afrouxamentoNaTabelaDeTier(texto)).toBeNull();
  });

  it.each([
    ["linha acrescentada com rótulo parentético", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T1 (revisado) | uma frente | o principal | verifier DISPENSADO quando o executor achar que nao vale |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["linha acrescentada com T1+", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T1+ | uma frente | o principal | verifier DISPENSADO se trivial |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["linha acrescentada escrita por extenso", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| tier 1 | uma frente | o principal | verifier so se o executor achar material |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["linha acrescentada com primeira célula vazia", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
|  | uma frente | o principal | verifier DISPENSADO |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["linha sem pipe inicial, que GFM aceita", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
T1 | uma frente | o principal | verifier DISPENSADO |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["homóglifo cirílico no rótulo", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| Т1 | uma frente | o principal | verifier DISPENSADO |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["zero-width space no rótulo", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T​1 | uma frente | o principal | verifier DISPENSADO |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["fullwidth no rótulo", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| Ｔ1 | uma frente | o principal | verifier DISPENSADO |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["linha T1 canônica substituída por versão condicional", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente sempre que a mudança for material |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["exceção na coluna quem-executa", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode**, dispensa a verificacao independente | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["exceção na coluna quando", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente — o executor decide sozinho se precisa | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
    ["verificador removido de T2", `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`],
  ])("controle negativo: %s É pego", (_nome, doc) => {
    expect(afrouxamentoNaTabelaDeTier(doc)).not.toBeNull();
  });

  it("controle negativo: uma SEGUNDA tabela de tier no arquivo É pega", () => {
    const duas = `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

` + "prosa entre as tabelas\n\n" + `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |
`;
    expect(blocosDeTier(duas).length).toBe(2);
    expect(afrouxamentoNaTabelaDeTier(duas)).toContain("2 tabelas");
  });

  it("controle negativo: tabela ausente É pega", () => {
    expect(afrouxamentoNaTabelaDeTier("# papel sem tabela nenhuma")).toContain("nenhuma tabela");
  });

  it("controle positivo: variação inocente NÃO reprova", () => {
    const comHifen = `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`.replace("—", "-");
    expect(afrouxamentoNaTabelaDeTier(comHifen), "travessão trocado por hífen").toBeNull();
    const semAcento = `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`.replace("papéis", "papeis").replace("nó", "no");
    expect(afrouxamentoNaTabelaDeTier(semAcento), "acento removido").toBeNull();
    const espacoDuplo = `| tier | quando | quem executa | pipeline |
|---|---|---|---|
| T0 | trivial, local, reversível, sem efeito externo | **o principal** | verify determinístico · sem subagente |
| T1 | uma frente, risco baixo | **o principal pode** | verifier independente **sempre** — o executor não julga se cabe; subagente só se trouxer vantagem real |
| T2 | 2-4 papéis, ou risco moderado | especialista | contrato por nó + verifier independente sempre |
| T3 | frentes independentes | vários executores | grafo com paralelismo + verifier independente sempre |
| T4 | auth, pagamento, produção, migração, dado sensível | vários + arquitetura | segurança + verificação independente sempre + **human gate** + rollback |

`.replace("uma frente", "uma  frente");
    expect(afrouxamentoNaTabelaDeTier(espacoDuplo), "espaço duplo").toBeNull();
  });

  it("controle negativo: um papel sem a separação É pego", () => {
    expect(sustentaSeparacao("# Papel\n\nVocê decide e valida você mesmo.\n")).toBe(false);
  });
});
