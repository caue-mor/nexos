/**
 * SELF-HOST RECONCILIATION — o "onde paramos" como record canônico.
 *
 *   STATE IS A SNAPSHOT != STATE IS HISTORY LOG
 *   RECENCY != AUTHORITY
 *
 * Medido em 14/08 num clone REAL do próprio nexos-cli: 68 decisões e 7 gotchas
 * atravessam, e o clone não sabe onde o trabalho parou. Estado e próxima ação
 * viviam só em `state.md`, que é local e gitignored.
 *
 * Tudo em capsule ISOLADA. `REAL CANONICAL STORE != SCRATCH SPACE`.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { init } from "../src/commands/init.js";
import { state, stateReconcile } from "../src/commands/state.js";
import { readCurrentRecords, contentOf } from "../src/lib/capsule/reader.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { readManifestProjectId, type IntegrityIssue } from "../src/lib/capsule/integrity.js";
import { buildSessionBriefForCwd } from "../src/lib/bootstrap-context.js";
import { resolveWorkState, CapsuleRecordSchema } from "../src/lib/capsule/schemas.js";
import { makeProjectState } from "./capsule-fixtures.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;

const SOURCE_REF = "nexos://project-state";
const silencioso = <T>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => vi.restoreAllMocks());
};

const estadoAtual = async (raiz: string): Promise<Record<string, string> | undefined> => {
  const r = await readCurrentRecords(raiz, { kind: "project_state" });
  if (!r.ok) return undefined;
  const x = r.records.find((y) => y.sourceRef === SOURCE_REF);
  return x ? contentOf(x.record) : undefined;
};

/** `evidence_refs` vive no ENVELOPE, não em `content` — `contentOf` não o alcança. */
const refsAtuais = async (raiz: string): Promise<readonly string[] | undefined> => {
  const r = await readCurrentRecords(raiz, { kind: "project_state" });
  if (!r.ok) return undefined;
  const x = r.records.find((y) => y.sourceRef === SOURCE_REF);
  return x ? (x.record as { evidence_refs?: readonly string[] }).evidence_refs : undefined;
};

/** Estado inicial COM evidência — base de toda a matriz de invalidação abaixo. */
const comEvidencia = async (raiz: string): Promise<void> => {
  await silencioso(() =>
    state({
      cwd: raiz,
      set: "parser pronto",
      next: "tratar BOM",
      title: "Importador",
      goal: "importador CSV",
      verified: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    })
  );
};

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "st-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  await silencioso(() => init({ cwd: root, registerGlobally: false }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

describe("nexos state · escrita canônica", () => {
  it("publica o estado com próxima ação", async () => {
    await silencioso(() =>
      state({ cwd: root, set: "parser pronto", next: "tratar BOM", title: "Importador" })
    );
    const c = await estadoAtual(root);
    expect(c?.current_state).toBe("parser pronto");
    expect(c?.next_action).toBe("tratar BOM");
    expect(c?.title).toBe("Importador");
  });

  /**
   * Sem supersessão, duas escritas no mesmo `source_ref` viram DIVERGED e o
   * reader recusa as duas — o projeto ficaria SEM estado por ter estado demais.
   */
  it("snapshot novo SUPERSEDE o anterior: sempre um head, nunca DIVERGED", async () => {
    await silencioso(() => state({ cwd: root, set: "v1", next: "a" }));
    await silencioso(() => state({ cwd: root, set: "v2", next: "b" }));
    await silencioso(() => state({ cwd: root, set: "v3", next: "c" }));

    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anomalies).toEqual([]);
    expect(r.records).toHaveLength(1);
    expect(contentOf(r.records[0]!.record).current_state).toBe("v3");
  });

  it("STATE IS A SNAPSHOT: o Store não acumula um head por escrita", async () => {
    for (let i = 0; i < 5; i++) {
      await silencioso(() => state({ cwd: root, set: `v${i}`, next: "x" }));
    }
    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok && r.records).toHaveLength(1);
  });

  it("exige next_action OU blocker — snapshot mudo não retoma trabalho", async () => {
    await silencioso(() => state({ cwd: root, set: "algo" }));
    expect(await estadoAtual(root)).toBeUndefined();
  });

  it("aceita blocker no lugar de next_action", async () => {
    await silencioso(() => state({ cwd: root, set: "parado", blocker: "falta credencial" }));
    expect((await estadoAtual(root))?.blocker).toBe("falta credencial");
  });

  /**
   * COUNTERFACTUAL — pega a regressão que o defeito original causava.
   *
   * Comportamento antigo (destrutivo): `content` era reconstruído do zero a
   * cada chamada, só com as flags passadas — `--next` sozinho publicava um
   * record novo com `current_state: undefined` (campo ausente, `min(1)`
   * falhava e o Store ficava sem head novo) e sem `title`/`last_verified`
   * herdados. Este teste falha contra aquele código porque `--next`-only
   * jamais chegaria a `current_state` presente.
   *
   * `last_verified` saiu deste teste e ganhou os seus, logo abaixo: a versão
   * anterior AFIRMAVA a herança da evidência como comportamento desejado, e
   * era exatamente o defeito (`HERDADO != REVERIFICADO`).
   */
  it("`--next` sozinho atualiza next_action e preserva title/current_state", async () => {
    await silencioso(() =>
      state({ cwd: root, set: "parser pronto", next: "tratar BOM", title: "Importador" })
    );

    await silencioso(() => state({ cwd: root, next: "tratar BOM2" }));

    const c = await estadoAtual(root);
    expect(c?.title).toBe("Importador");
    expect(c?.current_state).toBe("parser pronto");
    expect(c?.next_action).toBe("tratar BOM2");

    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok && r.records).toHaveLength(1);
  });

  it("`--set` sozinho atualiza current_state e preserva next_action/title", async () => {
    await silencioso(() =>
      state({ cwd: root, set: "parser pronto", next: "tratar BOM", title: "Importador" })
    );

    await silencioso(() => state({ cwd: root, set: "parser + testes" }));

    const c = await estadoAtual(root);
    expect(c?.current_state).toBe("parser + testes");
    expect(c?.next_action).toBe("tratar BOM");
    expect(c?.title).toBe("Importador");
  });

  it("`--blocker` sozinho limpa next_action velho — não deixa os dois stale", async () => {
    await silencioso(() => state({ cwd: root, set: "parser pronto", next: "tratar BOM" }));
    await silencioso(() => state({ cwd: root, blocker: "falta credencial" }));

    const c = await estadoAtual(root);
    expect(c?.blocker).toBe("falta credencial");
    expect(c?.next_action).toBeUndefined();
    expect(c?.current_state).toBe("parser pronto");
  });

  it("liga a evidência de gate ao estado", async () => {
    await silencioso(() =>
      state({ cwd: root, set: "verde", next: "seguir", verified: "ev_01TESTE" })
    );
    expect((await estadoAtual(root))?.last_verified).toBe("ev_01TESTE");
  });

  it("projeto sem Capsule canônica não ganha estado canônico", async () => {
    const semCapsule = path.join(ws, "sem");
    await fs.ensureDir(semCapsule);
    await silencioso(() => state({ cwd: semCapsule, set: "x", next: "y" }));
    expect(await fs.pathExists(path.join(semCapsule, ".nexos"))).toBe(false);
  });

  it("ler nunca escreve", async () => {
    await silencioso(() => state({ cwd: root }));
    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok && r.records).toHaveLength(0);
  });

  /**
   * WORK axis — `global_goal` é independente de `current_state`/`next_action`
   * e SOBREVIVE a escritas parciais que não o tocam, mesma disciplina que
   * `title`/`last_verified` já tinham (`PARTIAL UPDATE É O PADRÃO`).
   */
  it("round-trip: `--goal` publica global_goal e supersessão preserva o que não foi tocado", async () => {
    await silencioso(() =>
      state({ cwd: root, set: "parser pronto", next: "tratar BOM", goal: "importador CSV até produção" })
    );
    expect((await estadoAtual(root))?.global_goal).toBe("importador CSV até produção");

    // Escrita parcial seguinte não passa `--goal` — precisa sobreviver à supersessão.
    await silencioso(() => state({ cwd: root, next: "tratar BOM2" }));
    const c = await estadoAtual(root);
    expect(c?.global_goal).toBe("importador CSV até produção");
    expect(c?.next_action).toBe("tratar BOM2");
    expect(c?.current_state).toBe("parser pronto");

    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok && r.records).toHaveLength(1);
  });

  it("`--decision` publica decision_question e dispensa next_action/blocker", async () => {
    await silencioso(() =>
      state({ cwd: root, set: "aguardando escolha de gateway", decision: "Stripe ou gateway atual?" })
    );
    const c = await estadoAtual(root);
    expect(c?.decision_question).toBe("Stripe ou gateway atual?");
    expect(c?.next_action).toBeUndefined();
    expect(c?.blocker).toBeUndefined();
  });

  it("`--next` sozinho resolve uma decisão pendente — não deixa decision_question stale", async () => {
    await silencioso(() => state({ cwd: root, set: "aguardando escolha", decision: "Stripe ou atual?" }));
    await silencioso(() => state({ cwd: root, next: "migrar para Stripe" }));

    const c = await estadoAtual(root);
    expect(c?.next_action).toBe("migrar para Stripe");
    expect(c?.decision_question).toBeUndefined();
  });

  /**
   * DEFEITO 1 — repro EXATA do relatório: `nexos state --set s --next
   * CONTINUE_ME --blocker BLOCKED_ME --decision DECIDE_ME` era aceito, e os
   * três campos coexistiam no record sem escolha determinística de qual
   * vence. A correção é PRECEDÊNCIA, não rejeição — este teste prova as duas
   * metades: (1) a chamada continua sendo ACEITA (rejeitar destruiria
   * informação legítima) e os três campos continuam LEGÍVEIS; (2)
   * `resolveWorkState` — e só ele — resolve o empate para BLOCKED.
   */
  it("os três sinais de trabalho juntos são aceitos e ficam legíveis; resolveWorkState resolve BLOCKED", async () => {
    await silencioso(() =>
      state({
        cwd: root,
        set: "s",
        next: "CONTINUE_ME",
        blocker: "BLOCKED_ME",
        decision: "DECIDE_ME",
      })
    );

    const c = await estadoAtual(root);
    expect(c?.next_action).toBe("CONTINUE_ME");
    expect(c?.blocker).toBe("BLOCKED_ME");
    expect(c?.decision_question).toBe("DECIDE_ME");
    expect(resolveWorkState(c)).toBe("BLOCKED");
    // negative control — se a precedência quebrar, isto pega o falso positivo.
    expect(resolveWorkState(c)).not.toBe("CONTINUE");
    expect(resolveWorkState(c)).not.toBe("HUMAN_DECISION_REQUIRED");
  });

  /**
   * DEFEITO 2 — `complete` ganha vocabulário e participa da mesma
   * precedência. `--complete` sozinho segue a MESMA higiene de escrita
   * parcial que `--next`/`--blocker`/`--decision` já tinham: limpa os outros
   * três campos velhos do snapshot anterior, para não ficarem stale.
   */
  it("`--complete` publica complete e resolve COMPLETE; sozinho limpa next_action velho", async () => {
    await silencioso(() => state({ cwd: root, set: "em andamento", next: "terminar X" }));
    await silencioso(() => state({ cwd: root, complete: "Master Entrypoint V1 fase A entregue" }));

    const c = await estadoAtual(root);
    expect(c?.complete).toBe("Master Entrypoint V1 fase A entregue");
    expect(c?.next_action).toBeUndefined();
    expect(resolveWorkState(c)).toBe("COMPLETE");
  });
});

/**
 * HERDADO != REVERIFICADO — a matriz de invalidação de `last_verified`.
 *
 * O defeito medido: `ev_01M16MY1SNAKXDY89GV9CBBW83` (gate `test`, árvore SUJA,
 * commit `1c7e029f`) atravessou 19 revisões de `project_state` pelo
 * `?? head?.content.last_verified` de `montarConteudo`, chegando a um head que
 * declarava trabalho concluído 34 commits adiante — e o SessionStart imprimia
 * aquele id como verificação corrente.
 *
 * Contrato provado aqui, uma linha por teste:
 *
 *   mudança semântica  +  sem `--verified`  ->  last_verified AUSENTE
 *   mudança semântica  +  `--verified ev_B` ->  ev_B
 *   só `--title`                            ->  PRESERVA
 *   só `--verified ev_B`                    ->  ev_B
 *
 * Mudança semântica = qualquer um de `--set`, `--goal`, `--next`,
 * `--blocker`, `--decision`, `--complete` explicitamente passado NESTA chamada.
 */
describe("nexos state · last_verified não é herdado por escrita semântica", () => {
  it("`--set` invalida a evidência herdada", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, set: "parser + testes" }));
    expect((await estadoAtual(root))?.last_verified).toBeUndefined();
  });

  it("`--next` invalida a evidência herdada", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, next: "tratar BOM2" }));
    expect((await estadoAtual(root))?.last_verified).toBeUndefined();
  });

  it("`--goal` invalida a evidência herdada", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, goal: "importador CSV até produção" }));
    expect((await estadoAtual(root))?.last_verified).toBeUndefined();
  });

  it("`--blocker` invalida a evidência herdada", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, blocker: "falta credencial" }));
    expect((await estadoAtual(root))?.last_verified).toBeUndefined();
  });

  it("`--decision` invalida a evidência herdada", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, decision: "Stripe ou gateway atual?" }));
    expect((await estadoAtual(root))?.last_verified).toBeUndefined();
  });

  it("`--complete` invalida a evidência herdada", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, complete: "FATIA 4 entregue" }));
    expect((await estadoAtual(root))?.last_verified).toBeUndefined();
  });

  /**
   * O negativo que dá sentido à matriz: se TUDO invalidasse, o campo seria
   * inútil. Renomear o snapshot não muda nada do que foi observado.
   */
  it("só `--title` PRESERVA — renomear não é mudança semântica", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, title: "Importador v2" }));

    const c = await estadoAtual(root);
    expect(c?.last_verified).toBe("ev_01AAAAAAAAAAAAAAAAAAAAAAAA");
    expect(c?.title).toBe("Importador v2");
    expect(c?.current_state).toBe("parser pronto");
  });

  it("mudança semântica COM `--verified` novo grava o novo — invalidação não é apagamento", async () => {
    await comEvidencia(root);
    await silencioso(() =>
      state({ cwd: root, set: "parser + testes", verified: "ev_01BBBBBBBBBBBBBBBBBBBBBBBB" })
    );
    expect((await estadoAtual(root))?.last_verified).toBe("ev_01BBBBBBBBBBBBBBBBBBBBBBBB");
  });

  it("só `--verified` (sem mudança semântica) repõe a evidência", async () => {
    await comEvidencia(root);
    await silencioso(() => state({ cwd: root, verified: "ev_01BBBBBBBBBBBBBBBBBBBBBBBB" }));

    const c = await estadoAtual(root);
    expect(c?.last_verified).toBe("ev_01BBBBBBBBBBBBBBBBBBBBBBBB");
    expect(c?.current_state).toBe("parser pronto");
    expect(c?.next_action).toBe("tratar BOM");
  });

  /**
   * `evidence_refs` é DERIVADO de `last_verified` (`state()`): invalidar um e
   * deixar o outro publicaria uma referência a uma observação que o próprio
   * snapshot já não afirma. `ABSENCE = FIELD ABSENT` — o campo some inteiro,
   * não vira array vazio.
   */
  it("evidence_refs some junto quando a evidência é invalidada, e volta quando é reposta", async () => {
    await comEvidencia(root);
    expect(await refsAtuais(root)).toEqual(["ev_01AAAAAAAAAAAAAAAAAAAAAAAA"]);

    await silencioso(() => state({ cwd: root, set: "parser + testes" }));
    expect(await refsAtuais(root)).toBeUndefined();

    await silencioso(() => state({ cwd: root, verified: "ev_01BBBBBBBBBBBBBBBBBBBBBBBB" }));
    expect(await refsAtuais(root)).toEqual(["ev_01BBBBBBBBBBBBBBBBBBBBBBBB"]);
  });
});

function gitQuieto(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf-8" }).trim();
}

/** Repo git real com um commit — devolve o HEAD de verdade (`rev-parse`, nao inventado). */
const commitReal = (raiz: string): string => {
  gitQuieto(["init", "-q", "."], raiz);
  gitQuieto(["config", "user.email", "t@t"], raiz);
  gitQuieto(["config", "user.name", "t"], raiz);
  gitQuieto(["add", "-A"], raiz);
  gitQuieto(["commit", "-qm", "base"], raiz);
  return gitQuieto(["rev-parse", "HEAD"], raiz);
};

/** Evidence válida por construção — mesmo shape de `evidence-verifier.test.ts`. */
const escreverEvidencia = async (raiz: string, over: Record<string, unknown> = {}): Promise<void> => {
  const finished = new Date().toISOString();
  const record = {
    id: "ev_01CCCCCCCCCCCCCCCCCCCCCCCC",
    kind: "command_observation",
    gate: "typecheck",
    command: "npm",
    args: ["run", "typecheck"],
    cwd: raiz,
    started_at: finished,
    finished_at: finished,
    exit_code: 0,
    observed_pass: true,
    tree_state: "clean",
    stdout_tail: "",
    stderr_tail: "",
    stdout_bytes: 0,
    stderr_bytes: 0,
    producer: "nexos-evidence-v1",
    ...over,
  };
  const dir = path.join(forProject(raiz).localRoot(), "evidence");
  await fs.ensureDir(dir);
  await fs.writeJson(path.join(dir, `${String(record.id)}.json`), record, { spaces: 2 });
};

describe("nexos state · AVISO de snapshot sem --verified com evidência para HEAD", () => {
  const FINISHED_AT = "2026-01-01T00:00:00.000Z";

  it("AC1 — sem `--verified`, com evidência do HEAD e árvore limpa, avisa em stderr e não altera o record", async () => {
    const head = commitReal(root);
    await escreverEvidencia(root, { commit: head, started_at: FINISHED_AT, finished_at: FINISHED_AT });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await state({ cwd: root, set: "parser pronto", next: "tratar BOM" });
      /** Asserção ANTES do restore — `mockRestore` zera `.mock.calls` (`mockReset` por baixo). */
      expect(erro).toHaveBeenCalledTimes(1);
      expect(erro.mock.calls[0]?.[0]).toBe(
        `AVISO: snapshot sem --verified — 1 evidência(s) para HEAD ${head.slice(0, 7)} · ` +
          `mais recente: ev_01CCCCCCCCCCCCCCCCCCCCCCCC (typecheck · ${FINISHED_AT} · exit 0)`
      );
    } finally {
      log.mockRestore();
      erro.mockRestore();
    }

    const c = await estadoAtual(root);
    expect(c?.last_verified).toBeUndefined();
    expect(await refsAtuais(root)).toBeUndefined();
  });

  it("AC2 — COM `--verified`, nenhuma linha de aviso é emitida", async () => {
    const head = commitReal(root);
    await escreverEvidencia(root, { commit: head });

    const log = vi.spyOn(console, "log").mockImplementation(() => {});
    const erro = vi.spyOn(console, "error").mockImplementation(() => {});
    try {
      await state({
        cwd: root,
        set: "parser pronto",
        next: "tratar BOM",
        verified: "ev_01CCCCCCCCCCCCCCCCCCCCCCCC",
      });
      expect(erro).not.toHaveBeenCalled();
    } finally {
      log.mockRestore();
      erro.mockRestore();
    }

    expect((await estadoAtual(root))?.last_verified).toBe("ev_01CCCCCCCCCCCCCCCCCCCCCCCC");
  });
});

describe("SELF-HOST · o estado atravessa o clone", () => {
  it("clone independente recupera onde paramos e a próxima ação", async () => {
    const g = (a: string[], cwd: string): void => {
      execFileSync("git", a, { cwd, stdio: "ignore" });
    };
    g(["init", "-q", "."], root);
    g(["config", "user.email", "t@t"], root);
    g(["config", "user.name", "t"], root);

    await silencioso(() =>
      state({
        cwd: root,
        set: "reader e assembler entregues",
        next: "publicar o estado do proprio repo",
        title: "NexOS kernel",
      })
    );

    g(["add", "-A"], root);
    g(["commit", "-qm", "estado"], root);

    const clone = path.join(ws, "clone");
    execFileSync("git", ["clone", "-q", root, clone], { stdio: "ignore" });

    /** O `memory/` legado nem existe aqui: o estado vem do record. */
    expect(await fs.pathExists(path.join(clone, ".nexos", "memory"))).toBe(false);

    const c = await estadoAtual(clone);
    expect(c?.current_state).toBe("reader e assembler entregues");
    expect(c?.next_action).toBe("publicar o estado do proprio repo");

    /** E chega ao modelo pelo brief, não por leitura de arquivo. */
    const brief = await buildSessionBriefForCwd({ cwd: clone });
    const item = brief.brief.knowledge?.items[0];
    expect(item?.source_ref).toBe(SOURCE_REF);
    expect(item?.fields.next_action).toBe("publicar o estado do proprio repo");
  });
});

/**
 * SEGUNDA EXCEÇÃO (2026-09-05) — `ProjectStateSchema.supersedes` gated por
 * `content.reconciliation` (`schemas.ts`), e `nexos state-reconcile`
 * (`commands/state.ts`) como ÚNICO emitter.
 *
 *   SUPERSEDES IS ARRAY ⟺ RECONCILIATION IS PRESENT
 *
 * As seis primeiras provas são de SCHEMA puro (`CapsuleRecordSchema.safeParse`
 * direto, sem tocar disco) — o contrato pedido inclui `outra kind com array →
 * rejeitada`, que não tem caminho de escrita real (nenhum comando emite
 * `gotcha` com array) e só é observável no schema.
 */
describe("ProjectStateSchema · supersedes gated por reconciliation", () => {
  const base = () =>
    makeProjectState({
      supersedes: undefined,
      content: { title: "t", current_state: "s", next_action: "n" },
    });

  it("string sem reconciliation continua válido — não-regressão", () => {
    const r = CapsuleRecordSchema.safeParse({ ...base(), supersedes: base().id });
    expect(r.success).toBe(true);
  });

  it("array COM reconciliation é válido", () => {
    const rec = base();
    const parent = base();
    const r = CapsuleRecordSchema.safeParse({
      ...rec,
      supersedes: [parent.id, rec.id].sort(),
      content: {
        ...rec.content,
        reconciliation: { reason: "reconcilia duas linhagens", actor_ref: "human:test" },
      },
    });
    expect(r.success).toBe(true);
  });

  it("array SEM reconciliation é rejeitado", () => {
    const rec = base();
    const parent = base();
    const r = CapsuleRecordSchema.safeParse({ ...rec, supersedes: [parent.id, rec.id].sort() });
    expect(r.success).toBe(false);
  });

  it("reconciliation SEM array é rejeitado", () => {
    const rec = base();
    const r = CapsuleRecordSchema.safeParse({
      ...rec,
      supersedes: rec.id,
      content: {
        ...rec.content,
        reconciliation: { reason: "x", actor_ref: "human:test" },
      },
    });
    expect(r.success).toBe(false);
  });

  it("array desordenado ou duplicado é rejeitado — CANONICAL_SET", () => {
    const rec = base();
    const parent = base();
    const [a, b] = [parent.id, rec.id].sort();
    const content = {
      ...rec.content,
      reconciliation: { reason: "x", actor_ref: "human:test" },
    };
    expect(CapsuleRecordSchema.safeParse({ ...rec, supersedes: [b!, a!], content }).success).toBe(false);
    expect(CapsuleRecordSchema.safeParse({ ...rec, supersedes: [a!, a!], content }).success).toBe(false);
  });

  it("outra kind de KnowledgeRecord com array é rejeitada — exceção é do kind, não da family", () => {
    const parentA = base();
    const parentB = base();
    const r = CapsuleRecordSchema.safeParse({
      ...base(),
      kind: "gotcha",
      supersedes: [parentA.id, parentB.id].sort(),
      content: { title: "t", rule: "x" },
    });
    expect(r.success).toBe(false);
  });
});

/**
 * `nexos state-reconcile` — o ÚNICO emitter de `supersedes: string[]`.
 *
 * `REAL CANONICAL STORE != SCRATCH SPACE`: tudo em capsule isolada, mesma
 * disciplina do resto do arquivo.
 */
describe("nexos state-reconcile · recovery de Store DIVERGED", () => {
  async function projectId(): Promise<string> {
    const issues: IntegrityIssue[] = [];
    const id = await readManifestProjectId(forProject(root).manifest(), issues);
    if (typeof id !== "string") throw new Error("manifest ilegível na fixture de teste");
    return id;
  }

  /** Duas linhagens legítimas, mesmo `source_ref`, sem `supersedes` entre elas — DIVERGED por construção. */
  async function divergir(): Promise<{ headA: string; headB: string }> {
    const pid = await projectId();
    const a = makeProjectState({
      project_id: pid,
      content: { title: "canônica", current_state: "linhagem A", next_action: "seguir A" },
    });
    const b = makeProjectState({
      project_id: pid,
      content: { title: "histórica", current_state: "linhagem B", next_action: "seguir B" },
    });
    await publishCanonical(root, a);
    await publishCanonical(root, b);
    return { headA: a.id, headB: b.id };
  }

  it("recusa sem `--reason`", async () => {
    await divergir();
    await silencioso(() =>
      stateReconcile({ cwd: root, actor: "human:test", set: "x", next: "y" })
    );
    expect(await estadoAtual(root)).toBeUndefined(); // partição segue DIVERGED, nada mudou
  });

  it("recusa sem `--actor`", async () => {
    await divergir();
    await silencioso(() =>
      stateReconcile({ cwd: root, reason: "porque sim", set: "x", next: "y" })
    );
    expect(await estadoAtual(root)).toBeUndefined();
  });

  /**
   * CONTRAFACTUAL do contrato — partição `{A,B}` publica R multi-parent;
   * `headFor` (via `readCurrentRecords`) devolve CURRENT com R, e A/B deixam
   * de ser heads (não aparecem mais em `anomalies`, nem como record solto).
   */
  it("reconcilia `{A,B}`: publica R que supersede os dois, e a leitura vira CURRENT", async () => {
    const { headA, headB } = await divergir();

    const pre = await readCurrentRecords(root, { kind: "project_state" });
    expect(pre.ok).toBe(true);
    if (!pre.ok) return;
    expect(pre.records).toHaveLength(0);
    expect(pre.anomalies).toHaveLength(1);
    expect(pre.anomalies[0]!.state).toBe("DIVERGED");

    await silencioso(() =>
      stateReconcile({
        cwd: root,
        reason: "reconcilia linhagem canônica (166) e histórica (213), nenhuma depreciada",
        actor: "human:test",
        set: "reconciliado",
        next: "canonicalizar recovery -> main",
      })
    );

    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anomalies).toEqual([]);
    expect(r.records).toHaveLength(1);

    const head = r.records[0]!.record;
    expect((head as { supersedes?: string[] }).supersedes).toEqual([headA, headB].sort());
    expect(contentOf(head).current_state).toBe("reconciliado");
    expect(contentOf(head).next_action).toBe("canonicalizar recovery -> main");
    /** `contentOf` só extrai campos STRING — `reconciliation` é objeto, lido cru. */
    const reconciliation = (
      head as { content?: { reconciliation?: { reason: string; actor_ref: string } } }
    ).content?.reconciliation;
    expect(reconciliation?.actor_ref).toBe("human:test");
    expect(reconciliation?.reason).toContain("reconcilia linhagem canônica");
  });

  it("recusa quando a partição está CURRENT — reconciliar sem divergência é erro, não no-op", async () => {
    await silencioso(() => state({ cwd: root, set: "único head", next: "seguir" }));

    await silencioso(() =>
      stateReconcile({
        cwd: root,
        reason: "não deveria rodar",
        actor: "human:test",
        set: "outro",
        next: "outro next",
      })
    );

    const c = await estadoAtual(root);
    expect(c?.current_state).toBe("único head"); // Store intocado — recusa, não no-op
    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok && r.records).toHaveLength(1);
  });
});
