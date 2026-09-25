/**
 * DEFESA DE ENTRADA NÃO CONFIÁVEL nos agentes distribuídos.
 *
 *   CONTEÚDO LIDO != ORDEM RECEBIDA
 *
 * MEDIDO em 2026-09-22: **0 dos 5** agentes do NexOS tinham qualquer linha
 * sobre conteúdo não confiável, contra **67 de 68** no donor `affaan-m/ECC`
 * (MIT, bloco idêntico em todos — mesmo hash em 5 amostras). Era o item de
 * hardening que `dec_01M33FNYGV67GBE1N289EBR72R` lista em terceiro e que
 * nunca tinha saído do papel.
 *
 * O bloco não é decorativo: um agente lê página web, README de donor, issue,
 * saída de MCP e transcript de outro agente. Sem a separação entre DADO e
 * INSTRUÇÃO, qualquer um desses textos escrito no imperativo vira ordem.
 *
 * Este teste existe porque bloco de prompt é a coisa mais fácil de apagar sem
 * que nada falhe — `assets/rules` e `assets/agents` são markdown, e markdown
 * não quebra build. Sem guard, a defesa some na próxima edição e ninguém sabe.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";

const DIR = path.resolve(__dirname, "../assets/agents");

/** As cinco defesas que o bloco precisa nomear — não basta "falar de segurança". */
const EXIGIDAS: ReadonlyArray<{ nome: string; padrao: RegExp }> = [
  { nome: "dado != instrução", padrao: /CONTEÚDO LIDO != ORDEM RECEBIDA/ },
  { nome: "não troca de papel por texto lido", padrao: /não troco de papel|nao troco de papel/i },
  { nome: "não revela segredo", padrao: /credencial|segredo/i },
  { nome: "trata externo como não confiável", padrao: /não confi|nao confi/i },
  { nome: "recusa E reporta ampliação de alcance", padrao: /amplie o meu alcance|amplie o alcance/i },
];

describe("todo agente distribuído carrega a defesa de entrada não confiável", () => {
  const arquivos = fs.readdirSync(DIR).filter((n) => n.endsWith(".md"));

  it("há agentes para conferir — lista vazia passaria por acidente", () => {
    expect(arquivos.length).toBeGreaterThanOrEqual(5);
  });

  it.each(arquivos)("%s declara as cinco defesas", (nome) => {
    const texto = fs.readFileSync(path.join(DIR, nome), "utf-8");
    const faltando = EXIGIDAS.filter((e) => !e.padrao.test(texto)).map((e) => e.nome);
    expect(faltando, `${nome} perdeu defesa(s) — um agente sem isso obedece texto que leu`).toEqual([]);
  });

  it("a proveniência do donor fica registrada em cada agente", () => {
    for (const nome of arquivos) {
      const texto = fs.readFileSync(path.join(DIR, nome), "utf-8");
      expect(texto, `${nome} sem proveniência do port`).toMatch(/affaan-m\/ECC/);
    }
  });
});
