/**
 * T1 — scope canônico {kind, ref} e identidade de assunto (subject/subject_ref)
 * no envelope. Plano: nexos_aios_sdk_v1/docs/13_MEMORY_SCOPE_LAYERED_DECISION.md
 * (seções 1.2, 1.2.1, 1.3, 1.4) — Decision record dec_01M1ZYE3FBD5366JT9A7APTMQV
 * é a autoridade.
 *
 * Fixtures partem de `makeGotcha()` (envelope válido, `scope: "project"`) e
 * degradam só o que cada teste prova — mesmo padrão de `capsule-fixtures.ts`.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import os from "node:os";
import fs from "fs-extra";
import {
  validateRecord,
  scopeOf,
  subjectRef,
  LEGACY_SCOPE_UNRESOLVED,
  type CapsuleRecord,
} from "../src/lib/capsule/schemas.js";
import { parseCanonical } from "../src/lib/capsule/codec.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { makeGotcha, makeCheckpoint, PROJECT_ID } from "./capsule-fixtures.js";
import { initializeCapsule, initializeGlobalRoot } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { listKnownFamilyYamlFiles } from "../src/lib/capsule/reader.js";
import { readCurrentRecords, GLOBAL_ROOT_SOURCE_REF } from "../src/lib/capsule/reader.js";
import { assembleContext } from "../src/lib/context-assembler.js";
import { resumeCheckpoint } from "../src/lib/capsule/checkpoint.js";
import { GLOBAL_ROOT } from "../src/lib/constants.js";

const REPO = path.resolve(__dirname, "..");

/**
 * T7a/T7b (§6.4, §9 I31) — todo `KnowledgeRecord` global exige
 * `content.generality` e `content.verification_status="unverified"`. As
 * fixtures desta suíte testam SCOPE/RETRIEVAL, não promoção — o default aqui
 * as mantém válidas contra o invariante sem repetir os dois campos em cada
 * `it()`. Nenhum teste desta suíte afirma ausência desses dois campos
 * especificamente, então o merge nunca esconde o que um teste quer provar.
 */
const MARCAS_GLOBAIS_DEFAULT = {
  generality: "vale para qualquer projeto — fixture de teste",
  verification_status: "unverified",
} as const;

function isGlobalScope(scope: unknown): boolean {
  return typeof scope === "object" && scope !== null && (scope as { kind?: unknown }).kind === "global";
}

/** Mescla rasa sobre uma fixture válida — devolve `unknown` de propósito: os
 * testes desta suíte constroem, em sua maioria, formas INVÁLIDAS por desenho,
 * e `validateRecord` é quem decide, nunca o tipo estático do teste. */
function record(overrides: Record<string, unknown>): unknown {
  const base = { ...(makeGotcha() as unknown as Record<string, unknown>), ...overrides };
  if (!isGlobalScope((base as { scope?: unknown }).scope)) return base;
  const content = (base as { content?: Record<string, unknown> }).content ?? {};
  return { ...base, content: { ...MARCAS_GLOBAIS_DEFAULT, ...content } };
}

/** Mesma fixture, sem `project_id` — o caso `scope.kind === "global"`. */
function globalRecord(overrides: Record<string, unknown> = {}): unknown {
  const { project_id: _projectId, content: baseContent, ...semProjeto } = makeGotcha() as unknown as Record<
    string,
    unknown
  >;
  return {
    ...semProjeto,
    scope: { kind: "global", ref: null },
    subject: "gerenciador de pacotes",
    subject_ref: subjectRef("gerenciador de pacotes"),
    content: { ...MARCAS_GLOBAIS_DEFAULT, ...(baseContent as Record<string, unknown>) },
    ...overrides,
  };
}

/**
 * Compartilhado por T5 e T6 abaixo — mesmo tmpdir base, um projeto novo por
 * chamada. `GLOBAL_ROOT`/`NEXOS_HOME` já vêm isolados por
 * `tests/isolate-nexos-home.ts` (setup global): um tmpdir por ARQUIVO de
 * teste, nunca o `$HOME` real.
 */
const TMP = fs.realpathSync(os.tmpdir());

async function mkProject(name: string): Promise<{ root: string; projectId: string }> {
  const root = await fs.mkdtemp(path.join(TMP, `t5-${name}-`));
  const { projectId } = await initializeCapsule(root, { projectName: name });
  return { root, projectId };
}

/** `record()` (acima) + cast — aqui as fixtures são sempre VÁLIDAS, publicáveis de verdade. */
function gotcha(overrides: Record<string, unknown>): CapsuleRecord {
  return record(overrides) as CapsuleRecord;
}

describe("memory-scope — T1 contrato canônico", () => {
  it("scope global publica sem project_id", () => {
    const result = validateRecord(globalRecord());
    expect(result.ok).toBe(true);
  });

  it("scope global com project_id falha no schema", () => {
    const result = validateRecord(globalRecord({ project_id: PROJECT_ID }));
    expect(result.ok).toBe(false);
  });

  it("scope project sem project_id falha no schema", () => {
    const result = validateRecord(
      record({ scope: { kind: "project", ref: PROJECT_ID }, project_id: undefined })
    );
    expect(result.ok).toBe(false);
  });

  it("scope project com ref diferente falha no schema", () => {
    const result = validateRecord(
      record({ scope: { kind: "project", ref: "prj_01J8ZQ9WXYZOUTROOUTROXX" } })
    );
    expect(result.ok).toBe(false);
  });

  it("scope project com ref igual ao project_id e valido", () => {
    const result = validateRecord(record({ scope: { kind: "project", ref: PROJECT_ID } }));
    expect(result.ok).toBe(true);
  });

  it("scope.kind=task com ref que não é id de ProjectCheckpoint (string arbitrária) falha no schema", () => {
    const result = validateRecord(record({ scope: { kind: "task", ref: "tarefa-1" } }));
    expect(result.ok).toBe(false);
  });

  it("scope.kind=task com ref de OUTRA family (KnowledgeRecord) falha no schema", () => {
    const result = validateRecord(
      record({ scope: { kind: "task", ref: newRecordId("KnowledgeRecord") } })
    );
    expect(result.ok).toBe(false);
  });

  it("scope.kind=task com ref vazio falha no schema (ScopeRefSchema.ref exige min(1))", () => {
    const result = validateRecord(record({ scope: { kind: "task", ref: "" } }));
    expect(result.ok).toBe(false);
  });

  it("scope.kind=task com ref de um ProjectCheckpoint real é válido", () => {
    const chk = newRecordId("ProjectCheckpoint");
    const result = validateRecord(record({ scope: { kind: "task", ref: chk } }));
    expect(result.ok).toBe(true);
  });

  it("scope.kind=session com ref vazio falha no schema (ScopeRefSchema.ref exige min(1))", () => {
    const result = validateRecord(record({ scope: { kind: "session", ref: "" } }));
    expect(result.ok).toBe(false);
  });

  it("scope.kind=session com ref não vazio e diferente do project_id é válido", () => {
    const result = validateRecord(record({ scope: { kind: "session", ref: "sess_2026090801" } }));
    expect(result.ok).toBe(true);
  });

  it("scope objeto com kind host falha no schema", () => {
    const result = validateRecord(record({ scope: { kind: "host", ref: PROJECT_ID } }));
    expect(result.ok).toBe(false);
  });

  it("record legado scope host normaliza para project", () => {
    const result = validateRecord(record({ scope: "host" }));
    expect(result.ok).toBe(true);
    if (!result.ok) throw new Error("setup: fixture deveria validar");
    expect(scopeOf(result.value)).toEqual({ kind: "project", ref: PROJECT_ID });
  });

  it("string legada session e recusada como nao resolvida", () => {
    const fabricado = record({ scope: "session" });
    // `scope: "session"` já não passa por `validateRecord` (T1 fechou a
    // string legada) — `scopeOf` é a segunda defesa, para um record cru que
    // chegue sem ter passado pela validação. Cast explícito, não `any`.
    expect(() => scopeOf(fabricado as Parameters<typeof scopeOf>[0])).toThrow(
      LEGACY_SCOPE_UNRESOLVED
    );
  });

  it("subject sem subject_ref falha no schema", () => {
    const result = validateRecord(record({ subject: "gerenciador de pacotes" }));
    expect(result.ok).toBe(false);
  });

  it("subject_ref sem subject falha no schema", () => {
    const result = validateRecord(record({ subject_ref: "gerenciador-de-pacotes" }));
    expect(result.ok).toBe(false);
  });

  it("subject_ref divergente do subject falha no schema", () => {
    const result = validateRecord(
      record({ subject: "gerenciador de pacotes", subject_ref: "outra-coisa" })
    );
    expect(result.ok).toBe(false);
  });

  it("scope global sem subject falha no schema", () => {
    const { subject: _s, subject_ref: _sr, ...semAssunto } = globalRecord() as Record<
      string,
      unknown
    >;
    const result = validateRecord(semAssunto);
    expect(result.ok).toBe(false);
  });

  it("mesmo subject com fatos diferentes gera o mesmo subject_ref", () => {
    const subject = "gerenciador de pacotes";
    const a = record({
      subject,
      subject_ref: subjectRef(subject),
      content: { title: "npm trava em postinstall", rule: "sempre limpar cache antes" },
    });
    const b = record({
      subject,
      subject_ref: subjectRef(subject),
      content: { title: "pnpm ignora lockfile em CI", cause: "flag --frozen ausente" },
    });
    const va = validateRecord(a);
    const vb = validateRecord(b);
    expect(va.ok && vb.ok).toBe(true);
    if (!va.ok || !vb.ok) throw new Error("setup: as duas fixtures deveriam validar");
    expect(va.value.subject_ref).toBe(vb.value.subject_ref);
  });

  it("fatos parecidos com subjects diferentes geram refs diferentes", () => {
    const conteudoQuaseIgual = { title: "trava em postinstall", cause: "cache corrompido" };
    const subjectA = "gerenciador de pacotes";
    const subjectB = "gerenciador de dependencias";
    const a = record({
      subject: subjectA,
      subject_ref: subjectRef(subjectA),
      content: conteudoQuaseIgual,
    });
    const b = record({
      subject: subjectB,
      subject_ref: subjectRef(subjectB),
      content: conteudoQuaseIgual,
    });
    const va = validateRecord(a);
    const vb = validateRecord(b);
    expect(va.ok && vb.ok).toBe(true);
    if (!va.ok || !vb.ok) throw new Error("setup: as duas fixtures deveriam validar");
    expect(va.value.subject_ref).not.toBe(vb.value.subject_ref);
  });

  /**
   * `.nexos/records/` desta máquina — desde nexos://decision/memoria-nunca-sai-da-maquina
   * nunca está no git (C12.2 §5 revogada); um clone limpo/CI nasce sem ele e
   * `listKnownFamilyYamlFiles` devolveria `[]`, o que faria `falhas` ficar
   * vazio por FALTA DE INSUMO, não por integridade — exatamente a asserção
   * fraca que este arquivo proíbe (ver docstring do topo). Skip explícito.
   */
  it.skipIf(!fs.existsSync(path.join(REPO, ".nexos", "records")))(
    "todos os records reais do Store continuam validos",
    async () => {
    /**
     * P0 (achado do verifier) — o `nexos` global congelado
     * (pre-mvp-project-brain@8432677) continua escrevendo `host-observations/`
     * via os hooks desta sessão; família que o schema desta branch não
     * reconhece mais. `listKnownFamilyYamlFiles` ignora diretório de família
     * desconhecida por construção (mesma disciplina de `readCurrentRecords`),
     * então este teste prova só o que o Store realmente lê hoje — não a
     * árvore inteira de `.nexos/records/`.
     */
    const ignoradas: string[] = [];
    const arquivos = await listKnownFamilyYamlFiles(REPO, (dir) => ignoradas.push(dir));
    if (ignoradas.length > 0) {
      // eslint-disable-next-line no-console
      console.warn(`  família(s) desconhecida(s) ignorada(s): ${ignoradas.join(", ")}`);
    }

    const falhas: string[] = [];
    for (const arquivo of arquivos) {
      const texto = await fs.readFile(arquivo, "utf-8");
      const resultado = validateRecord(parseCanonical(texto));
      if (!resultado.ok) falhas.push(`${path.relative(REPO, arquivo)}: ${resultado.errors.join("; ")}`);
    }

    console.log(`  todos os records reais do Store continuam validos — ${arquivos.length} verificados`);
    expect(falhas).toEqual([]);
  });
});

/**
 * T5 — retrieval composto. Plano: `13_MEMORY_SCOPE_LAYERED_DECISION.md` §4.1,
 * §4.2, §4.4; invariantes I4/I5/I11/I27/I28 (§9). `GLOBAL_ROOT`/`NEXOS_HOME`
 * já vêm isolados por `tests/isolate-nexos-home.ts` (setup global) — um
 * tmpdir por ARQUIVO de teste, nunca o `$HOME` real.
 */
describe("T5 — retrieval composto (assembleContext / readCurrentRecords)", () => {
  it("I4 — projeto A nunca lê PROJECT de B, mesmo com includeGlobal", async () => {
    const a = await mkProject("i4-a");
    const b = await mkProject("i4-b");

    await publishCanonical(
      b.root,
      gotcha({
        project_id: b.projectId,
        provenance: { source_ref: "i4#somente-em-b", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "só existe em B", rule: "nao deveria vazar para A" },
      })
    );

    const leituraA = await readCurrentRecords(a.root, { includeGlobal: true });
    expect(leituraA.ok).toBe(true);
    if (!leituraA.ok) return;
    expect(leituraA.records.some((r) => r.sourceRef === "i4#somente-em-b")).toBe(false);
  });

  it("I5 — mesmo record GLOBAL aparece em dois projetos via assembleContext", async () => {
    const a = await mkProject("i5-a");
    const b = await mkProject("i5-b");
    await initializeGlobalRoot(GLOBAL_ROOT);

    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: "i5 fato global compartilhado",
        subject_ref: subjectRef("i5 fato global compartilhado"),
        provenance: { source_ref: "i5#global-compartilhado", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "fato global", rule: "visto em qualquer projeto" },
      })
    );

    const packA = await assembleContext({ projectRoot: a.root, intent: "fato global" });
    const packB = await assembleContext({ projectRoot: b.root, intent: "fato global" });
    expect(packA.ok && packB.ok).toBe(true);
    if (!packA.ok || !packB.ok) return;
    expect(packA.pack.items.some((i) => i.sourceRef === "i5#global-compartilhado")).toBe(true);
    expect(packB.pack.items.some((i) => i.sourceRef === "i5#global-compartilhado")).toBe(true);
  });

  it("I11 — head por root não mistura linhagem: mesmo source_ref no projeto e no global são duas partições", async () => {
    const a = await mkProject("i11-a");
    await initializeGlobalRoot(GLOBAL_ROOT);
    const sourceRef = "i11#mesma-string-dois-roots";

    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "partição do projeto", rule: "vive no root do projeto" },
      })
    );
    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: "i11 mesma string dois roots",
        subject_ref: subjectRef("i11 mesma string dois roots"),
        provenance: { source_ref: sourceRef, producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "partição global", rule: "vive no GLOBAL_ROOT" },
      })
    );

    const leitura = await readCurrentRecords(a.root, { includeGlobal: true });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    // Duas partições SOBREVIVEM sob o mesmo source_ref — nunca um DIVERGED
    // (que apareceria como zero records + uma entrada em anomalies).
    const doisHeads = leitura.records.filter((r) => r.sourceRef === sourceRef);
    expect(doisHeads).toHaveLength(2);
    expect(leitura.anomalies.some((an) => an.sourceRef === sourceRef)).toBe(false);
  });

  it("I27 — record task de outro checkpoint não entra no pack; com activeTaskRef igual entra; resumeCheckpoint propaga o próprio head", async () => {
    const a = await mkProject("i27-a");
    const checkpointId = newRecordId("ProjectCheckpoint");
    // `resumeCheckpoint` usa `content.statement` como `intent` do assembler —
    // termo em comum com o content do gotcha para não cair em NO_SIGNAL
    // (score 0), que é irrelevante para I27 e testado à parte.
    await publishCanonical(
      a.root,
      makeCheckpoint("revisar tarefa isolada", null, { id: checkpointId, project_id: a.projectId })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "task", ref: checkpointId },
        provenance: { source_ref: "i27#task-scoped", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "regra da tarefa isolada", rule: "isolado por checkpoint" },
      })
    );

    const semTask = await assembleContext({ projectRoot: a.root });
    expect(semTask.ok).toBe(true);
    if (semTask.ok) {
      expect(semTask.pack.items.some((i) => i.sourceRef === "i27#task-scoped")).toBe(false);
    }

    const taskErrada = await assembleContext({ projectRoot: a.root, activeTaskRef: "chk_outraTarefaQualquer" });
    expect(taskErrada.ok).toBe(true);
    if (taskErrada.ok) {
      expect(taskErrada.pack.items.some((i) => i.sourceRef === "i27#task-scoped")).toBe(false);
    }

    const taskCerta = await assembleContext({ projectRoot: a.root, activeTaskRef: checkpointId });
    expect(taskCerta.ok).toBe(true);
    if (taskCerta.ok) {
      expect(taskCerta.pack.items.some((i) => i.sourceRef === "i27#task-scoped")).toBe(true);
    }

    // `resumeCheckpoint` resolve o próprio head e passa `activeTaskRef` —
    // sem repetir aqui a chamada a `assembleContext`, o record task-scoped
    // desta MESMA linhagem já deveria aparecer sozinho.
    const resumo = await resumeCheckpoint(a.root);
    expect(resumo.kind).toBe("RESUMED");
    if (resumo.kind === "RESUMED") {
      expect(resumo.context?.items.some((i) => i.sourceRef === "i27#task-scoped")).toBe(true);
    }
  });

  it("I28 — record session de outra sessão não entra no pack; com activeSessionRef igual entra", async () => {
    const a = await mkProject("i28-a");
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "session", ref: "sess_i28_A" },
        provenance: { source_ref: "i28#session-scoped", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "só desta sessão", rule: "isolado por sessão" },
      })
    );

    const semSessao = await assembleContext({ projectRoot: a.root });
    expect(semSessao.ok).toBe(true);
    if (semSessao.ok) {
      expect(semSessao.pack.items.some((i) => i.sourceRef === "i28#session-scoped")).toBe(false);
    }

    const sessaoErrada = await assembleContext({ projectRoot: a.root, activeSessionRef: "sess_i28_B" });
    expect(sessaoErrada.ok).toBe(true);
    if (sessaoErrada.ok) {
      expect(sessaoErrada.pack.items.some((i) => i.sourceRef === "i28#session-scoped")).toBe(false);
    }

    const sessaoCerta = await assembleContext({ projectRoot: a.root, activeSessionRef: "sess_i28_A" });
    expect(sessaoCerta.ok).toBe(true);
    if (sessaoCerta.ok) {
      expect(sessaoCerta.pack.items.some((i) => i.sourceRef === "i28#session-scoped")).toBe(true);
    }
  });

  it("readCurrentRecords com includeGlobal=false (default) NÃO lê o global — call sites de escrita continuam intactos", async () => {
    const a = await mkProject("t5-default-a");
    await initializeGlobalRoot(GLOBAL_ROOT);
    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: "default false global",
        subject_ref: subjectRef("default false global"),
        provenance: { source_ref: "default-false#global", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "global que não deveria aparecer", rule: "includeGlobal default é false" },
      })
    );

    const semOpcao = await readCurrentRecords(a.root);
    const comFalseExplicito = await readCurrentRecords(a.root, { includeGlobal: false });
    expect(semOpcao.ok && comFalseExplicito.ok).toBe(true);
    if (!semOpcao.ok || !comFalseExplicito.ok) return;
    expect(semOpcao.records.some((r) => r.sourceRef === "default-false#global")).toBe(false);
    expect(comFalseExplicito.records.some((r) => r.sourceRef === "default-false#global")).toBe(false);
  });

  it("GLOBAL_ROOT com manifest ausente — pack do projeto intacto + anomalia registrada, nunca ok:false", async () => {
    const a = await mkProject("t5-global-absent-a");
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        provenance: { source_ref: "global-absent#projeto-intacto", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "record do projeto", rule: "sobrevive mesmo com global ilegível" },
      })
    );
    // Garante ausência independente da ordem de execução dos testes deste
    // arquivo — `GLOBAL_ROOT` é compartilhado por todo o arquivo.
    await fs.remove(path.join(GLOBAL_ROOT, ".nexos"));

    const leitura = await readCurrentRecords(a.root, { includeGlobal: true });
    expect(leitura.ok).toBe(true);
    if (!leitura.ok) return;
    expect(leitura.records.some((r) => r.sourceRef === "global-absent#projeto-intacto")).toBe(true);

    const anomalia = leitura.anomalies.find((an) => an.sourceRef === GLOBAL_ROOT_SOURCE_REF);
    expect(anomalia).toBeDefined();
    expect(anomalia?.family).toBe("KnowledgeRecord");
    expect(anomalia?.state).toBe("MALFORMED");
    expect(anomalia?.detail).toMatch(/GLOBAL_ROOT/);
  });
});

/**
 * T6 — precedência PROJECT sobre GLOBAL. Plano: `13_MEMORY_SCOPE_LAYERED_
 * DECISION.md` §4.2 passo C, §4.3 (4.3.1/4.3.2/4.3.3), §4.5, §4.6;
 * invariantes I6/I7/I18/I19/I20/I29/I30 (§9). `mkProject`/`gotcha` reusam os
 * helpers hoisted para o topo do arquivo (mesmo `GLOBAL_ROOT` isolado e
 * compartilhado por todo o arquivo do T5).
 */
describe("T6 — precedência PROJECT sobre GLOBAL", () => {
  /** Custo em bytes que `empacotar()` cobraria deste item — mesma fórmula de
   * `context-assembler.ts` (`bytes(JSON.stringify(fields)) + bytes(sourceRef)`),
   * recomputada aqui para montar orçamentos EXATOS sem importar internals. */
  function custoDoItem(sourceRef: string, fields: Record<string, string>): number {
    return (
      Buffer.byteLength(JSON.stringify(fields), "utf8") + Buffer.byteLength(sourceRef, "utf8")
    );
  }

  it("I6 — project suprime global de mesmo subject_ref", async () => {
    const a = await mkProject("i6-a");
    await initializeGlobalRoot(GLOBAL_ROOT);
    const subject = "i6 pacote compartilhado";

    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "i6#global-pacote", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "regra global do pacote", rule: "vem do GLOBAL_ROOT" },
      })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "i6#project-pacote", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "regra do projeto sobre o pacote", rule: "vence o global" },
      })
    );

    const pack = await assembleContext({ projectRoot: a.root, intent: "pacote" });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    expect(pack.pack.items.some((i) => i.sourceRef === "i6#project-pacote")).toBe(true);
    expect(pack.pack.items.some((i) => i.sourceRef === "i6#global-pacote")).toBe(false);
    const suprimido = pack.pack.omitted.find((o) => o.sourceRef === "i6#global-pacote");
    expect(suprimido?.reason).toBe("OVERRIDDEN_BY_PROJECT");
  });

  it("I7 — global sem par local permanece em B", async () => {
    const a = await mkProject("i7-a");
    const b = await mkProject("i7-b");
    await initializeGlobalRoot(GLOBAL_ROOT);
    const subject = "i7 fato sem override";

    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "i7#global-sem-override", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "fato global sem par local", rule: "fica em qualquer projeto sem override" },
      })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "i7#project-override-em-a", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "override só em A", rule: "suprime o global só em A" },
      })
    );

    const packA = await assembleContext({ projectRoot: a.root, intent: "fato" });
    const packB = await assembleContext({ projectRoot: b.root, intent: "fato" });
    expect(packA.ok && packB.ok).toBe(true);
    if (!packA.ok || !packB.ok) return;
    expect(packA.pack.items.some((i) => i.sourceRef === "i7#global-sem-override")).toBe(false);
    expect(packB.pack.items.some((i) => i.sourceRef === "i7#global-sem-override")).toBe(true);
  });

  it("I18 — fatos opostos com mesmo subject_ref colidem", async () => {
    const a = await mkProject("i18-a");
    await initializeGlobalRoot(GLOBAL_ROOT);
    const subject = "i18 politica de cache";

    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "i18#global-oposto", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "sempre usar cache agressivo", rule: "cache infinito é seguro aqui" },
      })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        subject,
        subject_ref: subjectRef(subject),
        provenance: { source_ref: "i18#project-oposto", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "nunca usar cache agressivo aqui", rule: "cache infinito corrompe dados neste projeto" },
      })
    );

    const pack = await assembleContext({ projectRoot: a.root, intent: "cache" });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    expect(pack.pack.items.some((i) => i.sourceRef === "i18#project-oposto")).toBe(true);
    expect(pack.pack.items.some((i) => i.sourceRef === "i18#global-oposto")).toBe(false);
    const suprimido = pack.pack.omitted.find((o) => o.sourceRef === "i18#global-oposto");
    expect(suprimido?.reason).toBe("OVERRIDDEN_BY_PROJECT");
  });

  it("I19 — subject_ref diferente não colide, mesmo com fatos quase iguais", async () => {
    const a = await mkProject("i19-a");
    await initializeGlobalRoot(GLOBAL_ROOT);
    /**
     * Quase iguais no SENTIDO, nunca no BYTE: idênticos colidiriam no dedup
     * por conteúdo de `empacotar()` (`vistos`, `context-assembler.ts`) — um
     * mecanismo TOTALMENTE separado da supressão por `subject_ref` que este
     * teste prova. Igual ao byte faria o teste testar o dedup, não R3.
     */
    const conteudoGlobal = { title: "trava em postinstall", rule: "limpar cache antes" };
    const conteudoProjeto = { title: "trava em postinstall", rule: "limpar cache antes de buildar" };
    const subjectGlobal = "i19 gerenciador de pacotes";
    const subjectProjeto = "i19 gerenciador de dependencias";

    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: subjectGlobal,
        subject_ref: subjectRef(subjectGlobal),
        provenance: { source_ref: "i19#global-parecido", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: conteudoGlobal,
      })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        subject: subjectProjeto,
        subject_ref: subjectRef(subjectProjeto),
        provenance: { source_ref: "i19#project-parecido", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: conteudoProjeto,
      })
    );

    const pack = await assembleContext({ projectRoot: a.root, intent: "postinstall" });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;
    expect(pack.pack.items.some((i) => i.sourceRef === "i19#project-parecido")).toBe(true);
    expect(pack.pack.items.some((i) => i.sourceRef === "i19#global-parecido")).toBe(true);
    expect(pack.pack.omitted.some((o) => o.sourceRef === "i19#global-parecido")).toBe(false);
  });

  it("I20 — unkeyed não suprime nem é suprimido, mesmo com outra supressão ativa no mesmo pack", async () => {
    const a = await mkProject("i20-a");
    await initializeGlobalRoot(GLOBAL_ROOT);

    // supressão ATIVA de verdade, para provar que ela não vaza para o par
    // unkeyed abaixo — não é "nada aconteceu", é "algo aconteceu ao lado".
    const subjectAtivo = "i20 chave ativa";
    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: subjectAtivo,
        subject_ref: subjectRef(subjectAtivo),
        provenance: { source_ref: "i20#global-ativo", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "global da chave ativa", rule: "deveria ser suprimido" },
      })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        subject: subjectAtivo,
        subject_ref: subjectRef(subjectAtivo),
        provenance: { source_ref: "i20#project-ativo", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "project da chave ativa", rule: "suprime o global ao lado" },
      })
    );

    // caso 1: PROJECT unkeyed (sem subject declarado) — não suprime nada, e
    // não é afetado pela supressão ativa acima.
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        provenance: { source_ref: "i20#project-unkeyed", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: {
          title: "project sem subject declarado sobre chave",
          rule: "unkeyed, nao participa da supressao de chave",
        },
      })
    );

    // caso 2 ("vice-versa"): GLOBAL keyed sem par local declarado — não é
    // suprimido pelo PROJECT unkeyed do caso 1, nem pela supressão ativa de
    // outra chave.
    const subjectNeutro = "i20 chave neutra";
    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: subjectNeutro,
        subject_ref: subjectRef(subjectNeutro),
        provenance: { source_ref: "i20#global-neutro", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: { title: "global sem par local", rule: "nao tem project com a mesma chave" },
      })
    );

    const pack = await assembleContext({ projectRoot: a.root, intent: "chave" });
    expect(pack.ok).toBe(true);
    if (!pack.ok) return;

    // a supressão ativa de fato aconteceu.
    expect(pack.pack.items.some((i) => i.sourceRef === "i20#global-ativo")).toBe(false);
    expect(pack.pack.items.some((i) => i.sourceRef === "i20#project-ativo")).toBe(true);

    // e não vazou para o par unkeyed nem para o global sem par local.
    expect(pack.pack.items.some((i) => i.sourceRef === "i20#project-unkeyed")).toBe(true);
    expect(pack.pack.items.some((i) => i.sourceRef === "i20#global-neutro")).toBe(true);
    expect(pack.pack.omitted.some((o) => o.sourceRef === "i20#project-unkeyed")).toBe(false);
    expect(pack.pack.omitted.some((o) => o.sourceRef === "i20#global-neutro")).toBe(false);
  });

  it("I29 — todo item de localPack continua em mixedPack, mesmo com orçamento apertado", async () => {
    const a = await mkProject("i29-a");
    const intent = "propriedade termo alfa termo beta termo gama";

    const camposLocal1 = { title: "propriedade termo alfa local um", rule: "regra i29 local um" };
    const camposLocal2 = { title: "propriedade termo beta local dois", rule: "regra i29 local dois" };
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        provenance: { source_ref: "i29#local-um", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: camposLocal1,
      })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        provenance: { source_ref: "i29#local-dois", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: camposLocal2,
      })
    );

    // orçamento EXATO à soma dos dois locais — nenhuma sobra para o global.
    const orcamentoExato =
      custoDoItem("i29#local-um", camposLocal1) + custoDoItem("i29#local-dois", camposLocal2);

    const localPack = await assembleContext({ projectRoot: a.root, intent, budgetBytes: orcamentoExato });
    expect(localPack.ok).toBe(true);
    if (!localPack.ok) return;
    expect(localPack.pack.items.map((i) => i.sourceRef).sort()).toEqual([
      "i29#local-dois",
      "i29#local-um",
    ]);

    // agora um GLOBAL entra, com score MAIS ALTO que qualquer local (casa
    // com os cinco termos do intent, os locais casam só com dois) — se a
    // fatia global competisse pelo mesmo orçamento na ordem de rank, ela
    // entraria ANTES dos locais e expulsaria um dos dois.
    await initializeGlobalRoot(GLOBAL_ROOT);
    const subjectGlobal = "i29 fato global concorrente";
    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: subjectGlobal,
        subject_ref: subjectRef(subjectGlobal),
        provenance: { source_ref: "i29#global-concorrente", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: {
          title: "propriedade termo alfa termo beta termo gama global",
          rule: "propriedade termo alfa termo beta termo gama global",
        },
      })
    );

    const mixedPack = await assembleContext({ projectRoot: a.root, intent, budgetBytes: orcamentoExato });
    expect(mixedPack.ok).toBe(true);
    if (!mixedPack.ok) return;

    const localRefs = localPack.pack.items.map((i) => i.sourceRef);
    const mixedRefs = new Set(mixedPack.pack.items.map((i) => i.sourceRef));
    expect(localRefs.length).toBeGreaterThan(0);
    for (const ref of localRefs) {
      expect(mixedRefs.has(ref)).toBe(true);
    }
    expect(mixedPack.pack.items.some((i) => i.sourceRef === "i29#global-concorrente")).toBe(false);
  });

  it("I30 — global não ocupa o piso de gotcha nem desloca local: orçamento só cabe os locais", async () => {
    const a = await mkProject("i30-a");
    await initializeGlobalRoot(GLOBAL_ROOT);
    const intent = "orcamento apertado prioridade teste global";

    const camposLocal1 = { title: "orcamento apertado local um", rule: "regra i30 local um" };
    const camposLocal2 = { title: "orcamento apertado local dois", rule: "regra i30 local dois" };
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        provenance: { source_ref: "i30#local-um", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: camposLocal1,
      })
    );
    await publishCanonical(
      a.root,
      gotcha({
        project_id: a.projectId,
        scope: { kind: "project", ref: a.projectId },
        provenance: { source_ref: "i30#local-dois", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: camposLocal2,
      })
    );

    const subjectGlobal = "i30 fato global de score alto";
    await publishCanonical(
      GLOBAL_ROOT,
      gotcha({
        project_id: undefined,
        scope: { kind: "global", ref: null },
        subject: subjectGlobal,
        subject_ref: subjectRef(subjectGlobal),
        provenance: { source_ref: "i30#global-score-alto", producer_id: "test", submitted_at: "2026-09-09T00:00:00Z" },
        content: {
          title: "orcamento apertado prioridade teste global",
          rule: "orcamento apertado prioridade teste global",
        },
      })
    );

    const orcamentoExato =
      custoDoItem("i30#local-um", camposLocal1) + custoDoItem("i30#local-dois", camposLocal2);

    const apertado = await assembleContext({ projectRoot: a.root, intent, budgetBytes: orcamentoExato });
    expect(apertado.ok).toBe(true);
    if (!apertado.ok) return;
    expect(apertado.pack.items.some((i) => i.sourceRef === "i30#local-um")).toBe(true);
    expect(apertado.pack.items.some((i) => i.sourceRef === "i30#local-dois")).toBe(true);
    expect(apertado.pack.items.some((i) => i.sourceRef === "i30#global-score-alto")).toBe(false);
    const omitidoGlobal = apertado.pack.omitted.find((o) => o.sourceRef === "i30#global-score-alto");
    expect(omitidoGlobal?.reason).toBe("BUDGET");
  });
});
