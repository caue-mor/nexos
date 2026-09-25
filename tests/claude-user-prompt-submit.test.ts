/**
 * FATIA 1 / PASSO 3 — UserPromptSubmit vira canal de DELTA.
 *
 *   REPEAT EVERY PROMPT != PRESENT ONCE, THEN REPORT CHANGE
 *   STORE = AUTORIDADE  ·  TMP = PRESENTATION CACHE (fingerprint, nunca conteúdo)
 *
 * Os 8 cenários exigidos pelo dono, um `it` por item da lista. Onde a prova
 * exige mostrar que o mecanismo importa (não só que o caminho feliz funciona),
 * o teste inclui o CONTRAFACTUAL: o que aconteceria se a chave de cache não
 * isolasse sessão/projeto, ou se o cache fosse tratado como autoridade.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { init } from "../src/commands/init.js";
import { state } from "../src/commands/state.js";
import { resolveProject } from "../src/lib/project-resolver.js";
import { runSessionStartAdapter, buildAdditionalContext, readProjectName } from "../src/host/claude/session-start.js";
import { buildSessionBriefForCwd } from "../src/lib/bootstrap-context.js";
import {
  runUserPromptSubmitAdapter,
  __testing,
  type UserPromptSubmitHookInput,
} from "../src/host/claude/user-prompt-submit.js";

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

const payload = (root: string, sessionId: string, over: Partial<UserPromptSubmitHookInput> = {}) => ({
  hook_event_name: "UserPromptSubmit",
  session_id: sessionId,
  cwd: root,
  prompt: "continua",
  ...over,
});

const chamar = (root: string, sessionId: string, over: Partial<UserPromptSubmitHookInput> = {}) =>
  runUserPromptSubmitAdapter(payload(root, sessionId, over), { CLAUDE_PROJECT_DIR: root });

async function cacheFilePara(root: string, sessionId: string): Promise<string> {
  const resolution = await resolveProject({ cwd: root });
  return __testing.presentationCacheFile(resolution.bootstrapLocator, sessionId);
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "ups-delta-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

// ─── 1 · SessionStart contém a base uma vez ─────────────────────────────────

describe("1 · SessionStart apresenta a base", () => {
  it("additionalContext traz o current_state — a base que o UPS não deve repetir", async () => {
    const root = await novoProjeto("p1");
    await silencioso(() => state({ cwd: root, set: "fase 1", next: "seguir" }));

    const { brief } = await buildSessionBriefForCwd({ cwd: root });
    const projectName = await readProjectName(brief, root);
    const additionalContext = buildAdditionalContext(brief, projectName);

    expect(additionalContext).toContain("Estado: fase 1");
    // usa o adapter real, não só o builder, para provar o caminho automático:
    const r = await runSessionStartAdapter(
      { hook_event_name: "SessionStart", source: "startup", session_id: "boot-1", cwd: root },
      { CLAUDE_PROJECT_DIR: root }
    );
    expect(r.additionalContext).toContain("Estado: fase 1");
  });
});

// ─── 2 · Três UPS consecutivos sem alteração NÃO repetem current_state ──────

describe("2 · silêncio quando nada muda", () => {
  it("1ª chamada reemite (cache ausente), 2ª e 3ª ficam UNCHANGED", async () => {
    const root = await novoProjeto("p2");
    await silencioso(() => state({ cwd: root, set: "estado fixo", next: "nao muda" }));

    const r1 = await chamar(root, "s-fixo");
    const r2 = await chamar(root, "s-fixo");
    const r3 = await chamar(root, "s-fixo");

    expect(r1.state).toBe("DELTA");
    if (r1.state === "DELTA") expect(r1.text).toContain("Estado: estado fixo");

    expect(r2.state).toBe("UNCHANGED");
    expect(r3.state).toBe("UNCHANGED");

    /**
     * Contrafactual: sem a chave de sessão isolando as chamadas (ex.: cache
     * sempre vazio, doutrina anterior), as 3 chamadas teriam sido idênticas a
     * r1 — DELTA nas três. `r2`/`r3` diferentes de `r1` É a prova de que o
     * mecanismo, e não coincidência, produziu o silêncio.
     */
    expect(r2).not.toEqual(r1);
  });
});

// ─── 3 · Mudança real produz delta ──────────────────────────────────────────

describe("3 · mudança real de project_state", () => {
  it("current_state e next_action mudam → delta mostra só o NOVO, nunca o antigo", async () => {
    const root = await novoProjeto("p3");
    await silencioso(() => state({ cwd: root, set: "estado 1", next: "fazer x" }));
    await chamar(root, "s-muda"); // prime — reemite o snapshot inicial

    await silencioso(() => state({ cwd: root, set: "estado 2", next: "fazer y" }));
    const r = await chamar(root, "s-muda");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") {
      expect(r.text).toContain("Estado atualizado: estado 2");
      expect(r.text).toContain("Próxima ação atualizada: fazer y");
      // O CORAÇÃO do teste: o valor ANTIGO já está no boot — repeti-lo aqui É o defeito.
      expect(r.text).not.toContain("estado 1");
      expect(r.text).not.toContain("fazer x");
    }

    // contrafactual: uma 3ª chamada sem mudança nenhuma volta a ficar muda.
    const r2 = await chamar(root, "s-muda");
    expect(r2.state).toBe("UNCHANGED");
  });
});

// ─── 4 · Nova decisão pendente produz delta ─────────────────────────────────

describe("4 · decisão humana pendente aparece", () => {
  it("decision_question novo vira delta, e o axis anterior é reportado como removido — evento explícito, sem repetir o antigo", async () => {
    const root = await novoProjeto("p4");
    await silencioso(() => state({ cwd: root, set: "estado", next: "fazer x" }));
    await chamar(root, "s-decisao"); // prime

    await silencioso(() => state({ cwd: root, decision: "usar Stripe ou LemonSqueezy?" }));
    const r = await chamar(root, "s-decisao");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") {
      expect(r.text).toContain("Decisão humana pendente: usar Stripe ou LemonSqueezy?");
      // `--decision` sozinho reseta o axis (blocker/next/complete) — o próprio
      // `commands/state.ts` documenta isso; o delta precisa refletir a perda
      // com um EVENTO explícito, nunca repetindo o valor antigo removido.
      expect(r.text).toContain("Próxima ação removida.");
      expect(r.text).not.toContain("fazer x");
    }
  });
});

// ─── FORMATO DO DELTA — rodada 3: "antes → depois" recriava o boot ─────────
//
//   Medido no host real: current_state ~1200 chars, next_action ~700 chars.
//   O formato antigo imprimia os dois lados de cada mudança — um delta de
//   2927 bytes contra um boot de 3074 recriava o boot inteiro. NÃO é
//   threshold de tamanho (proibido pelo dono): a regra é semântica — o valor
//   ANTIGO nunca aparece no delta, tenha 3 ou 3000 chars, porque ele já está
//   no contexto da sessão desde o SessionStart.
//
// Os 10 testes do dono, mapeados: 1/2/3 aqui; 4/5 (blocker) e 6/7 (decisão)
// nos describes dedicados abaixo; 8/9 já cobertos pelos describes "2" e
// "5"/"6" acima (não reescritos — o formato do texto não muda esse
// comportamento). O contrafactual (10) é estrutural: reverter `renderChange`
// para `${prev} → ${next}` faz as asserções `.not.toContain` desta seção
// falharem imediatamente.

describe("FORMATO 1 · next_action muda — só o novo, nunca o antigo", () => {
  it("valor antigo curto não aparece; só o novo, com o vocabulário de atualização", async () => {
    const root = await novoProjeto("f1");
    await silencioso(() => state({ cwd: root, set: "estado", next: "acao antiga" }));
    await chamar(root, "s-f1");

    await silencioso(() => state({ cwd: root, next: "acao nova" }));
    const r = await chamar(root, "s-f1");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") {
      expect(r.text).toBe("Próxima ação atualizada: acao nova");
      expect(r.text).not.toContain("acao antiga");
    }
  });
});

describe("FORMATO 2 · current_state longo muda — novo aparece uma vez, antigo nunca", () => {
  it("~1200 chars de antigo somem por completo; ~1200 chars de novo aparecem uma única vez", async () => {
    const root = await novoProjeto("f2");
    const antigo = "A".repeat(1200);
    const novo = "B".repeat(1200);
    await silencioso(() => state({ cwd: root, set: antigo, next: "x" }));
    await chamar(root, "s-f2");

    await silencioso(() => state({ cwd: root, set: novo }));
    const r = await chamar(root, "s-f2");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") {
      expect(r.text).toBe(`Estado atualizado: ${novo}`);
      expect(r.text).not.toContain(antigo);
      // "uma única vez": o novo não pode aparecer duplicado (ex.: resíduo de
      // um "antes → depois" onde antigo e novo coincidissem por engano).
      expect(r.text.split(novo)).toHaveLength(2);
      // Bytes medidos: rótulo + um valor de ~1200 chars, nunca dois.
      expect(Buffer.byteLength(r.text)).toBeLessThan(1300);
    }
  });
});

describe("FORMATO 3 · vários campos mudam juntos — só os alterados aparecem", () => {
  it("current_state, global_goal e next_action mudam; blocker (inalterado) não aparece", async () => {
    const root = await novoProjeto("f3");
    await silencioso(() => state({ cwd: root, set: "e1", goal: "g1", blocker: "b-fixo" }));
    await chamar(root, "s-f3");

    await silencioso(() => state({ cwd: root, set: "e2", goal: "g2", blocker: "b-fixo" }));
    const r = await chamar(root, "s-f3");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") {
      expect(r.text).toContain("Estado atualizado: e2");
      expect(r.text).toContain("Objetivo atualizado: g2");
      // blocker não mudou — não pode gerar linha nenhuma.
      expect(r.text).not.toContain("Blocker");
      expect(r.text).not.toContain("b-fixo");
    }
  });
});

describe("FORMATO 4/5 · blocker criado e removido — evento explícito", () => {
  it("blocker criado aparece com o valor novo", async () => {
    const root = await novoProjeto("f4");
    await silencioso(() => state({ cwd: root, set: "estado", next: "x" }));
    await chamar(root, "s-f4");

    await silencioso(() => state({ cwd: root, blocker: "esperando aprovação" }));
    const r = await chamar(root, "s-f4");

    expect(r.state).toBe("DELTA");
    // `--blocker` sozinho também reseta o axis: next_action (index anterior a
    // blocker em DELTA_FIELDS) some junto — daí a ordem "removida" antes de "novo".
    if (r.state === "DELTA") expect(r.text).toBe("Próxima ação removida.\nNovo blocker: esperando aprovação");
  });

  it("blocker removido gera evento explícito, sem repetir o valor antigo", async () => {
    const root = await novoProjeto("f5");
    await silencioso(() => state({ cwd: root, set: "estado", blocker: "bloqueado por X" }));
    await chamar(root, "s-f5");

    await silencioso(() => state({ cwd: root, next: "seguir sem bloqueio" }));
    const r = await chamar(root, "s-f5");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") {
      expect(r.text).toContain("Blocker removido.");
      expect(r.text).not.toContain("bloqueado por X");
    }
  });
});

describe("FORMATO 6/7 · decisão criada e resolvida — evento explícito", () => {
  it("decisão criada aparece com a pergunta nova", async () => {
    const root = await novoProjeto("f6");
    await silencioso(() => state({ cwd: root, set: "estado", next: "x" }));
    await chamar(root, "s-f6");

    await silencioso(() => state({ cwd: root, decision: "qual fornecedor de pagamento?" }));
    const r = await chamar(root, "s-f6");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") expect(r.text).toContain("Decisão humana pendente: qual fornecedor de pagamento?");
  });

  it("decisão resolvida gera resolução explícita, sem repetir a pergunta antiga", async () => {
    const root = await novoProjeto("f7");
    await silencioso(() => state({ cwd: root, set: "estado", decision: "qual banco de dados?" }));
    await chamar(root, "s-f7");

    await silencioso(() => state({ cwd: root, next: "seguir com Postgres" }));
    const r = await chamar(root, "s-f7");

    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") {
      expect(r.text).toContain("Decisão humana pendente resolvida.");
      expect(r.text).not.toContain("qual banco de dados?");
    }
  });
});

describe("FORMATO 10 · contrafactual — o formato antigo faria isto vermelho", () => {
  it("o oráculo `.not.toContain(antigo)` REPROVA o formato `campo: antes → depois`", async () => {
    // Não reverte o produto — prova que o oráculo dos testes acima TEM poder
    // discriminante. Reconstrói literalmente o formato de antes desta rodada
    // (`renderChange` chamando `→` com o valor anterior) e mostra que a MESMA
    // asserção usada em FORMATO 1/2 (`.not.toContain(antigo)`) o reprovaria.
    // Sem isto, a asserção poderia estar sempre-verdadeira por acidente (ex.:
    // `antigo` nunca aparecendo em NENHUM formato) e os testes acima passariam
    // mesmo com o defeito de volta.
    const antigo = "acao antiga";
    const novo = "acao nova";
    const formatoAntigo = `Próxima ação: ${antigo} → ${novo}`;
    const formatoAtual = `Próxima ação atualizada: ${novo}`;

    expect(formatoAntigo).toContain(antigo); // o defeito medido no host real
    expect(formatoAtual).not.toContain(antigo); // o que este passo corrigiu
  });
});

// ─── 5 · cache ausente ⇒ REEMITIR, nunca omitir ─────────────────────────────

describe("5 · cache ausente reemite", () => {
  it("apagar o cache entre duas chamadas idênticas força reemissão, não silêncio", async () => {
    const root = await novoProjeto("p5");
    await silencioso(() => state({ cwd: root, set: "estado", next: "x" }));

    const r1 = await chamar(root, "s-cache");
    expect(r1.state).toBe("DELTA"); // primeira chamada: cache nunca existiu

    const r2 = await chamar(root, "s-cache");
    expect(r2.state).toBe("UNCHANGED"); // cache presente, nada mudou

    await fs.remove(await cacheFilePara(root, "s-cache"));

    const r3 = await chamar(root, "s-cache");
    expect(r3.state).toBe("DELTA"); // cache removido — REEMITIR, nunca omitir
    if (r3.state === "DELTA") expect(r3.text).toContain("Estado: estado");
  });
});

// ─── 6 · cache stale/corrompido não bloqueia a informação ───────────────────

describe("6 · corrupção de cache nunca suprime informação", () => {
  it("bytes de lixo no arquivo de cache ainda produzem delta, nunca uma exceção", async () => {
    const root = await novoProjeto("p6");
    await silencioso(() => state({ cwd: root, set: "estado", next: "x" }));
    await chamar(root, "s-lixo"); // prime

    await fs.writeFile(await cacheFilePara(root, "s-lixo"), "  NAO-E-UM-ID-VALIDO ", "utf-8");

    const r = await chamar(root, "s-lixo");
    expect(r.state).toBe("DELTA");
    if (r.state === "DELTA") expect(r.text).toContain("Estado: estado");
  });
});

// ─── 7 · isolamento por projeto e por sessão ────────────────────────────────

describe("7 · projeto A/B e session_id diferentes não compartilham cache", () => {
  it("duas sessões no MESMO projeto: a segunda não herda o silêncio da primeira", async () => {
    const root = await novoProjeto("p7-sessao");
    await silencioso(() => state({ cwd: root, set: "estado", next: "x" }));

    const s1 = await chamar(root, "sessao-um");
    expect(s1.state).toBe("DELTA");

    /**
     * Contrafactual embutido: se a chave do cache ignorasse `session_id`,
     * esta chamada leria o arquivo que `sessao-um` acabou de escrever e diria
     * UNCHANGED por engano — o projeto não mudou, só a sessão é nova.
     */
    const s2 = await chamar(root, "sessao-dois");
    expect(s2.state).toBe("DELTA");
  });

  it("dois projetos com o MESMO session_id não se sobrescrevem", async () => {
    const rootA = await novoProjeto("p7-a");
    const rootB = await novoProjeto("p7-b");
    await silencioso(() => state({ cwd: rootA, set: "estado A", next: "x" }));
    await silencioso(() => state({ cwd: rootB, set: "estado B", next: "y" }));

    await chamar(rootA, "compartilhada"); // A escreve seu id sob a chave "compartilhada"
    await chamar(rootB, "compartilhada"); // se a chave fosse só a sessão, isto sobrescreveria o arquivo de A

    const aDeNovo = await chamar(rootA, "compartilhada");
    /**
     * Se o cache fosse chaveado só por `session_id` (sem hash de projeto), o
     * arquivo agora conteria o id de B, o comparador acharia "mudou" e
     * reemitiria — o teste pegaria a fuga. Isolado corretamente, A já viu seu
     * próprio estado e fica em silêncio.
     */
    expect(aDeNovo.state).toBe("UNCHANGED");
  });
});

// ─── 8 · nova sessão (/clear, resume) produz base nova e apropriada ─────────

describe("8 · nova sessão não herda o silêncio da sessão anterior", () => {
  it("sessão antiga já em UNCHANGED; sessão nova (simulando /clear) recebe a base completa", async () => {
    const root = await novoProjeto("p8");
    await silencioso(() => state({ cwd: root, set: "estado", next: "x" }));

    await chamar(root, "sessao-antiga");
    const antigaSilenciosa = await chamar(root, "sessao-antiga");
    expect(antigaSilenciosa.state).toBe("UNCHANGED");

    const novaSessao = await chamar(root, "sessao-pos-clear");
    expect(novaSessao.state).toBe("DELTA");
    if (novaSessao.state === "DELTA") expect(novaSessao.text).toContain("Estado: estado");
  });
});

// ─── 9 · DEFEITO A — SessionStart primeia o cache que o UPS lê ──────────────

describe("9 · SessionStart e UserPromptSubmit compartilham a apresentação (DEFEITO A)", () => {
  it("SessionStart apresenta o estado -> primeiro UserPromptSubmit da mesma sessão fica em silêncio", async () => {
    const root = await novoProjeto("p9-a");
    await silencioso(() => state({ cwd: root, set: "estado do boot", next: "seguir" }));

    const boot = await runSessionStartAdapter(
      { hook_event_name: "SessionStart", source: "startup", session_id: "sessao-boot", cwd: root },
      { CLAUDE_PROJECT_DIR: root }
    );
    expect(boot.additionalContext).toContain("Estado: estado do boot");

    const primeiro = await chamar(root, "sessao-boot");
    expect(primeiro.state).toBe("UNCHANGED");
  });

  it("contrafactual — sem SessionStart nesta sessão, o fail-safe REEMITIR continua valendo", async () => {
    const root = await novoProjeto("p9-b");
    await silencioso(() => state({ cwd: root, set: "estado sem boot", next: "seguir" }));

    // Mesmo projeto, MESMA rotina — só que sem `runSessionStartAdapter` antes.
    const primeiro = await chamar(root, "sessao-sem-boot");
    expect(primeiro.state).toBe("DELTA");
  });

  it("SessionStart sem project_state para apresentar não primeia nada — UPS ainda reemite quando o estado aparece depois", async () => {
    const root = await novoProjeto("p9-c"); // capsule criada, `nexos state` ainda não rodou

    const boot = await runSessionStartAdapter(
      { hook_event_name: "SessionStart", source: "startup", session_id: "sessao-tardia", cwd: root },
      { CLAUDE_PROJECT_DIR: root }
    );
    expect(boot.additionalContext).not.toContain("Estado:");

    await silencioso(() => state({ cwd: root, set: "estado criado depois do boot", next: "x" }));

    const primeiro = await chamar(root, "sessao-tardia");
    expect(primeiro.state).toBe("DELTA");
    if (primeiro.state === "DELTA") expect(primeiro.text).toContain("Estado: estado criado depois do boot");
  });

  it("sessões diferentes continuam isoladas mesmo com o SessionStart primeando cache", async () => {
    const root = await novoProjeto("p9-d");
    await silencioso(() => state({ cwd: root, set: "estado compartilhado", next: "x" }));

    await runSessionStartAdapter(
      { hook_event_name: "SessionStart", source: "startup", session_id: "sessao-A", cwd: root },
      { CLAUDE_PROJECT_DIR: root }
    );
    const promptA = await chamar(root, "sessao-A");
    expect(promptA.state).toBe("UNCHANGED");

    // SessionStart de A não pode ter primeado a sessão B — B nunca viu nada.
    const promptB = await chamar(root, "sessao-B");
    expect(promptB.state).toBe("DELTA");
  });
});

/**
 * H3 REABERTO (revisão independente, rodada 2) — o describe que morava aqui
 * ("item 3, persist só depois do stdout") provava uma premissa FALSA: que
 * chamar `persist()` depois de obter `result`, DENTRO do mesmo processo,
 * bastava para proteger contra o kill de `nexos-budget.sh`. Não basta — o
 * wrapper redireciona o stdout do filho para um ARQUIVO e só o repassa ao
 * host se o filho sair dentro do orçamento; a ordem interna nunca foi a
 * variável que decidia isso. A prova real (sentinela + wrapper cooperando,
 * processo de verdade sob o `nexos-budget.sh` real) mora em
 * `tests/hook-budget-h3.test.ts`.
 */
