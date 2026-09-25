/**
 * C2.4.4.3 — Claude SessionStart adapter.
 *
 *   HOST PROJECT ROOT != LIVE HOOK CWD
 *   MISSING HOST PROJECT BINDING != FALL BACK TO LIVE CWD
 *   `.serialized` (bytes crus do Builder) SOBREVIVE intacto no retorno; o que
 *   vai para `additionalContext` (Fatia 1/Passo 2) é a projeção legível de
 *   `buildAdditionalContext`, não mais os mesmos bytes — ver A13/A14.
 *
 * A2 é o teste central: prova que o binding vence o cwd. Sem ele, o adapter
 * herdaria o defeito L2 medido ao vivo na 4.4.1.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import {
  runSessionStartAdapter,
  toHookOutput,
  buildAdditionalContext,
  readProjectName,
  SessionStartAdapterError,
  SESSION_START_SOURCES,
} from "../src/host/claude/session-start.js";
import { buildSessionBriefForCwd } from "../src/lib/bootstrap-context.js";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { newRecordId } from "../src/lib/capsule/ids.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { EVIDENCE_MAX_AGE_MS, resolveNamedEvidence } from "../src/lib/evidence.js";
import { execFileSync } from "node:child_process";
import { makeProjectState, makeGotcha, makeCheckpoint } from "./capsule-fixtures.js";
import { advanceCheckpoint } from "../src/lib/capsule/checkpoint.js";
import { serializeCanonical } from "../src/lib/capsule/codec.js";
import type { SessionBrief } from "../src/lib/session-brief.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, projectA: string, elsewhere: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "c2443-"));
  projectA = path.join(ws, "project-a");
  elsewhere = path.join(ws, "somewhere-else");
  await fs.ensureDir(projectA);
  await fs.ensureDir(elsewhere);
  await fs.writeJson(path.join(projectA, "package.json"), { name: "project-a" });
  await fs.writeJson(path.join(elsewhere, "package.json"), { name: "somewhere-else" });
});
afterEach(async () => {
  await fs.remove(ws);
});

const payload = (over: Record<string, unknown> = {}) => ({
  session_id: "s1",
  hook_event_name: "SessionStart",
  source: "startup",
  cwd: projectA,
  ...over,
});

// ─── A1 · caminho feliz ─────────────────────────────────────────────────────

describe("A1 · startup", () => {
  it("emite exatamente um brief do projeto vinculado", async () => {
    const r = await runSessionStartAdapter(payload(), {
      CLAUDE_PROJECT_DIR: projectA,
    });

    expect(r.source).toBe("startup");
    expect(r.projectDir).toBe(projectA);
    const brief = JSON.parse(r.serialized);
    expect(brief.project.identity_source).toBe("bootstrap");
  });
});

// ─── A2 · O TESTE CENTRAL ───────────────────────────────────────────────────

describe("A2 · binding vence o cwd", () => {
  it("CLAUDE_PROJECT_DIR=A e cwd=B → brief de A", async () => {
    const bound = await runSessionStartAdapter(
      payload({ cwd: elsewhere }),
      { CLAUDE_PROJECT_DIR: projectA }
    );

    const expected = await buildSessionBriefForCwd({ cwd: projectA });
    const wrong = await buildSessionBriefForCwd({ cwd: elsewhere });

    expect(bound.serialized).toBe(expected.serialized);
    expect(bound.serialized).not.toBe(wrong.serialized);
  });

  it("o cwd do payload NÃO influencia a identidade em nenhum valor", async () => {
    const ids = await Promise.all(
      [projectA, elsewhere, ws, os.tmpdir()].map(async (cwd) => {
        const r = await runSessionStartAdapter(payload({ cwd }), {
          CLAUDE_PROJECT_DIR: projectA,
        });
        return JSON.parse(r.serialized).project.id;
      })
    );
    expect(new Set(ids).size).toBe(1);
  });
});

// ─── A3 · binding ausente ───────────────────────────────────────────────────

describe("A3 · sem CLAUDE_PROJECT_DIR", () => {
  it("falha explicitamente, sem cair no cwd", async () => {
    await expect(runSessionStartAdapter(payload(), {})).rejects.toThrow(
      SessionStartAdapterError
    );
    await expect(runSessionStartAdapter(payload(), {})).rejects.toThrow(
      /CLAUDE_PROJECT_DIR ausente/
    );
  });

  it("string vazia também falha — não é binding válido", async () => {
    await expect(
      runSessionStartAdapter(payload(), { CLAUDE_PROJECT_DIR: "" })
    ).rejects.toThrow(SessionStartAdapterError);
  });

  it("mesmo com cwd perfeitamente válido, NÃO usa fallback", async () => {
    await expect(
      runSessionStartAdapter(payload({ cwd: projectA }), {})
    ).rejects.toThrow(/NÃO usa input\.cwd como fallback/);
  });
});

// ─── A4 · as cinco fontes ───────────────────────────────────────────────────

describe("A4 · sources", () => {
  it("as cinco fontes documentadas estão declaradas", () => {
    expect([...SESSION_START_SOURCES]).toEqual([
      "startup",
      "resume",
      "clear",
      "compact",
      "fork",
    ]);
  });

  for (const source of SESSION_START_SOURCES) {
    it(`${source} → exatamente uma emissão`, async () => {
      const r = await runSessionStartAdapter(payload({ source }), {
        CLAUDE_PROJECT_DIR: projectA,
      });
      expect(r.source).toBe(source);
      expect(JSON.parse(r.serialized).version).toBe(1);
    });
  }

  it("fonte desconhecida falha — não entra por omissão", async () => {
    await expect(
      runSessionStartAdapter(payload({ source: "teleport" }), {
        CLAUDE_PROJECT_DIR: projectA,
      })
    ).rejects.toThrow(/source inválido/);
  });
});

// ─── A5 · evento errado ─────────────────────────────────────────────────────

describe("A5 · evento errado", () => {
  for (const evt of ["UserPromptSubmit", "CwdChanged", "SessionEnd", undefined]) {
    it(`${String(evt)} → falha, zero brief`, async () => {
      await expect(
        runSessionStartAdapter(payload({ hook_event_name: evt }), {
          CLAUDE_PROJECT_DIR: projectA,
        })
      ).rejects.toThrow(/evento inesperado/);
    });
  }
});

// ─── A6 · bytes exatos ──────────────────────────────────────────────────────

describe("A6 · o transporte não re-serializa", () => {
  it("saída do adapter == saída do Builder, byte a byte", async () => {
    const adapter = await runSessionStartAdapter(payload({ cwd: elsewhere }), {
      CLAUDE_PROJECT_DIR: projectA,
    });
    const builder = await buildSessionBriefForCwd({ cwd: projectA });

    expect(adapter.serialized).toBe(builder.serialized);
    expect(Buffer.byteLength(adapter.serialized, "utf8")).toBe(builder.byteLength);
  });

  it("sem label, sem markdown, sem newline extra", async () => {
    const { serialized } = await runSessionStartAdapter(payload(), {
      CLAUDE_PROJECT_DIR: projectA,
    });
    expect(serialized.startsWith("{")).toBe(true);
    expect(serialized.endsWith("}")).toBe(true);
    expect(serialized).not.toContain("\n");
    expect(serialized).not.toContain("NEXOS");
  });
});

// ─── A11 · envelope do host ─────────────────────────────────────────────────

/**
 * `VALID JSON ON STDOUT -> PARSED AS HOOK OUTPUT, NOT AS CONTEXT`.
 *
 * O brief é JSON válido; cru no stdout ele seria interpretado como structured
 * hook output, falharia a validação de schema e o contexto **nunca** entraria.
 * Achado pelo review do Codex no PR #6 — os testes de função não pegavam,
 * porque o defeito é do contrato com o host, não da função.
 */
describe("A11 · SessionStart structured output", () => {
  it("envelopa com hookSpecificOutput / hookEventName / additionalContext", () => {
    const out = toHookOutput('{"version":1}');
    expect(out).toEqual({
      hookSpecificOutput: {
        hookEventName: "SessionStart",
        additionalContext: '{"version":1}',
      },
    });
  });

  it("additionalContext carrega os bytes do Builder VERBATIM", async () => {
    const { serialized } = await runSessionStartAdapter(payload({ cwd: elsewhere }), {
      CLAUDE_PROJECT_DIR: projectA,
    });
    const builder = await buildSessionBriefForCwd({ cwd: projectA });

    const out = toHookOutput(serialized);
    expect(out.hookSpecificOutput.additionalContext).toBe(builder.serialized);
    /** round-trip: o brief sai do envelope idêntico ao que entrou */
    expect(JSON.parse(out.hookSpecificOutput.additionalContext)).toEqual(
      JSON.parse(builder.serialized)
    );
  });

  /**
   * P0 (MVP Project Brain, bloco h) removeu `automation--agents-md-loader.json`
   * (exemplo de terceiro, nunca registrado em `assets/settings.json`) — a
   * comparação contra o `command` dele só confirmava uma coincidência de
   * nomenclatura com um asset alheio, não testava código próprio. A asserção
   * real (forma exata do envelope) continua abaixo, sem a dependência morta.
   */
  it("o envelope de hook tem exatamente a forma esperada pelo host", () => {
    const out = toHookOutput("x");
    expect(Object.keys(out)).toEqual(["hookSpecificOutput"]);
    expect(Object.keys(out.hookSpecificOutput).sort()).toEqual([
      "additionalContext",
      "hookEventName",
    ]);
  });
});

// ─── A7/A8 · estado real vs fixture canônica ────────────────────────────────

describe("A7/A8 · o adapter não altera o payload", () => {
  it("A7 · projeto bootstrap real → UNAVAILABLE, sem fabricar manifest", async () => {
    const r = await runSessionStartAdapter(payload(), { CLAUDE_PROJECT_DIR: projectA });
    expect(await fs.pathExists(path.join(projectA, ".nexos"))).toBe(false);
    /**
     * P1.3i (B7) — "Projeto sem identidade canônica · locator de bootstrap:
     * ..." era jargão redundante com a linha de lifecycle (que já é uma
     * frase legível). `lifecycleLine` para NEW (`.nexos` ausente, marker de
     * projeto presente) é a única identificação textual agora.
     */
    expect(r.additionalContext).toContain("Projeto sem Project Brain (.nexos ausente)");
    expect(r.additionalContext).not.toContain("locator de bootstrap");
    expect(r.additionalContext).not.toMatch(/^Projeto: prj_/m);
  });
});

// ─── A9 · fronteira estrutural ──────────────────────────────────────────────

describe("A9 · nenhuma dependência legada", () => {
  it("o adapter só importa a composição da 4.3", async () => {
    const raw = await fs.readFile("src/host/claude/session-start.ts", "utf-8");
    const code = raw.replace(/\/\*[\s\S]*?\*\//g, "").replace(/\/\/.*$/gm, "");

    /**
     * ALLOWLIST ESTRUTURAL, IGUALDADE EXATA — um import novo tem que passar
     * por aqui e ser justificado, em vez de entrar por um `toContain` que
     * nunca reprova.
     *
     * Corte presence/capability/observations
     * (nexos://decision/p0-corte-presence-capability-observations): saíram
     * `session-observation`, `capsule/store` (publishCanonical — a
     * observação que o usava), `host/surface-resolver`, `host/gate-health`,
     * `host/autonomous-mode-projection`, `commands/boot` (linha "última
     * sessão") e `./cache-warmer` (o disparo do aquecedor detached) — cada
     * um dependia de um módulo removido no mesmo corte. `node:path` saiu
     * junto por ficar sem uso real depois da poda.
     *
     * P1.2 (nexos://decision/p1-2-project-lifecycle) — `capsule/project-lifecycle.js`
     * entrou para o único dispatch de lifecycle do SessionStart
     * (`classifyProjectLifecycleForResolution`/`formatLifecycleLine`), reusando
     * a `identity` já resolvida em vez de um segundo `resolveProject()`.
     */
    /**
     * P1.5 (nexos://decision/p1-5-hot-brief) — `node:fs/promises` (leitura
     * best-effort de `.nexos/map/project.json`, `resolveMapSummary`) e
     * `capsule/map/hot-brief.js` (seções 2+3 do HOT, via `readMapSummary`)
     * entram para o resumo do Project Map.
     *
     * P1.3i (B5) — `node:path` volta (constrói `.nexos/memory/project/*` sem
     * depender de `forProject`, que não expõe esse subcaminho legado) e
     * `capsule/repair.js` entra só por `extractDecisionTitles` — reusa o
     * MESMO parser textual que `scanMemoryOrphans` já usa para contar
     * títulos de `decisions.md`, nunca uma segunda regex duplicada.
     *
     * C1 (fatia C, orquestrador) — `capsule/map/stack-detector.js` sai (só o
     * `MapFact` da leitura CRUA de `project.json`, removida com a troca para
     * `readMapSummary`); `capsule/map/freshness.js` entra por
     * `checkMapFreshness`/`refreshMapIfStale` — o SessionStart passa a
     * CONVERGIR o mapa desatualizado sob orçamento, não só ler.
     *
     * nexos://decision/recall-continuidade-indice-por-janela — `./memory-recall.js`
     * entra só por `shownMarkerFile`: `compact`/`clear` apagam o contexto do
     * modelo, então o marker de dedup do recall (que vive fora dele, em
     * `/tmp`) precisa ser apagado junto, ou a sessão fica em silêncio sobre
     * tudo que já tinha mostrado antes do apagão.
     *
     * 18/09 (registro de sessão, dec_01M2H0QRNKGQRSJM92DCK285WY) —
     * `capsule/session-events.js` entra por `writeSessionStarted`: a
     * publicação de `Session/started` que o comentário acima já anotava como
     * removida ("saiu `capsule/store` — publishCanonical, a observação que o
     * usava") volta, como record PRÓPRIO (family `Session`, não
     * `HostObservation` revivida) e via `session-events.js`, nunca
     * `capsule/store.js` direto — o adapter continua sem CAS/head-resolution
     * no caminho quente.
     */
    expect([...code.matchAll(/from\s+"([^"]+)"/g)].map((m) => m[1])).toEqual([
      "node:fs/promises",
      "node:path",
      "../../lib/bootstrap-context.js",
      "../../lib/context-assembler.js",
      "../../lib/host/state-presentation.js",
      "../../lib/project-resolver.js",
      "../../lib/capsule/project-lifecycle.js",
      "../../lib/capsule/repair.js",
      "../../lib/capsule/reader.js",
      "../../lib/capsule/integrity.js",
      "../../lib/capsule/paths.js",
      "../../lib/capsule/ids.js",
      "../../lib/capsule/schemas.js",
      "../../lib/evidence.js",
      "../../lib/capsule/checkpoint.js",
      /**
       * Também por `findPreviousSession`/`formatPreviousSessionLine` desde
       * 18/09: a linha "Última sessão" voltou sobre esta family, e o import é
       * o MESMO módulo — uma entrada só, porque duas linhas de import do
       * mesmo arquivo é duplicação, não duas dependências.
       */
      "../../lib/capsule/session-events.js",
      "../../lib/capsule/authority.js",
      "../../lib/capsule/integrity-cache.js",
      /**
       * 2026-09-17 — `MANUAL PATH SEES != AUTOMATIC PATH SEES`. Projeção de
       * agentes desatualizada só aparecia em `nexos boot`; o hook, que é o
       * único que roda sem ninguém digitar, ficava mudo — e foi exatamente
       * assim que uma sessão inteira rodou os 17 agentes de 13/09 com
       * precedência sobre o canônico. O módulo é leve (fs-extra, path,
       * agent-projection, constants) e o caminho comum sai num `pathExists`:
       * medido no mesmo projeto sem projeção, 5 execuções, mediana 371 ms com
       * a chamada contra 367 ms sem ela — diferença dentro do ruído.
       */
      "../../lib/host/agent-projection-report.js",
      /**
       * MANUAL PATH SEES != AUTOMATIC PATH SEES — `host/stale-runtime.js`
       * entra para o SessionStart avisar o que só `nexos boot` avisava: que o
       * binário em execução não é o build deste worktree. Quem abre o Claude
       * Code sem digitar `boot` nunca via, e runtime velho lê o Store de hoje
       * com o schema de ontem (já produziu `INVALID_SCHEMA ×8` sobre Store
       * íntegro). Módulo leve por construção: comparação de hash de duas
       * árvores `dist/`, zero I/O de Store. MEDIDO 120ms frio / 52ms quente
       * contra teto de 2700ms, dentro do mesmo `Promise.all` do round 2.
       */
      "../../lib/host/stale-runtime.js",
      /**
       * INSTALLED CODE != INSTALLED ASSETS — `host/asset-drift.js` entra para
       * o brief avisar que os assets de `~/.claude` são de uma versão anterior
       * à do pacote em execução. Pacote e assets são instalações
       * independentes: `npm i -g` traz código, `nexos install` projeta
       * agents/skills/rules/hooks, e nada sincroniza os dois. MEDIDO nesta
       * máquina: assets 6.5.1 contra pacote 6.5.2, visível só por
       * `doctor --project`, que custa ~1s (37% do teto de 2700ms). Este módulo
       * lê um JSON pequeno e é a fatia do health que cabe no orçamento.
       */
      "../../lib/host/asset-drift.js",

      "../../lib/evidence-cache.js",
      "../../lib/session-brief.js",
      "../../lib/map/hot-brief.js",
      "../../lib/map/freshness.js",
      "./memory-recall.js",
    ]);

    /**
     * P1.3i (B5) — `state.md` deixou de ser blanket-proibido: o brief agora
     * lê `.nexos/memory/project/state.md`, legado DENTRO da própria Capsule
     * (mesma área que `migration-classifier.ts`/`repair.ts` já tratam como
     * LEGACY_TOLERATED) — não é a "arqueologia de markdown solto" na raiz do
     * repo que este teste sempre proibiu (ver módulo docstring). O que
     * continua banido por completo, sem exceção: `gotchas.md` legado,
     * `MEMORY.md`, `CLAUDE.md`.
     */
    expect(code).not.toMatch(/gotchas\.md|MEMORY\.md|CLAUDE\.md/);
    expect(code).toMatch(/\.nexos\/memory\/project\/state\.md/);
    expect(code).not.toMatch(/settings\.json|settings\.local|\.mcp\.json|skills|agents/);
    expect(code).not.toMatch(/nexos-session-init|nexos-inbox|synapse|pixel-agents/);
    /** input.cwd NUNCA alimenta a resolução — só CLAUDE_PROJECT_DIR. */
    expect(code).not.toMatch(/buildSessionBriefForCwd\(\s*\{\s*cwd:\s*input/);
  });
});

// ─── A10 · higiene de stdout ────────────────────────────────────────────────

describe("A10 · higiene de canal", () => {
  it("erro não produz brief — a rejeição é o único resultado", async () => {
    const outcome = await runSessionStartAdapter(payload(), {}).then(
      (r) => ({ ok: true as const, r }),
      (e: Error) => ({ ok: false as const, e })
    );
    expect(outcome.ok).toBe(false);
    if (!outcome.ok) expect(outcome.e).toBeInstanceOf(SessionStartAdapterError);
  });

  it("a mensagem de erro não vaza o brief nem o cwd rejeitado", async () => {
    try {
      await runSessionStartAdapter(payload({ cwd: elsewhere }), {});
      expect.unreachable();
    } catch (error) {
      const msg = (error as Error).message;
      expect(msg).not.toContain("{\"version\"");
      expect(msg).not.toContain(elsewhere);
    }
  });
});

// ─── A13 · buildAdditionalContext — a projeção legível (Fatia 1/Passo 2) ────

function fakeBrief(overrides: Partial<SessionBrief> = {}): SessionBrief {
  return {
    version: 1,
    project: { id: "prj_01M008F1FQWJSY1HP82RAZ9ZXG", identity_source: "manifest" },
    warnings: [],
    ...overrides,
  };
}

describe("A13 · buildAdditionalContext — projeção legível", () => {
  it("primeira linha é o cabeçalho fixo; Projeto traz nome + id quando o nome existe", () => {
    const out = buildAdditionalContext(fakeBrief(), "nexos-cli");
    expect(out.split("\n")[0]).toBe("NexOS");
    expect(out).toContain("Projeto: nexos-cli · prj_01M008F1FQWJSY1HP82RAZ9ZXG");
  });

  it("sem nome legível, degrada para o id sozinho — nunca fabrica um nome", () => {
    const out = buildAdditionalContext(fakeBrief(), undefined);
    expect(out).toContain("Projeto: prj_01M008F1FQWJSY1HP82RAZ9ZXG");
    expect(out.split("\n")[1]).not.toContain("·");
  });

  it("Estado/Objetivo/Próxima ação vêm de nexos://project-state; Blocker/decisão só quando existe", () => {
    const semBlocker = buildAdditionalContext(
      fakeBrief({
        knowledge: {
          items: [
            {
              source_ref: "nexos://project-state",
              title: "estado",
              why: "estado atual do projeto",
              fields: {
                title: "estado",
                current_state: "trabalhando na fatia 1",
                global_goal: "entregar o canal canônico do boot",
                next_action: "escrever os testes",
              },
            },
          ],
          omitted: 0,
          anomalies: 0,
        },
      }),
      undefined
    );
    expect(semBlocker).toContain("Estado: trabalhando na fatia 1");
    expect(semBlocker).toContain("Objetivo: entregar o canal canônico do boot");
    expect(semBlocker).toContain("Próxima ação: escrever os testes");
    expect(semBlocker).not.toContain("Blocker/decisão");

    const comBlocker = buildAdditionalContext(
      fakeBrief({
        knowledge: {
          items: [
            {
              source_ref: "nexos://project-state",
              title: "estado",
              why: "estado atual do projeto",
              fields: { title: "estado", current_state: "parado", blocker: "aguardando decisão humana" },
            },
          ],
          omitted: 0,
          anomalies: 0,
        },
      }),
      undefined
    );
    expect(comBlocker).toContain("Blocker/decisão: aguardando decisão humana");
  });

  it("pointer com title vazio não entra; pointer titulado entra de forma compacta", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        knowledge: {
          items: [
            {
              source_ref: "nexos://gotcha/x",
              title: "gotcha X",
              why: "boot: head canônico atual do projeto",
              fields: { title: "gotcha X", rule: "sempre verificar antes de declarar sucesso" },
            },
          ],
          omitted: 5,
          anomalies: 0,
          pointers: [
            { source_ref: "nexos://gotcha/sem-titulo", title: "" },
            { source_ref: "nexos://gotcha/com-titulo", title: "gotcha titulada" },
          ],
        },
      }),
      undefined
    );
    expect(out).not.toContain("sem-titulo");
    expect(out).toContain("gotcha titulada");
    expect(out).toContain("nexos://gotcha/com-titulo");
    expect(out).toContain("Contexto: 1 itens · 5 omitidos");
  });

  /**
   *   DESCOBERTA BARATA, CORPO CARO SOB DEMANDA
   *
   * O brief dizia o que o projeto LEMBRA e nunca o que ele PODE FAZER — um
   * agente recém-iniciado não tinha como saber que capabilities, research e
   * verificação existem. A linha é PONTEIRO: não pode carregar corpo, e não
   * pode custar o orçamento do hook (`capabilities --audit` mede ~840ms
   * contra teto de 2700ms).
   */
  it("anuncia as capacidades por ponteiro, sem carregar corpo nem rodar scan", () => {
    const out = buildAdditionalContext(fakeBrief({}), undefined);

    expect(out).toContain("nexos capabilities --for");
    expect(out).toContain("nexos research --search");
    expect(out).toContain("nexos verify --subject");
    // NEGATIVE CONTROL: ponteiro não vira despejo. Se algum dia alguém
    // resolver listar as skills aqui, este expect cai — e tem que cair.
    expect(out).toContain("nada carregado aqui");
    expect(out.length).toBeLessThan(8000);
  });

  it("warning não-vazio aparece TRADUZIDO — nunca o código cru; identity_source fica fora da projeção", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        /**
         * Amostra qualquer de warning VIVO — o teste mede a TRADUÇÃO, não este
         * código em particular. Era `HOST_RUNTIME_STALE`, retirado junto com os
         * outros 9 códigos que o brief declarava e nunca emitia; o aviso de
         * runtime desatualizado continua vivo por OUTRO caminho
         * (`formatStaleRuntimeWarning`, `session-start.ts`), que não passa por
         * `BriefWarning`.
         */
        warnings: ["KNOWLEDGE_TIMEOUT"],
      }),
      undefined
    );
    expect(out).not.toContain("KNOWLEDGE_TIMEOUT");
    expect(out).toContain("Avisos: leitura do conhecimento canônico excedeu o tempo limite");
    expect(out).not.toContain("manifest");
    expect(out).not.toContain("PRESENT");
    expect(out).not.toContain("vcs:git");
  });

  it("V3 · FOREIGN_MANIFEST vira frase citando caminho + nome/id do projeto envolvente — nunca o código cru", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        warnings: ["FOREIGN_MANIFEST"],
        foreignManifest: { rootPath: "/Users/x/Projetos/pai", projectName: "projeto-pai", projectId: "prj_01ABCDEF" },
      }),
      undefined
    );
    expect(out).not.toContain("FOREIGN_MANIFEST");
    expect(out).toContain("está dentro de outro projeto NexOS");
    expect(out).toContain("/Users/x/Projetos/pai");
    expect(out).toContain("projeto-pai");
    expect(out).toContain("fronteira própria (.git)");
    expect(out).toContain("memória separada");
  });

  it("V3 · FOREIGN_MANIFEST sem nome/id lido (manifest ancestral ilegível) degrada para o caminho, nunca lança nem some", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        warnings: ["FOREIGN_MANIFEST"],
        foreignManifest: { rootPath: "/Users/x/Projetos/pai" },
      }),
      undefined
    );
    expect(out).not.toContain("FOREIGN_MANIFEST");
    expect(out).toContain("/Users/x/Projetos/pai");
  });

  it("V3 · um código de warning desconhecido (drift de versão) nunca chega cru — vira 'aviso interno: <código>'", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        warnings: ["ALGUM_CODIGO_FUTURO" as unknown as SessionBrief["warnings"][number]],
      }),
      undefined
    );
    expect(out).toContain("Avisos: aviso interno: ALGUM_CODIGO_FUTURO");
  });


  /**
   * P1.5 (nexos://decision/p1-5-hot-brief) — SUPERSEDE do contrafactual
   * anterior ("NÃO trunque conteúdo de um item"): esse era exatamente o
   * defeito medido que fez o brief chegar a ~7,9 KB (corpo inteiro de
   * Decision, `fields.decision`, 2-3 KB por item). Agora o item genérico
   * (não-gotcha) SEMPRE trunca: título + source_ref na mesma linha + UMA
   * linha "regra:" cortada em ~140 chars com reticências — nunca o corpo.
   */
  it("item genérico (não-gotcha) trunca o campo longo — nunca o corpo inteiro atravessa", () => {
    const longValue = "detalhe ".repeat(80).trim();
    const out = buildAdditionalContext(
      fakeBrief({
        knowledge: {
          items: [
            {
              source_ref: "nexos://decision/y",
              title: "Decision Y",
              why: "boot: head canônico atual do projeto",
              fields: { title: "Decision Y", decision: longValue },
            },
          ],
          omitted: 0,
          anomalies: 0,
        },
      }),
      undefined
    );
    expect(out).toContain("Decision Y (nexos://decision/y)");
    expect(out).not.toContain(longValue);
    expect(out).toMatch(/regra: detalhe detalhe[\w ]*…/);
    expect(out.split("Decision Y").length - 1).toBe(1);
  });

  /**
   * Fatia 1/Passo 3, commit 2: `CANONICAL GOTCHA = completo · BOOT PROJECTION
   * = acionável e compacta`. Só na projeção legível — `serialized` continua
   * com os sete campos, provado no segundo teste abaixo. P1.5: `source_ref`
   * agora vai inline na linha do título (`- title (source_ref)`), e a linha
   * de regra usa o rótulo `regra:` (era `rule:`) — mesmo dado, rótulo comum
   * a gotcha/decision.
   */
  it("gotcha na projeção mostra só title/source_ref/regra — cause/mitigation/consequence/trigger somem", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        knowledge: {
          items: [
            {
              source_ref: "nexos://gotcha/exemplo",
              title: "gotcha de exemplo",
              why: "boot: head canônico atual do projeto",
              fields: {
                title: "gotcha de exemplo",
                rule: "sempre verificar antes de declarar sucesso",
                failure_mode: "declarou sucesso sem rodar o teste",
                cause: "pressa",
                mitigation: "nenhuma",
                prevention: "checklist obrigatorio",
                consequence: "regressao em producao",
                trigger: "deploy sexta-feira",
              },
            },
          ],
          omitted: 0,
          anomalies: 0,
        },
      }),
      undefined
    );
    expect(out).toContain("gotcha de exemplo (nexos://gotcha/exemplo)");
    expect(out).toContain("regra: sempre verificar antes de declarar sucesso");
    for (const campo of ["failure_mode", "cause", "mitigation", "prevention", "consequence", "trigger"]) {
      expect(out, `${campo} vazou na projeção compacta`).not.toContain(campo);
    }
  });

  it("gotcha sem rule: mostra title/source_ref e omite a linha rule, nunca fabrica", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        knowledge: {
          items: [
            {
              source_ref: "nexos://gotcha/sem-rule",
              title: "gotcha sem rule",
              why: "boot: head canônico atual do projeto",
              fields: { title: "gotcha sem rule", failure_mode: "algo quebrou" },
            },
          ],
          omitted: 0,
          anomalies: 0,
        },
      }),
      undefined
    );
    expect(out).toContain("gotcha sem rule (nexos://gotcha/sem-rule)");
    expect(out).not.toContain("regra:");
    expect(out).not.toContain("failure_mode");
  });
});

/**
 * V3 (H2, achado do orquestrador) — ponta a ponta: um repositório git
 * ANINHADO dentro de um projeto NexOS canônico produzia `Avisos:
 * FOREIGN_MANIFEST` cru no brief real (não só na projeção unitária acima),
 * sem citar o projeto envolvente. `runSessionStartAdapter` completo, cwd na
 * subpasta com `.git` próprio — a MESMA rota de produção.
 */
describe("V3 · repositório git aninhado — brief real nunca mostra código cru", () => {
  it("cwd num nested repo (git próprio) sob um projeto NexOS canônico cita caminho+nome do envolvente", async () => {
    const root = path.join(ws, "projeto-envolvente");
    await fs.ensureDir(root);
    await fs.writeJson(path.join(root, "package.json"), { name: "projeto-envolvente" });
    await initializeCapsule(root, { projectName: "projeto-envolvente" });

    const nested = path.join(root, "nested-repo");
    await fs.ensureDir(nested);
    await fs.writeJson(path.join(nested, "package.json"), { name: "nested-repo" });
    execFileSync("git", ["init", "-q"], { cwd: nested });

    const r = await runSessionStartAdapter(payload({ cwd: nested }), { CLAUDE_PROJECT_DIR: nested });

    expect(r.additionalContext).not.toContain("FOREIGN_MANIFEST");
    expect(r.additionalContext).toContain("está dentro de outro projeto NexOS");
    expect(r.additionalContext).toContain(root);
    expect(r.additionalContext).toContain("projeto-envolvente");
    expect(r.additionalContext).toContain("fronteira própria (.git)");
    expect(r.additionalContext).toContain("memória separada");
  });
});

// ─── A14 · nome do projeto — leitura aditiva do manifest ───────────────────

describe("A14 · readProjectName — leitura aditiva, nunca custa o boot", () => {
  it("identity_source=manifest com nome legível → chega na additionalContext real do adapter", async () => {
    const root = path.join(ws, "named");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "meu-projeto-nomeado" });

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Projeto: meu-projeto-nomeado ·");
    /** `serialized` — o SessionBrief estruturado — continua intacto e não leva o nome. */
    expect(JSON.parse(r.serialized).project).not.toHaveProperty("name");
  });

  it("manifest ilegível no path esperado → degrada para undefined, nunca lança", async () => {
    const semManifest = path.join(ws, "sem-manifest");
    await fs.ensureDir(semManifest);
    await expect(readProjectName(fakeBrief(), semManifest)).resolves.toBeUndefined();
  });

  it("identity_source=bootstrap → undefined sem exigir manifest nenhum", async () => {
    await expect(
      readProjectName(fakeBrief({ project: { id: "prj_bootstraplocator0", identity_source: "bootstrap" } }), ws)
    ).resolves.toBeUndefined();
  });

  /**
   * P1.3i (B3) — o defeito medido (H1): `CLAUDE_PROJECT_DIR` numa SUBPASTA
   * de um projeto canônico (sem `.nexos` próprio) fazia `readProjectName`/
   * `resolveMapSummary` lerem `forProject(projectDir)` — a subpasta em si,
   * que nunca teve manifest nem mapa — perdendo nome e mapa do projeto
   * inteiro. A correção lê `identity.rootPath` (a fronteira REAL, resolvida
   * por `resolveProject`), não `CLAUDE_PROJECT_DIR` cru.
   */
  it("B3 · CLAUDE_PROJECT_DIR numa subpasta do projeto canônico ainda mostra nome e mapa", async () => {
    const { writeFreshProjectMap } = await import("../src/lib/map/project-map.js");
    const root = path.join(ws, "canonico-com-subpasta");
    await fs.ensureDir(root);
    await fs.writeJson(path.join(root, "package.json"), { name: "projeto-com-subpasta", version: "1.0.0" });
    /**
     * C1 (fatia C, orquestrador) — precisa de UMA rota real para que
     * `mapSummaryLine` não seja `undefined`: `readMapSummary` (A14) nunca
     * fabrica "routes 0 · tabelas 0 · componentes 0" (o defeito que a
     * fatia C fechou — C7/C8), então um projeto sem NENHUM fato observável
     * legitimamente não tem "Mapa:" nenhum para mostrar. A asserção precisa
     * de um fato real para continuar provando o que B3 sempre provou: o
     * mapa do projeto CANÔNICO (raiz), não da subpasta, chega na projeção.
     */
    await fs.ensureDir(path.join(root, "src", "app", "api", "x"));
    await fs.writeFile(path.join(root, "src", "app", "api", "x", "route.ts"), "export async function GET() {}\n");
    await initializeCapsule(root, { projectName: "projeto-com-subpasta" });
    await writeFreshProjectMap(root);

    const subpasta = path.join(root, "src", "domain");
    await fs.ensureDir(subpasta);

    const r = await runSessionStartAdapter(payload({ cwd: subpasta }), { CLAUDE_PROJECT_DIR: subpasta });
    expect(r.additionalContext).toContain("Projeto: projeto-com-subpasta ·");
    expect(r.additionalContext).toContain("Mapa:");
    expect(r.additionalContext).toMatch(/rotas 1 em 1 arquivo/);
  });
});

/**
 * C1/C4 (fatia C, orquestrador) — o SessionStart deixa de ser só uma FOTO do
 * último `nexos map`: quando `checkMapFreshness` acusa `stale`, converge
 * (`refreshMapIfStale`) sob orçamento ANTES de montar o resumo — mudança sem
 * commit chega no brief da MESMA sessão em que aconteceu, sem esperar o
 * usuário lembrar de rodar `nexos map`.
 */
describe("C1/C4 · SessionStart converge mapa desatualizado sob orçamento", () => {
  async function gitProjetoComRota(nome: string): Promise<string> {
    const root = path.join(ws, nome);
    await fs.ensureDir(root);
    await fs.writeJson(path.join(root, "package.json"), { name: nome, dependencies: {} });
    await fs.ensureDir(path.join(root, "src", "app", "api", "x"));
    await fs.writeFile(path.join(root, "src", "app", "api", "x", "route.ts"), "export async function GET() {}\n");
    gitQuieto(["init", "-q", "."], root);
    gitQuieto(["config", "user.email", "t@t"], root);
    gitQuieto(["config", "user.name", "t"], root);
    gitQuieto(["add", "-A"], root);
    gitQuieto(["commit", "-qm", "base"], root);
    return root;
  }

  it("C4 · rota nova NÃO commitada (dentro do escopo) aparece na contagem do brief, sem esperar `nexos map`", async () => {
    const { init } = await import("../src/commands/init.js");
    const root = await gitProjetoComRota("c1-refresh-dentro");
    await init({ cwd: root, registerGlobally: false });

    // rota nova, NUNCA commitada — o cenário central do defeito I da auditoria.
    await fs.ensureDir(path.join(root, "src", "app", "api", "y"));
    await fs.writeFile(path.join(root, "src", "app", "api", "y", "route.ts"), "export async function POST() {}\n");

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toMatch(/rotas 2 em 2 arquivo/);
    expect(r.additionalContext).not.toContain("Mapa desatualizado");
  });

  it("C4 · escopo acima do limite (files_examined > 1500) → linha 'Mapa desatualizado', sem tentar convergir", async () => {
    const { init } = await import("../src/commands/init.js");
    const { forProject } = await import("../src/lib/capsule/paths.js");
    const root = await gitProjetoComRota("c1-acima-do-limite");
    await init({ cwd: root, registerGlobally: false });

    /**
     * Forja `files_examined` acima do teto SEM criar 1500 arquivos de
     * verdade no disco — o único efeito real de `files_examined` é o gate
     * `withinScope` dentro de `resolveMapSummary`; `checkMapFreshness` não
     * lê este campo (só HEAD/`git status`), então a comparação de frescor
     * continua válida sobre o projeto pequeno de verdade.
     */
    const projectJsonPath = forProject(root).mapProjectJson();
    const projectJson = await fs.readJson(projectJsonPath);
    projectJson.files_examined = 5000;
    await fs.writeJson(projectJsonPath, projectJson);

    // mudança sem commit — dispara `stale: uncommitted_changes`.
    await fs.writeFile(path.join(root, "src", "app", "api", "x", "route.ts"), "export async function GET() { return 1; }\n");

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Mapa desatualizado:");
    expect(r.additionalContext).toContain("route.ts");
    expect(r.additionalContext).toContain("`nexos map` atualiza.");
    // `staleLine` SUBSTITUI a seção — nunca mistura resumo (potencialmente
    // velho) com o aviso de desatualizado na mesma resposta.
    expect(r.additionalContext).not.toContain("Mapa: rotas");
  });
});

// ─── A15 · cadeia inteira: project_state.global_goal → Objetivo no boot ────

/**
 * Fatia 1/Passo 3, commit 1. `global_goal` só chegou a `CAMPOS_UTEIS`
 * (`context-assembler.ts`) nesta mudança — prova a cadeia real, não só a
 * função pura: record publicado no Store canônico → `assembleContext` →
 * `buildSessionBriefForCwd` → `runSessionStartAdapter` → `additionalContext`.
 */
describe("A15 · global_goal atravessa a cadeia inteira até a linha Objetivo:", () => {
  it("presente no record → Objetivo: aparece na additionalContext real do adapter", async () => {
    const root = path.join(ws, "com-objetivo");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "com-objetivo" });
    await publishCanonical(
      root,
      makeProjectState({
        project_id: projectId,
        content: {
          title: "estado",
          current_state: "trabalhando",
          next_action: "seguir",
          global_goal: "fechar o canal canonico do boot",
        },
      })
    );

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Objetivo: fechar o canal canonico do boot");
  });

  it("ausente no record → sem linha Objetivo:, nunca fabricada", async () => {
    const root = path.join(ws, "sem-objetivo");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "sem-objetivo" });
    await publishCanonical(root, makeProjectState({ project_id: projectId }));

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).not.toContain("Objetivo:");
  });
});

// ─── A16 · gotcha compacto — cadeia inteira (Fatia 1/Passo 3, commit 2) ────

/**
 * `CANONICAL GOTCHA = completo · BOOT PROJECTION = acionável e compacta`.
 * Prova que a compactação é SÓ da leitura em texto: o record publicado, o
 * `ContextPack` do assembler e o `SessionBrief` estruturado (`serialized`)
 * continuam com os sete campos — só `additionalContext` corta.
 */
describe("A16 · gotcha na projeção mostra title/rule/source_ref; serialized continua completo", () => {
  it("additionalContext compacta; serialized guarda todos os campos do gotcha", async () => {
    const root = path.join(ws, "com-gotcha");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "com-gotcha" });
    await publishCanonical(
      root,
      makeGotcha({
        project_id: projectId,
        provenance: {
          source_ref: "nexos://gotcha/exemplo-e2e",
          producer_id: "test",
          submitted_at: "2026-08-12T12:00:00.000Z",
        },
        evidence_refs: ["nexos://gotcha/exemplo-e2e"],
        content: {
          title: "gotcha e2e",
          rule: "sempre medir antes de declarar sucesso",
          failure_mode: "declarou sucesso sem medir",
          cause: "pressa",
          mitigation: "nenhuma",
          prevention: "checklist obrigatorio",
          consequence: "regressao em producao",
          trigger: "deploy sexta-feira",
        },
      })
    );

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });

    expect(r.additionalContext).toContain("gotcha e2e (nexos://gotcha/exemplo-e2e)");
    expect(r.additionalContext).toContain("regra: sempre medir antes de declarar sucesso");
    for (const campo of ["failure_mode", "cause", "mitigation", "prevention", "consequence", "trigger"]) {
      expect(r.additionalContext, `${campo} vazou na projeção compacta`).not.toContain(campo);
    }

    const serializedFields = JSON.parse(r.serialized).knowledge.items.find(
      (i: { source_ref: string }) => i.source_ref === "nexos://gotcha/exemplo-e2e"
    ).fields;
    expect(Object.keys(serializedFields).sort()).toEqual(
      ["cause", "consequence", "failure_mode", "mitigation", "prevention", "rule", "title", "trigger"].sort()
    );
  });
});

// ─── A17 · a evidência NOMEADA por last_verified — leitura auditável ───────

/**
 * `HERDADO != REVERIFICADO` · `UNKNOWN != VERIFIED`.
 *
 * Antes desta fatia o boot escrevia `Verificado: ${fields.last_verified}` — um
 * id NU, apresentado como verdade corrente, que nada no texto permitia
 * conferir. Medido no Store real deste repo: `ev_01M16MY1SNAKXDY89GV9CBBW83`
 * (gate `test`, árvore SUJA, commit `1c7e029f`) atravessou 19 revisões de
 * `project_state` e continuava sendo impresso como verificação 34 commits
 * depois.
 *
 * A política — TTL, amarração a commit, recusa de árvore suja — continua sendo
 * `verifyFromEvidence` (`lib/evidence.ts`). Estes testes provam a LEITURA: um
 * estado explícito por modo de falha, e `Verificado:` só quando `OK`.
 */

const EV_GATE = "test";
const HORA = 60 * 60 * 1_000;

function gitQuieto(args: readonly string[], cwd: string): string {
  return execFileSync("git", [...args], { cwd, encoding: "utf-8" }).trim();
}

/** Repo git real com Capsule canônica — `resolveNamedEvidence` lê o HEAD de verdade. */
async function repoCanonico(nome: string): Promise<{ root: string; projectId: string; head: string }> {
  const root = path.join(ws, nome);
  await fs.ensureDir(root);
  await fs.writeJson(path.join(root, "package.json"), { name: nome });
  gitQuieto(["init", "-q", "."], root);
  gitQuieto(["config", "user.email", "t@t"], root);
  gitQuieto(["config", "user.name", "t"], root);
  gitQuieto(["add", "-A"], root);
  gitQuieto(["commit", "-qm", "base"], root);
  const { projectId } = await initializeCapsule(root, { projectName: nome });
  return { root, projectId, head: gitQuieto(["rev-parse", "HEAD"], root) };
}

async function gravarEvidencia(
  root: string,
  record: Record<string, unknown>
): Promise<void> {
  const dir = path.join(forProject(root).localRoot(), "evidence");
  await fs.ensureDir(dir);
  await fs.writeJson(path.join(dir, `${String(record.id)}.json`), record, { spaces: 2 });
}

/** Evidence VÁLIDA por construção; cada teste degrada exatamente um eixo. */
function evidencia(over: Record<string, unknown> = {}): Record<string, unknown> {
  const finished = new Date().toISOString();
  return {
    id: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    kind: "command_observation",
    gate: EV_GATE,
    command: "npm",
    args: ["run", "test"],
    cwd: "/qualquer",
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
}

async function estadoDeclarando(root: string, projectId: string, declarado: string): Promise<void> {
  await publishCanonical(
    root,
    makeProjectState({
      project_id: projectId,
      content: {
        title: "estado",
        current_state: "trabalhando",
        next_action: "seguir",
        last_verified: declarado,
      },
    })
  );
}

describe("A17 · resolveNamedEvidence — um estado explícito por modo de falha", () => {
  it("OK: evidência do HEAD, árvore limpa e fresca → linha falsificável com gate/instante/commit/tree", async () => {
    const { root, projectId, head } = await repoCanonico("ev-ok");
    await gravarEvidencia(root, evidencia({ commit: head }));
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("OK");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain(`Verificação: ${EV_GATE} ·`);
    expect(r.additionalContext).toContain(`commit ${head.slice(0, 7)}`);
    expect(r.additionalContext).toContain("tree clean");
    /** O id NU nunca mais aparece como afirmação de verificação. */
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  it("MISSING: id declarado sem arquivo nenhum no disco", async () => {
    const { root, projectId } = await repoCanonico("ev-missing");
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("MISSING");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Evidência: MISSING");
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  /**
   * FAIL CLOSED — o arquivo cujo `id` não sobreviveu ao parse PODE ser este.
   * `AUSENTE` e `ILEGÍVEL` são fatos diferentes; adivinhar ausência esconderia
   * justamente o record que deixou de ser lido.
   */
  it("CORRUPT: JSON ilegível no diretório de Evidence não vira MISSING", async () => {
    const { root, projectId } = await repoCanonico("ev-corrupt");
    const dir = path.join(forProject(root).localRoot(), "evidence");
    await fs.ensureDir(dir);
    await fs.writeFile(path.join(dir, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA.json"), "{ isto não é json");
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("CORRUPT");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Evidência: CORRUPT");
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  it("STALE: evidência do HEAD, limpa, mas além do TTL", async () => {
    const { root, projectId, head } = await repoCanonico("ev-stale");
    const velho = new Date(Date.now() - EVIDENCE_MAX_AGE_MS - HORA).toISOString();
    await gravarEvidencia(
      root,
      evidencia({ commit: head, started_at: velho, finished_at: velho })
    );
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("STALE");
    expect(status.detail).toContain("expirada");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Evidência: STALE");
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  it("COMMIT_MISMATCH: evidência de outro commit", async () => {
    const { root, projectId } = await repoCanonico("ev-commit");
    await gravarEvidencia(root, evidencia({ commit: "a".repeat(40) }));
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("COMMIT_MISMATCH");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Evidência: COMMIT_MISMATCH");
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  it("DIRTY_TREE: evidência do HEAD e fresca, mas observada em árvore suja", async () => {
    const { root, projectId, head } = await repoCanonico("ev-dirty");
    await gravarEvidencia(root, evidencia({ commit: head, tree_state: "dirty" }));
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("DIRTY_TREE");
    expect(status.detail).toContain("árvore suja");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Evidência: DIRTY_TREE");
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  /**
   * O Store REAL deste repo já guardou texto livre aqui — `"verify:work-graph
   * exit 0 · verify:session-continuity 12/12 · 1999 testes"` por 17 revisões, e
   * um ensaio de ~900 chars por 3. Valor que não resolve como Evidence canônica
   * NÃO é verificação: degrada com estado explícito, não lança, não some com o
   * boot, e não ocupa a linha inteira.
   */
  it("LEGACY: texto livre degrada honestamente, sem exceção e sem engolir o boot", async () => {
    const { root, projectId } = await repoCanonico("ev-legacy");
    const livre = "verify:work-graph exit 0 · verify:session-continuity 12/12 · 1999 testes";
    await estadoDeclarando(root, projectId, livre);

    const status = await resolveNamedEvidence({ projectRoot: root, declared: livre });
    expect(status.state).toBe("LEGACY");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Verificação declarada (legado): não validável");
    expect(r.additionalContext).not.toContain("Verificado:");
    /** O boot inteiro continua saindo — o resto do brief não é colateral. */
    expect(r.additionalContext).toContain("Estado: trabalhando");
  });

  it("LEGACY longo é truncado — um ensaio de ~900 chars não vira linha de boot", async () => {
    const { root } = await repoCanonico("ev-legacy-longo");
    const ensaio = "prosa ".repeat(200).trim();
    const status = await resolveNamedEvidence({ projectRoot: root, declared: ensaio });
    expect(status.state).toBe("LEGACY");
    expect(status.declared.length).toBeLessThan(120);
    expect(status.declared.endsWith("…")).toBe(true);
  });

  /**
   * A armadilha do homônimo, medida: `verifyFromEvidence` elege A MAIS RECENTE
   * do gate no commit — que pode não ser a nomeada. Sem esta separação, uma
   * execução mais nova absolveria um id que ninguém revalidou.
   * `A PASS FOR THE GATE != A PASS FOR THIS RECORD`.
   */
  it("SUPERSEDED: outra evidência do MESMO gate/commit, mais nova, não absolve a nomeada", async () => {
    const { root, projectId, head } = await repoCanonico("ev-superseded");
    const antes = new Date(Date.now() - 60_000).toISOString();
    await gravarEvidencia(root, evidencia({ commit: head, started_at: antes, finished_at: antes }));
    await gravarEvidencia(
      root,
      evidencia({ id: "ev_01BBBBBBBBBBBBBBBBBBBBBBBB", commit: head })
    );
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("SUPERSEDED");
    expect(status.detail).toContain("ev_01BBBBBBBBBBBBBBBBBBBBBBBB");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  /**
   * CONTRAFACTUAL host-facing: os fatos EXATOS de
   * `ev_01M16MY1SNAKXDY89GV9CBBW83` no Store real — gate `test`, árvore SUJA,
   * commit `1c7e029f…` diferente do HEAD. O boot NÃO pode imprimir aquele id
   * como verificação, e TEM que expor o motivo que o validador devolveu.
   *
   * Medido contra o repo real (branch `recovery/audit-v2-d11`, HEAD
   * `8605692`): o validador devolve COMMIT_MISMATCH, não DIRTY_TREE — o filtro
   * de commit roda ANTES da checagem de árvore em `verifyFromEvidence`, e
   * elimina o record antes de a sujeira chegar a ser avaliada.
   */
  it("contrafactual: os fatos reais de ev_01M16MY1… nunca saem como `Verificado:`", async () => {
    const { root, projectId } = await repoCanonico("ev-contrafactual");
    await gravarEvidencia(
      root,
      evidencia({
        id: "ev_01M16MY1SNAKXDY89GV9CBBW83",
        gate: "test",
        args: ["run", "test:all"],
        started_at: "2026-08-29T11:34:27.654Z",
        finished_at: "2026-08-29T11:36:59.957Z",
        commit: "1c7e029fff0b10bc6a4850f1b30db55ae72cc3ae",
        tree_state: "dirty",
      })
    );
    await estadoDeclarando(root, projectId, "ev_01M16MY1SNAKXDY89GV9CBBW83");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).not.toContain("Verificado: ev_01M16MY1SNAKXDY89GV9CBBW83");
    expect(r.additionalContext).toContain("Evidência: COMMIT_MISMATCH");
    expect(r.additionalContext).toContain("de outro commit");
  });

  /**
   * Sem repo git não há commit a que amarrar. Recusa NOMEADA, não um PASS por
   * omissão: `verifyFromEvidence` só checa `tree_state` quando o caller exige
   * um commit, então cair no caminho sem commit seria justamente aceitar
   * evidência que não prova commit nenhum.
   */
  it("NO_COMMIT: projeto sem repo git observável não vira verificação", async () => {
    const root = path.join(ws, "ev-sem-git");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "ev-sem-git" });
    await gravarEvidencia(root, evidencia({ commit: "b".repeat(40) }));

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("NO_COMMIT");
    expect(status.record?.gate).toBe(EV_GATE);
  });

  /**
   * O fallback honesto: recusa cujo motivo este módulo não soube nomear
   * continua sendo recusa, com o motivo VERBATIM do validador. Aqui o gate
   * simplesmente FALHOU — nada a ver com commit, TTL ou árvore.
   */
  it("REFUSED: gate que saiu diferente de 0 não é nomeado, mas também não passa", async () => {
    const { root, projectId, head } = await repoCanonico("ev-refused");
    await gravarEvidencia(
      root,
      evidencia({ commit: head, exit_code: 1, observed_pass: false })
    );
    await estadoDeclarando(root, projectId, "ev_01AAAAAAAAAAAAAAAAAAAAAAAA");

    const status = await resolveNamedEvidence({
      projectRoot: root,
      declared: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
    });
    expect(status.state).toBe("REFUSED");
    expect(status.detail).toContain("exit 1 observado");

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Evidência: REFUSED");
    expect(r.additionalContext).not.toContain("Verificado:");
  });

  /**
   * `UNKNOWN != VERIFIED` na fronteira sync/async: `buildAdditionalContext`
   * continua SÍNCRONA e o status chega resolvido do caller. Chamada sem status
   * — caller que esqueceu de resolver, ou I/O que falhou — degrada para recusa
   * explícita, nunca para `Verificado:`.
   */
  it("sem status resolvido, a linha vira NÃO RESOLVIDA — nunca um `Verificado:` de graça", () => {
    const out = buildAdditionalContext(
      fakeBrief({
        knowledge: {
          items: [
            {
              source_ref: "nexos://project-state",
              title: "estado",
              why: "estado atual do projeto",
              fields: {
                title: "estado",
                current_state: "trabalhando",
                last_verified: "ev_01AAAAAAAAAAAAAAAAAAAAAAAA",
              },
            },
          ],
          omitted: 0,
          anomalies: 0,
        },
      }),
      undefined
    );
    expect(out).toContain("Evidência: NÃO RESOLVIDA (ev_01AAAAAAAAAAAAAAAAAAAAAAAA)");
    expect(out).not.toContain("Verificado:");
  });
});

// --- C3 · buildAdditionalContext(capabilityLines) — pura, sem I/O ----------

describe("C3 · buildAdditionalContext imprime capabilityLines logo após taskLine, ou nada", () => {
  it("linhas não-vazias entram verbatim, na ordem recebida", () => {
    const out = buildAdditionalContext(fakeBrief(), undefined, undefined, "Tarefa: X · READY", [
      "Capabilities da tarefa:",
      "- project.structure",
      "- library.docs",
    ]);
    const idx = out.split("\n").findIndex((l) => l === "Tarefa: X · READY");
    expect(out.split("\n").slice(idx + 1, idx + 4)).toEqual([
      "Capabilities da tarefa:",
      "- project.structure",
      "- library.docs",
    ]);
  });

  it("array vazio ou undefined não escreve o cabeçalho", () => {
    const semArray = buildAdditionalContext(fakeBrief(), undefined, undefined, "Tarefa: X", []);
    expect(semArray).not.toContain("Capabilities da tarefa:");
    const semParam = buildAdditionalContext(fakeBrief(), undefined, undefined, "Tarefa: X");
    expect(semParam).not.toContain("Capabilities da tarefa:");
  });
});

// --- B5 · estado legado (.nexos/memory/project/state.md) --------------------

describe("B5 · estado legado aparece só sem head canônico de project_state", () => {
  it("sem project_state canônico + state.md legado → nota 'não confirmado' com data e ponteiro para decisions.md", async () => {
    const root = path.join(ws, "legado-state");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "legado-state" });
    const memoryDir = path.join(root, ".nexos", "memory", "project");
    await fs.ensureDir(memoryDir);
    await fs.writeFile(
      path.join(memoryDir, "state.md"),
      "# Estado\n\nStatus: em andamento\nPróximo: revisar webhook\n"
    );
    await fs.writeFile(
      path.join(memoryDir, "decisions.md"),
      "## ADR-001: usar postgres\n\ntexto\n\n## ADR-002: usar prisma\n\ntexto\n"
    );

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toMatch(
      /Estado legado \(não confirmado\): \.nexos\/memory\/project\/state\.md · modificado \d{4}-\d{2}-\d{2}/
    );
    expect(r.additionalContext).toContain("Status: em andamento");
    expect(r.additionalContext).toContain("Próximo: revisar webhook");
    expect(r.additionalContext).toContain("decisions.md (2 título(s), legado)");
  });

  it("com project_state canônico presente, legado NUNCA aparece como estado", async () => {
    const root = path.join(ws, "canonico-com-legado-state");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "canonico-com-legado-state" });
    const memoryDir = path.join(root, ".nexos", "memory", "project");
    await fs.ensureDir(memoryDir);
    await fs.writeFile(path.join(memoryDir, "state.md"), "Status: legado nunca deveria aparecer\n");

    await publishCanonical(
      root,
      makeProjectState({
        project_id: projectId,
        content: { title: "estado", current_state: "estado canônico real", next_action: "seguir" },
      })
    );

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Estado: estado canônico real");
    expect(r.additionalContext).not.toContain("Estado legado");
    expect(r.additionalContext).not.toContain("nunca deveria aparecer");
  });

  /**
   * C5 (fatia C, orquestrador) — o `state.md` real observado (Fintech) carrega
   * o rótulo DENTRO do título markdown ("## Status: FASE 4 …", "## Fase
   * Atual: Development — próximo: …"), não numa linha de corpo solta. A
   * versão anterior de `extractLegacyStateLines` excluía TODA linha
   * começando com `#` do candidato a rotulada — o rótulo real nunca era
   * visto, e o fallback genérico pegava linhas soltas de uma lista de
   * commits em vez do status de verdade.
   */
  it("C5 · rótulo dentro de título markdown ('## Status: ...', '## Fase Atual: ...') conta como rotulada", async () => {
    const root = path.join(ws, "legado-titulo-rotulado");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "legado-titulo-rotulado" });
    const memoryDir = path.join(root, ".nexos", "memory", "project");
    await fs.ensureDir(memoryDir);
    await fs.writeFile(
      path.join(memoryDir, "state.md"),
      "## Status: FASE 4 — integração\n\n" +
        "## Fase Atual: Development — próximo: revisar webhook\n\n" +
        "## Histórico de commits\n- a1b2c3d fix: x\n- e4f5a6b feat: y\n"
    );

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Status: FASE 4 — integração");
    expect(r.additionalContext).toContain("Fase Atual: Development — próximo: revisar webhook");
    expect(r.additionalContext).not.toContain("a1b2c3d fix: x");
  });
});

// --- B8 · arquitetura toda UNKNOWN ------------------------------------------

describe("B8 · architecture.md com tudo em UNKNOWN vira uma linha honesta, nunca silêncio", () => {
  it("architecture.md existe mas só tem a seção UNKNOWN → 'nada observado ainda'", async () => {
    const { forProject } = await import("../src/lib/capsule/paths.js");
    const { writeFreshProjectMap } = await import("../src/lib/map/project-map.js");
    const root = path.join(ws, "so-unknown");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "so-unknown" });
    /**
     * C1 (fatia C, orquestrador) — `resolveMapSummary` agora CONVERGE mapa
     * ausente/desatualizado (`checkMapFreshness`/`refreshMapIfStale`) antes
     * de montar o resumo. Sem um `project.json` real, este teste ficaria
     * `stale`/`no_map` e a convergência REESCREVERIA o `architecture.md`
     * forjado abaixo com o gerador de verdade — testando o gerador (fora do
     * escopo desta suíte, e de fatia diferente), não a APRESENTAÇÃO. Rodar o
     * gerador real UMA vez primeiro estabelece um `project.json` com
     * fingerprint que bate com o código-fonte atual (nenhum arquivo de
     * origem muda depois) — `checkMapFreshness` enxerga `fresh`, e o
     * `architecture.md` forjado a seguir (que `.nexos/` nunca entra no
     * fingerprint) é lido tal como escrito, sem reconvergir.
     */
    await writeFreshProjectMap(root);
    const p = forProject(root);
    await fs.ensureDir(path.dirname(p.mapArchitectureMd()));
    await fs.writeFile(
      p.mapArchitectureMd(),
      "# Arquitetura\n\nGerado deterministicamente.\n\nPerguntas de aceite sem fato\n- o que este projeto faz?\n"
    );

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    /**
     * C8 (fatia C, orquestrador) — projeto sem NENHUM arquivo de linguagem
     * suportada tem `coverage.json` real com todas as áreas `not_examined`
     * (`writeFreshProjectMap` acima escreve isso de verdade). `coverageLine`
     * PREFERE essa frase concreta ao filler genérico "nada observado ainda"
     * — as duas nunca aparecem juntas dizendo a mesma coisa (ver
     * `buildAdditionalContext`). O filler genérico continua coberto, sem
     * depender do gerador real, no teste unitário de
     * `buildAdditionalContext` logo abaixo ("C8 · buildAdditionalContext").
     */
    expect(r.additionalContext).toContain("Cobertura:");
    expect(r.additionalContext).toContain("not_examined");
    expect(r.additionalContext).not.toContain("Arquitetura: nada observado ainda");
  });

  it("architecture.md ausente (projeto NEW) — seção de arquitetura nem aparece", async () => {
    const root = path.join(ws, "sem-arch-md");
    await fs.ensureDir(root);
    await fs.writeJson(path.join(root, "package.json"), { name: "sem-arch-md" });

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).not.toContain("Arquitetura:");
  });
});

/**
 * C8 (fatia C, orquestrador) — testado no NÍVEL PURO de `buildAdditionalContext`,
 * sem passar pelo gerador real de mapa: decouplado de qualquer defeito
 * (corrigido ou não) no PRÓPRIO gerador — só a regra de PRECEDÊNCIA entre
 * `architectureSummaryLines`/`coverageLine`/o filler genérico.
 */
describe("C8 · buildAdditionalContext — coverageLine tem precedência sobre o filler genérico", () => {
  it("architectureSummaryLines vazio + sem coverageLine → filler genérico 'nada observado ainda'", () => {
    const out = buildAdditionalContext(
      fakeBrief(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      []
    );
    expect(out).toContain("Arquitetura: nada observado ainda (projeto novo ou stack sem detector).");
  });

  it("architectureSummaryLines vazio + coverageLine presente → coverageLine substitui o filler, nunca as duas juntas", () => {
    const out = buildAdditionalContext(
      fakeBrief(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      [],
      undefined,
      undefined,
      "Cobertura: routes unsupported — sem detector para C++"
    );
    expect(out).toContain("Cobertura: routes unsupported — sem detector para C++");
    expect(out).not.toContain("nada observado ainda");
  });

  it("architectureSummaryLines com conteúdo + coverageLine presente → as duas aparecem (áreas diferentes)", () => {
    const out = buildAdditionalContext(
      fakeBrief(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      ["Aplicação web/serviço com rotas HTTP observadas."],
      undefined,
      undefined,
      "Cobertura: auth not_examined — nenhum arquivo de código no escopo"
    );
    expect(out).toContain("Arquitetura:");
    expect(out).toContain("Aplicação web/serviço com rotas HTTP observadas.");
    expect(out).toContain("Cobertura: auth not_examined — nenhum arquivo de código no escopo");
  });

  it("mapSummaryLine ganha o rótulo 'Mapa: ' — a função de dados nunca prefixa", () => {
    const out = buildAdditionalContext(
      fakeBrief(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "rotas 6 em 4 arquivo(s) · modelos 11 · enums 6 (prisma/postgresql, remoto não verificado)"
    );
    expect(out).toContain(
      "Mapa: rotas 6 em 4 arquivo(s) · modelos 11 · enums 6 (prisma/postgresql, remoto não verificado)"
    );
  });
});

describe("C1 · buildAdditionalContext — staleLine (mapa desatualizado)", () => {
  it("staleLine presente → aparece na projeção; ausente → nada é acrescentado", () => {
    const comStale = buildAdditionalContext(
      fakeBrief(),
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      undefined,
      "Mapa desatualizado: 2 arquivo(s) mudaram (src/a.ts, src/b.ts) — `nexos map` atualiza."
    );
    expect(comStale).toContain(
      "Mapa desatualizado: 2 arquivo(s) mudaram (src/a.ts, src/b.ts) — `nexos map` atualiza."
    );

    const semStale = buildAdditionalContext(fakeBrief(), undefined);
    expect(semStale).not.toContain("Mapa desatualizado");
  });
});

// --- A15 · linha "Tarefa:" (vertical ProjectCheckpoint) ---------------------

describe('A15 · linha "Tarefa:" — HEAD, EMPTY, UNHEALTHY', () => {
  it("EMPTY: capsule canonica sem checkpoint ainda — linha omitida (B6)", async () => {
    const root = path.join(ws, "task-empty");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "task-empty" });

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    // P1.3i (B6) — chain vazia é o estado NORMAL de um projeto recém-canônico,
    // não uma recusa: a linha "Tarefa:" some por completo.
    expect(r.additionalContext).not.toContain("Tarefa:");
  });

  it("HEAD: checkpoint READY mostra estado, tentativa e proximas arestas", async () => {
    const root = path.join(ws, "task-head");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "task-head" });
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "fatia A15" });
    const ready = await advanceCheckpoint({ projectRoot: root, state: "READY" });
    expect(ready.ok).toBe(true);
    if (!ready.ok) return;

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain(
      `Tarefa: fatia A15 · READY · tentativa 1 · próximo: RUNNING | BLOCKED · ${ready.record.id}`
    );
  });

  it("UNHEALTHY: predecessor orfao — a linha nomeia a recusa, nunca inventa progresso", async () => {
    const root = path.join(ws, "task-unhealthy");
    await fs.ensureDir(root);
    const { projectId } = await initializeCapsule(root, { projectName: "task-unhealthy" });
    const orphanPrev = newRecordId("ProjectCheckpoint");
    const orphan = {
      ...makeCheckpoint("orfao", orphanPrev, { id: newRecordId("ProjectCheckpoint") }),
      project_id: projectId,
    };
    const dir = forProject(root).familyDir("ProjectCheckpoint");
    await fs.ensureDir(dir);
    await fs.writeFile(
      path.join(dir, `${orphan.id}.yaml`),
      serializeCanonical(orphan as Parameters<typeof serializeCanonical>[0])
    );

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Tarefa: chain não legível — DANGLING_PREDECESSOR");
  });
});

// --- C1/C3 · "Capabilities da tarefa:" (vertical task-owned capability) -----

describe('C1/C3 · linha "Capabilities da tarefa:" — presente só quando o head declara', () => {
  it("head com required_capabilities: brief contém o cabeçalho e um `- <id>` por capability", async () => {
    const root = path.join(ws, "task-caps-present");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "task-caps-present" });
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "fatia C1" });
    const ready = await advanceCheckpoint({
      projectRoot: root,
      state: "READY",
      requiredCapabilities: ["project.structure"],
    });
    expect(ready.ok).toBe(true);

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toContain("Capabilities da tarefa:");
    expect(r.additionalContext).toContain("- project.structure");
  });

  it("head sem required_capabilities: nenhuma linha aparece", async () => {
    const root = path.join(ws, "task-caps-absent");
    await fs.ensureDir(root);
    await initializeCapsule(root, { projectName: "task-caps-absent" });
    await advanceCheckpoint({ projectRoot: root, state: "PENDING", statement: "fatia C1" });
    await advanceCheckpoint({ projectRoot: root, state: "READY" });

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).not.toContain("Capabilities da tarefa:");
  });
});

/**
 * C7 (fatia C, orquestrador) — o resumo ANTIGO (`formatMapSummaryLine`,
 * removido) contava relações/enums/migrations como "tabelas" — um schema com
 * 11 models + 6 enums + relações saía como "tabelas 37" (medido no Fintech
 * real). `readMapSummary` (A14) separa `modelos`/`enums` explicitamente —
 * este teste prova que o SessionStart real (não só `readMapSummary` isolado,
 * já coberto em `map-freshness-integration.test.ts`) nunca mais imprime a
 * palavra "tabelas".
 */
describe("C7 · SessionStart nunca imprime 'tabelas' — modelos/enums separados, sem inflar por relação", () => {
  it("schema prisma com modelos + enums + relações → 'modelos N · enums M', nunca 'tabelas'", async () => {
    const { init } = await import("../src/commands/init.js");
    const root = path.join(ws, "c7-schema-generico");
    await fs.ensureDir(root);
    await fs.writeJson(path.join(root, "package.json"), { name: "c7-schema-generico", dependencies: { prisma: "^5.0.0" } });
    await fs.ensureDir(path.join(root, "prisma"));
    await fs.writeFile(
      path.join(root, "prisma", "schema.prisma"),
      [
        'datasource db {',
        '  provider = "postgresql"',
        '  url      = env("DATABASE_URL")',
        "}",
        "",
        "enum Status {",
        "  ACTIVE",
        "  INACTIVE",
        "}",
        "",
        "model Account {",
        "  id     Int      @id @default(autoincrement())",
        "  status Status",
        "  items  Item[]",
        "  @@map(\"accounts\")",
        "}",
        "",
        "model Item {",
        "  id        Int     @id @default(autoincrement())",
        "  account   Account @relation(fields: [accountId], references: [id])",
        "  accountId Int",
        "}",
        "",
      ].join("\n")
    );
    gitQuieto(["init", "-q", "."], root);
    gitQuieto(["config", "user.email", "t@t"], root);
    gitQuieto(["config", "user.name", "t"], root);
    gitQuieto(["add", "-A"], root);
    gitQuieto(["commit", "-qm", "base"], root);
    await init({ cwd: root, registerGlobally: false });

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).toMatch(/modelos 2/);
    expect(r.additionalContext).toMatch(/enums 1/);
    expect(r.additionalContext).not.toContain("tabelas");
  });
});

/**
 * C4 (fatia C, orquestrador) — o teto de bytes que o handoff exige: um brief
 * de fixture tipo "Fintech" (rotas + schema prisma + auth própria — nomes
 * GENÉRICOS, nunca os do app real) precisa caber em ≤ 2048 bytes. Prova que
 * o corte de exibição (`MAX_ITEMS_HOT`, corpo de knowledge fora do brief,
 * seções honestas em vez de dumps) mantém o HOT compacto mesmo com um schema
 * de porte real.
 */
describe("C4 · brief de fixture tipo Fintech cabe no teto de bytes", () => {
  it("rotas + schema prisma com múltiplos models/enums + auth própria → additionalContext ≤ 2048 bytes", async () => {
    const { init } = await import("../src/commands/init.js");
    const root = path.join(ws, "c4-fixture-fintech");
    await fs.ensureDir(root);
    await fs.writeJson(path.join(root, "package.json"), {
      name: "c4-fixture-fintech",
      dependencies: { prisma: "^5.0.0", inngest: "^3.0.0" },
    });
    for (const nome of ["accounts", "transfers", "webhooks", "billing"]) {
      await fs.ensureDir(path.join(root, "src", "app", "api", nome));
      await fs.writeFile(
        path.join(root, "src", "app", "api", nome, "route.ts"),
        "export async function GET() {}\nexport async function POST() {}\n"
      );
    }
    await fs.ensureDir(path.join(root, "src", "lib"));
    await fs.writeFile(
      path.join(root, "src", "lib", "auth.ts"),
      'export function authenticate(req: Request) { return req.headers.get("authorization"); }\n'
    );
    await fs.ensureDir(path.join(root, "prisma"));
    const models = ["Account", "Transfer", "Webhook", "Invoice", "Customer", "AuditLog"];
    const enums = ["Status", "Currency"];
    await fs.writeFile(
      path.join(root, "prisma", "schema.prisma"),
      [
        'datasource db {\n  provider = "postgresql"\n  url = env("DATABASE_URL")\n}\n',
        ...enums.map((e) => `enum ${e} {\n  A\n  B\n}\n`),
        ...models.map((m) => `model ${m} {\n  id Int @id @default(autoincrement())\n}\n`),
      ].join("\n")
    );
    gitQuieto(["init", "-q", "."], root);
    gitQuieto(["config", "user.email", "t@t"], root);
    gitQuieto(["config", "user.name", "t"], root);
    gitQuieto(["add", "-A"], root);
    gitQuieto(["commit", "-qm", "base"], root);
    await init({ cwd: root, registerGlobally: false });

    const r = await runSessionStartAdapter(payload({ cwd: elsewhere }), { CLAUDE_PROJECT_DIR: root });
    const bytes = Buffer.byteLength(r.additionalContext, "utf-8");
    expect(bytes, r.additionalContext).toBeLessThanOrEqual(2048);
  });
});

describe("brief automático × caminho manual — MANUAL PATH SEES != AUTOMATIC PATH SEES", () => {
  /**
   * Medido em 2026-09-17: `.claude/agents` deste repo tinha 17 agentes de
   * 13/09 com precedência sobre o canônico, a sessão inteira rodou prompt
   * obsoleto, e o brief automático — o único que aparece sem ninguém digitar —
   * não tinha vocabulário para dizer isso. Só `nexos boot` falava.
   */
  const projecaoVelha = async (root: string): Promise<void> => {
    const agentsDir = path.join(root, ".claude", "agents");
    await fs.ensureDir(agentsDir);
    const corpo = "---\nname: nexos-legado\n---\ncorpo antigo\n";
    await fs.writeFile(path.join(agentsDir, "nexos-legado.md"), corpo);
    const { createHash } = await import("node:crypto");
    await fs.writeJson(path.join(agentsDir, "nexos-agents.manifest.json"), {
      schema_version: 1,
      generated_at: "2026-09-13T18:03:59.733Z",
      source_dir: "pacote-antigo/assets/agents",
      target_dir: agentsDir,
      producer: "nexos-cli@6.3.2",
      files: [
        {
          target: "nexos-legado.md",
          source: "agents/nexos-legado.md",
          sha256: createHash("sha256").update(corpo).digest("hex"),
          agent: "nexos-legado",
        },
      ],
    });
  };

  it("projeção desatualizada aparece no brief do hook, não só no nexos boot", async () => {
    const { root } = await repoCanonico("brief-projecao-velha");
    await projecaoVelha(root);

    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });

    expect(r.additionalContext).toContain("Agentes do projeto");
    expect(r.additionalContext).toContain("nexos-legado.md");
    expect(r.additionalContext).toContain("precedência");
  });

  it("projeto SEM projeção não ganha linha nenhuma — silêncio é o certo", async () => {
    const { root } = await repoCanonico("brief-sem-projecao");
    const r = await runSessionStartAdapter(payload({ cwd: root }), { CLAUDE_PROJECT_DIR: root });
    expect(r.additionalContext).not.toContain("Agentes do projeto");
  });
});
