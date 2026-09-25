/**
 * `nexos gotcha` — armadilha registrada como record CANÔNICO.
 *
 * Mesmo padrão de `tests/project-state.test.ts`: capsule ISOLADA em tmpdir,
 * `init({cwd, registerGlobally: false})`, console silenciado.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { init } from "../src/commands/init.js";
import { gotcha } from "../src/commands/gotcha.js";
import { state } from "../src/commands/state.js";
import { readCurrentRecords, contentOf } from "../src/lib/capsule/reader.js";
import { assembleContext } from "../src/lib/context-assembler.js";
import { evidenceRefsExternas } from "../src/lib/capsule/schemas.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;

const silencioso = <T>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => vi.restoreAllMocks());
};

const gotchasAtuais = async (raiz: string) => readCurrentRecords(raiz, { kind: "gotcha" });

const admissionOf = (r: CapsuleRecord): { approved_by?: string } =>
  (r as unknown as { admission: { approved_by?: string } }).admission;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "gt-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  await silencioso(() => init({ cwd: root, registerGlobally: false }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

describe("nexos gotcha · escrita canônica", () => {
  it("A: record válido é aceito e lido de volta", async () => {
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "grep exit 1 nao e ausencia no arquivo",
        rule: "GREP EXIT 1 != AUSENCIA NO ARQUIVO",
        cause: "grep retorna 1 tambem em erro de leitura",
        /**
         * A regra nova (`--cause` exige `--evidence`) barrou este teste, que
         * afirmava causa sem medicao nenhuma — o defeito em miniatura. MEDIDO
         * em darwin 25.5.0: `grep nada arquivo` sem match sai 1; `grep nada
         * /caminho/inexistente` sai 2; `grep nada diretorio/` sai 1.
         */
        evidence: "medido em darwin 25.5.0: sem match sai 1, arquivo ausente sai 2, diretorio sai 1",
      })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(1);
    const c = contentOf(r.records[0]!.record);
    expect(c.title).toBe("grep exit 1 nao e ausencia no arquivo");
    expect(c.rule).toBe("GREP EXIT 1 != AUSENCIA NO ARQUIVO");
  });

  it("B: título sem nenhum dos 7 campos do refine — nada escrito (RED)", async () => {
    await silencioso(() => gotcha({ cwd: root, title: "so titulo, sem substancia" }));
    const r = await gotchasAtuais(root);
    expect(r.ok && r.records).toHaveLength(0);
  });

  it("B2: sem --title, nem tenta escrever (nao chega a ler o manifest)", async () => {
    /**
     * Manifest corrompido (chave duplicada — CANONICAL_PARSE usa uniqueKeys:
     * true) faria QUALQUER leitura de manifest lançar. Se `gotcha({cwd: root})`
     * sem título retornar sem lançar, é porque o `--title` obrigatório barrou
     * antes de chegar lá.
     */
    await fs.writeFile(
      path.join(root, ".nexos", "manifest.yaml"),
      "schema_version: 1\nschema_version: 1\n",
      "utf-8"
    );
    await expect(silencioso(() => gotcha({ cwd: root }))).resolves.toBeUndefined();
  });

  it("C: sourceRef vazio — schema recusa (min(1)), nada escrito", async () => {
    await silencioso(() =>
      gotcha({ cwd: root, title: "titulo valido", rule: "regra valida", sourceRef: "" })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok && r.records).toHaveLength(0);
  });

  it("D/G: duas escritas ao mesmo título — segunda SUPERSEDE, um head só, sem anomalia", async () => {
    await silencioso(() => gotcha({ cwd: root, title: "titulo repetido", rule: "regra 1" }));
    await silencioso(() => gotcha({ cwd: root, title: "titulo repetido", rule: "regra 2" }));

    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anomalies).toEqual([]);
    expect(r.records).toHaveLength(1);
    expect(contentOf(r.records[0]!.record).rule).toBe("regra 2");
  });

  it("E: markdown legado em .nexos/memory/project/gotchas.md não vira record canônico", async () => {
    const memDir = path.join(root, ".nexos", "memory", "project");
    await fs.ensureDir(memDir);
    await fs.writeFile(path.join(memDir, "gotchas.md"), "# Gotchas\n\n- algo encontrado\n", "utf-8");

    const r = await gotchasAtuais(root);
    expect(r.ok && r.records).toHaveLength(0);
  });

  it("F: default de approved_by casa /^policy:/", async () => {
    await silencioso(() => gotcha({ cwd: root, title: "default de admissao", rule: "regra" }));
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(admissionOf(r.records[0]!.record).approved_by).toMatch(/^policy:/);
  });

  it("F2 (STORE AUTHORITY BOUNDARY V1): approved_by NUNCA é fornecido pelo caller — mesmo tentando, o valor é ignorado", async () => {
    /**
     * `GotchaOptions` não tem mais `approvedBy` (removido nesta fatia — era
     * uma flag pública que produzia `admission.approved_by: human:<qualquer
     * coisa>` sem nenhum humano envolvido). O cast simula um chamador que
     * tenta contornar o tipo (ex.: JS puro, ou reintrodução futura por
     * engano) — a prova real é que o RUNTIME ignora o campo, não só o tipo.
     */
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "admissao humana",
        rule: "regra",
        ...({ approvedBy: "human:steve" } as unknown as Record<string, never>),
      })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(admissionOf(r.records[0]!.record).approved_by).toBe("policy:nexos-gotcha");
  });

  it("F3 (STORE AUTHORITY BOUNDARY V1): --source-ref fora do namespace nexos://gotcha/ é recusado — FAIL CLOSED, nada escrito", async () => {
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "tentativa de forjar o head de outro produtor",
        rule: "regra",
        sourceRef: "nexos://project-state",
      })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(0);

    /** A partição de `nexos://project-state` continua INTACTA — nunca chega a ser reivindicada pelo forjado. */
    const projectState = await readCurrentRecords(root, { kind: "project_state" });
    expect(projectState.ok).toBe(true);
    if (!projectState.ok) return;
    expect(projectState.anomalies).toEqual([]);
  });

  it("F4 (STORE AUTHORITY BOUNDARY V1): ataque de squat ANTES do primeiro `nexos state` não bloqueia mais o produtor legítimo", async () => {
    /**
     * Reproduzido em sandbox real nesta fatia (projeto novo, `nexos state`
     * nunca rodou): o forjado reivindicava o claim ROOT do source_ref
     * `nexos://project-state` para sempre — todo `nexos state --set`
     * legítimo subsequente falhava com HeadRaceExhaustedError
     * ("concorrência persistente"), e o projeto nunca mais conseguia
     * publicar estado canônico. Este teste é o contrafactual: se o guard de
     * `F3` (prefixo `nexos://gotcha/`) sumir, ESTE teste fica RED porque
     * `state --set` volta a falhar.
     */
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "ataque antes do primeiro state",
        rule: "regra",
        sourceRef: "nexos://project-state",
      })
    );

    await silencioso(() => state({ cwd: root, set: "estado inicial", next: "fazer algo" }));

    const r = await readCurrentRecords(root, { kind: "project_state" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.anomalies).toEqual([]);
    expect(r.records).toHaveLength(1);
    expect(contentOf(r.records[0]!.record).current_state).toBe("estado inicial");
  });

  it.each([
    "nexos://gotcha/../project-state",
    "nexos://gotcha//../project-state",
    "nexos://gotcha/x#../../project-state",
  ])(
    "F5 (GAP 2 — %s): sufixo com sintaxe de escape passa em startsWith mas é recusado FAIL CLOSED",
    async (sourceRef) => {
      await silencioso(() =>
        gotcha({ cwd: root, title: "tentativa de escape sintatico", rule: "regra", sourceRef })
      );
      const r = await gotchasAtuais(root);
      expect(r.ok).toBe(true);
      if (!r.ok) return;
      expect(r.records).toHaveLength(0);
    }
  );

  it("F6 (GAP 2, contrafactual): --source-ref custom SEM sintaxe de escape continua aceito", async () => {
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "titulo qualquer",
        rule: "regra",
        sourceRef: "nexos://gotcha/slug-explicito-do-caller",
      })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(1);
  });

  it("H: WRITE WITHOUT RETRIEVAL != MEMORY — assembleContext devolve o gotcha", async () => {
    await silencioso(() =>
      gotcha({ cwd: root, title: "gotcha recuperavel", rule: "tem que aparecer no pack" })
    );
    const result = await assembleContext({ projectRoot: root });
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    const item = result.pack.items.find((i) => i.kind === "gotcha");
    expect(item).toBeDefined();
    expect(item?.fields.title).toBe("gotcha recuperavel");
  });
});

/**
 * VER-CAUSE-NOT-VERIFIED — os contrafactuais da regra do ESCRITOR.
 *
 *   ASSERTING A CAUSE != HAVING MEASURED IT
 *   A CLAIM IS NOT ITS OWN EVIDENCE
 *
 * O positivo (J2, J5) não é enfeite: sem ele, uma regra que barrasse TUDO
 * passaria por correta nos negativos.
 */
describe("nexos gotcha · causa afirmada exige medição", () => {
  it("J1: --cause sem --evidence é BARRADO e nada é escrito", async () => {
    const anterior = process.exitCode;
    await silencioso(() =>
      gotcha({ cwd: root, title: "causa sem medicao", cause: "regressao do commit 8da5db5" })
    );
    expect(process.exitCode).toBe(1);
    process.exitCode = anterior;

    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(0);
  });

  it("J2 (POSITIVO): --cause COM --evidence passa sem atrito", async () => {
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "causa medida",
        cause: "npm --version compara metadado, nao conteudo",
        evidence: "global 6.3.2 dizia INVALID_SCHEMA x8; worktree 6.3.2 dizia Store integro",
      })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(1);
    expect(contentOf(r.records[0]!.record).cause).toBe("npm --version compara metadado, nao conteudo");
  });

  it("J3 (POSITIVO): campos de OBSERVAÇÃO sem --evidence seguem livres", async () => {
    await silencioso(() =>
      gotcha({
        cwd: root,
        title: "so observacao",
        trigger: "rodar o comando do PATH",
        failureMode: "responde INVALID_SCHEMA x8",
        consequence: "sessao inteira acreditou no diagnostico falso",
      })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(1);
  });

  it("J4: o record NÃO cita o próprio source_ref como evidência", async () => {
    await silencioso(() =>
      gotcha({ cwd: root, title: "nao se autocita", rule: "A CLAIM IS NOT ITS OWN EVIDENCE" })
    );
    const r = await gotchasAtuais(root);
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const rec = r.records[0]!.record as unknown as {
      evidence_refs?: string[];
      provenance: { source_ref: string };
    };
    expect(rec.evidence_refs ?? []).not.toContain(rec.provenance.source_ref);
    /** Ausente, nunca `[]`: array vazio afirmaria "procurei e não achei". */
    expect(rec.evidence_refs).toBeUndefined();
  });

  it("J5 (POSITIVO): ref EXTERNA sobrevive — a regra é sobre auto-citação, não sobre citar", () => {
    expect(
      evidenceRefsExternas("nexos://gotcha/x", ["nexos://gotcha/x", "src/lib/capsule/store.ts:302"])
    ).toEqual(["src/lib/capsule/store.ts:302"]);
    /** `source_ref` que É um artefato no disco (gotcha-migrator) não é auto-citação. */
    expect(
      evidenceRefsExternas(".nexos/memory/project/gotchas.md#GOTCHA-017", [
        ".nexos/memory/project/gotchas.md#GOTCHA-017",
      ])
    ).toEqual([".nexos/memory/project/gotchas.md#GOTCHA-017"]);
  });
});

describe("nexos state · snapshot não é evidência de si mesmo", () => {
  it("J6: sem --last-verified, evidence_refs some; com ele, sobra só ele", async () => {
    await silencioso(() => state({ cwd: root, set: "onde paramos", next: "proximo passo" }));
    const semRef = await readCurrentRecords(root, { kind: "project_state" });
    expect(semRef.ok).toBe(true);
    if (!semRef.ok) return;
    expect((semRef.records[0]!.record as unknown as { evidence_refs?: string[] }).evidence_refs).toBeUndefined();

    await silencioso(() =>
      state({ cwd: root, set: "onde paramos", next: "proximo passo", verified: "verify:work-graph exit 0" })
    );
    const comRef = await readCurrentRecords(root, { kind: "project_state" });
    expect(comRef.ok).toBe(true);
    if (!comRef.ok) return;
    expect((comRef.records[0]!.record as unknown as { evidence_refs?: string[] }).evidence_refs).toEqual([
      "verify:work-graph exit 0",
    ]);
  });
});
