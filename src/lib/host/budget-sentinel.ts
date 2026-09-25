/**
 * H3 REABERTO (revisão independente, rodada 2) — a fatia anterior desta
 * correção (separar `result` de `persist()` DENTRO do processo, e só chamar
 * `persist()` depois do `process.stdout.write`) não protege nada sob o
 * wrapper real (`assets/hooks/nexos-budget.sh`), e a contraprova do revisor
 * (rodando contra o código de c6d8721e, ANTES desta fatia, com o mesmo
 * resultado) prova que a ordem dentro do processo nunca foi a variável que
 * importava.
 *
 *   O FILHO ESCREVER STDOUT != O HOST RECEBER STDOUT
 *
 * `nexos_run_with_budget` redireciona o stdout do FILHO para um ARQUIVO
 * (`$dir/out`), nunca direto para o stdout do wrapper. A entrega ao host só
 * acontece se o filho sair DENTRO do orçamento — o wrapper faz `cat "$dir/out"`
 * só nesse caminho. No timeout, ele mata o filho e `rm -rf "$dir"` SEM nunca
 * ler `$dir/out` — não importa se o conteúdo já estava 100% escrito lá dentro.
 * Repro do revisor: atrasar só o `appendFile` de `registrarRecuperacao`
 * (que roda DEPOIS do marker de dedup, dentro de `persist()`) além do
 * orçamento — o filho estoura o tempo com o stdout já pronto, o wrapper mata
 * e descarta, e o host recebe 0 bytes mesmo com a memória certa já formatada.
 *
 * ---
 *
 * CORREÇÃO — sentinela cooperativa entre o filho e o wrapper.
 *
 * O wrapper exporta `NEXOS_BUDGET_DONE=<dir>/done` no ambiente do filho. O
 * filho grava esse arquivo (síncrono, vazio) logo DEPOIS do último
 * `process.stdout.write` e ANTES de qualquer efeito colateral que possa
 * estourar o orçamento (`persist()`). No timeout, o wrapper confere: se o
 * sentinela existe, `$dir/out` estava completo quando o filho foi morto — só
 * o persist (efeito colateral, nunca a saída) que não coube — e o wrapper
 * relê `$dir/out` antes de descartar. Sem o sentinela, a saída em si nunca
 * ficou pronta, e o descarte de sempre continua valendo.
 *
 *   SENTINELA PROVA "SAÍDA COMPLETA", NUNCA "PROCESSO TERMINOU"
 *
 * A garantia que torna isto seguro (não uma corrida disfarçada): segundo a
 * doc oficial do Node (v22.x, `process.md`, "A note on process I/O"):
 * "Files: synchronous on Windows and POSIX" — `$dir/out` é um ARQUIVO comum
 * (redirecionado pelo `>` do bash), então `process.stdout.write` já é
 * SÍNCRONO no macOS e no Linux. Quando este módulo grava o sentinela, o
 * conteúdo de `$dir/out` já está fisicamente completo em disco — não uma
 * promessa pendente que uma leitura concorrente do wrapper poderia pegar pela
 * metade. Confirmado ao vivo via MCP context7 (`/websites/nodejs_latest-
 * v22_x_api`) e pelo fetch direto de `nodejs.org/docs/latest-v22.x/api/
 * process.html` nesta sessão — não é premissa, é o texto oficial.
 */
import { writeFileSync } from "node:fs";

/** Nome da env var que `nexos-budget.sh` usa para combinar o caminho do sentinela com o filho. */
export const NEXOS_BUDGET_DONE_ENV = "NEXOS_BUDGET_DONE";

/**
 * Sinaliza que o stdout deste processo já está COMPLETO — chamar depois do
 * ÚLTIMO `process.stdout.write`/`process.stderr.write` e antes de qualquer
 * `persist()`/efeito colateral.
 *
 * Fora do wrapper (`NEXOS_BUDGET_DONE` ausente — testes, invocação direta do
 * CLI, `nexos-budget.sh` de uma versão anterior sem a env var) é NO-OP: nada
 * do lado do wrapper depende deste sinal existir, e escrever num caminho
 * arbitrário do ambiente seria pior que não escrever nada.
 *
 * `writeFileSync`, nunca a versão assíncrona: precisa estar gravado em disco
 * ANTES da função retornar — é a garantia que o resto do processo (persist)
 * roda depois, não uma corrida com o próprio sinal.
 */
export function sinalizarStdoutCompleto(env: NodeJS.ProcessEnv = process.env): void {
  const caminho = env[NEXOS_BUDGET_DONE_ENV];
  if (typeof caminho !== "string" || caminho.length === 0) return;
  try {
    writeFileSync(caminho, "");
  } catch (error) {
    // Nunca derruba o hook, mas deixa a causa: sem ela, um estouro depois vira
    // "saída descartada" no wrapper com a saída que estava pronta.
    process.stderr.write(`nexos budget-sentinel: sinal não gravado — ${error instanceof Error ? error.message : String(error)}\n`);
  }
}
