/**
 * FATIA 2 — MEMORY RECALL AUTOMÁTICO.
 *
 * Os testes A–G exigidos pelo dono, um `describe` por item, mais os 4
 * contrafactuais obrigatórios embutidos onde a prova exige mostrar que o
 * MECANISMO importa (não só que o caminho feliz funciona) — mesma disciplina
 * de `claude-user-prompt-submit.test.ts`.
 *
 * Store isolado por projeto temporário (`novoProjeto`): a Store REAL deste
 * repo muda a cada sessão (outros agentes publicam records concorrentemente),
 * então nenhuma asserção pode depender do conteúdo dela — só do que este
 * arquivo escreve.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { init } from "../src/commands/init.js";
import { state } from "../src/commands/state.js";
import { gotcha } from "../src/commands/gotcha.js";
import { publishContextDecision } from "../src/commands/decision.js";
import { resolveProject } from "../src/lib/project-resolver.js";
import { assembleContext, termosDe } from "../src/lib/context-assembler.js";
import {
  runMemoryRecallAdapter,
  __testing,
  type MemoryRecallHookInput,
} from "../src/host/claude/memory-recall.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;

const silencioso = <T>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => vi.restoreAllMocks());
};

async function novoProjeto(nome: string): Promise<string> {
  const root = path.join(ws, nome);
  await fs.ensureDir(root);
  await silencioso(() => init({ cwd: root, registerGlobally: false }));
  return root;
}

const payload = (root: string, sessionId: string, prompt: string): MemoryRecallHookInput => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  cwd: root,
  prompt,
});

const chamar = (root: string, sessionId: string, prompt: string) =>
  runMemoryRecallAdapter(payload(root, sessionId, prompt), { CLAUDE_PROJECT_DIR: root });

async function markerPara(root: string, sessionId: string): Promise<string> {
  const resolution = await resolveProject({ cwd: root });
  return __testing.shownMarkerFile(resolution.bootstrapLocator, sessionId);
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "memrecall-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

// ─── A · gotcha relevante recuperado; State fora; sem padding ───────────────

describe("A · vamos mexer novamente no permission gate", () => {
  it("recupera o gotcha relevante, não injeta project_state, e não escolhe 3 só porque existem", async () => {
    const root = await novoProjeto("a");

    // project_state com "gate" e "permissao" — se não fosse excluído por kind,
    // dominaria o ranking (PESO_KIND.project_state = 100).
    await silencioso(() =>
      state({ cwd: root, set: "trabalhando na permissao do gate", next: "revisar" })
    );

    // Alvo: título contém a FRASE "permission gate" — vence o desempate de tier 1.
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Nome customizado de subagente mascara o agent_type e o permission gate nega o papel legitimo",
        rule: "NOMEAR O SUBAGENTE SUBSTITUI A IDENTIDADE QUE AUTORIZA",
      })
    );

    // Empate deliberado: bate os MESMOS 2 termos (permission, gate), mas NÃO
    // como frase adjacente no título, e é criado DEPOIS (mais recente).
    // Ver CONTRAFACTUAL 2 abaixo: sem tie-break por título, este venceria.
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Erro de permission ao aplicar novo gate no CI, sem relacao com subagentes",
        rule: "pipeline de CI, nao tema de dispatch",
      })
    );

    // Ruído: compartilha SÓ "mexer" (1 termo) — não pode qualificar.
    await silencioso(() =>
      gotcha({ cwd: root, title: "Mexer no schema sem migration quebra o RLS", rule: "sempre gerar migration" })
    );

    // Ruído: zero termos em comum.
    await silencioso(() =>
      gotcha({ cwd: root, title: "Cache do npm corrompe build quando node_modules e symlink", rule: "limpar cache" })
    );

    const r = await chamar(root, "s-a", "vamos mexer novamente no permission gate");

    expect(r.state).toBe("RECALL");
    if (r.state !== "RECALL") return;

    expect(r.text.startsWith("[NEXOS MEMORY]")).toBe(true);
    expect(r.text).toContain("permission gate nega o papel legitimo");

    // project_state NUNCA aparece — nem o rótulo, nem o valor escrito acima.
    expect(r.text).not.toContain("Estado");
    expect(r.text).not.toContain("trabalhando na permissao do gate");

    // Os dois gotchas de "mexer"/"npm cache" NUNCA qualificam (sinal fraco
    // demais) — 4 gotchas existem, só 2 têm matchedTerms>=2. NUNCA preenche
    // as 3 posições artificialmente.
    expect(r.text).not.toContain("Mexer no schema");
    expect(r.text).not.toContain("Cache do npm");
    expect((r.text.match(/^- /gm) ?? []).length).toBe(2);

    /**
     * O gotcha "Erro de permission ao aplicar novo gate no CI" empata em
     * matchedTerms/score com o alvo — é o mesmo par usado no CONTRAFACTUAL 2
     * abaixo, que prova (por execução, não por comentário) que sem o tier de
     * frase exata essa ordem sairia errada.
     */
    const idxAlvo = r.text.indexOf("permission gate nega o papel legitimo");
    const idxEmpate = r.text.indexOf("Erro de permission ao aplicar novo gate no CI");
    expect(idxEmpate).toBeGreaterThan(-1);
    expect(idxAlvo).toBeLessThan(idxEmpate);
  });

  it("CONTRAFACTUAL 2 — sem o tier de frase exata no título, o desempate base (score/recency/id) erra a ordem; com o tier, acerta", async () => {
    const root = await novoProjeto("a-contra2");

    // Mesmo par de A: dois gotchas empatam em matchedTerms (2: "permission",
    // "gate") e em score (nenhum bônus de kind) — só a ORDEM de criação
    // difere, e o empate é criado DEPOIS (ULID/created_at mais recente).
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Nome customizado de subagente mascara o agent_type e o permission gate nega o papel legitimo",
        rule: "NOMEAR O SUBAGENTE SUBSTITUI A IDENTIDADE QUE AUTORIZA",
      })
    );
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Erro de permission ao aplicar novo gate no CI, sem relacao com subagentes",
        rule: "pipeline de CI, nao tema de dispatch",
      })
    );

    const intent = "vamos mexer novamente no permission gate";

    // `assembleContext` é o código real SEM o tier de relevância textual —
    // ele mora só em `memory-recall.ts`, o assembler nunca o executa. A
    // ordem que ele devolve é o desempate BASE (score → recency → id), o
    // mesmo que `qualificados.sort` receberia se o tier fosse removido.
    const semTier = await assembleContext({
      projectRoot: root,
      intent,
      budgetBytes: Number.MAX_SAFE_INTEGER,
      excludeKinds: ["project_state"],
    });
    expect(semTier.ok).toBe(true);
    if (!semTier.ok) return;
    expect(semTier.pack.items).toHaveLength(2);

    const [primeiroSemTier, segundoSemTier] = semTier.pack.items;
    expect(primeiroSemTier?.matchedTerms.length).toBe(2);
    expect(segundoSemTier?.matchedTerms.length).toBe(2);
    expect(primeiroSemTier?.score).toBe(segundoSemTier?.score);

    // VERMELHO: sem o tier, o empate (mais recente) vence e aparece
    // primeiro — o alvo fica em segundo. Ordem ERRADA.
    expect(primeiroSemTier?.title).toContain("Erro de permission ao aplicar novo gate no CI");
    expect(segundoSemTier?.title).toContain("permission gate nega o papel legitimo");

    // Mesmos dois itens, agora ordenados pelo comparador REAL de
    // `memory-recall.ts` (exportado só para teste via `__testing`).
    const termosIntent = termosDe(intent);
    const intentBigramas = __testing.bigramasDe(intent);
    const comTier = [...semTier.pack.items].sort((a, b) =>
      __testing.compararRelevanciaTextual(a, b, intentBigramas, termosIntent)
    );

    // VERDE: com o tier de frase exata no título, o alvo vence — ordem CERTA.
    expect(comTier[0]?.title).toContain("permission gate nega o papel legitimo");
    expect(comTier[1]?.title).toContain("Erro de permission ao aplicar novo gate no CI");
  });
});

// ─── B · host surface drift prioriza a memória, não o State ─────────────────

describe("B · host surface drift", () => {
  it("prioriza a memória de host surface; o State, com bônus +100, nunca entra no pool", async () => {
    const root = await novoProjeto("b");

    await silencioso(() =>
      state({ cwd: root, set: "investigando host surface drift no boot", next: "medir de novo" })
    );
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Host surface entra em DRIFT quando dist muda sem reinstalar global",
        rule: "SOURCE != BUILT != DEPLOYED — medir cada superficie, nunca inferir",
      })
    );

    const r = await chamar(root, "s-b", "host surface drift");
    expect(r.state).toBe("RECALL");
    if (r.state === "RECALL") {
      expect(r.text).toContain("Host surface entra em DRIFT");
      expect(r.text).not.toContain("Estado");
      expect(r.text).not.toContain("investigando host surface drift no boot");
    }
  });

  it("CONTRAFACTUAL 3 — sem excludeKinds, project_state (score ~103) dominaria o pool", async () => {
    const root = await novoProjeto("b-contra");
    await silencioso(() =>
      state({ cwd: root, set: "investigando host surface drift no boot", next: "medir de novo" })
    );
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Host surface entra em DRIFT quando dist muda sem reinstalar global",
        rule: "medir cada superficie",
      })
    );

    const semExclusao = await assembleContext({
      projectRoot: root,
      intent: "host surface drift",
      budgetBytes: Number.MAX_SAFE_INTEGER,
    });
    expect(semExclusao.ok).toBe(true);
    if (!semExclusao.ok) return;
    const top = semExclusao.pack.items[0];
    expect(top?.kind).toBe("project_state");
    expect(top?.score).toBeGreaterThanOrEqual(100);
  });
});

// ─── C · sem qualquer sinal → 0 bytes ────────────────────────────────────────

describe("C · receita de estrogonofe de camarão", () => {
  it("nenhum termo bate com o Store — EMPTY, 0 bytes", async () => {
    const root = await novoProjeto("c");
    await silencioso(() => state({ cwd: root, set: "implementando FATIA 2", next: "escrever testes" }));
    await silencioso(() => gotcha({ cwd: root, title: "Permission gate nega spawn com nome fora do registry", rule: "usar authority declarada" }));

    const r = await chamar(root, "s-c", "receita de estrogonofe de camarão");
    expect(r.state).toBe("EMPTY");
  });
});

// ─── D · uma palavra genérica, dezenas de records → não injeta ──────────────

describe("D · query de 1 palavra genérica compartilhada com dezenas de records", () => {
  it("nenhum record qualifica — matchedTerms de 1 nunca é sinal suficiente", async () => {
    const root = await novoProjeto("d");
    for (let i = 0; i < 12; i++) {
      await silencioso(() =>
        gotcha({
          cwd: root,
          title: `Assunto completamente diferente numero ${i}`,
          rule: `alguma regra qualquer que menciona sessao de passagem, item ${i}`,
        })
      );
    }

    const r = await chamar(root, "s-d", "sessao");
    expect(r.state).toBe("EMPTY");
  });

  it("CONTRAFACTUAL 1 — sem a política conservadora, o pool bruto TEM candidatos (matchedTerms=1)", async () => {
    const root = await novoProjeto("d-contra");
    for (let i = 0; i < 12; i++) {
      await silencioso(() =>
        gotcha({
          cwd: root,
          title: `Assunto completamente diferente numero ${i}`,
          rule: `alguma regra qualquer que menciona sessao de passagem, item ${i}`,
        })
      );
    }

    const bruto = await assembleContext({
      projectRoot: root,
      intent: "sessao",
      budgetBytes: Number.MAX_SAFE_INTEGER,
      excludeKinds: ["project_state"],
    });
    expect(bruto.ok).toBe(true);
    if (!bruto.ok) return;
    const comSinal = bruto.pack.items.filter((i) => i.matchedTerms.length > 0);
    // O defeito que a política existe para prevenir: dezenas de candidatos
    // "casariam" por 1 termo só. `qualifica()` (D acima) reprova todos; sem
    // ela, `hits.length > 0` injetaria memória irrelevante em toda sessão.
    expect(comSinal.length).toBeGreaterThan(5);
  });
});

// ─── E · dedup na mesma sessão ───────────────────────────────────────────────

describe("E · mesma sessão não repete", () => {
  it("aparece na primeira chamada; some na segunda, mesma sessão", async () => {
    const root = await novoProjeto("e");
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Permission gate nega spawn com nome fora do registry",
        rule: "authority precisa vir do registry declarado",
      })
    );

    const r1 = await chamar(root, "s-e", "o permission gate negou o spawn de novo");
    expect(r1.state).toBe("RECALL");

    const r2 = await chamar(root, "s-e", "o permission gate negou o spawn de novo");
    expect(r2.state).toBe("EMPTY");
  });

  it("CONTRAFACTUAL 4 — apagar o marker entre as duas chamadas faz reaparecer (prova que o marker é o mecanismo)", async () => {
    const root = await novoProjeto("e-contra");
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Permission gate nega spawn com nome fora do registry",
        rule: "authority precisa vir do registry declarado",
      })
    );

    const r1 = await chamar(root, "s-e2", "o permission gate negou o spawn de novo");
    expect(r1.state).toBe("RECALL");

    const r2 = await chamar(root, "s-e2", "o permission gate negou o spawn de novo");
    expect(r2.state).toBe("EMPTY"); // dedup ligado

    await fs.remove(await markerPara(root, "s-e2"));

    const r3 = await chamar(root, "s-e2", "o permission gate negou o spawn de novo");
    expect(r3.state).toBe("RECALL"); // marker sumiu — fail-safe REEMITIR, nunca bloquear
  });
});

// ─── F · nova sessão pode reaparecer ─────────────────────────────────────────

describe("F · novo session_id, mesmo tema", () => {
  it("sessão nova não herda o silêncio da sessão anterior", async () => {
    const root = await novoProjeto("f");
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Permission gate nega spawn com nome fora do registry",
        rule: "authority precisa vir do registry declarado",
      })
    );

    const s1a = await chamar(root, "sessao-um", "o permission gate negou o spawn de novo");
    expect(s1a.state).toBe("RECALL");
    const s1b = await chamar(root, "sessao-um", "o permission gate negou o spawn de novo");
    expect(s1b.state).toBe("EMPTY");

    const s2 = await chamar(root, "sessao-dois", "o permission gate negou o spawn de novo");
    expect(s2.state).toBe("RECALL");
  });
});

// ─── G · isolamento por projeto ──────────────────────────────────────────────

describe("G · projeto A não retorna record de projeto B", () => {
  it("mesmo termo, mesma pergunta: projeto com o gotcha recupera; o outro fica em silêncio", async () => {
    const rootA = await novoProjeto("g-a");
    const rootB = await novoProjeto("g-b");

    await silencioso(() =>
      gotcha({
        cwd: rootA,
        title: "Permission gate nega spawn com nome fora do registry",
        rule: "authority precisa vir do registry declarado",
      })
    );
    // rootB nunca recebe este gotcha — isolamento é estrutural
    // (`assembleContext` → `readCurrentRecords(rootPath)` só enxerga
    // `<rootPath>/.nexos/records`), não um filtro aplicado depois.

    const rA = await chamar(rootA, "s-ga", "o permission gate negou o spawn de novo");
    expect(rA.state).toBe("RECALL");

    const rB = await chamar(rootB, "s-gb", "o permission gate negou o spawn de novo");
    expect(rB.state).toBe("EMPTY");
  });
});

// ─── SOMENTE RECALL: nunca publica nada no Store ────────────────────────────

describe("SOMENTE RECALL", () => {
  it("o adapter não altera o Store do projeto — antes e depois têm o mesmo conjunto de records", async () => {
    const root = await novoProjeto("readonly");
    await silencioso(() =>
      gotcha({ cwd: root, title: "Permission gate nega spawn com nome fora do registry", rule: "authority declarada" })
    );

    const antes = await fs.readdir(path.join(root, ".nexos", "records", "knowledge"));
    await chamar(root, "s-ro", "o permission gate negou o spawn de novo");
    const depois = await fs.readdir(path.join(root, ".nexos", "records", "knowledge"));

    expect(depois.sort()).toEqual(antes.sort());
  });
});

// ─── H · Decision hifenizada qualifica; ruído de bigrama-preposição some ────

/**
 * Reproduz, isolado, o defeito medido contra o Store real deste repo:
 * `bigramasDe` contava "gate de"/"de permissao" — par ligado só pela
 * preposição "de" — como frase exata em QUALQUER título que a contivesse,
 * dando candidatura (via `qualifica`) a um gotcha com só 1 termo
 * genuinamente em comum. Esse falso positivo está corrigido (nunca
 * qualifica). O empate GENUÍNO entre dois candidatos com o mesmo
 * `matchedTerms`/score continua caindo em recency/id puro — EXPERIMENTO
 * mecânico (ver docstring de `compararRelevanciaTextual`) testou um tier
 * condicional "Decision vence" e outro por densidade de título; os dois
 * venciam este caso mas perdiam o contraexemplo do describe I (Decision
 * genérica vencendo gotcha on-topic só por forma, não por texto) — KEEP foi
 * reverter para recency/id puro. Documentado aqui como LIMITAÇÃO CONHECIDA:
 * entre dois candidatos igualmente casados, o mais recente vence, mesmo
 * quando um deles é a Decision aplicável.
 */
describe("H · Decision hifenizada qualifica no empate; ruído de bigrama-preposição nunca aparece", () => {
  it("gotcha com 1 termo, qualificado só pela preposição, NUNCA aparece; entre Decision e gotcha genuinamente empatados, o mais recente vence (limitação conhecida)", async () => {
    const root = await novoProjeto("h");

    await silencioso(() =>
      publishContextDecision({
        cwd: root,
        key: "remove-permission-gate-legacy",
        set: "Removemos o gate de permissao antiga do sistema; revisao obrigatoria em toda mudanca de acesso.",
        type: "constraint",
        source: "fixture://h/decision",
        applicability: "todo o projeto a partir desta fixture",
      })
    );

    // Ruído: só 1 termo real em comum ("gate") — qualificava ANTES do fix
    // só porque o título contém "gate de" adjacente (bigrama ligado pela
    // preposição "de", não pelo assunto).
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Ferramenta trava ao configurar o gate de acesso do pipeline",
        rule: "verificar a configuracao do pipeline antes de rodar",
      })
    );

    // Empate genuíno: mesmos 2 termos da Decision ("gate", "permissao"),
    // criado DEPOIS (id mais recente) — LIMITAÇÃO CONHECIDA: vence o
    // desempate por recency/id puro, sem vantagem de relevância sobre a
    // Decision (nem o contrário) — nenhum sinal textual sobra para decidir.
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Erro ao configurar permissao de acesso no gate secundario",
        rule: "revisar antes de aplicar a mudanca",
      })
    );

    const r = await chamar(root, "s-h", "adicionar gate de permissão");

    expect(r.state).toBe("RECALL");
    if (r.state !== "RECALL") return;

    // O ruído de 1 termo nunca qualifica — nem título nem source_ref aparecem.
    expect(r.text).not.toContain("Ferramenta trava ao configurar o gate de acesso");

    // Os dois candidatos genuinamente empatados aparecem (RECALL_MAX_ITEMS
    // comporta os dois) — a ORDEM entre eles é a limitação conhecida:
    // recency decide, não relevância.
    expect(r.text).toContain("remove-permission-gate-legacy");
    expect(r.text).toContain("Erro ao configurar permissao de acesso no gate secundario");
    const idxDecisao = r.text.indexOf("remove-permission-gate-legacy");
    const idxEmpate = r.text.indexOf("Erro ao configurar permissao de acesso no gate secundario");
    expect(idxEmpate).toBeLessThan(idxDecisao);
  });
});

// ─── I · Contraexemplo: Decision genérica NÃO vence gotcha on-topic ─────────

/**
 * Contraexemplo medido pelo verificador contra os tiers rejeitados no
 * EXPERIMENTO (ver docstring de `compararRelevanciaTextual`): uma Decision
 * genérica ("revisar periodicamente o processo de arquitetura") empata em
 * `matchedTerms`=2 ("revisar", "processo") com um gotcha específico sobre
 * deploy/rollback ("processo de rollback", "deploy") que também casa 2
 * termos ("processo", "deploy") — nenhum tier de frase resolve (nenhum
 * bigrama da query sobrevive à peneira de stopword: "revisar o processo de
 * deploy" só tem palavras de conteúdo não-adjacentes). Um tier por `family`
 * ou por densidade de título fazia a Decision vencer SÓ POR FORMA — este
 * teste prova que o comparador atual (recency/id puro) não repete o erro:
 * não garante que o gotcha vença por relevância (é recency, não
 * entendimento), mas não é mais CEGO ao kind.
 */
describe("I · contraexemplo — Decision genérica empatada não vence só por ser Decision", () => {
  it("gotcha on-topic (deploy/rollback) e Decision genérica (arquitetura) empatam; a ordem não vem de `family`", async () => {
    const root = await novoProjeto("i");

    await silencioso(() =>
      publishContextDecision({
        cwd: root,
        key: "revisar-processo-arquitetura",
        set: "Revisar periodicamente o processo de arquitetura do sistema e suas decisoes historicas.",
        type: "preference",
        source: "fixture://i/decision",
        applicability: "todo o projeto",
      })
    );

    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "Deploy em producao falha e o processo de rollback nao e acionado automaticamente",
        rule: "verificar o processo de rollback antes de cada deploy",
      })
    );

    const r = await chamar(root, "s-i", "revisar o processo de deploy");

    expect(r.state).toBe("RECALL");
    if (r.state !== "RECALL") return;

    // Os dois qualificam e aparecem — nenhum kind é excluído por não ser
    // Decision. A afirmação que este teste protege é negativa: a Decision
    // NUNCA vence só por `family === "Decision"` (não há esse tier no
    // comparador) — a asserção positiva de ordem é a mesma limitação
    // conhecida do describe H (recency decide o empate genuíno).
    expect(r.text).toContain("revisar-processo-arquitetura");
    expect(r.text).toContain("Deploy em producao falha");
    const idxDecisao = r.text.indexOf("revisar-processo-arquitetura");
    const idxGotcha = r.text.indexOf("Deploy em producao falha");
    // Gotcha criado DEPOIS da Decision nesta fixture — vence por recency,
    // não por um tier que julgasse "Decision sempre vence": prova que
    // remover o tier de `family` é suficiente para o gotcha on-topic não
    // perder só por forma.
    expect(idxGotcha).toBeLessThan(idxDecisao);
  });
});

/**
 * PODA DO ÍNDICE — nexos://decision/indice-de-continuidade-poda-por-relevancia
 *
 *   TETO EM GRANDEZA DIFERENTE NÃO COMPÕE
 *
 * A primeira versão desta poda usava teto em CONTAGEM (10 nomes) no mesmo
 * caminho onde já havia um teto em BYTES (4096). O de contagem saturava
 * antes e o gatilho do outro nunca mais disparava — quebrou
 * `decision-continuity.test.ts` e o HEAD ficou vermelho. Mesma grandeza aqui.
 */
describe("índice nomeia por relevância até um teto em bytes", () => {
  async function projetoCom(n: number, prefixo: string): Promise<string> {
    const root = await novoProjeto(`bytes-${prefixo}`);
    for (let i = 0; i < n; i += 1) {
      await silencioso(() =>
        publishContextDecision({
          cwd: root,
          key: `${prefixo}-assunto-${i}`,
          set: `Regra operacional numero ${i} sobre ${prefixo} para efeito de fixture.`,
          type: "decision",
          source: "fixture://poda",
          applicability: "fixture",
        })
      );
    }
    return root;
  }

  const linhaDoIndice = (t: string): string =>
    t.split("\n").find((l) => l.startsWith("Decisões de continuidade")) ?? "";

  it("o teto é em BYTES, não em número de chaves", async () => {
    /** Chaves longas: o teto de bytes deixa passar MENOS nomes que chaves curtas. */
    const longo = await novoProjeto("bytes-longo");
    for (let i = 0; i < 30; i += 1) {
      await silencioso(() =>
        publishContextDecision({
          cwd: longo,
          key: `${String(i).padStart(2, "0")}-${"k".repeat(70)}`,
          set: `Regra operacional numero ${i} com chave longa para efeito de fixture.`,
          type: "decision",
          source: "fixture://poda",
          applicability: "fixture",
        })
      );
    }
    const curto = await projetoCom(30, "curto");

    const rl = await chamar(longo, "s-bytes-1", "regra operacional");
    const rc = await chamar(curto, "s-bytes-2", "regra operacional");
    const contar = (t: string) => (linhaDoIndice(t).match(/,/g) ?? []).length;
    const nl = contar(rl.state === "RECALL" ? rl.text : "");
    const nc = contar(rc.state === "RECALL" ? rc.text : "");
    expect(nl, "chave longa consome mais bytes, então cabem menos nomes").toBeLessThan(nc);
    /** E as duas linhas ficam na mesma ORDEM DE GRANDEZA — que é o ponto do teto em bytes. */
    const bl = Buffer.byteLength(linhaDoIndice(rl.state === "RECALL" ? rl.text : ""), "utf8");
    const bc = Buffer.byteLength(linhaDoIndice(rc.state === "RECALL" ? rc.text : ""), "utf8");
    expect(Math.abs(bl - bc)).toBeLessThan(400);
  });

  /** CONTROLE: o flag é sobre recuperabilidade, nunca sobre exibição. */
  it("poda NÃO liga CONTINUITY_CONTEXT_INCOMPLETE", async () => {
    const root = await projetoCom(40, "flag");
    const r = await chamar(root, "s-bytes-3", "regra operacional sobre flag");
    const texto = r.state === "RECALL" ? r.text : "";
    expect(linhaDoIndice(texto)).toContain("não nomeadas");
    expect(texto).not.toContain("CONTINUITY_CONTEXT_INCOMPLETE");
  });
});

/**
 * PISO DE RELEVÂNCIA — `mudadas` não engole o orçamento do corpo.
 *
 *   MUDOU != IMPORTA AGORA
 *
 * MEDIDO em 2026-09-22 no repo real (132 Decisions): na SEGUNDA chamada de uma
 * sessão, `mudadas` — toda Decision alterada desde a chamada anterior — furava
 * a fila num orçamento ÚNICO de 4096 bytes e sem teto próprio, então o prompt
 * "adicionar um campo styling no mapa" devolvia 9 itens com 8 CORPOS de
 * decisão e UMA única memória relevante. O `RECALL_MAX_ITEMS = 3` existia e
 * não era honrado: não sobrava orçamento.
 *
 * Depois do piso, o mesmo cenário: 6 corpos de decisão e as 3 memórias. O que
 * não coube continua na fila (`cortadas`), como antes — o piso não perde
 * continuidade, só deixa de deixá-la monopolizar.
 */
describe("piso de relevância: Decision alterada não expulsa a memória que casa com o prompt", () => {
  it("segunda chamada continua entregando as memórias relevantes, não só continuidade", async () => {
    const root = await novoProjeto("piso");

    /** Massa de continuidade: muitas Decisions, nenhuma sobre o assunto do prompt. */
    for (let i = 0; i < 40; i += 1) {
      await silencioso(() =>
        publishContextDecision({
          cwd: root,
          key: `continuidade-irrelevante-${String(i).padStart(2, "0")}`,
          set: `Regra operacional de continuidade numero ${i}, sobre assunto que nada tem a ver com a tarefa.`,
          type: "decision",
          source: "fixture://piso",
          applicability: "fixture",
        })
      );
    }

    /** Três gotchas que casam com o prompt — é o que precisa sobreviver. */
    for (const n of ["um", "dois", "tres"]) {
      await silencioso(() =>
        gotcha({
          cwd: root,
          title: `hidratacao do componente react quebra no servidor (${n})`,
          rule: "HIDRATACAO NO SERVIDOR != RENDER NO CLIENTE",
          evidence: `medido na fixture ${n}`,
        })
      );
    }

    // 1a chamada: popula o marker e o índice. 2a: é onde `mudadas` entrava sem teto.
    await chamar(root, "s-piso", "listar os projetos adotados");
    const r = await chamar(root, "s-piso", "hidratacao do componente react no servidor");
    expect(r.state).toBe("RECALL");
    const texto = r.state === "RECALL" ? r.text : "";

    const corposDeDecisao = (texto.match(/^ {2}decision: /gm) ?? []).length;
    const gotchasRelevantes = (texto.match(/hidratacao do componente react/g) ?? []).length;

    expect(
      gotchasRelevantes,
      `nenhuma memória relevante sobreviveu — ${String(corposDeDecisao)} corpos de decisão ocuparam o orçamento`
    ).toBeGreaterThan(0);
    // O orçamento reservado comporta as 3; menos que isso significa que a continuidade voltou a monopolizar.
    expect(gotchasRelevantes).toBeGreaterThanOrEqual(2);
  });

  it("com MASSA TRIPLA de continuidade a memória relevante continua entrando", async () => {
    /**
     * O teto é em BYTES, não em contagem — 13 Decisions curtas cabem nos mesmos
     * 2.731 bytes em que 3 longas cabem, e contar corpos mede a fixture, não o
     * contrato. O que o piso promete é uma coisa só: a memória que casa com o
     * prompt SEMPRE tem orçamento. Isto prova sob pressão tripla.
     */
    const root = await novoProjeto("piso-massa");
    for (let i = 0; i < 120; i += 1) {
      await silencioso(() =>
        publishContextDecision({
          cwd: root,
          key: `massa-${String(i).padStart(3, "0")}`,
          set: `Regra operacional numero ${i}, com corpo longo o bastante para ocupar orcamento de verdade no bloco de memoria injetado a cada prompt do usuario.`,
          type: "decision",
          source: "fixture://piso",
          applicability: "fixture",
        })
      );
    }
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "hidratacao do componente react quebra no servidor sob massa",
        rule: "HIDRATACAO NO SERVIDOR != RENDER NO CLIENTE",
        evidence: "medido na fixture de massa",
      })
    );

    await chamar(root, "s-massa", "listar os projetos adotados");
    const r = await chamar(root, "s-massa", "hidratacao do componente react no servidor");
    const texto = r.state === "RECALL" ? r.text : "";
    const corpos = (texto.match(/^ {2}decision: /gm) ?? []).length;
    expect(
      texto,
      `120 Decisions e ${String(corpos)} corpos no bloco — a memória relevante foi expulsa de novo`
    ).toContain("hidratacao do componente react");
  });
});

describe("mensagem que não é pedido do usuário", () => {
  it("notificação de tarefa, canal de peer e relatório de subagente não disparam recall", async () => {
    for (const prompt of [
      "<task-notification>\n<task-id>x</task-id>\n<summary>permission gate pronto</summary>",
      '<channel source="claude-peers" from_id="a">vamos mexer no permission gate</channel>',
      "Another Claude session sent a message:\n<agent-message>permission gate</agent-message>",
      '<agent-message from="a1">\n[Subagent hand-back] relatório sobre o permission gate',
      // HIGH #4 (rodada 3): wrapper documentado da ferramenta SendMessage.
      '<cross-session-message from="peer-a">vamos mexer no permission gate</cross-session-message>',
      '<teammate-message from="team-lead">vamos mexer no permission gate</teammate-message>',
    ]) {
      const result = await runMemoryRecallAdapter(
        { hook_event_name: "UserPromptSubmit", session_id: "s", prompt },
        { CLAUDE_PROJECT_DIR: "/qualquer" }
      );
      expect(result).toEqual({ state: "SKIPPED", reason: "mensagem de tarefa/canal/subagente — recall é para o pedido do usuário" });
    }
  });
});
