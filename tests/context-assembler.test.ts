/**
 * N2 — ContextAssembler v1.
 *
 *   NEXOS KNOWS N → TASK NEEDS K → MODEL SEES K
 *
 * Fixtures de regressão de contexto: o que entra, o que fica de fora, e por quê.
 * Um assembler sem esses fixtures degrada em silêncio — ninguém percebe quando
 * o record importante para de ser selecionado.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { assembleContext, termosDe, CAMPOS_UTEIS } from "../src/lib/context-assembler.js";
import { CAMPO_DO_FATO } from "../src/lib/capsule/memory-promotion.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";
import { makeProjectState } from "./capsule-fixtures.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-14T21:00:00.000Z";
let ws: string;
let root: string;
let projectId: string;

function rec(sourceRef: string, content: Record<string, string>): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "migration",
    provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: NOW },
    lifecycle: "immutable",
    portability: "portable",
    regenerable: false,
    admission: { status: "admitted", approved_by: "human:test", approved_at: NOW },
    sensitivity: { classification: "internal", checked_at: NOW, checker_version: "t1" },
    evidence_refs: [sourceRef],
    created_at: NOW,
    version: 1,
    content,
  } as CapsuleRecord;
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "n2-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

describe("N2 · ContextAssembler", () => {
  it("Store vazio degrada com segurança", async () => {
    const r = await assembleContext({ projectRoot: root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.items).toEqual([]);
    expect(r.pack.usedBytes).toBe(0);
  });

  it("inclui o record relevante e exclui o irrelevante", async () => {
    await publishCanonical(root, rec("s#auth", { title: "login quebra", failure_mode: "token jwt expira cedo" }));
    await publishCanonical(root, rec("s#css", { title: "botao torto", failure_mode: "padding do rodape" }));

    const r = await assembleContext({ projectRoot: root, intent: "corrigir token jwt do login" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.items.map((i) => i.sourceRef)).toEqual(["s#auth"]);
    expect(r.pack.omitted.map((o) => o.sourceRef)).toContain("s#css");
  });

  it("cada item empacotado responde WHY WAS I INCLUDED", async () => {
    await publishCanonical(root, rec("s#auth", { title: "login", failure_mode: "token jwt expira" }));
    const r = await assembleContext({ projectRoot: root, intent: "token jwt" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.items[0]!.why).toMatch(/termo\(s\) do intent/);
    expect(r.pack.items[0]!.why).toContain("token");
  });

  it("respeita o orçamento e registra o que ficou de fora", async () => {
    for (let i = 0; i < 40; i++) {
      await publishCanonical(
        root,
        rec(`s#${String(i).padStart(2, "0")}`, {
          title: `caso ${i}`,
          failure_mode: `token jwt ${"x".repeat(200)} ${i}`,
        })
      );
    }
    const r = await assembleContext({ projectRoot: root, intent: "token jwt", budgetBytes: 1024 });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.usedBytes).toBeLessThanOrEqual(1024);
    expect(r.pack.omitted.filter((o) => o.reason === "BUDGET").length).toBeGreaterThan(0);
  });

  it("ordem é estável entre execuções", async () => {
    for (const s of ["s#c", "s#a", "s#b"]) {
      await publishCanonical(root, rec(s, { title: s, failure_mode: "token jwt igual" }));
    }
    const a = await assembleContext({ projectRoot: root, intent: "token jwt" });
    const b = await assembleContext({ projectRoot: root, intent: "token jwt" });
    expect(a.ok && b.ok).toBe(true);
    if (!a.ok || !b.ok) return;
    /**
     * A ordem alfabética de `sourceRef` NÃO é mais o contrato — desde o FIX 1
     * (D11) o desempate final é o `id` do record (ULID, independente da
     * forma do `source_ref`), então `["s#a","s#b","s#c"]` seria coincidência,
     * não invariante. O que o nome do teste promete é ESTABILIDADE entre duas
     * leituras do MESMO Store já persistido (mesmos ids, logo mesma ordem) —
     * é isso que as duas asserções abaixo provam.
     */
    expect(a.pack.items.map((i) => i.sourceRef)).toEqual(b.pack.items.map((i) => i.sourceRef));
    expect(a.pack.items.map((i) => i.sourceRef).sort()).toEqual(["s#a", "s#b", "s#c"]);
  });

  it("não injeta o mesmo conteúdo duas vezes", async () => {
    const igual = { title: "mesmo", failure_mode: "token jwt identico" };
    await publishCanonical(root, rec("s#1", igual));
    await publishCanonical(root, rec("s#2", { ...igual }));

    const r = await assembleContext({ projectRoot: root, intent: "token jwt" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.items).toHaveLength(1);
  });

  /** `CANNOT OBSERVE != DOES NOT EXIST` — Store ilegível não vira contexto vazio. */
  it("Store ilegível NÃO degrada para pack vazio", async () => {
    await publishCanonical(root, rec("s#a", { title: "a", failure_mode: "token" }));
    const dir = forProject(root).familyDir("KnowledgeRecord");
    const f = (await fs.readdir(dir)).find((x) => x.endsWith(".yaml"))!;
    await fs.writeFile(path.join(dir, f), "{{{");

    const r = await assembleContext({ projectRoot: root, intent: "token" });
    expect(r.ok).toBe(false);
  });

  it("sem intent, o boot leva os heads atuais", async () => {
    await publishCanonical(root, rec("s#a", { title: "a", failure_mode: "x" }));
    await publishCanonical(root, rec("s#b", { title: "b", failure_mode: "y" }));
    const r = await assembleContext({ projectRoot: root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.items).toHaveLength(2);
    expect(r.pack.items[0]!.why).toContain("boot");
  });

  it("excludeKinds: [] é idêntico a omitir excludeKinds — o corte é ADITIVO, nunca um filtro por padrão", async () => {
    await publishCanonical(root, rec("s#auth", { title: "login quebra", failure_mode: "token jwt expira cedo" }));
    await publishCanonical(root, rec("s#css", { title: "botao torto", failure_mode: "padding do rodape" }));

    const semCampo = await assembleContext({ projectRoot: root, intent: "token jwt" });
    const comArrayVazio = await assembleContext({ projectRoot: root, intent: "token jwt", excludeKinds: [] });
    expect(semCampo.ok && comArrayVazio.ok).toBe(true);
    if (!semCampo.ok || !comArrayVazio.ok) return;

    expect(comArrayVazio.pack.items.map((i) => i.id)).toEqual(semCampo.pack.items.map((i) => i.id));
    expect(comArrayVazio.pack.usedBytes).toBe(semCampo.pack.usedBytes);
  });

  it("termosDe ignora stopwords e normaliza acento", () => {
    const t = termosDe("A migração do Store para o canônico");
    expect(t.has("migracao")).toBe(true);
    expect(t.has("canonico")).toBe(true);
    expect(t.has("do")).toBe(false);
    expect(t.has("a")).toBe(false);
  });

  /**
   * G2.1 (`docs/pos-mvp-matriz-capabilities.md` §2) — `nexos memory --search
   * "hono mapper framework nao reconhecido"` casava 4 Decisions sem relação
   * pela palavra "nao": não era stopword. MEDIDO: golden set de 43 perguntas
   * reais deste repo, baseline recall@5 4,7% (`docs/memory-eval/golden.yaml`).
   */
  it("termosDe ignora 'nao' e outras palavras funcionais PT de alta frequência (G2.1)", () => {
    const t = termosDe("hono mapper framework nao reconhecido");
    expect(t.has("hono")).toBe(true);
    expect(t.has("mapper")).toBe(true);
    expect(t.has("framework")).toBe(true);
    expect(t.has("reconhecido")).toBe(true);
    expect(t.has("nao")).toBe(false);

    const funcionais = termosDe(
      "não sem mais muito também isso isto essa esse esta este quando onde " +
        "como mas ou já só foi ser estar seu sua pelo pela num numa nem " +
        "entre até depois antes então assim cada todo toda aqui ali você " +
        "eles elas meu minha nosso nossa dele dela aquele aquela tudo algo " +
        "outro mesmo"
    );
    expect(funcionais.size).toBe(0);
  });
});

/**
 * D11 — piso reservado para `kind: gotcha` (decisões A/B do node) e os
 * contrafactuais que o operador exige. Cada `it` monta sua própria Capsule
 * isolada (não reusa `root`/`projectId` do describe acima) porque A4 precisa
 * comparar DUAS configurações lado a lado.
 */
describe("N2 · D11 — piso de gotcha e contrafactuais", () => {
  function envelope(pid: string, family: string, sourceRef: string) {
    return {
      schema_version: 1 as const,
      project_id: pid,
      family,
      scope: "project" as const,
      origin: "migration" as const,
      provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: NOW },
      lifecycle: "immutable" as const,
      portability: "portable" as const,
      regenerable: false as const,
      admission: { status: "admitted" as const, approved_by: "human:test", approved_at: NOW },
      sensitivity: { classification: "internal" as const, checked_at: NOW, checker_version: "t1" },
      evidence_refs: [sourceRef],
      created_at: NOW,
      version: 1,
    };
  }
  function gotcha(pid: string, sourceRef: string, i: number): CapsuleRecord {
    return {
      ...envelope(pid, "KnowledgeRecord", sourceRef),
      id: newRecordId("KnowledgeRecord"),
      kind: "gotcha",
      content: { title: `gotcha ${i}`, failure_mode: `falha operacional numero ${i} em producao` },
    } as unknown as CapsuleRecord;
  }
  function decisionOf(pid: string, sourceRef: string, i: number): CapsuleRecord {
    return {
      ...envelope(pid, "Decision", sourceRef),
      id: newRecordId("Decision"),
      content: { title: `decisao ${i}`, decision: `optou-se pela abordagem numero ${i}` },
    } as unknown as CapsuleRecord;
  }
  function stateOf(pid: string): CapsuleRecord {
    return {
      ...envelope(pid, "KnowledgeRecord", "nexos://project_state/head"),
      id: newRecordId("KnowledgeRecord"),
      kind: "project_state",
      content: {
        title: "estado",
        current_state: "em andamento",
        next_action: "continuar",
      },
    } as unknown as CapsuleRecord;
  }

  async function novaCapsula() {
    const ws2 = await fs.mkdtemp(path.join(TMP, "n2-cf-"));
    const root2 = path.join(ws2, "proj");
    await fs.ensureDir(root2);
    const pid = (await initializeCapsule(root2, { projectName: "proj" })).projectId;
    return { ws2, root2, pid };
  }

  it("A4 — inverter o source_ref não muda quantos gotcha/decision entram", async () => {
    const budgetBytes = 1600;

    async function montar(prefixoDecision: string, prefixoGotcha: string) {
      const { ws2, root2, pid } = await novaCapsula();
      for (let i = 0; i < 20; i++) {
        await publishCanonical(root2, decisionOf(pid, `${prefixoDecision}dec${String(i).padStart(2, "0")}`, i));
      }
      for (let i = 0; i < 3; i++) {
        await publishCanonical(root2, gotcha(pid, `${prefixoGotcha}got${String(i).padStart(2, "0")}`, i));
      }
      const r = await assembleContext({ projectRoot: root2, budgetBytes });
      await fs.remove(ws2);
      if (!r.ok) throw new Error("fixture ilegível");
      return r.pack;
    }

    /** decision (".") ordena ANTES de gotcha ("z") — a forma medida no boot real. */
    const original = await montar(".", "z");
    /** INVERTIDO: gotcha (".") ordena ANTES de decision ("z") — mesmo kind, mesmo
     * conteúdo, mesma relevância; só a forma do source_ref virou. */
    const invertido = await montar("z", ".");

    const porKind = (items: typeof original.items) => ({
      gotcha: items.filter((i) => i.kind === "gotcha").length,
      decision: items.filter((i) => i.family === "Decision").length,
    });

    const k1 = porKind(original.items);
    const k2 = porKind(invertido.items);

    /** As 3 gotcha cabem inteiras no piso (25% de 1600 = 400B), então nenhuma
     * fica pendente pra fatia geral — onde o desempate lexical ainda mora.
     * Isso torna a contagem EXATAMENTE igual, não só "melhor na média". */
    expect(k1.gotcha).toBe(3);
    expect(k2.gotcha).toBe(3);
    expect(k1.decision).toBe(k2.decision);
    expect(original.usedBytes).toBe(invertido.usedBytes);
  });

  it("A5 — sem intent, o boot garante project_state + piso de aprendizado durável mesmo com Decision numerosa", async () => {
    const { ws2, root2, pid } = await novaCapsula();
    await publishCanonical(root2, stateOf(pid));
    /** 40 Decision baratas, source_ref começando em "." — a forma que, sem
     * piso, esgotava o orçamento antes de qualquer gotcha ser tentado. */
    for (let i = 0; i < 40; i++) {
      await publishCanonical(root2, decisionOf(pid, `.dec${String(i).padStart(2, "0")}`, i));
    }
    /** 5 gotcha, source_ref "zzz..." — pior caso alfabético possível pra elas. */
    for (let i = 0; i < 5; i++) {
      await publishCanonical(root2, gotcha(pid, `zzz-gotcha-${String(i).padStart(2, "0")}`, i));
    }

    const budgetBytes = 2048;
    const r = await assembleContext({ projectRoot: root2, budgetBytes });
    await fs.remove(ws2);
    expect(r.ok).toBe(true);
    if (!r.ok) return;

    const gotchaItems = r.pack.items.filter((i) => i.kind === "gotcha");
    const decisionOmitidosBudget = r.pack.omitted.filter(
      (o) => o.reason === "BUDGET" && o.sourceRef.startsWith(".dec")
    );

    /** Contrato declarado (não "gotcha count > 0"):
     *  1. project_state está presente;
     *  2. as 5 gotcha — TODO o kind, não uma amostra — entraram inteiras;
     *  3. havia contenção real: alguma Decision foi cortada por orçamento,
     *     então gotcha não entrou "porque sobrou espaço", entrou porque o
     *     piso é dela. */
    expect(r.pack.items.some((i) => i.kind === "project_state")).toBe(true);
    expect(gotchaItems).toHaveLength(5);
    expect(decisionOmitidosBudget.length).toBeGreaterThan(0);
  });

  it("A6 — intent relevante ranqueia gotcha acima do irrelevante; intent não relacionado não inunda o contexto", async () => {
    const { ws2, root2, pid } = await novaCapsula();
    await publishCanonical(root2, stateOf(pid));
    // representativo: intent de "docker/sandbox/timeout" (lista da rubrica A6)
    await publishCanonical(root2, {
      ...envelope(pid, "KnowledgeRecord", "s#relevante"),
      id: newRecordId("KnowledgeRecord"),
      kind: "gotcha",
      content: {
        title: "container trava",
        failure_mode: "docker sandbox estoura o timeout ao subir o harness de CI",
      },
    } as unknown as CapsuleRecord);
    await publishCanonical(root2, {
      ...envelope(pid, "KnowledgeRecord", "s#irrelevante"),
      id: newRecordId("KnowledgeRecord"),
      kind: "gotcha",
      content: { title: "botao torto", failure_mode: "padding do rodape do formulario de cadastro" },
    } as unknown as CapsuleRecord);
    await publishCanonical(root2, {
      ...envelope(pid, "Decision", "s#decisao-irrelevante"),
      id: newRecordId("Decision"),
      content: { title: "paleta de cores", decision: "usar tons pastel no onboarding" },
    } as unknown as CapsuleRecord);

    const relevante = await assembleContext({ projectRoot: root2, intent: "docker sandbox timeout" });
    expect(relevante.ok).toBe(true);
    if (relevante.ok) {
      const refs = relevante.pack.items.map((i) => i.sourceRef);
      expect(refs).toContain("s#relevante");
      expect(refs).not.toContain("s#irrelevante");
      expect(refs).not.toContain("s#decisao-irrelevante");
    }

    /** Intent SEM relação nenhuma com o que está no Store: conhecimento
     * disponível não pode "vazar" pra dentro do contexto por causa do piso.
     * `MEMORY AVAILABLE != MEMORY ALWAYS INJECTED` — só project_state
     * (bonus incondicional) sobrevive. */
    const irrelacionado = await assembleContext({
      projectRoot: root2,
      intent: "migrar banco de dados postgres para outra regiao",
    });
    await fs.remove(ws2);
    expect(irrelacionado.ok).toBe(true);
    if (!irrelacionado.ok) return;
    const kinds = irrelacionado.pack.items.map((i) => i.kind);
    expect(kinds).toEqual(["project_state"]);
  });

  /**
   * A4-bis — a contraparte do A4 acima que o A4 não cobre: A4 força as 3
   * gotcha a caber INTEIRAS no piso, então o desempate nunca chega a ser
   * exercitado na fatia geral. Este teste usa só `Decision` (fora do piso,
   * `ehGotcha` nunca a inclui) para isolar o desempate de `comparar()` na
   * fatia geral, sem a mecânica do piso no meio.
   */
  it("A4-bis — sem intent, created_at desempata a ordem (não a forma de source_ref)", async () => {
    const { ws2, root2, pid } = await novaCapsula();
    const T = (d: number) => `2026-08-${String(10 + d).padStart(2, "0")}T00:00:00.000Z`;
    async function dec(sourceRef: string, i: number, createdAt: string) {
      await publishCanonical(root2, {
        ...envelope(pid, "Decision", sourceRef),
        id: newRecordId("Decision"),
        created_at: createdAt,
        content: { title: `decisao ${i}`, decision: "mesma decisao de conteudo identico" },
      } as unknown as CapsuleRecord);
    }
    /** "a*" ordena ANTES de "z*" por `localeCompare`, mas é o par MAIS
     * ANTIGO — o oposto do que `created_at` deveria escolher. */
    await dec("a01", 1, T(1));
    await dec("a02", 2, T(2));
    await dec("z01", 3, T(4)); // mais novo
    await dec("z02", 4, T(3));

    const semCorte = await assembleContext({ projectRoot: root2 });
    expect(semCorte.ok).toBe(true);
    if (!semCorte.ok) {
      await fs.remove(ws2);
      return;
    }
    /** recency desc: z01(T4) > z02(T3) > a02(T2) > a01(T1) — nunca lexical. */
    expect(semCorte.pack.items.map((i) => i.sourceRef)).toEqual(["z01", "z02", "a02", "a01"]);

    /** Mesmo Store, orçamento só para os 2 mais baratos: os DOIS MAIS NOVOS
     * sobrevivem ao corte, não os dois de source_ref lexicograficamente menor. */
    const custoPorItem = semCorte.pack.items[0]!.bytes;
    const comCorte = await assembleContext({
      projectRoot: root2,
      budgetBytes: custoPorItem * 2 + 1,
    });
    await fs.remove(ws2);
    expect(comCorte.ok).toBe(true);
    if (!comCorte.ok) return;
    expect(comCorte.pack.items.map((i) => i.sourceRef).sort()).toEqual(["z01", "z02"]);
    expect(
      comCorte.pack.omitted.filter((o) => o.reason === "BUDGET").map((o) => o.sourceRef).sort()
    ).toEqual(["a01", "a02"]);
  });

  /**
   * A4-ter — a lacuna que A4-bis não cobre: A4-bis desempata por `created_at`
   * DIFERENTE. Mas o Store real (migração C12) publica em LOTE — 78 Decision
   * colapsadas em 10 `created_at` DISTINTOS, em grupos de até 10 registros
   * IDÊNTICOS ao milissegundo. Dentro do lote, `created_at` empata e o
   * desempate cai de volta no ÚLTIMO critério — que não pode ser
   * `sourceRef.localeCompare`, senão a inversão lexical fora de lote (A4-bis)
   * volta a valer DENTRO do lote.
   *
   * Aqui `created_at` é IDÊNTICO para as 20 Decision (simula o lote), e o
   * `id` de cada uma é fixado ANTES das duas montagens e REUSADO — só o
   * PREFIXO do `source_ref` (a metade que leva "a" vs "z") troca entre
   * `original` e `invertido`. Se o desempate final depende da forma do
   * `source_ref`, o conjunto de vencedores (por índice lógico, não por
   * source_ref) muda quando o prefixo troca de metade. Se depende do `id`
   * (fixo por índice nas duas montagens), o conjunto não muda.
   */
  it("A4-ter — desempate em LOTE (created_at idêntico): vencedor não pode depender da forma do source_ref", async () => {
    const budgetBytes = 800;
    const T = "2026-08-12T00:00:00.000Z";

    /** ids fixados uma única vez, reusados nas duas montagens — só o prefixo
     * do source_ref muda entre elas, nunca o id por índice. */
    const ids = Array.from({ length: 20 }, () => newRecordId("Decision"));

    async function montar(prefixoDe: (i: number) => string) {
      const { ws2, root2, pid } = await novaCapsula();
      for (let i = 0; i < 20; i++) {
        await publishCanonical(root2, {
          ...envelope(pid, "Decision", `${prefixoDe(i)}${String(i).padStart(2, "0")}`),
          id: ids[i],
          created_at: T,
          content: { title: `decisao ${i}`, decision: `conteudo distinto numero ${i}` },
        } as unknown as CapsuleRecord);
      }
      const r = await assembleContext({ projectRoot: root2, budgetBytes });
      await fs.remove(ws2);
      if (!r.ok) throw new Error("fixture ilegível");
      return r.pack;
    }

    /** índice 0-9 leva prefixo "a", 10-19 leva "z". */
    const original = await montar((i) => (i < 10 ? "a" : "z"));
    /** invertido: troca QUAL metade leva qual prefixo — mesmo id por índice. */
    const invertido = await montar((i) => (i < 10 ? "z" : "a"));

    /** sourceRef é `${prefixo}${indice}` — o índice sobrevive à troca de prefixo. */
    const indicesVencedores = (pack: typeof original) =>
      pack.items.map((it) => Number(it.sourceRef.slice(1))).sort((a, b) => a - b);

    const vOriginal = indicesVencedores(original);
    const vInvertido = indicesVencedores(invertido);

    /** Contenção real: nem todos os 20 cabem em 800B — senão o teste não prova nada. */
    expect(vOriginal.length).toBeGreaterThan(0);
    expect(vOriginal.length).toBeLessThan(20);

    expect(vInvertido).toEqual(vOriginal);
  });

  /**
   * A7 — item maior que o orçamento INTEIRO não pode zerar o pack. O corte
   * por prefixo estrito (`empacotar`) fechava a fatia no primeiro candidato
   * que não coubesse — e `project_state` (bônus de `PESO_KIND`, sempre
   * rank 1) é tentado ANTES de qualquer outro item. Um `project_state`
   * grande (`nexos state --set` cresce esse campo) fechava a fatia geral
   * antes dela sequer tentar o resto: orçamento pequeno virava pack VAZIO,
   * mesmo havendo itens pequenos que caberiam sobrando.
   */
  it("A7 — varredura de orçamento: nenhum ponto devolve pack vazio havendo itens que caberiam", async () => {
    const { ws2, root2, pid } = await novaCapsula();

    /** ~2.25 KB — maior que os orçamentos pequenos da varredura, mas um
     * `current_state` alcançável (o campo cresce a cada `--set`). */
    await publishCanonical(root2, {
      ...envelope(pid, "KnowledgeRecord", "nexos://project_state/head"),
      id: newRecordId("KnowledgeRecord"),
      kind: "project_state",
      content: {
        title: "estado",
        current_state: "x".repeat(2200),
        next_action: "continuar",
      },
    } as unknown as CapsuleRecord);

    /** 5 Decision pequenas — fora do piso do gotcha, cabem folgadas em
     * qualquer orçamento da varredura. */
    for (let i = 0; i < 5; i++) {
      await publishCanonical(root2, decisionOf(pid, `s#dec-${i}`, i));
    }

    for (const budgetBytes of [512, 1024, 1600, 2048, 4096, 6144, 8192]) {
      const r = await assembleContext({ projectRoot: root2, budgetBytes });
      expect(r.ok, `budget=${budgetBytes}`).toBe(true);
      if (!r.ok) continue;
      expect(r.pack.items.length, `budget=${budgetBytes} zerou o pack`).toBeGreaterThan(0);
    }
    await fs.remove(ws2);
  });
});

/**
 * `SAVED != RETRIEVABLE`.
 *
 * `nexos memory --kind` oferece gotcha, pattern e architecture como
 * equivalentes, mas `CAMPOS_UTEIS` só conhecia o vocabulário de gotcha,
 * project_state e Decision. Um record `pattern` ou `architecture` pontuava e
 * era descartado por `fields` vazio — gravado e irrecuperável. Medido no Store
 * real deste repo: `--search PATTERN-001` devolvia zero, com
 * `nexos://pattern/PATTERN-001` em `omitted` como NO_SIGNAL.
 */
describe("N2 · os três kinds de memória são recuperáveis", () => {
  function envelopeK(pid: string, sourceRef: string) {
    return {
      schema_version: 1 as const,
      id: newRecordId("KnowledgeRecord"),
      project_id: pid,
      family: "KnowledgeRecord",
      scope: "project" as const,
      origin: "agent" as const,
      provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: NOW },
      lifecycle: "immutable" as const,
      portability: "portable" as const,
      regenerable: false as const,
      admission: { status: "admitted" as const, approved_by: "human:test", approved_at: NOW },
      sensitivity: { classification: "internal" as const, checked_at: NOW, checker_version: "t1" },
      evidence_refs: [sourceRef],
      created_at: NOW,
      version: 1,
    };
  }

  /** Mesma forma que `promoteToRecord` produz para cada kind. */
  const patternRec = (pid: string): CapsuleRecord =>
    ({
      ...envelopeK(pid, "nexos://pattern/P1"),
      kind: "pattern",
      content: {
        context: "callers escreviam a propria autoridade",
        practice: "representar autorizacao com tipo branded por unique symbol",
        expected_effect: "literais deixam de construir autoridade",
        applicability: "dentro do mesmo processo",
        evidence: "ADR-069 slice 2",
      },
    }) as unknown as CapsuleRecord;

  const architectureRec = (pid: string): CapsuleRecord =>
    ({
      ...envelopeK(pid, "nexos://architecture/A1"),
      kind: "architecture",
      content: {
        subject: "broker de presenca",
        model: "o observador coleta sinal do terminal e o gate decide autoridade",
        invariants: [],
        dependencies: [],
      },
    }) as unknown as CapsuleRecord;

  it("pattern e architecture são empacotados quando o assunto casa", async () => {
    await publishCanonical(root, patternRec(projectId));
    await publishCanonical(root, architectureRec(projectId));

    const p = await assembleContext({ projectRoot: root, intent: "tipo branded por unique symbol" });
    expect(p.ok).toBe(true);
    if (!p.ok) return;
    expect(p.pack.items.map((i) => i.sourceRef)).toContain("nexos://pattern/P1");

    const a = await assembleContext({ projectRoot: root, intent: "broker de presenca observador do terminal" });
    expect(a.ok).toBe(true);
    if (!a.ok) return;
    expect(a.pack.items.map((i) => i.sourceRef)).toContain("nexos://architecture/A1");
  });

  it("um assunto sem relação continua não achando nada", async () => {
    await publishCanonical(root, patternRec(projectId));
    await publishCanonical(root, architectureRec(projectId));

    const r = await assembleContext({ projectRoot: root, intent: "receita de bolo de cenoura" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.pack.items.filter((i) => i.matchedTerms.length > 0)).toEqual([]);
    expect(r.pack.omitted.map((o) => o.sourceRef).sort()).toEqual([
      "nexos://architecture/A1",
      "nexos://pattern/P1",
    ]);
  });

  /**
   * `INDEXED FOR SEARCH != INJECTED INTO THE BRIEF` — o teto que impede a
   * correção de virar inflação de contexto. Campo de APOIO casa a busca e não
   * pode aparecer em `fields`; se aparecer, os 126 gotcha do Store real ganham
   * `evidence` e o brief perde um corpo inteiro (medido: 4 → 3 corpos).
   *
   * `evidence` entra na lista proibida por DOIS motivos: não é injetado E não
   * é indexado — ver o teto em `CAMPOS_INDEXADOS`.
   */
  it("campo de apoio indexa mas NÃO é injetado", async () => {
    await publishCanonical(root, patternRec(projectId));

    const r = await assembleContext({ projectRoot: root, intent: "callers escreviam dentro do mesmo processo" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.pack.items.find((i) => i.sourceRef === "nexos://pattern/P1");
    expect(item, "campo de apoio deveria ter casado a busca").toBeDefined();
    for (const apoio of ["evidence", "context", "expected_effect", "applicability"]) {
      expect(Object.keys(item!.fields), `${apoio} não pode viajar no pack`).not.toContain(apoio);
    }
    expect(Object.keys(item!.fields)).toEqual(["practice"]);
  });

  /**
   * O campo que CARREGA a afirmação de cada kind já tem uma resposta canônica
   * em `CAMPO_DO_FATO` (memory-promotion). Se alguém adicionar um kind lá e
   * esquecer aqui, o record volta a ser gravado e irrecuperável — este teste é
   * o que impede a regressão silenciosa.
   */
  it("todo campo de CAMPO_DO_FATO é injetável", () => {
    for (const campo of Object.values(CAMPO_DO_FATO)) {
      expect(CAMPOS_UTEIS as readonly string[], `${campo} fora de CAMPOS_UTEIS`).toContain(campo);
    }
  });
});

/**
 * global_goal chega ao pack (Fatia 1/Passo 3, commit 1).
 *
 * O record sempre teve o campo (`ProjectStateSchema`, `capsule/schemas.ts`) e
 * `nexos state` sempre o leu direto do record — só o assembler não sabia dele,
 * porque `CAMPOS_UTEIS` é quem decide o que vira `fields` (ver o comentário
 * acima da lista). Contrafactual provado ao vivo: remover `global_goal` de
 * `CAMPOS_UTEIS` e rodar esta suíte faz o primeiro teste falhar com
 * `expected undefined to be 'entregar o boot util'` — restaurado antes do
 * commit.
 */
describe("N2 · global_goal em CAMPOS_UTEIS", () => {
  it("presente no record → presente no pack", async () => {
    await publishCanonical(
      root,
      makeProjectState({
        project_id: projectId,
        content: {
          title: "estado",
          current_state: "trabalhando na fatia",
          next_action: "seguir para o proximo passo",
          global_goal: "entregar o boot util",
        },
      })
    );
    const r = await assembleContext({ projectRoot: root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.pack.items.find((i) => i.kind === "project_state");
    expect(item?.fields.global_goal).toBe("entregar o boot util");
  });

  it("ausente no record → ausente no pack, nunca fabricado", async () => {
    await publishCanonical(root, makeProjectState({ project_id: projectId }));
    const r = await assembleContext({ projectRoot: root });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const item = r.pack.items.find((i) => i.kind === "project_state");
    expect(item?.fields.global_goal).toBeUndefined();
  });
});
