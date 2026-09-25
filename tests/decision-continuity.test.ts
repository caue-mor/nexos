import { afterEach, beforeEach, describe, expect, it } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { randomUUID } from "node:crypto";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { advanceCheckpoint, retryCheckpoint, resolveCheckpointHead, resumeCheckpoint } from "../src/lib/capsule/checkpoint.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { publishContextDecision } from "../src/commands/decision.js";
import { assembleContext } from "../src/lib/context-assembler.js";
import { buildSessionBriefForCwd } from "../src/lib/bootstrap-context.js";
import { classifyAdmission } from "../src/lib/capsule/integrity.js";

const repo = path.resolve(__dirname, "..");
let lab: string, home: string, alpha: string, beta: string;
function cli(cwd: string, args: string[], input?: unknown) {
  const r = spawnSync(process.execPath, [path.join(repo, "dist/index.js"), ...args], {
    cwd, encoding: "utf8", timeout: 15_000,
    input: input === undefined ? undefined : JSON.stringify(input),
    env: { HOME: home, PATH: process.env.PATH, NO_COLOR: "1", CLAUDE_PROJECT_DIR: cwd, TMPDIR: process.env.TMPDIR },
  });
  if (r.error || r.status !== 0) throw new Error(r.error?.message ?? r.stderr);
  return r.stdout;
}
beforeEach(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "dec-continuity-"));
  home = path.join(lab, "home"); alpha = path.join(lab, "alpha"); beta = path.join(lab, "beta");
  await fs.ensureDir(home);
  for (const root of [alpha, beta]) {
    await fs.ensureDir(path.join(root, "src/deep"));
    // P1.1 (nexos://decision/p1-1-resolver-fronteira-e-binding): fronteira
    // antes de identidade — resolver a partir de src/deep precisa de um
    // marcador próprio da raiz.
    await fs.writeJson(path.join(root, "package.json"), { name: path.basename(root) });
    await initializeCapsule(root, { projectName: path.basename(root) });
  }
});
afterEach(async () => { await fs.remove(lab); });

/** Chaves listadas no índice de continuidade do recall (`Decisões de continuidade fora deste bloco … — grupo: a, b · grupo: c`). */
const indexKeys = (out: string): string[] => {
  const linha = out.split("\n\n").find((l) => l.startsWith("Decisões de continuidade fora")) ?? "";
  const grupos = linha.split(" — ").slice(1).join(" — ");
  return grupos === "" ? [] : grupos.split(" · ").flatMap((g) => g.replace(/^[^:]+: /, "").split(", "));
};
/** Chaves de Decision RENDERIZADAS no corpo (linha `source_ref: nexos://decision/<chave>`) — nunca via índice/contagem. */
const bodyKeys = (out: string, prefixo: string): string[] =>
  [...out.matchAll(new RegExp(`nexos://decision/(${prefixo}\\S*)`, "g"))].map((m) => m[1]!);
const create = (cwd: string, key: string, extra = {}) => publishContextDecision({ cwd, key, set: `Restrição ${key}: preservar os dados existentes.`, type: "constraint", source: "fixture://conversation/turn-1", applicability: "Durante o trabalho neste projeto", ...extra });

describe("continuidade por checkpoint e Decision, sem autoridade adicional", () => {
  it("deriva uma origem estável de transições/refinamento/retry; tarefa nova ganha outra", async () => {
    const first = await advanceCheckpoint({ projectRoot: alpha, state: "PENDING", statement: "Pedido inicial" });
    if (!first.ok) throw new Error("fixture não iniciou");
    for (const state of ["READY", "RUNNING", "BLOCKED", "READY", "RUNNING", "FAILED"] as const) {
      const result = await advanceCheckpoint({ projectRoot: alpha, state, statement: "Descoberta refinou o caminho" });
      expect(result.ok).toBe(true);
      expect(await resolveCheckpointHead(alpha)).toMatchObject({ originCheckpointId: first.record.id });
    }
    expect((await retryCheckpoint({ projectRoot: alpha, maxAttempts: 3 })).ok).toBe(true);
    expect(await resolveCheckpointHead(alpha)).toMatchObject({ originCheckpointId: first.record.id, attempt: 2 });
    await advanceCheckpoint({ projectRoot: alpha, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: alpha, state: "FAILED" });
    const next = await advanceCheckpoint({ projectRoot: alpha, state: "READY", statement: "Outro trabalho" });
    if (!next.ok) throw new Error("fixture não iniciou trabalho novo");
    expect(await resolveCheckpointHead(alpha)).toMatchObject({ originCheckpointId: next.record.id, attempt: 1 });
    expect(next.record.id).not.toBe(first.record.id);
  });

  it("CLI produz; boot e recall em novos processos consomem por projeto; revogação substitui o head", () => {
    for (const root of [alpha, beta]) {
      const name = path.basename(root);
      cli(root, ["decision", "--key", name, "--set", `Preservar marcador ${name}`, "--type", "constraint", "--source", `fixture://conversation/${name}`, "--applicability", `Somente projeto ${name}`, "--conditions", "Até revisão explícita"]);
    }
    const session = randomUUID();
    for (const root of [alpha, beta]) {
      const name = path.basename(root), other = root === alpha ? "beta" : "alpha";
      const cwd = path.join(root, "src/deep");
      const start = cli(cwd, ["claude-session-start"], { hook_event_name: "SessionStart", source: "startup", cwd, session_id: session });
      const recall = cli(cwd, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", cwd, session_id: session, prompt: "Qual o andamento?" });
      expect(start).toContain(`Preservar marcador ${name}`);
      expect(start).not.toContain(`Preservar marcador ${other}`);
      /** Prompt sem sobreposição lexical: a decisão é NOMEADA no índice (nunca some), o corpo não é injetado. */
      expect(indexKeys(recall)).toEqual([name]);
      expect(recall).not.toContain(other);
      expect(recall).not.toContain("CONTINUITY_CONTEXT_INCOMPLETE");
      const relevante = cli(cwd, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", cwd, session_id: randomUUID(), prompt: `preservar marcador ${name}` });
      expect(relevante).toContain(`Preservar marcador ${name}`);
      /**
       * P1.5 (nexos://decision/p1-5-hot-brief) — SessionStart é HOT (título +
       * id + regra truncada); `decision_conditions` ("Até revisão
       * explícita") não é a regra principal e some do brief compacto.
       *
       * nexos://decision/recall-formato-compacto-revisa-p1-5 — revisa a
       * cláusula de escopo de p1-5-hot-brief que dizia "UserPromptSubmit
       * continua completo": aquilo delimitava o P1.5 (SessionStart), não era
       * regra de produto. `claude-memory-recall` agora TAMBÉM é compacto
       * (`memory-recall.ts:formatarItem`) — mas decisão ativa mostra a
       * regra (`decision`) MAIS uma linha própria de `decision_conditions`
       * quando presente, então "Até revisão explícita" continua aparecendo
       * aqui, só que via uma linha dedicada, não o dump do record inteiro.
       */
      expect(relevante).toContain("Até revisão explícita");
    }
    const [head] = JSON.parse(cli(alpha, ["decision"])) as { id: string }[];
    cli(alpha, ["decision", "--revoke", head!.id, "--source", "fixture://conversation/revocation", "--why", "Condição deixou de existir"]);
    const revoked = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", cwd: alpha, session_id: session, prompt: "Continue o trabalho" });
    expect(revoked).toContain("revoked");
    expect(revoked).toContain("Condição deixou de existir");
    expect(() => cli(alpha, ["decision", "--key", "alpha", "--set", "Atualização atrasada", "--type", "constraint", "--source", "fixture://stale", "--applicability", "projeto", "--expected", head!.id])).toThrow(/HEAD_CHANGED/);
  });

  it("escopo do trabalho atravessa refinamento e não vaza para tarefa nova ou projeto B", async () => {
    await advanceCheckpoint({ projectRoot: alpha, state: "PENDING", statement: "Trabalho A" });
    const record = await create(alpha, "temporaria", { work: true });
    await advanceCheckpoint({ projectRoot: alpha, state: "READY", statement: "Refinamento" });
    let result = await assembleContext({ projectRoot: alpha, intent: "sem coincidência lexical" });
    expect(result.ok && result.pack.items.some((i) => i.id === record.id)).toBe(true);
    result = await assembleContext({ projectRoot: beta });
    expect(result.ok && result.pack.items.some((i) => i.id === record.id)).toBe(false);
    await advanceCheckpoint({ projectRoot: alpha, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: alpha, state: "FAILED" });
    await advanceCheckpoint({ projectRoot: alpha, state: "READY", statement: "Trabalho B" });
    result = await assembleContext({ projectRoot: alpha });
    expect(result.ok && result.pack.items.some((i) => i.id === record.id)).toBe(false);
  });

  it("FAILED mantém contexto de objetivo em todos consumidores; retry preserva e trabalho novo substitui", async () => {
    await advanceCheckpoint({ projectRoot: alpha, state: "PENDING", statement: "Trabalho A" });
    const record = await create(alpha, "falha", { work: true });
    for (const state of ["READY", "RUNNING", "FAILED"] as const) {
      expect((await advanceCheckpoint({ projectRoot: alpha, state })).ok).toBe(true);
    }
    const check = async (current: boolean) => {
      const pack = await assembleContext({ projectRoot: alpha });
      expect(pack.ok && pack.pack.items.some((i) => i.id === record.id)).toBe(current);
      const resumed = await resumeCheckpoint(alpha);
      expect(resumed.kind === "RESUMED" && resumed.context?.items.some((i) => i.id === record.id)).toBe(current);
      const sid = randomUUID();
      const start = cli(alpha, ["claude-session-start"], { hook_event_name: "SessionStart", source: "startup", cwd: alpha, session_id: sid });
      const recall = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", cwd: alpha, session_id: sid, prompt: "Continue" });
      expect(start.includes("Restrição falha")).toBe(current);
      expect(indexKeys(recall).includes("falha")).toBe(current);
      const listing = JSON.parse(cli(alpha, ["decision"])) as { id: string; applicability: string }[];
      expect(listing.find((r) => r.id === record.id)?.applicability).toBe(current ? "current" : "historical");
    };
    await check(true);
    // O writer compartilha o contrato: a tentativa falhou, mas a restrição
    // descoberta nessa falha ainda pode ser registrada para o mesmo objetivo.
    const afterFailure = await create(alpha, "apos-falha", { work: true });
    expect(afterFailure.content.continuity?.work_ref).toBe(record.content.continuity?.work_ref);
    expect((await retryCheckpoint({ projectRoot: alpha, maxAttempts: 3 })).ok).toBe(true);
    await check(true);
    await advanceCheckpoint({ projectRoot: alpha, state: "RUNNING" });
    await advanceCheckpoint({ projectRoot: alpha, state: "FAILED" });
    await advanceCheckpoint({ projectRoot: alpha, state: "READY", statement: "Outro objetivo" });
    await check(false);
  }, 30_000);

  it("SUCCEEDED deixa a decisão apenas na listagem histórica, inclusive na retomada", async () => {
    await advanceCheckpoint({ projectRoot: alpha, state: "PENDING", statement: "Trabalho concluído" });
    const record = await create(alpha, "concluida", { work: true });
    // Fixture da leitura de estado; não é evidência de execução de usuário.
    for (const state of ["READY", "RUNNING", "VERIFYING", "SUCCEEDED"] as const) {
      expect((await advanceCheckpoint({ projectRoot: alpha, state })).ok).toBe(true);
    }
    const pack = await assembleContext({ projectRoot: alpha });
    expect(pack.ok && pack.pack.items.some((i) => i.id === record.id)).toBe(false);
    expect(pack.ok && !!pack.pack.continuityIncomplete).toBe(false);
    const resumed = await resumeCheckpoint(alpha);
    expect(resumed.kind === "RESUMED" && resumed.context?.items.some((i) => i.id === record.id)).toBe(false);
    const sid = randomUUID();
    for (const output of [
      cli(alpha, ["claude-session-start"], { hook_event_name: "SessionStart", source: "startup", cwd: alpha, session_id: sid }),
      cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", cwd: alpha, session_id: sid, prompt: "Continue" }),
    ]) expect(output).not.toContain("Restrição concluida");
    expect(JSON.parse(cli(alpha, ["decision"]))).toEqual([expect.objectContaining({ id: record.id, applicability: "historical" })]);
    await expect(create(alpha, "tardia", { work: true })).rejects.toThrow(/SUCCEEDED/);
  });

  it.each(["predecessor ausente", "cadeia vazia"])("%s torna o escopo indeterminado e avisa sem injetar a decisão", async (corruption) => {
    const first = await advanceCheckpoint({ projectRoot: alpha, state: "PENDING", statement: "Trabalho A" });
    if (!first.ok) throw new Error("fixture não iniciou");
    const record = await create(alpha, "indeterminada", { work: true });
    for (const state of ["READY", "RUNNING", "FAILED"] as const) await advanceCheckpoint({ projectRoot: alpha, state });
    await retryCheckpoint({ projectRoot: alpha, maxAttempts: 3 });
    await fs.remove(corruption === "cadeia vazia" ? forProject(alpha).familyDir("ProjectCheckpoint") : forProject(alpha).recordPath("ProjectCheckpoint", first.record.id));
    expect(await resolveCheckpointHead(alpha)).toMatchObject({ kind: corruption === "cadeia vazia" ? "EMPTY" : "UNHEALTHY" });
    const pack = await assembleContext({ projectRoot: alpha });
    expect(pack.ok && pack.pack.items.some((i) => i.id === record.id)).toBe(false);
    expect(pack.ok && pack.pack.continuityIncomplete).toBe(true);
    expect(await resumeCheckpoint(alpha)).toMatchObject({ continuityIncomplete: true });
    const brief = await buildSessionBriefForCwd({ cwd: alpha });
    expect(brief.brief.warnings).toContain("CONTINUITY_CONTEXT_INCOMPLETE");
    const sid = randomUUID();
    const start = cli(alpha, ["claude-session-start"], { hook_event_name: "SessionStart", source: "startup", cwd: alpha, session_id: sid });
    const recall = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", cwd: alpha, session_id: sid, prompt: "Continue" });
    const search = cli(alpha, ["memory", "--search", "indeterminada"]);
    const checkpoint = cli(alpha, ["checkpoint"]);
    /**
     * V3 — `start` é "o brief" (SessionStart `additionalContext`, montado por
     * `buildAdditionalContext`): o código cru virou frase traduzida
     * (`translateWarning`), nunca mais aparece bare. `recall`/`search`/
     * `checkpoint` NÃO são o brief — mantêm o formato pré-existente
     * (`CONTINUITY_CONTEXT_INCOMPLETE: <explicação>`, ver `memory-recall.ts`/
     * `commands/memory.ts`/`commands/checkpoint.ts`), fora do escopo do V3.
     */
    expect(start).not.toContain("CONTINUITY_CONTEXT_INCOMPLETE");
    expect(start).toContain("memória de continuidade incompleta");
    for (const output of [recall, search, checkpoint]) {
      expect(output).toContain("CONTINUITY_CONTEXT_INCOMPLETE");
      expect(output).not.toContain("Restrição indeterminada");
    }
    expect(JSON.parse(cli(alpha, ["decision"]))).toEqual([expect.objectContaining({ id: record.id, applicability: "undetermined" })]);
    await expect(create(alpha, "incerta", { work: true })).rejects.toThrow(/íntegra/);
  });

  it("CAS impede dois updates do mesmo head e não atribui aprovação ao humano", async () => {
    const first = await create(alpha, "concorrente");
    const results = await Promise.allSettled([
      create(alpha, "concorrente", { expected: first.id, set: "Nova condição" }),
      publishContextDecision({ cwd: alpha, revoke: first.id, source: "fixture://revocation", why: "Revogado" }),
    ]);
    expect(results.filter((r) => r.status === "fulfilled")).toHaveLength(1);
    expect(results.filter((r) => r.status === "rejected")).toHaveLength(1);
    expect(first.origin).toBe("agent");
    expect(classifyAdmission(first)).toBe("ADMITTED");
    expect(classifyAdmission({ ...first, admission: { ...first.admission, approved_by: "human:inventado" } })).toBe("UNTRUSTED_RAW");
  });

  it("budget não apaga restrição/revogação silenciosamente, inclusive em prompts repetidos", async () => {
    /**
     * nexos://decision/recall-formato-compacto-revisa-p1-5 — o recall agora
     * é compacto (`memory-recall.ts:formatarItem`, `corta()` reduz QUALQUER
     * campo a ≤160 bytes antes de somar). UM record gigante
     * ("X".repeat(4000)) não estoura mais sozinho o teto de 4096 bytes de
     * `renderizar()` — o corpo inteiro que forçava o overflow foi
     * exatamente o que o formato compacto para de injetar. A prova de
     * "budget não apaga em silêncio" continua válida, só que agora é
     * CONTAGEM de decisões (cada uma pequena) que precisa passar do teto,
     * não o tamanho de uma só — ~276 bytes/item compacto quando a regra
     * bate o teto de truncagem (`corta()`, 160 chars); 25 records passa
     * de 4096 com folga — texto curto por item, como o resto do arquivo
     * usa, NÃO estoura sozinho.
     */
    for (let i = 0; i < 25; i++) {
      await create(alpha, `grande-${i}`, { set: `Restrição grande ${i}: ${"Y".repeat(150)}` });
    }
    const brief = await buildSessionBriefForCwd({ cwd: alpha, knowledgeBudgetBytes: 1 });
    expect(brief.brief.warnings).toContain("CONTINUITY_CONTEXT_INCOMPLETE");
    const sid = randomUUID();
    const primeiro = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
    /** Omissão ENUMERADA não é contexto incompleto: as 25 chaves estão nomeadas. */
    expect(primeiro).not.toContain("CONTINUITY_CONTEXT_INCOMPLETE");
    expect(indexKeys(primeiro).sort()).toEqual(Array.from({ length: 25 }, (_, i) => `grande-${i}`).sort());
    expect(Buffer.byteLength(primeiro)).toBeLessThan(6000);
    /** Mesma sessão, nada mudou: silêncio, não repetição. */
    expect(cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" })).toBe("");
    /** Revogação no meio da sessão, sem relação lexical com o prompt: aparece no prompt seguinte, com motivo. */
    const [alvo] = JSON.parse(cli(alpha, ["decision"])) as { id: string }[];
    cli(alpha, ["decision", "--revoke", alvo!.id, "--source", "fixture://budget/revocation", "--why", "Motivo da revogação no meio da sessão"]);
    const depois = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
    expect(depois).toContain("revoked");
    expect(depois).toContain("Motivo da revogação no meio da sessão");
    /** Compactação apaga o contexto do modelo: SessionStart(compact) zera o marker e o índice volta. */
    cli(alpha, ["claude-session-start"], { hook_event_name: "SessionStart", source: "compact", cwd: alpha, session_id: sid });
    const aposCompact = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
    expect(indexKeys(aposCompact)).toHaveLength(25);
  }, 60_000);

  /**
   * CONTRATO NOVO — nexos://decision/indice-de-continuidade-poda-por-relevancia
   * (pedido do dono em 2026-09-19, aprovado pelo orquestrador).
   *
   * Este teste protegia quatro garantias quando MUITAS chaves estouravam o
   * teto de 4096 bytes e o índice degradava para uma contagem sem nomes.
   * Com a poda por relevância esse gatilho não existe mais: nomeia-se até
   * ~600 bytes, então muitas chaves nunca somam 4096.
   *
   *     A PODA SUBSTITUIU O COMPORTAMENTO QUE ESTE TESTE PROTEGIA
   *
   * O que SAIU, explicitamente e não por omissão:
   *   - o gatilho "60 chaves longas estouram o teto"
   *   - a contagem CEGA (`fora deste bloco: 60`, nenhum nome), que virou
   *     contagem COM os mais relevantes nomeados
   *   - `CONTINUITY_CONTEXT_INCOMPLETE` neste cenário: ele passou a
   *     significar só NÃO-RECUPERÁVEL, nunca não-exibido
   *     (`NÃO NOMEADO != NÃO RECUPERÁVEL`)
   *
   * O que FICA, garantia por garantia, nomeada abaixo.
   */
  it("G1 · o total nunca some: quantas existem fora do bloco fica declarado", async () => {
    for (let i = 0; i < 60; i++) {
      await create(alpha, `${String(i).padStart(2, "0")}-${"k".repeat(76)}`);
    }
    const sid = randomUUID();
    const recall = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
    expect(recall).toMatch(/Decisões de continuidade fora deste bloco \(60;/);
  }, 60_000);

  it("G2 · a poda é declarada: quantas foram nomeadas e quantas não", async () => {
    for (let i = 0; i < 60; i++) {
      await create(alpha, `${String(i).padStart(2, "0")}-${"k".repeat(76)}`);
    }
    const sid = randomUUID();
    const recall = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
    expect(recall).toMatch(/\d+ mais prováveis para esta tarefa, \d+ não nomeadas/);
  }, 60_000);

  it("G3 · o bloco continua pequeno mesmo com 60 decisões fora dele", async () => {
    for (let i = 0; i < 60; i++) {
      await create(alpha, `${String(i).padStart(2, "0")}-${"k".repeat(76)}`);
    }
    const sid = randomUUID();
    const recall = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
    expect(Buffer.byteLength(recall)).toBeLessThan(2000);
  }, 60_000);

  /**
   * G4 — a garantia do contraexemplo do verifier, adaptada e PROVADA.
   *
   *   SÓ QUEM APARECEU PODE SER MARCADO COMO MOSTRADO
   *
   * O contraexemplo original: nenhuma das 60 pode ganhar `idx:` por ter sido
   * apenas CONTADA, senão a chamada seguinte a trata como já indexada e ela
   * some para sempre. Com poda, quem é nomeada FOI exibida, então marcar é
   * correto; o que não pode é uma NÃO NOMEADA ser marcada.
   *
   * A primeira versão deste teste asseria `expect(segunda).not.toBe("")`.
   * A verificação independente derrubou isso com uma mutação de uma linha
   * (`foraNomeadas = porRelevancia.slice(0, nomeadas.length + 2)`, duas a
   * mais do que apareceram): a suíte inteira seguiu VERDE com duas decisões
   * perdidas para sempre na sessão. "Não vazio" passa com qualquer coisa.
   *
   *   ASSERÇÃO FRACA PASSA NO BUG QUE ELA NOMEIA PROIBIR
   *
   * Agora compara CONJUNTOS DE CHAVES: o que não foi nomeado na 1ª chamada
   * precisa reaparecer por NOME nas chamadas seguintes. Medido: o corpo
   * drena ~10 por chamada, então 53 não nomeadas fecham em ~6; 10 chamadas
   * dão margem sem esconder regressão — se algo for marcado sem aparecer,
   * ele nunca entra em `mudadas` e o conjunto final fica incompleto.
   */
  it("G4 · decisão não nomeada reaparece por nome; nenhuma é marcada sem ter sido exibida", async () => {
    const PREFIXO = "g4";
    for (let i = 0; i < 60; i++) {
      await create(alpha, `${PREFIXO}-${String(i).padStart(2, "0")}-${"k".repeat(70)}`);
    }
    const sid = randomUUID();
    const chamar = (): string =>
      cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });

    const primeira = chamar();
    const nomeadasNaPrimeira = new Set(indexKeys(primeira).filter((k) => k.startsWith(PREFIXO)));
    expect(nomeadasNaPrimeira.size, "a poda tem que deixar alguém de fora para este teste valer").toBeGreaterThan(0);
    expect(nomeadasNaPrimeira.size).toBeLessThan(60);

    /** O conjunto em risco: existe, não foi nomeado, e precisa reaparecer. */
    const emRisco = new Set(
      Array.from({ length: 60 }, (_, i) => `${PREFIXO}-${String(i).padStart(2, "0")}-${"k".repeat(70)}`).filter(
        (k) => !nomeadasNaPrimeira.has(k)
      )
    );
    expect(emRisco.size).toBeGreaterThan(0);

    const vistas = new Set<string>();
    for (let n = 0; n < 10 && vistas.size < emRisco.size; n++) {
      const saida = chamar();
      for (const k of [...bodyKeys(saida, PREFIXO), ...indexKeys(saida)]) {
        if (emRisco.has(k)) vistas.add(k);
      }
    }

    const sumidas = [...emRisco].filter((k) => !vistas.has(k));
    expect(
      sumidas,
      `${sumidas.length} decisão(ões) não nomeada(s) nunca reapareceram — marcadas como mostradas sem terem sido exibidas`
    ).toEqual([]);
  }, 120_000);

  /**
   * NÃO NOMEADA != MUDADA — linha de base da janela (`base:<id>`).
   *
   * MEDIDO 24/09 numa cópia do Store deste repo: sem a base, a Decision que a
   * poda deixou fora do índice caía em `mudadas` e ia ao CORPO nas chamadas
   * seguintes — 58 corpos e INCOMPLETE em 9 de 10 prompts, inclusive "GO".
   * A não nomeada segue sendo nomeada (G4 acima), mas só pela chave.
   */
  it("E1 · não nomeada e não mudada volta só pelo nome, sem corpo e sem INCOMPLETE; nova de verdade vai ao corpo", async () => {
    for (let i = 0; i < 60; i++) {
      await create(alpha, `e1-${String(i).padStart(2, "0")}-${"k".repeat(70)}`);
    }
    const sid = randomUUID();
    const chamar = (): string =>
      cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });

    chamar();
    const segunda = chamar();
    expect(bodyKeys(segunda, "e1-"), "não nomeada virou corpo como se tivesse mudado").toEqual([]);
    expect(segunda).not.toContain("CONTINUITY_CONTEXT_INCOMPLETE");
    expect(indexKeys(segunda).length, "a não nomeada tem que continuar sendo nomeada pelo índice").toBeGreaterThan(0);

    await create(alpha, "e1-nova-de-verdade");
    const terceira = chamar();
    expect(bodyKeys(terceira, "e1-nova"), "Decision nova depois da base tem que vir como corpo").toEqual(["e1-nova-de-verdade"]);
  }, 120_000);

  it("rajada pós-índice: Decision cortada pelo orçamento do corpo nunca ganha idx: — drena inteira nas chamadas seguintes", async () => {
    /** 1ª chamada da sessão: 1 Decision só, índice consumido (marker passa a ter idx: para ela). */
    await create(alpha, "primeira-chamada");
    const sid = randomUUID();
    const primeira = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
    expect(indexKeys(primeira)).toEqual(["primeira-chamada"]);

    /**
     * Rajada no MESMO turno: 30 Decisions novas, ~276 B cada renderizada
     * (mesmo padrão de "budget não apaga" acima — regra bate o teto de 160
     * chars do `corta()`) — 4096 B / ~276 B ≈ 14 cabem, ~16 ficam de fora.
     * É o contraexemplo exato do verifier (14/30 cabem, 16 cortadas).
     */
    for (let i = 0; i < 30; i++) {
      await create(alpha, `rajada-${String(i).padStart(2, "0")}`, { set: `Restrição rajada ${i}: ${"Z".repeat(150)}` });
    }

    let cortouEmAlgumaChamada = false;
    const vistas = new Set<string>();
    for (let volta = 0; volta < 6 && vistas.size < 30; volta++) {
      const recall = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "Continue" });
      if (recall.includes("não couberam")) cortouEmAlgumaChamada = true;
      for (const k of bodyKeys(recall, "rajada-")) vistas.add(k);
      if (recall === "") break;
    }

    /** (b) a chamada que corta traz a linha de contagem — nunca só o INCOMPLETE genérico sozinho. */
    expect(cortouEmAlgumaChamada).toBe(true);
    /** (a) a união do que apareceu em CORPO nas chamadas seguintes cobre as 30 — nenhuma ficou perdida atrás de um `idx:` que não mereceu. */
    expect(vistas.size).toBe(30);
  }, 60_000);

  it("R6/P2 — busca por assunto encontra Decision de continuidade; assunto sem sobreposição avisa em vez de omitir", () => {
    cli(alpha, ["decision", "--key", "zebralimite", "--set", "Marcador ZEBRALIMITE: preservar os dados", "--type", "constraint", "--source", "fixture://r6", "--applicability", "projeto"]);

    const hit = cli(alpha, ["memory", "--search", "zebralimite"]);
    expect(hit).toContain("ZEBRALIMITE");
    expect(hit).toContain("active");
    expect(hit).not.toContain("nenhum record casou");

    const [head] = JSON.parse(cli(alpha, ["decision"])) as { id: string }[];
    cli(alpha, ["decision", "--revoke", head!.id, "--source", "fixture://r6/revocation", "--why", "Condição mudou"]);

    const revokedHit = cli(alpha, ["memory", "--search", "zebralimite"]);
    expect(revokedHit).toContain("revoked");
    expect(revokedHit).toContain("Condição mudou");

    const noMatch = cli(alpha, ["memory", "--search", "assuntoinexistente"]);
    expect(noMatch).toContain("nexos decision");
    expect(noMatch).not.toContain("ZEBRALIMITE");
  });

  it("R6/P2 — matchedTerms da Decision de continuidade é a sobreposição lexical real, nunca fabricada", async () => {
    const record = await create(alpha, "zebralimite");

    const hit = await assembleContext({ projectRoot: alpha, intent: "zebralimite" });
    const hitItem = hit.ok ? hit.pack.items.find((i) => i.id === record.id) : undefined;
    expect(hitItem?.matchedTerms).toContain("zebralimite");

    const miss = await assembleContext({ projectRoot: alpha, intent: "outracoisa" });
    const missItem = miss.ok ? miss.pack.items.find((i) => i.id === record.id) : undefined;
    expect(missItem).toBeDefined();
    expect(missItem?.matchedTerms).toEqual([]);
    /**
     * G2.1 REVISADO (`docs/pos-mvp-matriz-capabilities.md` §2) — o score de
     * uma Decision sem sobreposição nenhuma é FINITO (0), não mais
     * `Number.MAX_SAFE_INTEGER`. Presença no pack continua garantida (linha
     * acima); o que mudou é que ela para de vencer o ranking por definição.
     */
    expect(missItem?.score).toBe(0);
  });

  it("G2.1 REVISADO — Decision de continuidade com UM termo incidental não bate um match específico de vários termos", async () => {
    /**
     * MEDIDO no Store real (golden set, `docs/memory-eval/golden.yaml`):
     * decisões de continuidade são parágrafos longos com vocabulário
     * genérico de engenharia — "arquivo" aqui é o mesmo tipo de colisão
     * incidental que derrubava recall@5 para 4,7%. `zzqui` é um marcador
     * único desta fixture, nunca aparece em outro record.
     */
    const decisao = await create(alpha, "constrangimento-generico", {
      set: "Regra geral do projeto: sempre validar o arquivo inteiro antes de prosseguir com qualquer commit.",
    });
    cli(alpha, [
      "gotcha",
      "--title", "zzqui byte NUL silencia o grep no arquivo inteiro",
      "--rule", "ZZQUI: byte NUL silencia o grep",
      "--cause", "byte NUL no meio do arquivo depois de zzqui",
      "--evidence", "medido com fixture zzqui real",
    ]);

    const r = await assembleContext({ projectRoot: alpha, intent: "zzqui byte nul grep arquivo inteiro" });
    if (!r.ok) throw new Error("assembleContext falhou na fixture");
    const hits = r.pack.items.filter((i) => i.matchedTerms.length > 0);
    const rankGotcha = hits.findIndex((i) => i.title.includes("zzqui"));
    const rankDecisao = hits.findIndex((i) => i.id === decisao.id);

    expect(rankGotcha).toBeGreaterThanOrEqual(0);
    /** A decisão pode ou não casar por "arquivo"/"inteiro"; se casar, vem DEPOIS do match específico, nunca antes. */
    if (rankDecisao !== -1) expect(rankGotcha).toBeLessThan(rankDecisao);

    const itemDecisao = r.pack.items.find((i) => i.id === decisao.id);
    expect(itemDecisao?.score).not.toBe(Number.MAX_SAFE_INTEGER);
  });

  it("recall-continuidade-indice-por-janela — DISPLAY DEDUPE != RECALL/APPLICATION: Decision já mostrada reaparece COMPACTA num prompt posterior relevante; silêncio em prompt neutro", async () => {
    const sid = randomUUID();
    await create(alpha, "producao");

    /** (a) primeira chamada relevante nesta sessão: corpo completo, disclaimer de status presente. */
    const primeira = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "preservar os dados existentes em producao" });
    expect(bodyKeys(primeira, "producao")).toEqual(["producao"]);
    expect(primeira).toContain("contexto relatado pelo agente; não é grant");

    /** (b) prompt SEM sobreposição léxica: já mostrada não é "de plantão" — fica em silêncio, não reaparece por inércia. */
    const neutro = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "qual a previsão do tempo para amanhã" });
    expect(neutro).not.toContain("producao");

    /** (a) prompt POSTERIOR, de novo relevante, mesma sessão: reaparece — mas COMPACTA (sem disclaimer, sem decision_conditions), nunca dropada pelo dedup comum. */
    const depois = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "preservar os dados existentes em producao de novo" });
    expect(bodyKeys(depois, "producao")).toEqual(["producao"]);
    expect(depois).not.toContain("contexto relatado pelo agente; não é grant");
  });

  it("recall-continuidade-indice-por-janela — (c) Decision nova E lexicalmente relevante no MESMO turno não duplica (mudada exclui reaparição)", async () => {
    const sid = randomUUID();
    /** Consome a primeira chamada da janela (índice) com um tópico sem termo em comum com "duplo" abaixo. */
    await create(alpha, "outra", { set: "Restrição outra: nunca commitar segredo em texto puro." });
    cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "revisar o pipeline de deploy" });

    /** Publicada DEPOIS da 1ª chamada — nem indexada nem vista (entra em `mudadas`) — e o prompt do MESMO turno bate >=2 termos do próprio conteúdo dela (entra em `top`/`qualifica()` também). */
    await create(alpha, "duplo");
    const turno = cli(alpha, ["claude-memory-recall"], { hook_event_name: "UserPromptSubmit", session_id: sid, cwd: alpha, prompt: "preservar os dados existentes do duplo" });

    const ocorrencias = (turno.match(/nexos:\/\/decision\/duplo/g) ?? []).length;
    expect(ocorrencias).toBe(1);
  });
});
