/**
 * O prazo precisa segurar o processo até vencer.
 *
 *   O TIMER DO PRAZO NÃO PODE DEPENDER DO PERDEDOR PARA MANTER O PROCESSO VIVO
 *
 * MEDIDO em 26/09: `nexos claude-session-start` saiu com exit 0 e 0 bytes em
 * aberturas seguidas; o traço mostrou o processo encerrando aos ~2,3s com o
 * loop vazio (código 13 sob top-level await). `withDeadline` fazia `unref()`
 * no timer supondo que o trabalho perdedor seguraria o processo — quando o
 * trabalho espera uma promise sem nada ativo por trás, nada segura, o Node
 * encerra antes do prazo e o hook não entrega nem o contexto mínimo.
 * Processo filho de propósito: dentro do vitest o loop nunca esvazia.
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import path from "node:path";

const modulo = path.resolve(__dirname, "..", "dist", "lib", "bootstrap-context.js");

describe("withDeadline num processo sem outro handle vivo", () => {
  it("trabalho que nunca resolve ainda termina em timeout, e o processo espera por ele", () => {
    const script = `const { withDeadline } = await import(${JSON.stringify(modulo)});
const r = await withDeadline(new Promise(() => {}), 200);
process.stdout.write(r.outcome);`;
    const r = spawnSync(process.execPath, ["--input-type=module", "-e", script], { encoding: "utf8", timeout: 10_000 });
    expect(r.status, r.stderr).toBe(0);
    expect(r.stdout).toBe("timeout");
  });
});
