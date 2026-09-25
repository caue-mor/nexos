/**
 * Isolamento GLOBAL de `NEXOS_HOME` para toda a suíte de testes.
 *
 * MEDIDO (05/09): `~/.nexos/projects/` (real, symlink para
 * `~/.nexos-global/.nexos/projects/`) tinha 2419 diretórios / 9,4 MB, cada um
 * um `project_id` de teste que já não existe em disco (amostra de
 * `active_root`: tmpdirs de `os.tmpdir()` de rodadas antigas de `npm test`).
 * Cresce a cada rodada, para sempre.
 *
 * CAUSA: `publishCanonical` resolve authority (`resolveActiveRoot`,
 * `authority.ts`) em toda publicação. O módulo já expõe o parâmetro certo
 * para isolar isso em teste — `PublishOptions.nexosHome` / `nexosHome é
 * sempre parâmetro, nunca process.env` (docstring de `authority.ts`) — mas
 * ~315 call-sites em 35 arquivos de teste não o passam, então o default
 * (`NEXOS_HOME`, `constants.ts`) resolve para o `$HOME` REAL do processo, e
 * cada `project_id` efêmero de teste vira um `CLAIMED` permanente lá.
 *
 * DUAS DIREÇÕES DESCARTADAS, por evidência:
 *
 *   1) Atualizar os ~315 call-sites para passar `nexosHome` explícito —
 *      reescreveria 35 arquivos de teste para repetir, em cada um, um
 *      parâmetro que já É o comportamento correto por default em produção.
 *
 *   2) Mover a ESCRITA da authority para `initializeCapsule` (o momento de
 *      criação do project_id), deixando `publishCanonical` só ler — MEDIDO
 *      que isso troca o vazamento de lugar, não o fecha: os dois pontos de
 *      produção que criam capsule (`commands/init.ts`, `commands/boot.ts`)
 *      são exercitados EM PROCESSO pelos próprios testes de comando
 *      (`init-canonical.test.ts`, `boot.test.ts`,
 *      `boot-bootstrap-proposal.test.ts`), que tentam isolar `HOME` via
 *      `process.env.HOME = fakeHome` em `beforeEach` — padrão que NÃO
 *      funciona para nada derivado de `NEXOS_HOME`: a constante é avaliada
 *      UMA VEZ no import (`constants.ts:10`), antes de qualquer `beforeEach`
 *      rodar (o MESMO defeito já documentado em `commands/init.ts:43-45`
 *      para `registerGlobally`). Escrever em `initializeCapsule` com o
 *      default real reintroduziria o vazamento nesses três arquivos com um
 *      nome de função diferente; escrever ali SEM default (opt-in) exigiria
 *      then fiar os call-sites de produção (`init.ts`/`boot.ts`) através dos
 *      MESMOS arquivos de teste contaminados — o problema se moveria, nunca
 *      fecharia.
 *
 * ESTA solução: isolar só o EXPORT `NEXOS_HOME` (+ `ENGINE_INSTALL_DIR`,
 * único outro export derivado dele) do módulo `constants.ts`, via
 * `vi.mock` num `setupFiles` global. Por que isto em vez de mutar
 * `process.env.HOME`/`os.homedir()` globalmente (a leitura óbvia de "isolar
 * HOME num setup global de vitest"): MEDIDO que dois arquivos usam
 * `os.homedir()` para verificar o HOST REAL de propósito —
 * `canonical-desired.test.ts` e `plugin-projection-host.test.ts` comparam
 * `~/.claude/settings.json` ANTES e DEPOIS de toda a suíte, para provar que
 * nada escreveu lá. Mutar `HOME` globalmente faria essa leitura apontar
 * SEMPRE para um diretório fake ausente — a asserção "antes == depois"
 * continuaria batendo (ambos `ABSENT`), mas deixaria de proteger,
 * silenciosamente, o que existe para proteger. Mockar só o export
 * `NEXOS_HOME` não toca `os.homedir()` em lugar nenhum: as duas leituras
 * acima continuam batendo no `~/.claude` real, como antes.
 *
 * VERIFICADO empiricamente (harness descartável, fora deste repo, Vitest
 * 4.1.2 / pool "forks" — a mesma combinação deste projeto) antes de aplicar:
 *   - `vi.mock` dentro de `setupFiles` REAPLICA por arquivo de teste
 *     (`isolate: true`, default aqui — `vitest.config.ts` não desliga);
 *   - sobrevive a especificadores relativos DIFERENTES apontando para o
 *     MESMO módulo absoluto (o caso real: `store.ts` importa
 *     `"../constants.js"` a partir de `src/lib/capsule/`, este arquivo
 *     importa `"../src/lib/constants.js"` a partir de `tests/` — mesmo
 *     arquivo, specifiers diferentes, o mock se aplica aos dois);
 *   - um `const` de topo computado ANTES da chamada a `vi.mock(...)` (SEM
 *     `vi.hoisted`) fica pronto a tempo: a fábrica do mock só roda quando
 *     ALGUÉM IMPORTA o módulo mockado, o que nunca acontece antes deste
 *     arquivo terminar de executar. (`vi.hoisted` foi tentado primeiro e
 *     REJEITADO por evidência: seu callback roda ANTES até dos imports
 *     estáticos deste próprio arquivo serem inicializados —
 *     `ReferenceError: Cannot access '__vi_import_0__' before
 *     initialization` ao tentar usar `fs`/`path`/`os` lá dentro.)
 *
 * Nenhum teste hoje afirma o VALOR de `NEXOS_HOME` nem compara contra a
 * fórmula `path.join(os.homedir(), ".nexos")` recomputada — confirmado via
 * busca no repo antes de aplicar.
 */
import { vi, afterAll } from "vitest";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";

const isolatedHome = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "nexos-test-home-"));
const isolatedNexosHome = path.join(isolatedHome, ".nexos");

vi.mock("../src/lib/constants.js", async (importOriginal) => {
  const actual = await importOriginal<typeof import("../src/lib/constants.js")>();
  return {
    ...actual,
    // GLOBAL_ROOT entra a partir de T3 (plano de memória em camadas v3.2):
    // mesma base isolada de NEXOS_HOME, nunca o `os.homedir()` real.
    GLOBAL_ROOT: isolatedHome,
    NEXOS_HOME: isolatedNexosHome,
    ENGINE_INSTALL_DIR: path.join(isolatedNexosHome, "engine"),
  };
});

/**
 * `os.tmpdir()` isolado por arquivo de teste. MEDIDO 23/09: 24.973 marcadores
 * `nexos-prompt-cache-*` / `nexos-memory-recall-shown-*` no TMPDIR, de 22.362
 * projetos de teste distintos — cada rodada deixava dezenas (2 arquivos = 42).
 * O Node lê TMPDIR a cada chamada e os processos filhos herdam o env.
 */
const isolatedTmp = fs.mkdtempSync(path.join(fs.realpathSync(os.tmpdir()), "nexos-test-tmp-"));
process.env.TMPDIR = isolatedTmp;

afterAll(() => {
  fs.rmSync(isolatedHome, { recursive: true, force: true });
  fs.rmSync(isolatedTmp, { recursive: true, force: true });
});
