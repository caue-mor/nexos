/**
 * Worker de processo para CF-C2/CF-C4 (corrida real entre dois `nexos boot`
 * no mesmo projeto `ABSENT`).
 *
 * Chama a MESMA função que o comando `boot` da CLI usa
 * (`program.command("boot").action(boot)` em `src/index.ts`) — não reimplementa
 * nem contorna nenhuma camada. O teste depende de nunca ver um stack trace cru
 * no stderr deste processo: é exatamente o defeito 2 do bloqueador.
 */
import { boot } from "../../src/commands/boot.js";

const root = process.argv[2];
if (!root) {
  console.error("root ausente");
  process.exit(2);
}

await boot({ cwd: root });
