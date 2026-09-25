/**
 * MEM-DEPRECATE + MEM-CORRECT — sair de circulação sem apagar, e corrigir sem
 * que a versão velha volte.
 *
 *   DEPRECATED != DELETED
 *   OUT OF CIRCULATION != OUT OF DISK
 *   CURRENT KNOWLEDGE != LINEAGE HEAD
 *
 * Sem o contrafactual POSITIVO ("o record NÃO depreciado segue aparecendo"),
 * um filtro que apagasse tudo passaria por correto. Sem o de linhagem, uma
 * depreciação que quebra a próxima escrita (DIVERGED) passaria despercebida até
 * alguém perder o Store inteiro de vista.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { buildSessionBriefForCwd } from "../src/lib/bootstrap-context.js";
import { memory } from "../src/commands/memory.js";
import { gotcha } from "../src/commands/gotcha.js";
import { state } from "../src/commands/state.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
const NOW = "2026-08-28T12:00:00.000Z";

let root: string;
let projectId: string;
let idErrado: string;
let idCerto: string;

/**
 * DOIS canais, nao um: `memory` escreve por clack (`process.stdout.write` cru),
 * `gotcha`/`state` por `console.log` — e o vitest INTERCEPTA `console.log`
 * antes de ele chegar ao `process.stdout`. Espionar so o stream devolvia `""`
 * para os dois ultimos e um assert de saida passaria por vazio.
 */
function captureStdout(): { text: () => string; restore: () => void } {
  let out = "";
  const stream = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  const log = vi.spyOn(console, "log").mockImplementation((...args: unknown[]) => {
    out += `${args.map((a) => (typeof a === "string" ? a : String(a))).join(" ")}\n`;
  });
  return {
    text: () => out,
    restore: () => {
      stream.mockRestore();
      log.mockRestore();
    },
  };
}

async function comSaida(fn: () => Promise<void>): Promise<string> {
  const cap = captureStdout();
  try {
    await fn();
    return cap.text();
  } finally {
    cap.restore();
  }
}

function rec(sourceRef: string, content: Record<string, string>): CapsuleRecord {
  return {
    schema_version: 1,
    id: newRecordId("KnowledgeRecord"),
    project_id: projectId,
    family: "KnowledgeRecord",
    kind: "gotcha",
    scope: "project",
    origin: "migration",
    provenance: { source_ref: sourceRef, producer_id: "produtor-de-teste", submitted_at: NOW },
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

/** Arquivos de record no disco — a prova de que append-only não foi violado. */
async function arquivosDeRecord(): Promise<string[]> {
  const dir = path.join(root, ".nexos", "records", "knowledge");
  return (await fs.readdir(dir)).sort();
}

async function idsCorrentes(): Promise<string[]> {
  const r = await readCurrentRecords(root, { kind: "gotcha" });
  if (!r.ok) throw new Error("store ilegível");
  return r.records.map((x) => x.record.id).sort();
}

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "mem-deprecate-"));
  projectId = (await initializeCapsule(root, { projectName: "projeto-deprecate" })).projectId;

  const errado = rec("nexos://gotcha/timeout-lambda", {
    title: "o timeout de lambda e de 900 segundos",
    rule: "o timeout maximo de uma lambda e de 900 segundos por invocacao",
    evidence: "medido em 2026-01-01",
  });
  const certo = rec("nexos://gotcha/awk-nul", {
    title: "awk do macOS trunca em byte NUL",
    rule: "awk do macOS trunca a linha no primeiro byte NUL sem avisar",
    evidence: "medido em 2026-08-14",
  });
  await publishCanonical(root, errado);
  await publishCanonical(root, certo);
  idErrado = errado.id;
  idCerto = certo.id;
});

afterEach(async () => {
  await fs.remove(root);
  vi.restoreAllMocks();
});

describe("MEM-DEPRECATE", () => {
  it("tira o record dos correntes, da busca e do brief — e mantem o arquivo no disco", async () => {
    const antesArquivos = await arquivosDeRecord();
    expect(await idsCorrentes()).toContain(idErrado);

    const buscaAntes = await comSaida(() => memory({ cwd: root, search: "timeout lambda" }));
    expect(buscaAntes).toContain("timeout");

    const saida = await comSaida(() =>
      memory({
        cwd: root,
        deprecate: idErrado,
        why: "o numero esta errado: o teto e por invocacao, nao por conta",
        by: "human:steve",
      })
    );
    expect(saida).toContain("depreciado");

    /** 1 — sai dos correntes. */
    expect(await idsCorrentes()).not.toContain(idErrado);

    /** 1 — sai da busca. */
    const buscaDepois = await comSaida(() => memory({ cwd: root, search: "timeout lambda" }));
    expect(buscaDepois).not.toContain("timeout maximo de uma lambda");

    /** 1 — sai do brief de sessao. */
    const brief = await buildSessionBriefForCwd({ cwd: root, intent: "timeout lambda" });
    expect(brief.serialized).not.toContain("timeout maximo de uma lambda");

    /** 2 — APPEND-ONLY: nenhum arquivo sumiu, e um novo apareceu. */
    const depoisArquivos = await arquivosDeRecord();
    for (const f of antesArquivos) expect(depoisArquivos).toContain(f);
    expect(depoisArquivos.length).toBe(antesArquivos.length + 1);
    expect(depoisArquivos).toContain(`${idErrado}.yaml`);
  });

  it("o record NAO depreciado segue corrente, na busca e no brief", async () => {
    await comSaida(() =>
      memory({ cwd: root, deprecate: idErrado, why: "numero errado" })
    );

    /** 3 — o positivo: sem isto, "some tudo" passaria por correto. */
    expect(await idsCorrentes()).toEqual([idCerto]);

    const busca = await comSaida(() => memory({ cwd: root, search: "awk NUL" }));
    expect(busca).toContain("awk");

    const brief = await buildSessionBriefForCwd({ cwd: root, intent: "awk NUL" });
    expect(brief.serialized).toContain("awk");
  });

  it("a depreciacao carrega quem, quando e por que — e a linhagem continua navegavel", async () => {
    await comSaida(() =>
      memory({
        cwd: root,
        deprecate: idErrado,
        why: "o teto e por invocacao, nao por conta",
        by: "human:steve",
      })
    );

    const r = await readCurrentRecords(root, { kind: "gotcha", includeDeprecated: true });
    if (!r.ok) throw new Error("store ilegível");
    const marcador = r.records.find((x) => x.sourceRef === "nexos://gotcha/timeout-lambda");
    expect(marcador).toBeDefined();

    /** 4 — quem / quando / por que. */
    const rec = marcador!.record as unknown as {
      deprecation?: { reason: string; actor_ref: string };
      created_at: string;
      supersedes?: string;
      provenance: { producer_id: string };
    };
    expect(rec.deprecation?.reason).toBe("o teto e por invocacao, nao por conta");
    expect(rec.deprecation?.actor_ref).toBe("human:steve");
    expect(rec.created_at).not.toBe(NOW);
    expect(rec.provenance.producer_id).toBe("nexos-memory-deprecate");

    /** 2 — a linhagem aponta para o depreciado, e o arquivo dele esta la. */
    expect(rec.supersedes).toBe(idErrado);
    const noDisco = await fs.readFile(
      path.join(root, ".nexos", "records", "knowledge", `${idErrado}.yaml`),
      "utf-8"
    );
    expect(noDisco).toContain("timeout maximo de uma lambda");
  });

  it("recusa depreciar sem motivo, e nada e escrito", async () => {
    const antes = await arquivosDeRecord();
    const saida = await comSaida(() => memory({ cwd: root, deprecate: idErrado }));
    expect(saida).toContain("--why");
    expect(await arquivosDeRecord()).toEqual(antes);
    expect(await idsCorrentes()).toContain(idErrado);
    process.exitCode = 0;
  });

  it("5 — leitura pura: buscar e ler correntes nao escrevem nada", async () => {
    const antes = await arquivosDeRecord();
    await comSaida(() => memory({ cwd: root, search: "lambda" }));
    await comSaida(() => memory({ cwd: root }));
    await readCurrentRecords(root);
    await buildSessionBriefForCwd({ cwd: root, intent: "lambda" });
    expect(await arquivosDeRecord()).toEqual(antes);
  });

  /**
   * O risco que a propria depreciacao cria: se o ESCRITOR deixasse de enxergar
   * o head depreciado, a proxima escrita naquele `source_ref` nasceria sem pai
   * — dois heads nao referenciados, DIVERGED, e a particao inteira sairia de
   * `records`. `CURRENT KNOWLEDGE != LINEAGE HEAD`.
   */
  it("depois de depreciar, a proxima escrita na mesma fonte supersede em vez de divergir", async () => {
    await comSaida(() =>
      memory({ cwd: root, deprecate: idErrado, why: "numero errado" })
    );

    await comSaida(() =>
      gotcha({
        cwd: root,
        title: "o teto de lambda e por invocacao",
        rule: "o teto de 900s vale por invocacao",
        sourceRef: "nexos://gotcha/timeout-lambda",
        /** A escrita passou a EXIGIR a porta explicita — ver MEM-REOPEN, abaixo. */
        reopen: true,
      })
    );

    const r = await readCurrentRecords(root, { kind: "gotcha", includeDeprecated: true });
    if (!r.ok) throw new Error("store ilegível");
    expect(r.anomalies).toEqual([]);
    const head = r.records.filter((x) => x.sourceRef === "nexos://gotcha/timeout-lambda");
    expect(head).toHaveLength(1);
    expect((head[0]!.record as unknown as { supersedes?: string }).supersedes).toBeDefined();
  });
});

/**
 * MEM-REOPEN — ressuscitar uma linhagem depreciada e legitimo; ressuscitar em
 * SILENCIO nao.
 *
 *   REVIVING A LINEAGE != SILENTLY REVIVING A LINEAGE
 *   HOT PATH REFUSAL != FREE REFUSAL
 *
 * O defeito medido em 38b4b46: `nexos gotcha` no `source_ref` de uma linhagem
 * depreciada devolvia `heads correntes: 1, deprecation: undefined, anomalias:
 * 0` — corrente de novo, motivo antigo morto, ninguem avisado.
 *
 * Sem o contrafactual POSITIVO (linhagem VIVA segue publicando sem atrito),
 * "avisa sempre" passaria por correto.
 */
describe("MEM-REOPEN", () => {
  /** Head (possivelmente depreciado) de um `source_ref` de gotcha. */
  async function headDe(sourceRef: string) {
    const r = await readCurrentRecords(root, { kind: "gotcha", includeDeprecated: true });
    if (!r.ok) throw new Error("store ilegível");
    return r.records.find((x) => x.sourceRef === sourceRef);
  }

  async function headDeEstado() {
    const r = await readCurrentRecords(root, { kind: "project_state", includeDeprecated: true });
    if (!r.ok) throw new Error("store ilegível");
    return r.records.find((x) => x.sourceRef === "nexos://project-state");
  }

  it("1 — gotcha sobre linhagem DEPRECIADA e barrado, com o motivo antigo na cara, e nada e escrito", async () => {
    await comSaida(() =>
      memory({ cwd: root, deprecate: idErrado, why: "o teto e por invocacao, nao por conta", by: "human:steve" })
    );
    const antes = await arquivosDeRecord();

    const saida = await comSaida(() =>
      gotcha({
        cwd: root,
        title: "o teto de lambda e por invocacao",
        rule: "o teto de 900s vale por invocacao",
        sourceRef: "nexos://gotcha/timeout-lambda",
      })
    );

    expect(saida).toContain("DEPRECIADA");
    /** O motivo antigo aparece para quem foi barrado — nao so o fato de estar barrado. */
    expect(saida).toContain("o teto e por invocacao, nao por conta");
    expect(saida).toContain("human:steve");
    expect(saida).toContain("--reopen");

    /** FAIL CLOSED: nenhum arquivo novo, e a linhagem segue fora dos correntes. */
    expect(await arquivosDeRecord()).toEqual(antes);
    expect(await idsCorrentes()).toEqual([idCerto]);
    process.exitCode = 0;
  });

  it("2 — o POSITIVO: linhagem VIVA publica sem atrito, e --reopen sobre ela e recusado", async () => {
    const saida = await comSaida(() =>
      gotcha({
        cwd: root,
        title: "awk do macOS trunca em byte NUL",
        rule: "awk do macOS trunca a linha no primeiro byte NUL, sem aviso nenhum",
        sourceRef: "nexos://gotcha/awk-nul",
      })
    );
    expect(saida).toContain("gotcha publicado");
    expect(saida).not.toContain("DEPRECIADA");

    const head = await headDe("nexos://gotcha/awk-nul");
    expect((head!.record as unknown as { reopens?: unknown }).reopens).toBeUndefined();

    /** A flag nao pode ser inocua fora da reabertura: passa-la por habito reabriria o silencio. */
    const antes = await arquivosDeRecord();
    const recusa = await comSaida(() =>
      gotcha({
        cwd: root,
        title: "awk do macOS trunca em byte NUL",
        rule: "mais uma versao",
        sourceRef: "nexos://gotcha/awk-nul",
        reopen: true,
      })
    );
    expect(recusa).toContain("nao esta depreciada");
    expect(await arquivosDeRecord()).toEqual(antes);
    process.exitCode = 0;
  });

  it("3 — reabertura deliberada FICA REGISTRADA, com o motivo antigo recuperavel do proprio record", async () => {
    await comSaida(() =>
      memory({ cwd: root, deprecate: idErrado, why: "o teto e por invocacao, nao por conta", by: "human:steve" })
    );

    const saida = await comSaida(() =>
      gotcha({
        cwd: root,
        title: "o teto de lambda e por invocacao",
        rule: "o teto de 900s vale por invocacao",
        sourceRef: "nexos://gotcha/timeout-lambda",
        reopen: true,
      })
    );
    expect(saida).toContain("reaberta");

    const head = await headDe("nexos://gotcha/timeout-lambda");
    const rec = head!.record as unknown as {
      reopens?: { reason: string; actor_ref: string };
      deprecation?: unknown;
    };

    /** O record DIZ que houve reabertura, e carrega o motivo antigo — sem caminhar por `supersedes`. */
    expect(rec.reopens?.reason).toBe("o teto e por invocacao, nao por conta");
    expect(rec.reopens?.actor_ref).toBe("human:steve");
    /** E volta a ser CORRENTE: reabrir e legitimo, o defeito era o silencio. */
    expect(rec.deprecation).toBeUndefined();
    expect(await idsCorrentes()).toContain(head!.record.id);
  });

  it("4 — state sobre linhagem DEPRECIADA AVISA e publica: recusar no caminho quente perderia o snapshot", async () => {
    await comSaida(() => state({ cwd: root, set: "primeiro snapshot", next: "seguir" }));
    const alvo = (await headDeEstado())!.record.id;
    await comSaida(() => memory({ cwd: root, deprecate: alvo, why: "snapshot fabricado por engano", by: "human:steve" }));
    expect(await headDeEstado()).toBeDefined();

    const saida = await comSaida(() => state({ cwd: root, set: "sessao real de hoje", next: "publicar" }));

    /** Avisa, com o motivo antigo — o oposto do silencio medido. */
    expect(saida).toContain("DEPRECIADA");
    expect(saida).toContain("snapshot fabricado por engano");
    expect(saida).toContain("human:steve");
    /** E NAO perde o snapshot: o caminho quente publica. */
    expect(saida).toContain("estado publicado");

    const head = (await headDeEstado())!.record as unknown as {
      reopens?: { reason: string; actor_ref: string };
      content: Record<string, string>;
    };
    expect(head.content["current_state"]).toBe("sessao real de hoje");
    expect(head.reopens?.reason).toBe("snapshot fabricado por engano");
    expect(head.reopens?.actor_ref).toBe("human:steve");

    /** O positivo do caminho quente: sem depreciacao, nenhum aviso e nenhum `reopens`. */
    const limpo = await comSaida(() => state({ cwd: root, set: "sessao seguinte", next: "continuar" }));
    expect(limpo).not.toContain("DEPRECIADA");
    expect((await headDeEstado())!.record as unknown as { reopens?: unknown }).not.toHaveProperty("reopens");
  });

  /**
   * O TESTE QUE NAO PODE FALTAR. A checagem nova le o head com
   * `includeDeprecated: true` — a MESMA leitura que resolve o pai de
   * `supersedes`. Se ela tivesse sido escrita com a leitura de correntes, o
   * portao veria "sem head" e a escrita nasceria orfa: dois heads nao
   * referenciados, DIVERGED, particao inteira fora de `records` (o defeito que
   * 088cfcf fechou). `CURRENT KNOWLEDGE != LINEAGE HEAD`.
   */
  it("5 — depois da reabertura, escrever de novo na mesma fonte NAO produz dois heads", async () => {
    await comSaida(() => memory({ cwd: root, deprecate: idErrado, why: "numero errado" }));

    await comSaida(() =>
      gotcha({
        cwd: root,
        title: "o teto de lambda e por invocacao",
        rule: "o teto de 900s vale por invocacao",
        sourceRef: "nexos://gotcha/timeout-lambda",
        reopen: true,
      })
    );
    /** Segunda escrita: a linhagem ja esta VIVA de novo, entao sem --reopen. */
    await comSaida(() =>
      gotcha({
        cwd: root,
        title: "o teto de lambda e por invocacao",
        rule: "900s por invocacao, confirmado nas docs",
        sourceRef: "nexos://gotcha/timeout-lambda",
      })
    );

    for (const incluirDepreciadas of [true, false]) {
      const r = await readCurrentRecords(root, {
        kind: "gotcha",
        includeDeprecated: incluirDepreciadas,
      });
      if (!r.ok) throw new Error("store ilegível");
      expect(r.anomalies).toEqual([]);
      expect(r.records.filter((x) => x.sourceRef === "nexos://gotcha/timeout-lambda")).toHaveLength(1);
    }
  });

  /** O mesmo, no caminho quente: reabrir por `state` nao pode divergir a particao de estado. */
  it("5b — state reaberto segue com um head so e zero anomalias", async () => {
    await comSaida(() => state({ cwd: root, set: "primeiro", next: "seguir" }));
    const alvo = (await headDeEstado())!.record.id;
    await comSaida(() => memory({ cwd: root, deprecate: alvo, why: "engano" }));

    await comSaida(() => state({ cwd: root, set: "reaberto", next: "seguir" }));
    await comSaida(() => state({ cwd: root, set: "depois da reabertura", next: "seguir" }));

    const r = await readCurrentRecords(root, { kind: "project_state", includeDeprecated: true });
    if (!r.ok) throw new Error("store ilegível");
    expect(r.anomalies).toEqual([]);
    expect(r.records.filter((x) => x.sourceRef === "nexos://project-state")).toHaveLength(1);
  });
});

describe("MEM-CORRECT", () => {
  it("6 — corrige o fato e a versao velha NAO volta como atual", async () => {
    const antes = await arquivosDeRecord();

    const saida = await comSaida(() =>
      memory({
        cwd: root,
        correct: idErrado,
        fact: "o teto de 900s de lambda e por INVOCACAO",
        evidence: "docs da AWS, lidas em 2026-08-28",
      })
    );
    expect(saida).toContain("corrigido");

    const r = await readCurrentRecords(root, { kind: "gotcha" });
    if (!r.ok) throw new Error("store ilegível");
    const head = r.records.filter((x) => x.sourceRef === "nexos://gotcha/timeout-lambda");
    expect(head).toHaveLength(1);
    expect(head[0]!.record.id).not.toBe(idErrado);

    const c = (head[0]!.record as unknown as { content: Record<string, string> }).content;
    expect(c["rule"]).toBe("o teto de 900s de lambda e por INVOCACAO");
    expect(c["evidence"]).toBe("docs da AWS, lidas em 2026-08-28");
    /** Titulo ESCRITO a mao (nao e copia do fato) fica intacto. */
    expect(c["title"]).toBe("o timeout de lambda e de 900 segundos");

    /** A velha nao volta: nem como corrente, nem na busca. */
    expect(await idsCorrentes()).not.toContain(idErrado);
    const busca = await comSaida(() => memory({ cwd: root, search: "timeout lambda" }));
    expect(busca).not.toContain("por invocacao, nao por conta");
    expect(busca).toContain("INVOCACAO");

    /** Append-only intacto: o arquivo velho continua la. */
    const depois = await arquivosDeRecord();
    for (const f of antes) expect(depois).toContain(f);
  });

  it("recusa corrigir uma linhagem depreciada — ressuscitar nao e corrigir", async () => {
    await comSaida(() => memory({ cwd: root, deprecate: idErrado, why: "numero errado" }));

    const r = await readCurrentRecords(root, { kind: "gotcha", includeDeprecated: true });
    if (!r.ok) throw new Error("store ilegível");
    const marcador = r.records.find((x) => x.sourceRef === "nexos://gotcha/timeout-lambda")!;

    const saida = await comSaida(() =>
      memory({ cwd: root, correct: marcador.record.id, fact: "qualquer coisa" })
    );
    expect(saida).toContain("DEPRECIADA");
    expect(await idsCorrentes()).toEqual([idCerto]);
    process.exitCode = 0;
  });

  it("recusa corrigir um record que nao e head — superseder um pai ja superseded produz DIVERGED", async () => {
    await comSaida(() =>
      memory({ cwd: root, correct: idErrado, fact: "o teto e por invocacao" })
    );

    const saida = await comSaida(() =>
      memory({ cwd: root, correct: idErrado, fact: "terceira versao" })
    );
    expect(saida).toContain("não é head");

    const r = await readCurrentRecords(root, { kind: "gotcha" });
    if (!r.ok) throw new Error("store ilegível");
    expect(r.anomalies).toEqual([]);
    process.exitCode = 0;
  });
});

/**
 * `promoteToRecord` copia o fato para mais de um campo (`title` recebe
 * `fato.slice(0,120)`). Sem levar os DERIVADOS junto, o `--search` seguiria
 * exibindo a versao errada no titulo e a certa no corpo.
 *
 *   HALF-CORRECTED RECORD STILL SHOWS THE WRONG CLAIM
 */
describe("MEM-CORRECT — campos derivados do fato", () => {
  it("leva junto o campo que era COPIA do fato, e nao toca no escrito a mao", async () => {
    const derivado = rec("nexos://gotcha/derivado", {
      title: "o cache expira em 30 segundos",
      rule: "o cache expira em 30 segundos",
      cause: "default do cliente http",
      evidence: "medido em 2026-02-02",
    });
    await publishCanonical(root, derivado);

    await comSaida(() =>
      memory({ cwd: root, correct: derivado.id, fact: "o cache expira em 300 segundos" })
    );

    const r = await readCurrentRecords(root, { kind: "gotcha" });
    if (!r.ok) throw new Error("store ilegível");
    const head = r.records.find((x) => x.sourceRef === "nexos://gotcha/derivado")!;
    const c = (head.record as unknown as { content: Record<string, string> }).content;

    expect(c["rule"]).toBe("o cache expira em 300 segundos");
    /** Era copia literal do fato — acompanha. */
    expect(c["title"]).toBe("o cache expira em 300 segundos");
    /** Nao era copia — intacto. */
    expect(c["cause"]).toBe("default do cliente http");

    const busca = await comSaida(() => memory({ cwd: root, search: "cache expira" }));
    expect(busca).not.toContain("30 segundos");
    expect(busca).toContain("300 segundos");
  });
});
