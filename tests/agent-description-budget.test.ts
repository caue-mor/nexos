/**
 * ORÇAMENTO DE `description` — o custo de entregar muitos agentes.
 *
 *   MAIS AGENTES != MELHOR SELEÇÃO
 *   DESCRIPTION É CONTEXTO PAGO EM TODA SESSÃO
 *
 * A `description` de cada subagente entra no contexto da conversa principal —
 * é por ela que o host decide delegar. Isso tem um teto DOCUMENTADO: passando
 * de 15.000 tokens somados (fora os built-in), o Claude Code mostra um aviso
 * no startup com a contagem e manda encurtar
 * (code.claude.com/docs/en/sub-agents.md, seção "Automatic delegation", lido
 * em 2026-09-22; o erro correspondente é
 * `errors#agent-descriptions-are-over-the-15000-token-limit`).
 *
 * MEDIDO em 2026-09-22, com 22 agentes entregues (5 papéis + 17
 * especialistas): 6.165 caracteres, ~1.541 tokens — 10% do teto. O risco não é
 * hoje; é a próxima colheita de donor entrar sem ninguém medir. Este teste é o
 * medidor, e falha ANTES do host reclamar.
 *
 * O número é aproximado de propósito: `chars/4` é a régua grosseira, e o teto
 * usado aqui (8.000 tokens, metade do limite real) deixa a folga para o erro
 * dessa aproximação. Tokenizar de verdade exigiria puxar um tokenizer só para
 * um guard — `NO REAL CONSUMER -> DO NOT IMPLEMENT`.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import { parseFrontmatter } from "../src/lib/agent/registry.js";

const DIR = path.resolve(__dirname, "../assets/agents");

/** Metade do limite documentado: a folga cobre o erro de `chars/4`. */
const TETO_TOKENS = 8_000;
const CHARS_POR_TOKEN = 4;

describe("orçamento de description dos agentes entregues", () => {
  const arquivos = fs.readdirSync(DIR).filter((n) => n.endsWith(".md"));

  it("há agentes para medir — lista vazia passaria por acidente", () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(5);
  });

  it("todo agente entregue tem description legível — `|` em bloco inclusive", () => {
    const semDescription = arquivos.filter((nome) => {
      const fm = parseFrontmatter(fs.readFileSync(path.join(DIR, nome), "utf-8"));
      const d = fm?.["description"];
      return typeof d !== "string" || d.trim().length < 40;
    });
    expect(
      semDescription,
      "description ausente ou curta demais — o host seleciona por ela; sem description o agente existe e nunca é escolhido"
    ).toEqual([]);
  });

  it("a soma das descriptions fica abaixo do teto do host", () => {
    const chars = arquivos.reduce((soma, nome) => {
      const fm = parseFrontmatter(fs.readFileSync(path.join(DIR, nome), "utf-8"));
      const d = fm?.["description"];
      return soma + (typeof d === "string" ? d.length : 0);
    }, 0);
    const tokens = Math.round(chars / CHARS_POR_TOKEN);
    expect(
      tokens,
      `${String(arquivos.length)} agentes somam ~${String(tokens)} tokens de description (${String(chars)} chars). ` +
        `Teto aqui: ${String(TETO_TOKENS)} (metade do limite documentado de 15.000). ` +
        `Encurtar as descriptions e mover detalhe para o corpo do agente, que só carrega quando ele roda.`
    ).toBeLessThan(TETO_TOKENS);
  });
});
