#!/usr/bin/env node

/**
 * 03e (candidato 1, orquestrador — iteração 3 do nó `03_host_event_observation`)
 * — entrada leve para `nexos claude-session-start`.
 *
 * MEDIDO (orquestrador): `--version` (carrega `dist/index.js` inteiro, ~55
 * comandos registrados no Commander antes de rodar qualquer coisa) custa
 * 222ms; importar SÓ `dist/host/claude/session-start.js` custa 160ms — ~62ms
 * de subida que este hook, sob o orçamento de `PROCESS_WATCHDOG_MS` (2700ms,
 * `host/claude/session-start.ts`) e sob contenção real do host, não tem para
 * gastar carregando 54 comandos que nunca vai executar.
 *
 *   ONE DEVIATION POINT, NOT 55 CALL SITES
 *
 * O desvio é só AQUI, antes de `import("../dist/index.js")` — os outros 54
 * comandos continuam passando pelo caminho normal, nenhum `.action()` em
 * `src/index.ts` muda. `process.argv.length === 3` (nenhum argumento extra
 * além do nome do subcomando) é a condição estrita: qualquer uso fora do
 * padrão exato que o host sempre usa (`"command": "nexos claude-session-start"`,
 * sem flags) cai no caminho normal, que já sabe validar/ajudar/errar.
 */
if (process.argv[2] === "claude-session-start" && process.argv.length === 3) {
  import("../dist/host/claude/session-start.js")
    .then(({ claudeSessionStart }) => claudeSessionStart())
    .catch((err) => {
      console.error("Failed to load NexOS installer:", err.message);
      process.exit(1);
    });
} else {
  import("../dist/index.js").catch((err) => {
    console.error("Failed to load NexOS installer:", err.message);
    process.exit(1);
  });
}
