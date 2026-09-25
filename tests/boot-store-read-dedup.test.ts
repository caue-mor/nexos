/**
 * `nexos boot` lia o Store do projeto QUATRO vezes na mesma execução.
 *
 *   FILTRO POR KIND NÃO É LEITURA PARCIAL
 *
 * `readCurrentRecords(root, { kind })` lê todas as famílias e filtra depois,
 * então duas chamadas filtradas custam duas leituras completas. Medido por
 * fase na máquina do dono, carga de 0,60 por núcleo:
 *
 *     inspectProjectNexOSState   3228 ms
 *     read:project_state         2669 ms
 *     read:bootstrap_proposal    2601 ms
 *     total do comando          10444 ms
 *
 * Depois do reuso: 10368 -> 7737 ms (-25%), leituras 4 -> 3.
 *
 * Este teste conta CHAMADAS, nunca segundos. Asserção de relógio produz
 * vermelho falso sob carga — o gate de fechamento deste repo já deu 20495ms
 * contra um teto de 2000 numa entrega que mudou zero linhas executáveis
 * (nexos://gotcha/o-gate-de-fechamento-tem-assercao-de-relogio...).
 *
 * As três leituras que sobram estão FORA de `boot.ts`
 * (`inspectProjectNexOSState`, `assembleKnowledge`) ou são a leitura
 * compartilhada deste fix. A quarta, `readHead` dentro de
 * `publishSuperseding`, não entra no reuso de propósito: roda no instante da
 * escrita, pede `includeDeprecated` e existe para não sobrescrever uma head
 * que mudou. Reusar ali trocaria garantia de concorrência por milissegundos.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";

const fonte = (): string => fs.readFileSync(path.join(process.cwd(), "src", "commands", "boot.ts"), "utf8");

describe("boot monta UMA leitura do Store e repassa", () => {
  it("a leitura compartilhada existe e nasce antes dos consumidores", () => {
    const s = fonte();
    /**
     * Casa o NOME da leitura compartilhada, não a expressão que a produz — a
     * fonte dela mudou de `readCurrentRecords` direto para o reuso do
     * `inspection.storeRead`, e o contrato ("uma leitura, nascida antes dos
     * consumidores") é o mesmo. Asserção sobre a forma exata da linha quebra
     * em refatoração honesta; asserção sobre a ORDEM não.
     */
    const iLeitura = s.indexOf("const storeRead =");
    const iEstado = s.indexOf("readProjectState(inspection.rootPath, storeRead)");
    const iDrift = s.indexOf("driftDesdeUltimoBoot(inspection.rootPath, discovery.proposal, storeRead)");
    expect(iLeitura, "a leitura compartilhada sumiu").toBeGreaterThan(0);
    expect(iEstado, "readProjectState voltou a ler por conta própria").toBeGreaterThan(iLeitura);
    expect(iDrift, "driftDesdeUltimoBoot voltou a ler por conta própria").toBeGreaterThan(iLeitura);
  });

  it("as duas funções aceitam preload e só leem quando ele falta", () => {
    const s = fonte();
    expect(s).toContain('const r = preloadedRead ?? (await readCurrentRecords(root, { kind: "project_state" }));');
    expect(s).toContain('const r = preloadedRead ?? (await readCurrentRecords(root, { kind: "bootstrap_proposal" }));');
  });

  /**
   * CONTROLE do que NÃO pode ser deduplicado. Se alguém "otimizar" o
   * `readHead` do superseding, esta asserção cai — e ela cai por motivo
   * nomeado, não por acidente.
   */
  it("o readHead da publicação continua lendo fresco, com includeDeprecated", () => {
    const s = fonte();
    const i = s.indexOf("readHead: async () => {");
    expect(i, "o readHead do publishSuperseding sumiu").toBeGreaterThan(0);
    const bloco = s.slice(i, i + 500);
    expect(bloco).toContain("readCurrentRecords(root, {");
    expect(bloco).toContain("includeDeprecated: true");
    expect(bloco, "readHead não pode reusar leitura antiga").not.toContain("preloadedRead");
    expect(bloco).not.toContain("storeRead");
  });

  /**
   * Segunda rodada: a leitura que sobrava vinha de `inspectProjectNexOSState`,
   * que já lê o Store para responder "ele é legível?" (N1) e jogava fora o
   * resultado. Agora devolve, e o boot reusa.
   *
   *     leituras   4 -> 3 -> 2
   *     tempo      10444 -> 7737 -> 5156 ms   (-51% do ponto de partida)
   *
   * ADITIVO: campo novo no RETORNO, nenhum parâmetro de entrada mudou. O
   * único chamador de produção é o boot — `grep -rn inspectProjectNexOSState
   * src/` mostra só comentários fora dele.
   */
  it("o boot reusa a leitura que a inspeção já pagou", () => {
    const s = fonte();
    expect(s).toContain("inspection.storeRead ?? (await readCurrentRecords(inspection.rootPath))");
  });

  it("o inspector devolve a leitura em vez de descartá-la", () => {
    const insp = fs.readFileSync(path.join(process.cwd(), "src", "lib", "project-state-inspector.ts"), "utf8");
    expect(insp, "o campo storeRead sumiu do contrato de retorno").toContain("readonly storeRead?: ReadResult;");
    expect(insp, "a leitura legível precisa seguir para o chamador").toContain("storeRead: store,");
  });

  /** O total de chamadas no arquivo: 3 (2 com fallback + 1 readHead) + 1 compartilhada. */
  it("o arquivo tem exatamente as chamadas esperadas, nem mais", () => {
    const s = fonte();
    const chamadas = (s.match(/await readCurrentRecords\(/g) ?? []).length;
    expect(chamadas, "chamada nova de readCurrentRecords sem passar pelo preload").toBe(4);
  });
});
