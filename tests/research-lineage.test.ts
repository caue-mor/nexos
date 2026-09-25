/**
 * A camada de research estava INVISÍVEL por construção, não vazia por falta
 * de uso.
 *
 *   SOURCE_REF FIXO FAZ TODA PESQUISA VIRAR A MESMA LINHAGEM
 *
 * `readCurrentRecords` agrupa por `source_ref` e resolve UM head por linhagem
 * — é assim que Decision, Gotcha e Knowledge funcionam. `research.ts` gravava
 * `"nexos://research"` literal em TODAS, então cada pesquisa nova virava mais
 * um head desconectado da mesma linhagem e a família inteira saía como
 * `DIVERGED` em `anomalies`, nunca em `records`.
 *
 * MEDIDO em 2026-09-18 com 4 pesquisas reais no acervo:
 *   loadFamilyForResolution("Research")          -> 4 records
 *   readCurrentRecords({families:["Research"]})  -> 0 records, 1 anomalia DIVERGED
 *   nexos research --search "<termo que existe>" -> "0 pesquisa(s) no acervo"
 *
 * O produtor gravava, o disco guardava, e o leitor que a busca usa nunca via
 * nada — sem erro, sem aviso, com `ok: true`.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { research } from "../src/commands/research.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";

const TMP = fs.realpathSync(os.tmpdir());
let root: string;

beforeEach(async () => {
  root = await fs.mkdtemp(path.join(TMP, "research-lineage-"));
  execFileSync("git", ["init", "-q", "."], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  await initializeCapsule(root, { projectName: "proj" });
});

afterEach(async () => {
  await fs.remove(root);
});

const gravar = (question: string, findings: string) =>
  research({
    cwd: root,
    question,
    findings,
    source: ["https://exemplo.test/doc"],
    claim: ["o que a fonte sustenta"],
    confidence: ["OFFICIAL"],
  });

describe("linhagem de Research", () => {
  it("duas perguntas diferentes viram dois records LEGÍVEIS pelo leitor canônico", async () => {
    await gravar("Como o host entrega o transcript?", "achado A");
    await gravar("Subagente tem session_id proprio?", "achado B");

    const leitura = await readCurrentRecords(root, { families: ["Research"] });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;

    // O DEFEITO: antes disto, records era 0 e anomalies tinha 1 DIVERGED.
    expect(leitura.records).toHaveLength(2);
    expect(leitura.anomalies).toHaveLength(0);

    const refs = leitura.records.map((r) => r.sourceRef).sort();
    expect(refs[0]).toMatch(/^nexos:\/\/research\/.+/);
    expect(refs[0]).not.toBe(refs[1]);
  });

  /**
   * LIMITE CONHECIDO E DECLARADO, não comportamento desejado.
   *
   * `research.ts` publica sem CAS e sem `supersedes`: repetir a MESMA pergunta
   * cria um segundo head da mesma linhagem, e as duas somem do leitor
   * canônico. `gotcha.ts` resolve isso lendo o head e encadeando
   * (`supersedes: anterior.id`, sob CAS).
   *
   * A versão anterior deste bloco AFIRMAVA o limite: esperava 0 records e uma
   * anomalia `DIVERGED`, e dizia "se alguém implementar a supersessão, ele
   * FALHA — e essa falha é a notícia boa". Implementada, ele falhou com
   * `expected [ {…} ] to have a length of +0 but got 1`. **Essa falha foi a
   * prova**, e o teste passa a afirmar o comportamento certo.
   */
  it("a MESMA pergunta duas vezes supersede — um head, não duas verdades", async () => {
    await gravar("Qual o teto do watchdog?", "achado velho");
    await gravar("Qual o teto do watchdog?", "achado novo");

    const leitura = await readCurrentRecords(root, { families: ["Research"] });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;

    /** UM head — não zero (DIVERGED, que apagava as duas) nem dois. */
    expect(leitura.records).toHaveLength(1);
    expect(leitura.anomalies).toHaveLength(0);

    /** O head é a resposta NOVA: supersessão substitui, não acumula. */
    const head = leitura.records[0];
    expect(head).toBeDefined();
    if (head === undefined) return;
    const registro = head.record as unknown as { content: Record<string, unknown>; supersedes?: string };
    expect(registro.content["findings"]).toBe("achado novo");

    /** E ele CITA o antecessor — histórico no disco, head único. */
    expect(registro.supersedes).toBeTruthy();
  });

  /**
   * NEGATIVE CONTROL da supersessão: perguntas DIFERENTES continuam sendo
   * linhagens independentes. Se o encadeamento passasse a colapsar tudo num
   * head só, o teste acima ainda passaria e a camada perderia todo o acervo
   * menos a última pesquisa.
   */
  it("perguntas diferentes NÃO superseder uma à outra", async () => {
    await gravar("Pergunta A?", "resposta A");
    await gravar("Pergunta B?", "resposta B");

    const leitura = await readCurrentRecords(root, { families: ["Research"] });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.records.length).toBeGreaterThanOrEqual(2);
    expect(leitura.anomalies).toHaveLength(0);
  });

  it("NEGATIVE CONTROL: source_ref fixo reproduz o defeito — duas perguntas viram UMA linhagem DIVERGED", async () => {
    await gravar("Pergunta um?", "a");
    await gravar("Pergunta dois?", "b");

    // simula o comportamento antigo reescrevendo o source_ref das duas para o literal
    const dir = path.join(root, ".nexos", "records", "research");
    for (const f of await fs.readdir(dir)) {
      const p = path.join(dir, f);
      const texto = await fs.readFile(p, "utf-8");
      await fs.writeFile(p, texto.replace(/source_ref: nexos:\/\/research\/.*/g, "source_ref: nexos://research"), "utf-8");
    }

    const leitura = await readCurrentRecords(root, { families: ["Research"] });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    // é ISTO que acontecia com todo o acervo: nada em records, tudo em anomalies
    expect(leitura.records).toHaveLength(0);
    expect(leitura.anomalies[0]?.state).toBe("DIVERGED");
  });
});
