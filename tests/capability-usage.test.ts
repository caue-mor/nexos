/**
 * `scanCapabilityUsage` — o produtor de INVOKED.
 *
 * MEDIDO antes deste módulo existir:
 *
 *     INVOCABLE 339 · LISTED 199 · INSTALLED 88 · INVOKED 0 · EFFECTIVE 0
 *
 * Nada subia acima de `INVOCABLE` porque não havia produtor do dado — não era
 * lacuna de tela. Depois: 23 de 626 peças do catálogo foram invocadas alguma
 * vez, em 1665 transcritos e 907 mil linhas.
 *
 * Os controles aqui travam as três confusões que a medição manual custou:
 * menção contada como invocação, subagente invisível, e zero sem denominador.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { scanCapabilityUsage, nomeInvocado, nomeDaFerramenta, usoDe, projectUsageRoots, resumoDeLeitura } from "../src/lib/capabilities/usage.js";
import { claudeProjectSlug } from "../src/lib/host/memory-surfaces.js";

const TMP = fs.realpathSync(os.tmpdir());
const dirs: string[] = [];

afterEach(async () => {
  for (const d of dirs.splice(0)) await fs.remove(d);
});

async function projectsDir(): Promise<string> {
  const d = await fs.mkdtemp(path.join(TMP, "usage-"));
  dirs.push(d);
  return d;
}

function linhaToolUse(nome: string, campo: string, valor: string, ts = "2026-09-19T10:00:00Z"): string {
  return JSON.stringify({
    timestamp: ts,
    message: { content: [{ type: "tool_use", name: nome, input: { [campo]: valor } }] },
  });
}

/** Linha com um `tool_use` genérico qualquer (ex.: `Bash`, `Read`) — M1. */
function linhaFerramenta(nomeFerramenta: string, ts: string, input: Record<string, unknown> = {}): string {
  return JSON.stringify({
    timestamp: ts,
    message: { content: [{ type: "tool_use", name: nomeFerramenta, input }] },
  });
}

/** Serializa o scan como um consumidor real faria (Map -> array) — para o teste anti-vazamento. */
function serializar(scan: Awaited<ReturnType<typeof scanCapabilityUsage>>): string {
  return JSON.stringify({
    byName: [...scan.byName.entries()],
    skills: [...scan.skills.entries()],
    agents: [...scan.agents.entries()],
    tools: [...scan.tools.entries()],
    transcriptsRead: scan.transcriptsRead,
    linesRead: scan.linesRead,
    unreadable: scan.unreadable,
    windowStart: scan.windowStart,
    undatedEvents: scan.undatedEvents,
    namesRejected: scan.namesRejected,
  });
}

/** Linha de `tool_use` com `sessionId` explícito no envelope — para os testes de dedup de sessão. */
function linhaComSessao(nome: string, campo: string, valor: string, sessionId: string, ts = "2026-09-19T10:00:00Z"): string {
  return JSON.stringify({
    timestamp: ts,
    sessionId,
    message: { content: [{ type: "tool_use", name: nome, input: { [campo]: valor } }] },
  });
}

describe("nomeInvocado", () => {
  it("extrai skill de Skill e subagent_type de Task/Agent", () => {
    expect(nomeInvocado({ type: "tool_use", name: "Skill", input: { skill: "nexos-handoff" } })).toBe("nexos-handoff");
    expect(nomeInvocado({ type: "tool_use", name: "Task", input: { subagent_type: "nexos-dev" } })).toBe("nexos-dev");
    expect(nomeInvocado({ type: "tool_use", name: "Agent", input: { subagent_type: "Explore" } })).toBe("Explore");
  });

  /**
   * CONTROLE NEGATIVO — `MENÇÃO != INVOCAÇÃO`. Medido: `nexos-handoff`
   * aparece 153 vezes escrito em prosa e tem 36 invocações reais. Sem este
   * controle, um scan por substring contaria 4x a mais.
   */
  it("bloco de texto e outras ferramentas NÃO contam", () => {
    expect(nomeInvocado({ type: "text", text: "use a skill nexos-handoff" })).toBeUndefined();
    expect(nomeInvocado({ type: "tool_use", name: "Bash", input: { command: "Skill nexos-handoff" } })).toBeUndefined();
    expect(nomeInvocado({ type: "tool_use", name: "Skill", input: {} })).toBeUndefined();
  });
});

describe("nomeDaFerramenta (M1)", () => {
  it("extrai o nome literal de qualquer tool_use", () => {
    expect(nomeDaFerramenta({ type: "tool_use", name: "Bash", input: { command: "ls" } })).toBe("Bash");
    expect(nomeDaFerramenta({ type: "tool_use", name: "Read", input: { file_path: "/x" } })).toBe("Read");
    /** `Skill`/`Task` também são `tool_use` genérico — as duas contagens (byName e tools) coexistem. */
    expect(nomeDaFerramenta({ type: "tool_use", name: "Skill", input: { skill: "nexos-handoff" } })).toBe("Skill");
  });

  it("bloco de texto nunca conta como ferramenta", () => {
    expect(nomeDaFerramenta({ type: "text", text: "rodei Bash agora" })).toBeUndefined();
  });
});

describe("scanCapabilityUsage", () => {
  it("conta invocações, sessões distintas e a última data", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaToolUse("Skill", "skill", "alfa", "2026-09-01T00:00:00Z"),
        linhaToolUse("Skill", "skill", "alfa", "2026-09-05T00:00:00Z"),
      ].join("\n")
    );
    await fs.outputFile(path.join(dir, "proj/s2.jsonl"), linhaToolUse("Skill", "skill", "alfa", "2026-09-03T00:00:00Z"));

    const scan = await scanCapabilityUsage(dir);
    const alfa = scan.byName.get("alfa");
    expect(alfa?.invocations).toBe(3);
    /** Sessões DISTINTAS, não linhas: é o denominador que separa peça morta de peça nova. */
    expect(alfa?.sessions).toBe(2);
    expect(alfa?.lastUsedAt).toBe("2026-09-05T00:00:00Z");
    expect(scan.transcriptsRead).toBe(2);
  });

  /**
   * O TRANSCRIPT DO SUBAGENTE NÃO MORA AO LADO DO DA SESSÃO.
   *
   * MEDIDO: 1665 `.jsonl` no host, só 319 no primeiro nível — 81% do acervo
   * está em `<projeto>/<sessão>/subagents/`. A primeira versão deste módulo
   * lia um nível e teria reportado o uso do agente principal como uso total.
   */
  it("varre em profundidade: o que o subagente invoca também conta", async () => {
    const dir = await projectsDir();
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), linhaToolUse("Skill", "skill", "raso"));
    await fs.outputFile(
      path.join(dir, "proj/s1/subagents/agent-x.jsonl"),
      linhaToolUse("Task", "subagent_type", "fundo")
    );

    const scan = await scanCapabilityUsage(dir);
    expect(scan.transcriptsRead).toBe(2);
    expect(scan.byName.get("fundo")?.invocations).toBe(1);
  });

  /**
   * CONTROLE — `ZERO OPORTUNIDADE != ZERO USO`. Diretório sem transcrito
   * devolve `transcriptsRead: 0`, e é esse número que diz a quem consome que
   * não houve MEDIÇÃO, em vez de deixar "ninguém invocou" passar por fato.
   */
  it("diretório vazio ou inexistente: scan vazio com o denominador à mostra", async () => {
    const vazio = await projectsDir();
    const scan = await scanCapabilityUsage(vazio);
    expect(scan.byName.size).toBe(0);
    expect(scan.transcriptsRead).toBe(0);

    const inexistente = await scanCapabilityUsage(path.join(vazio, "nao-existe"));
    expect(inexistente.transcriptsRead).toBe(0);
  });

  it("linha corrompida no meio não derruba a varredura", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [linhaToolUse("Skill", "skill", "ok"), '{"message":{"content":[{"type":"tool_use","name":"Skill"', ""].join("\n")
    );
    const scan = await scanCapabilityUsage(dir);
    expect(scan.byName.get("ok")?.invocations).toBe(1);
    /** `unreadable` é ARQUIVO que não abriu — este arquivo abriu, só uma linha dentro dele não parseou. */
    expect(scan.unreadable).toBe(0);
    /**
     * MEDIUM (rodada 3) — sem `malformedLines`, corrupção NO MEIO do arquivo
     * (esta linha, que casa `podeConterEventoRelevante` mas não fecha o JSON)
     * era indistinguível de truncamento normal de FIM de transcript vivo.
     */
    expect(scan.malformedLines).toBe(1);
  });
});

/**
 * MEDIUM (rodada 3) — `readdir(...).catch(() => [])` fazia uma subárvore com
 * erro real (EACCES/EPERM) sumir sem contador: medido pelo revisor,
 * diretório `chmod 000` com 1 transcript dava `transcriptsRead: 1` e
 * `unreadable: 0`. `chmod` real não serve de prova aqui — root ignora
 * permissão e o runner de CI pode ser root (mesmo raciocínio já registrado em
 * `project-resolver.test.ts`) — por isso a falha é INJETADA via spy em
 * `fs.readdir`, determinística e independente de quem roda o teste.
 */
describe("unreadableDirs (rodada 3)", () => {
  it("subárvore com erro real (ex.: EACCES) conta em unreadableDirs; ENOENT nunca conta", async () => {
    const dir = await projectsDir();
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), linhaToolUse("Skill", "skill", "visivel"));
    const trancado = path.join(dir, "proj", "trancado");
    await fs.outputFile(path.join(trancado, "escondido.jsonl"), linhaToolUse("Skill", "skill", "invisivel"));

    const original = fs.readdir.bind(fs);
    const spy = vi
      .spyOn(fs, "readdir")
      .mockImplementation(async (...args: Parameters<typeof fs.readdir>) => {
        const [alvo] = args;
        if (alvo === trancado) {
          const erro = new Error("permission denied (injetado)") as NodeJS.ErrnoException;
          erro.code = "EACCES";
          throw erro;
        }
        return original(...args);
      });

    try {
      const scan = await scanCapabilityUsage(dir);
      expect(scan.byName.get("visivel")?.invocations).toBe(1);
      /** Dentro da subárvore travada — nunca visto, nunca contado. */
      expect(scan.byName.get("invisivel")).toBeUndefined();
      expect(scan.unreadableDirs).toBe(1);
      /** Canal distinto de `unreadable` (arquivo que não abriu) — este é diretório. */
      expect(scan.unreadable).toBe(0);
    } finally {
      spy.mockRestore();
    }
  });

  it("ENOENT continua sem contar — ausência de diretório é ausência de oportunidade, não erro", async () => {
    const dir = await projectsDir();
    const scan = await scanCapabilityUsage(path.join(dir, "nao-existe"));
    expect(scan.transcriptsRead).toBe(0);
    expect(scan.unreadableDirs).toBe(0);
  });
});

describe("usoDe", () => {
  it("casa exato primeiro, e só então pelo último segmento", async () => {
    const dir = await projectsDir();
    await fs.outputFile(path.join(dir, "p/s.jsonl"), linhaToolUse("Skill", "skill", "review"));
    const scan = await scanCapabilityUsage(dir);

    expect(usoDe(scan, "review")?.invocations).toBe(1);
    /** `plugin:review` cai no último segmento — o host nomeia assim. */
    expect(usoDe(scan, "meu-plugin:review")?.invocations).toBe(1);
    /** CONTROLE: nome que não existe continua sem uso, sem inventar equivalência. */
    expect(usoDe(scan, "outra-coisa")).toBeUndefined();
  });
});

/**
 * A3 — janela de 30 dias + total acumulado, do MESMO scan.
 *
 * `now` é injetado para o teste ser determinístico: sem isso, o corte
 * dependeria do relógio real da máquina que roda o teste.
 */
describe("janela 30d + total acumulado (A3)", () => {
  const AGORA = new Date("2026-09-23T00:00:00Z");

  it("byName: invocations é o total, invocations30d só o que está dentro da janela", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaToolUse("Skill", "skill", "alfa", "2026-01-01T00:00:00Z"), // fora da janela — só no total
        linhaToolUse("Skill", "skill", "alfa", "2026-09-20T00:00:00Z"), // dentro da janela
        linhaToolUse("Skill", "skill", "alfa", "2026-09-22T00:00:00Z"), // dentro da janela
      ].join("\n")
    );

    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const alfa = scan.byName.get("alfa");
    expect(alfa?.invocations).toBe(3);
    expect(alfa?.invocations30d).toBe(2);
    expect(scan.windowStart).toBe("2026-08-24T00:00:00.000Z");
  });

  it("sem timestamp: conta no total, nunca na janela — não dá para confirmar recência", async () => {
    const dir = await projectsDir();
    const linhaSemTs = JSON.stringify({
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "beta" } }] },
    });
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), linhaSemTs);

    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.byName.get("beta")?.invocations).toBe(1);
    expect(scan.byName.get("beta")?.invocations30d).toBe(0);
  });

  /**
   * LOW (rodada 3) — `envelope.timestamp` presente não significa VÁLIDO.
   * Antes desta checagem, um valor com forma inválida entrava como se fosse
   * confiável, e `registrar()` compara `lastUsedAt` como STRING: mesmo
   * tratamento de "sem timestamp" agora, ANTES de qualquer comparação.
   */
  it("timestamp com forma inválida: mesmo tratamento de sem-timestamp — nunca vira lastUsedAt, nunca entra em 30d", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      JSON.stringify({
        timestamp: "nao-e-uma-data-valida",
        message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "alfa" } }] },
      })
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const alfa = scan.byName.get("alfa");
    expect(alfa?.invocations).toBe(1);
    expect(alfa?.invocations30d).toBe(0);
    expect(alfa?.lastUsedAt).toBeNull();
    expect(scan.undatedEvents).toBe(1);
  });

  /**
   * Prova direta do bug: `"zzz-invalido" > "2026-09-01T00:00:00Z"` é
   * VERDADEIRO por ordem lexicográfica ('z' > '2') — sem a validação, o
   * timestamp inválido VENCE um timestamp real mais antigo e vira
   * `lastUsedAt`, ainda que jamais tenha acontecido.
   */
  it("timestamp inválido nunca vence um timestamp válido em lastUsedAt, mesmo comparando como string", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaToolUse("Skill", "skill", "beta", "2026-09-01T00:00:00Z"),
        JSON.stringify({
          timestamp: "zzz-invalido",
          message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "beta" } }] },
        }),
      ].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.byName.get("beta")?.lastUsedAt).toBe("2026-09-01T00:00:00Z");
  });

  /**
   * Revisão rodada 3 (LOW): `Date.parse` aceita RFC-2822, e `registrar()`
   * comparava STRING — "Tue, 01 Jan 2019" > "2026-09-20T..." ('T' > '2')
   * virava `lastUsedAt`. Só ISO-8601 em UTC entra, e a comparação é por instante.
   */
  it("timestamp RFC-2822 (Date.parse aceita) nunca vira lastUsedAt", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaToolUse("Skill", "skill", "gama", "2026-09-20T00:00:00Z"),
        linhaToolUse("Skill", "skill", "gama", "Tue, 01 Jan 2019 00:00:00 GMT"),
      ].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.byName.get("gama")?.lastUsedAt).toBe("2026-09-20T00:00:00Z");
  });

  it("lastUsedAt compara instante, não string: com e sem milissegundos", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaToolUse("Skill", "skill", "delta", "2026-09-20T00:00:00.500Z"),
        linhaToolUse("Skill", "skill", "delta", "2026-09-20T00:00:00Z"),
      ].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.byName.get("delta")?.lastUsedAt).toBe("2026-09-20T00:00:00.500Z");
  });
});

/**
 * MEDIDO 24/09: 485/485 transcripts do host terminam em `\n`, inclusive os 12
 * vivos da última hora — o host grava linha inteira. Uma linha final sem `\n`
 * não é "sessão em curso"; é truncamento (crash, disco cheio), e tem de contar.
 * (Tentativa anterior de descontá-la foi revertida: escondia perda real.)
 */
describe("malformedLines conta toda linha relevante que não parseia", () => {
  it("linha final truncada, sem \\n (crash), conta", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [linhaToolUse("Skill", "skill", "ok"), '{"message":{"content":[{"type":"tool_use","name":"Skill"'].join("\n")
    );
    const scan = await scanCapabilityUsage(dir);
    expect(scan.malformedLines).toBe(1);
  });

  it("linha corrompida seguida de linha válida conta", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      ['{"message":{"content":[{"type":"tool_use","name":"Skill"', linhaToolUse("Skill", "skill", "ok")].join("\n")
    );
    const scan = await scanCapabilityUsage(dir);
    expect(scan.malformedLines).toBe(1);
  });
});

/** M1 — contagem genérica de tool_use por nome literal da ferramenta. */
describe("tools — tool_use genérico (M1)", () => {
  const AGORA = new Date("2026-09-23T00:00:00Z");

  it("conta por nome de ferramenta, total e 30d, no mesmo scan que byName", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaFerramenta("Bash", "2026-01-01T00:00:00Z"), // fora da janela
        linhaFerramenta("Bash", "2026-09-20T00:00:00Z"),
        linhaFerramenta("Read", "2026-09-21T00:00:00Z"),
        linhaToolUse("Skill", "skill", "gama", "2026-09-21T00:00:00Z"), // conta em tools E em byName
      ].join("\n")
    );

    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.tools.get("Bash")).toEqual({ countTotal: 2, count30d: 1 });
    expect(scan.tools.get("Read")).toEqual({ countTotal: 1, count30d: 1 });
    /** `Skill` é, ao mesmo tempo, ferramenta genérica (tools) e nome invocado (byName). */
    expect(scan.tools.get("Skill")).toEqual({ countTotal: 1, count30d: 1 });
    expect(scan.byName.get("gama")?.invocations).toBe(1);
  });

  it("bloco de texto nunca vira entrada em tools", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      JSON.stringify({
        timestamp: "2026-09-21T00:00:00Z",
        message: { content: [{ type: "text", text: "rodei Bash na mão" }] },
      })
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.tools.size).toBe(0);
  });
});

/**
 * A4 — escopo por projeto (revisado pelo arquiteto na tarefa 1):
 * `projectUsageRoots` resolve a raiz canônica e devolve TODOS os diretórios
 * (principal + worktrees) que `scanCapabilityUsage` recebe via `options.roots`
 * — sem segunda varredura, é a pilha inicial que muda.
 */
describe("projectUsageRoots (A4)", () => {
  it("acha o diretório principal e as variantes de worktree (slug + '--'), ignora outro projeto", async () => {
    const claudeHome = await projectsDir(); // simula `~/.claude`
    const raizProjects = path.join(claudeHome, "projects"); // simula `~/.claude/projects`
    const cwd = "/fake/project-a"; // sem `.nexos`: resolveCommandRoot devolve o próprio cwd
    const slug = claudeProjectSlug(cwd);

    await fs.ensureDir(path.join(raizProjects, slug)); // sessão principal
    await fs.ensureDir(path.join(raizProjects, `${slug}--worktrees-console`)); // worktree
    await fs.ensureDir(path.join(raizProjects, `${slug}x-outro-projeto`)); // prefixo parecido, NÃO é worktree deste projeto (falta o `--`)
    await fs.ensureDir(path.join(raizProjects, claudeProjectSlug("/fake/project-b"))); // outro projeto

    const roots = await projectUsageRoots(cwd, raizProjects);
    expect(roots.sort()).toEqual(
      [path.join(raizProjects, slug), path.join(raizProjects, `${slug}--worktrees-console`)].sort()
    );
  });

  it("projectsDir inexistente devolve lista vazia — pilha vazia, nunca fallback silencioso pra --all", async () => {
    const claudeHome = await projectsDir();
    const roots = await projectUsageRoots("/fake/project-a", path.join(claudeHome, "nao-existe"));
    expect(roots).toEqual([]);
  });

  it("composto com scanCapabilityUsage: escopo por projeto (+ worktree) nunca inclui outro projeto; --all inclui todos", async () => {
    const claudeHome = await projectsDir();
    const raizProjects = path.join(claudeHome, "projects");
    const cwdA = "/fake/project-a";
    const cwdB = "/fake/project-b";
    const slugA = claudeProjectSlug(cwdA);

    await fs.outputFile(path.join(raizProjects, slugA, "s1.jsonl"), linhaToolUse("Skill", "skill", "so-no-a"));
    await fs.outputFile(
      path.join(raizProjects, `${slugA}--worktrees-console`, "s1.jsonl"),
      linhaToolUse("Skill", "skill", "so-no-worktree-de-a")
    );
    await fs.outputFile(
      path.join(raizProjects, claudeProjectSlug(cwdB), "s1.jsonl"),
      linhaToolUse("Skill", "skill", "so-no-b")
    );

    const roots = await projectUsageRoots(cwdA, raizProjects);
    const escopoA = await scanCapabilityUsage(undefined, { roots });
    expect(escopoA.byName.get("so-no-a")?.invocations).toBe(1);
    /** o worktree do projeto A conta no escopo de A — é o mesmo projeto, outro diretório de sessão. */
    expect(escopoA.byName.get("so-no-worktree-de-a")?.invocations).toBe(1);
    expect(escopoA.byName.get("so-no-b")).toBeUndefined();

    const tudo = await scanCapabilityUsage(raizProjects); // --all
    expect(tudo.byName.get("so-no-a")?.invocations).toBe(1);
    expect(tudo.byName.get("so-no-b")?.invocations).toBe(1);
  });
});

/**
 * Sessão = `sessionId` do envelope, não o nome do arquivo. MEDIDO em
 * transcript real do host (`~/.claude/projects/.../subagents/agent-*.jsonl`):
 * o arquivo do subagente grava o `sessionId` da sessão PAI. Contar por nome
 * de arquivo trataria cada subagente como sessão nova.
 */
describe("sessão por sessionId, não por nome de arquivo", () => {
  it("subagente com sessionId da sessão pai conta como A MESMA sessão", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/pai.jsonl"),
      linhaComSessao("Skill", "skill", "alfa", "sessao-pai", "2026-09-19T10:00:00Z")
    );
    // Arquivo com outro NOME, mas mesmo sessionId — é o transcript do subagente.
    await fs.outputFile(
      path.join(dir, "proj/pai/subagents/agent-x.jsonl"),
      linhaComSessao("Skill", "skill", "alfa", "sessao-pai", "2026-09-19T10:05:00Z")
    );

    const scan = await scanCapabilityUsage(dir);
    expect(scan.byName.get("alfa")?.invocations).toBe(2);
    /** UMA sessão distinta, não duas — dedup pelo sessionId do envelope. */
    expect(scan.byName.get("alfa")?.sessions).toBe(1);
  });

  it("sem sessionId no envelope: cai pro nome do arquivo (fallback)", async () => {
    const dir = await projectsDir();
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), linhaToolUse("Skill", "skill", "beta"));
    await fs.outputFile(path.join(dir, "proj/s2.jsonl"), linhaToolUse("Skill", "skill", "beta"));

    const scan = await scanCapabilityUsage(dir);
    expect(scan.byName.get("beta")?.sessions).toBe(2);
  });
});

/**
 * skills/agents são o MESMO evento que alimenta `byName`, separado por
 * origem — o invariante que o arquiteto pediu para travar por teste.
 */
describe("skills / agents — split de byName por origem", () => {
  it("Skill cai em skills, Task/Agent caem em agents, e a soma bate com byName", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaToolUse("Skill", "skill", "nexos-handoff"),
        linhaToolUse("Skill", "skill", "nexos-handoff"),
        linhaToolUse("Task", "subagent_type", "nexos-dev"),
        linhaToolUse("Agent", "subagent_type", "Explore"),
      ].join("\n")
    );

    const scan = await scanCapabilityUsage(dir);
    expect(scan.skills.get("nexos-handoff")?.invocations).toBe(2);
    expect(scan.agents.get("nexos-dev")?.invocations).toBe(1);
    expect(scan.agents.get("Explore")?.invocations).toBe(1);
    /** skills/agents nunca vazam pro mapa errado. */
    expect(scan.agents.get("nexos-handoff")).toBeUndefined();
    expect(scan.skills.get("nexos-dev")).toBeUndefined();

    const somaByName = [...scan.byName.values()].reduce((s, u) => s + u.invocations, 0);
    const somaSkills = [...scan.skills.values()].reduce((s, u) => s + u.invocations, 0);
    const somaAgents = [...scan.agents.values()].reduce((s, u) => s + u.invocations, 0);
    expect(somaByName).toBe(somaSkills + somaAgents);
  });
});

/** Evento sem timestamp: só no total, nunca some — `undatedEvents` mostra o denominador. */
describe("undatedEvents", () => {
  it("conta eventos sem timestamp, um por bloco, independente de quantos mapas ele alimenta", async () => {
    const dir = await projectsDir();
    const semTs = JSON.stringify({
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill: "alfa" } }] },
    });
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), semTs);

    const scan = await scanCapabilityUsage(dir);
    // Um bloco `Skill` sem timestamp alimenta byName+skills E tools — ainda assim é UM evento sem data.
    expect(scan.undatedEvents).toBe(1);
  });
});

/** Whitelist de nome — nunca deixa um valor colado passar como se fosse um "nome". */
describe("namesRejected — whitelist de forma de nome + padrão de segredo", () => {
  it("nome fora do formato ou com forma de segredo é rejeitado, nunca aparece em nenhum mapa", async () => {
    const dir = await projectsDir();
    const nomeComEspaco = "nome com espaço"; // fora de [A-Za-z0-9_.:-]
    const nomeSegredo = `AKIA${"B".repeat(16)}`; // forma de aws_key, montada em runtime: literal no fonte reprova o scan:secrets
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaToolUse("Skill", "skill", nomeComEspaco, "2026-09-19T10:00:00Z"),
        linhaToolUse("Skill", "skill", nomeSegredo, "2026-09-19T10:00:01Z"),
        linhaToolUse("Skill", "skill", "nome-valido", "2026-09-19T10:00:02Z"),
      ].join("\n")
    );

    const scan = await scanCapabilityUsage(dir);
    expect(scan.byName.get("nome-valido")?.invocations).toBe(1);
    expect(scan.byName.has(nomeComEspaco)).toBe(false);
    expect(scan.byName.has(nomeSegredo)).toBe(false);
    expect(scan.namesRejected).toBe(2);
    // O valor rejeitado não escapa em nenhum campo serializado.
    expect(serializar(scan)).not.toContain(nomeSegredo);
  });
});

/**
 * M3 — nunca vazar conteúdo de transcript. Uma string com forma de segredo em
 * `message.content` (texto livre) e em `input` de uma tool não pode aparecer
 * em NENHUM campo do resultado, mesmo serializado como um consumidor real
 * faria (`JSON.stringify` após converter os Maps em array).
 */
/** Linha de attachment de hook — spike docs/plans/nexos-usage-spike-hooks.md. */
function linhaHookPrimario(
  hookName: string,
  command: string | undefined,
  rendered: unknown,
  ts: string,
  uuid: string,
  tipo = "hook_success"
): string {
  return JSON.stringify({ type: "attachment", attachment: { type: tipo, hookName, command }, rendered, uuid, timestamp: ts });
}

function linhaHookCompanheiro(rendered: unknown, ts: string, parentUuid: string, tipo = "hook_additional_context"): string {
  return JSON.stringify({ type: "attachment", attachment: { type: tipo }, rendered, parentUuid, timestamp: ts });
}

/** T8 — hooks (S1/S2). Só 30d: sem par `_total`, por contrato da tarefa 8. */
describe("hooks (T8)", () => {
  const AGORA = new Date("2026-09-23T00:00:00Z");

  it("primário com rendered não-nulo: 1 fire, 1 com conteúdo, bytes de rendered (nunca de content/stdout)", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      linhaHookPrimario("PreToolUse:Bash", "/Users/x/.claude/hooks/foo.sh", ["texto injetado"], "2026-09-21T00:00:00Z", "u1")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const hook = scan.hooks.get("PreToolUse:Bash:foo.sh");
    expect(hook?.event).toBe("PreToolUse:Bash");
    expect(hook?.fires30d).toBe(1);
    expect(hook?.firesWithContent30d).toBe(1);
    expect(hook?.bytes30d).toBe(Buffer.byteLength(JSON.stringify(["texto injetado"]), "utf8"));
  });

  it("primário com rendered:null e sem companheiro: fire conta, conteúdo não", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      linhaHookPrimario("SessionStart", "check.sh", null, "2026-09-21T00:00:00Z", "u1", "hook_cancelled")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const hook = scan.hooks.get("SessionStart:check.sh");
    expect(hook?.fires30d).toBe(1);
    expect(hook?.firesWithContent30d).toBe(0);
    expect(hook?.bytes30d).toBe(0);
  });

  it("primário com rendered:null + companheiro pelo parentUuid: companheiro entrega o conteúdo", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaHookPrimario("UserPromptSubmit", "recall.sh", null, "2026-09-21T00:00:00Z", "u1"),
        linhaHookCompanheiro(["contexto extra"], "2026-09-21T00:00:01Z", "u1"),
      ].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const hook = scan.hooks.get("UserPromptSubmit:recall.sh");
    expect(hook?.fires30d).toBe(1);
    expect(hook?.firesWithContent30d).toBe(1);
    expect(hook?.bytes30d).toBe(Buffer.byteLength(JSON.stringify(["contexto extra"]), "utf8"));
  });

  it("companheiro com parentUuid que não casa: ignorado, primário fecha sem conteúdo", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaHookPrimario("UserPromptSubmit", "recall.sh", null, "2026-09-21T00:00:00Z", "u1"),
        linhaHookCompanheiro(["não é deste"], "2026-09-21T00:00:01Z", "outro-uuid"),
      ].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const hook = scan.hooks.get("UserPromptSubmit:recall.sh");
    expect(hook?.firesWithContent30d).toBe(0);
    expect(hook?.bytes30d).toBe(0);
  });

  it("segundo primário fecha o pendente anterior — dois hooks distintos, cada um com sua contagem", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        linhaHookPrimario("PreToolUse:Bash", "a.sh", ["a"], "2026-09-21T00:00:00Z", "u1"),
        linhaHookPrimario("PreToolUse:Bash", "b.sh", ["bb"], "2026-09-21T00:00:01Z", "u2"),
      ].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.hooks.get("PreToolUse:Bash:a.sh")?.fires30d).toBe(1);
    expect(scan.hooks.get("PreToolUse:Bash:b.sh")?.fires30d).toBe(1);
  });

  it("$HOME é trocado por ~ antes do basename, e identidade é hookName + basename(command)", async () => {
    const dir = await projectsDir();
    const home = os.homedir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      linhaHookPrimario("PreToolUse", `${home}/.claude/hooks/ponytail.cjs --flag`, null, "2026-09-21T00:00:00Z", "u1")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.hooks.has("PreToolUse:ponytail.cjs")).toBe(true);
  });

  it("fora da janela de 30d: não aparece em hooks — contrato T8 é só 30d", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      linhaHookPrimario("PreToolUse:Bash", "old.sh", ["x"], "2026-01-01T00:00:00Z", "u1")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.hooks.size).toBe(0);
  });

  it("tipo de attachment desconhecido: ignorado sem quebrar a varredura", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        JSON.stringify({ type: "attachment", attachment: { type: "hook_algo_novo", hookName: "X" }, rendered: null, uuid: "u9", timestamp: "2026-09-21T00:00:00Z" }),
        linhaHookPrimario("PreToolUse:Bash", "ok.sh", ["ok"], "2026-09-21T00:00:01Z", "u1"),
      ].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.hooks.get("PreToolUse:Bash:ok.sh")?.fires30d).toBe(1);
  });

  it("EOF fecha o último pendente do arquivo", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      linhaHookPrimario("Stop", "last.sh", ["fim"], "2026-09-21T00:00:00Z", "u1")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.hooks.get("Stop:last.sh")?.fires30d).toBe(1);
  });

  /** M3 aplicado a hooks — o texto de `rendered` nunca sai, só o tamanho em bytes. */
  it("segurança — conteúdo de rendered nunca aparece serializado, só o número de bytes", async () => {
    const SEGREDO = "sk-test-FAKE9988776655";
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      linhaHookPrimario("PreToolUse:Bash", "leak.sh", [`chave: ${SEGREDO}`], "2026-09-21T00:00:00Z", "u1")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const serializado = JSON.stringify([...scan.hooks.entries()]);
    expect(serializado).not.toContain(SEGREDO);
    expect(scan.hooks.get("PreToolUse:Bash:leak.sh")?.bytes30d).toBeGreaterThan(0);
  });
});

/** T9 — providers (S3): real (tool_use que de fato chama) vs. superficial (menção/--help). Só 30d. */
describe("providers (T9)", () => {
  const AGORA = new Date("2026-09-23T00:00:00Z");

  function linhaBash(command: string, ts = "2026-09-21T00:00:00Z"): string {
    return JSON.stringify({
      timestamp: ts,
      message: { content: [{ type: "tool_use", name: "Bash", input: { command } }] },
    });
  }
  function linhaTexto(texto: string, ts = "2026-09-21T00:00:00Z"): string {
    return JSON.stringify({ timestamp: ts, message: { content: [{ type: "text", text: texto }] } });
  }
  function linhaSkill(skill: string, ts = "2026-09-21T00:00:00Z"): string {
    return JSON.stringify({
      timestamp: ts,
      message: { content: [{ type: "tool_use", name: "Skill", input: { skill } }] },
    });
  }
  function linhaMcp(nomeFerramenta: string, ts = "2026-09-21T00:00:00Z"): string {
    return JSON.stringify({
      timestamp: ts,
      message: { content: [{ type: "tool_use", name: nomeFerramenta, input: {} }] },
    });
  }

  it("scan vazio ainda devolve as 4 chaves, zeradas", async () => {
    const dir = await projectsDir();
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.providers).toEqual({
      ctx7: { real30d: 0, superficial30d: 0 },
      notebooklm: { real30d: 0, superficial30d: 0 },
      graphify: { real30d: 0, superficial30d: 0 },
      last30days: { real30d: 0, superficial30d: 0 },
    });
  });

  it("ctx7 — comando real (`ctx7@latest library|docs`) vs. --help/menção distinguem os dois contadores", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [linhaBash("npx ctx7@latest library react hooks", "2026-09-21T00:00:00Z"), linhaBash("npx ctx7@latest --help", "2026-09-21T00:00:01Z")].join(
        "\n"
      )
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.providers.ctx7.real30d).toBe(1);
    expect(scan.providers.ctx7.superficial30d).toBe(1);
  });

  it("menção em texto livre conta como superficial, nunca real", async () => {
    const dir = await projectsDir();
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), linhaTexto("acho que devíamos usar o graphify aqui"));
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.providers.graphify.superficial30d).toBe(1);
    expect(scan.providers.graphify.real30d).toBe(0);
  });

  /**
   * MEDIUM (rodada 3) — o pré-filtro (`podeConterEventoRelevante`) comparava
   * `linha.includes(hint)` SENSÍVEL A CAIXA, enquanto toda
   * `PROVIDER_PATTERNS[*].mention` é `/i`. "NotebookLM"/"Graphify"
   * (capitalização natural em prosa) nunca continha o hint minúsculo — a
   * linha inteira era descartada ANTES do JSON.parse, e a regex `/i` nunca
   * chegava a rodar.
   */
  it("menção com maiúsculas (NotebookLM/Graphify) também conta — pré-filtro é case-insensitive, igual à classificação", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [linhaTexto("acho que devíamos usar o NotebookLM aqui"), linhaTexto("ou talvez o Graphify", "2026-09-21T00:00:01Z")].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.providers.notebooklm.superficial30d).toBe(1);
    expect(scan.providers.graphify.superficial30d).toBe(1);
  });

  it("invocação da skill graphify/notebooklm/last30days é uso REAL", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [linhaSkill("graphify", "2026-09-21T00:00:00Z"), linhaSkill("notebooklm", "2026-09-21T00:00:01Z"), linhaSkill("last30days", "2026-09-21T00:00:02Z")].join(
        "\n"
      )
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.providers.graphify.real30d).toBe(1);
    expect(scan.providers.notebooklm.real30d).toBe(1);
    expect(scan.providers.last30days.real30d).toBe(1);
  });

  it("tool_use de MCP mcp__notebooklm__*/mcp__context7__* conta como uso REAL", async () => {
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [linhaMcp("mcp__notebooklm__chat_ask"), linhaMcp("mcp__context7__query-docs", "2026-09-21T00:00:01Z")].join("\n")
    );
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.providers.notebooklm.real30d).toBe(1);
    expect(scan.providers.ctx7.real30d).toBe(1);
  });

  it("fora da janela de 30d: não conta em nenhum dos dois contadores", async () => {
    const dir = await projectsDir();
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), linhaBash("npx ctx7@latest library react", "2026-01-01T00:00:00Z"));
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    expect(scan.providers.ctx7.real30d).toBe(0);
    expect(scan.providers.ctx7.superficial30d).toBe(0);
  });

  it("segurança — o comando/texto testado nunca aparece serializado, só o contador", async () => {
    const SEGREDO = "sk-test-FAKE1122334455";
    const dir = await projectsDir();
    await fs.outputFile(path.join(dir, "proj/s1.jsonl"), linhaBash(`npx ctx7@latest library react # ${SEGREDO}`));
    const scan = await scanCapabilityUsage(dir, { now: AGORA });
    const serializado = JSON.stringify(scan.providers);
    expect(serializado).not.toContain(SEGREDO);
    expect(scan.providers.ctx7.real30d).toBe(1);
  });
});

describe("segurança — nunca serializa conteúdo de transcript (M3)", () => {
  it("segredo em texto livre e em input de tool não aparece em nenhum campo do scan", async () => {
    const SEGREDO = "sk-test-FAKE1234567890";
    const dir = await projectsDir();
    await fs.outputFile(
      path.join(dir, "proj/s1.jsonl"),
      [
        JSON.stringify({
          timestamp: "2026-09-21T00:00:00Z",
          message: { content: [{ type: "text", text: `aqui vai minha chave: ${SEGREDO}` }] },
        }),
        JSON.stringify({
          timestamp: "2026-09-21T00:00:01Z",
          message: {
            content: [{ type: "tool_use", name: "Bash", input: { command: `curl -H "Authorization: ${SEGREDO}"` } }],
          },
        }),
      ].join("\n")
    );

    const scan = await scanCapabilityUsage(dir, { now: new Date("2026-09-23T00:00:00Z") });
    const saida = serializar(scan);

    // O segredo colado em texto/input nunca aparece na saída.
    expect(saida).not.toContain(SEGREDO);
    // Nomes de ferramenta (Bash, Skill) continuam presentes — só conteúdo bruto é vetado.
    expect(scan.tools.get("Bash")?.countTotal).toBe(1);
  });
});

/** Revisão rodada 3 (MEDIUM): perda só no `--json` não é perda visível — a saída humana dizia "0 ilegível(is)". */
describe("resumoDeLeitura — a linha humana de nexos usage/capabilities", () => {
  it("mostra diretórios ilegíveis e linhas malformadas junto dos arquivos ilegíveis", () => {
    const linha = resumoDeLeitura({ transcriptsRead: 2, linesRead: 40, unreadable: 0, unreadableDirs: 1, malformedLines: 3, undatedEvents: 5 });
    expect(linha).toContain("0 arquivo(s) ilegível(is)");
    expect(linha).toContain("1 diretório(s) ilegível(is)");
    expect(linha).toContain("3 linha(s) relevante(s) malformada(s)");
    // Formato de timestamp novo do host jogaria tudo aqui — a janela 30d zeraria sem este número.
    expect(linha).toContain("5 evento(s) sem data");
  });
});
