/**
 * T1 hardening — `source_ref` legado de `nexos gotcha` é IDENTIDADE DE
 * LINHAGEM, não derivação livre de texto. `legacySourceSlug` (privada em
 * `src/commands/gotcha.ts`, comentário CONGELADA ao lado dela) restaura o
 * algoritmo VERBATIM de `main` (f7f6e41, `src/commands/gotcha.ts:105-113`) —
 * este arquivo prova, pelo comportamento OBSERVÁVEL do comando (nunca
 * importando a função privada), que os bytes batem exatamente com o que
 * `main` produzia, e que `subjectRef` (schemas.ts — identidade de ASSUNTO
 * declarado, contrato 1.4, usada em `subject_ref`) não é mais o gerador do
 * `source_ref` legado de `gotcha.ts`.
 *
 *   RECORD identity != OTHER FUNCTION's OUTPUT, MESMO QUE COINCIDAM HOJE
 *
 * Os 6 casos abaixo NÃO foram digitados de memória: foram gerados rodando o
 * `slug()` de `main` isoladamente via `node -e` nesta sessão (2026-09-08) —
 * ver a tabela completa no handoff desta fatia. Os dois casos extras (acento +
 * pontuação) existem porque a diferença entre `legacySourceSlug` (sem
 * `.trim()`) e `subjectRef` (com `.trim()`) só poderia aparecer em espaço nas
 * pontas — provar que ela NÃO aparece em nenhum dos 6 é o que fecha o achado
 * do verifier (ver handoff: "PROVE isso com teste, não assuma").
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { init } from "../src/commands/init.js";
import { gotcha } from "../src/commands/gotcha.js";
import { readCurrentRecords } from "../src/lib/capsule/reader.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let root: string;

const silencioso = <T>(fn: () => Promise<T>): Promise<T> => {
  vi.spyOn(console, "log").mockImplementation(() => {});
  return fn().finally(() => vi.restoreAllMocks());
};

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "gtslug-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  await silencioso(() => init({ cwd: root, registerGlobally: false }));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

/**
 * Bytes fixados nesta sessão (2026-09-08), derivados RODANDO o `slug()` de
 * `main` (f7f6e41) sobre cada `title`:
 *
 * ```
 * node -e '
 * function slug(title) {
 *   return title
 *     .normalize("NFD")
 *     .replace(/\p{Diacritic}/gu, "")
 *     .toLowerCase()
 *     .replace(/[^a-z0-9]+/g, "-")
 *     .replace(/^-+|-+$/g, "");
 * }
 * ...
 * '
 * ```
 *
 * Saída observada (não reescrita à mão):
 *   "title"                                    => "title"
 *   " title"                                   => "title"
 *   "title "                                   => "title"
 *   " title "                                  => "title"
 *   "  Título: com/acentos  "                  => "titulo-com-acentos"
 *   "Erro 500 — falha na conexão!!! (timeout)" => "erro-500-falha-na-conexao-timeout"
 */
const CASOS: Array<[title: string, esperado: string]> = [
  ["title", "title"],
  [" title", "title"],
  ["title ", "title"],
  [" title ", "title"],
  ["  Título: com/acentos  ", "titulo-com-acentos"],
  ["Erro 500 — falha na conexão!!! (timeout)", "erro-500-falha-na-conexao-timeout"],
];

describe("source_ref legado de `nexos gotcha` — byte-idêntico a main (f7f6e41)", () => {
  it.each(CASOS)("título %j -> source_ref nexos://gotcha/%s", async (title, esperado) => {
    await silencioso(() => gotcha({ cwd: root, title, rule: "regra qualquer" }));
    const r = await readCurrentRecords(root, { kind: "gotcha" });
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.records).toHaveLength(1);
    expect(r.records[0]!.sourceRef).toBe(`nexos://gotcha/${esperado}`);
  });

  it("GUARDA: gotcha.ts não importa subjectRef de schemas.js — o slug legado é função própria", async () => {
    const src = await fs.readFile(
      path.resolve(__dirname, "..", "src", "commands", "gotcha.ts"),
      "utf-8"
    );
    const importDeSchemas = src
      .split("\n")
      .find((linha) => linha.includes('from "../lib/capsule/schemas.js"'));
    expect(importDeSchemas).toBeDefined();
    // a coisa exata que este teste existe para travar: `subjectRef` saindo do
    // import de schemas.js e voltando a gerar o source_ref legado.
    expect(importDeSchemas).not.toMatch(/\bsubjectRef\b/);
    // e a função legada continua definida NO PRÓPRIO arquivo, não importada.
    expect(src).toMatch(/^function legacySourceSlug\(/m);
  });
});
