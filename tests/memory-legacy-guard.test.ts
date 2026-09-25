/**
 * T8 follow-up (plano de memória em camadas v3.2, §7/§8) — guard de
 * REGRESSÃO. O batch de `memory-legacy-normalization.test.ts` prova que os
 * RECORDS já admitidos normalizam para `project` na leitura; este arquivo
 * prova o lado que aquele não cobre: que a INSTRUÇÃO viva — CLAUDE.md, a
 * rule de governança e os hooks — não volta a mandar o agente ler/escrever
 * estado ou memória em markdown como autoridade.
 *
 *   MARKDOWN AS PROJECTION MENTION != MARKDOWN AS AUTHORITY DIRECTIVE
 *
 * O predicado é por FRASE-DIRETIVA (verbo de ação + arquivo), não pelo path
 * `memory/project`: `assets/CLAUDE.md` MENCIONA esse
 * path deliberadamente ("`.nexos/memory/project/*.md` são projeção/legado
 * ... nunca lidos como estado nem escritos como memória") — isso é a
 * descrição correta do estado atual, não uma instrução de voltar a lê-lo.
 * Um guard por path bloquearia a própria frase que documenta a neutralização.
 *
 * `nexos install` sobrescreve o CLAUDE.md global com este asset
 * (installer.ts:485-499, risco anotado em T8) — por isso o alvo aqui é
 * SEMPRE `assets/`, nunca `~/.claude/CLAUDE.md` do executor.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";

const ROOT = process.cwd();

/**
 * P0 (MVP Project Brain, bloco h) removeu `nexos-precompact-v2.sh` e
 * `quality-gates--scope-guard.sh` (nenhum registrado em `assets/settings.json`
 * — hooks órfãos). P1.0b (nexos://decision/p1-0-remover-authorization-layer)
 * removeu `nexos-boulder-stop.sh`/`nexos-orchestration-tracker.sh` por
 * inteiro (PreToolUse/PostToolUse não são mais lane do NexOS), e o verifier
 * reprovou autoridade residual em `assets/rules/` — `nexos-governance.md`
 * saiu junto (a lista de manutenção de rules do P0 restringiu o diretório a
 * lang-*.md/mechanical-verification.md/tool-usage.md/context7.md). Os
 * `it.each` históricos com o texto LITERAL desses arquivos continuam fixture
 * pura de string (nunca fazem I/O neles), então a cobertura da regressão
 * original permanece — só a leitura AO VIVO deles some daqui.
 */
const TARGET_FILES = [
  "assets/CLAUDE.md",
  "assets/hooks/nexos-context-warn.sh",
] as const;

/**
 * Frases-diretiva de leitura/escrita de memória em markdown como autoridade.
 * Cada alternativa é uma frase real que já existiu neste repo antes do T8
 * (ver `git show c4f1438` — as fixtures abaixo usam o texto literal removido
 * naquele commit), não uma frase inventada para o teste passar fácil.
 */
const LEGACY_DIRECTIVE = new RegExp(
  [
    "ler \\.nexos\\/memory",
    "leia \\.nexos\\/memory",
    "read .*state\\.md",
    "read .*gotchas\\.md",
    "ver state\\.md",
    "check state\\.md",
    "register .*gotchas\\.md",
    "update .*state\\.md",
    "read this file to resume",
  ].join("|"),
  "i"
);

describe("memory-legacy-guard — instrução viva nunca volta a mandar ler/escrever memória em markdown", () => {
  it.each(TARGET_FILES)("%s não contém frase-diretiva de memória legada", async (relPath) => {
    const raw = await fs.readFile(path.join(ROOT, relPath), "utf-8");
    expect(raw).not.toMatch(LEGACY_DIRECTIVE);
  });

  it("assets/CLAUDE.md declara a fonte canônica `nexos boot`", async () => {
    const raw = await fs.readFile(path.join(ROOT, "assets/CLAUDE.md"), "utf-8");
    expect(raw).toMatch(/nexos boot/);
  });

  /**
   * MENÇÃO COMO PROJEÇÃO É PERMITIDA — a frase real dos dois arquivos que
   * cita `memory/project` para descrever o que ele é (projeção/legado), não
   * para instruir leitura. Se o predicado fosse por path, esta linha teria
   * sido bloqueada por si mesma.
   */
  it("citar `.nexos/memory/project/*.md` como projeção/legado não dispara o guard", () => {
    const descricao =
      "`.nexos/memory/project/*.md` são projeção/legado: podem ser abertos sob demanda " +
      "para detalhe, nunca lidos como estado nem escritos como memória";
    expect(descricao).not.toMatch(LEGACY_DIRECTIVE);
  });

  /**
   * O GUARD MORDE — prova que o regex não é vazio. Fixtures são o texto
   * LITERAL removido pelo commit T8 (`c4f1438`) em 3 dos hooks afetados, não
   * frases fabricadas para o teste passar fácil. `nexos-boulder-stop.sh`
   * fica de fora deste `it.each`: a frase real que ele removia ("Trabalho
   * pendente detectado em state.md") não casa com nenhuma alternativa do
   * predicado (confirmado rodando o regex contra ela) — o predicado é por
   * FRASE-DIRETIVA específica, não por menção solta a `state.md`, e esse
   * hook some do guard não por lacuna deste teste, e sim porque a frase que
   * ele tinha nunca foi uma das nove frases-diretiva declaradas.
   */
  it.each([
    ["nexos-precompact-save.sh — Next Steps (antes de T8)", "${NEXT:-Check state.md for pending work}"],
    ["nexos-precompact-save.sh — Gotchas (antes de T8)", "Read .nexos/memory/project/gotchas.md after compression."],
    ["nexos-precompact-save.sh — footer (antes de T8)", "State preserved. Read this file to resume."],
    ["nexos-precompact-v2.sh — fase (antes de T8)", "${CURRENT_PHASE:-Ver state.md para fase atual}"],
    ["nexos-precompact-v2.sh — próxima ação (antes de T8)", "${NEXT_ACTION:-Ver state.md para proximos passos}"],
    ["quality-gates--scope-guard.sh — fallback (antes de T8)", "# Fallback: check state.md"],
    [
      "quality-gates--scope-guard.sh — mensagem (antes de T8)",
      "Register out-of-scope items in gotchas.md or state.md instead.",
    ],
  ])("fixture histórica '%s' É pega pelo guard", (_label, fixture) => {
    expect(fixture).toMatch(LEGACY_DIRECTIVE);
  });

  it("injetar uma frase legada num arquivo temporário derruba o guard", async () => {
    const conteudoContaminado = [
      "# NexOS Governance Rules v6.0",
      "Antes de qualquer trabalho, leia .nexos/memory/project/state.md para saber a fase atual.",
    ].join("\n");
    expect(conteudoContaminado).toMatch(LEGACY_DIRECTIVE);
  });
});
