/**
 * SECRET AUTHORITY GATE — o invariante na fronteira de escrita.
 *
 *   SENSITIVITY DECLARED != SECRET PROTECTED
 *   SECRET METADATA != SECRET MATERIAL
 *
 * uso: npx tsx scripts/verify-secret-authority.mts
 */
import { assertNoSecretMaterial, SecretMaterialError } from "../src/lib/capsule/secret-guard.js";

const provas: Array<{ n: string; ok: boolean; detail: string }> = [];
const checar = (n: string, ok: boolean, detail: string): void => {
  provas.push({ n, ok, detail });
};

const recusa = (r: unknown): string | null => {
  try {
    assertNoSecretMaterial(r as never);
    return null;
  } catch (e) {
    return e instanceof SecretMaterialError ? e.message : `erro inesperado: ${String(e)}`;
  }
};

console.log("\n── SECRET AUTHORITY ──\n");

// G — metadata de referência PODE persistir
const ref = {
  sensitivity: { classification: "secret" },
  portability: "prohibited",
  content: {
    logical_name: "WACALL_API_KEY",
    source_type: "railway",
    source_resource: "satisfied-comfort/@acme/comm-control-api",
    environment: "production",
    source_key: "WACALL_API_KEY",
    relation: "VERIFIED",
    status: "VERIFIED",
  },
};
checar("G metadata de referência persiste", recusa(ref) === null, "campos do contrato de referência");

// H — material secreto é RECUSADO
const material = { ...ref, content: { ...ref.content, value: "NEXOSSYN-material-proibido" } };
checar("H material secreto recusado", recusa(material) !== null, recusa(material)?.slice(0, 90) ?? "");

// H2 — qualquer campo fora do contrato é recusado, sem adivinhar formato
const arbitrario = { ...ref, content: { ...ref.content, stdout_dump: "texto arbitrario qualquer" } };
checar("H2 campo fora do contrato recusado", recusa(arbitrario) !== null, "allowlist, não regex");

// PORT — secret + portable é RECUSADO
const portatil = { ...ref, portability: "portable" };
checar("PORT secret+portable recusado", recusa(portatil) !== null, "PORTABLE SECRET REF != PORTABLE SECRET");

// PORT2 — secret + local é aceito
checar("PORT2 secret+local aceito", recusa({ ...ref, portability: "local" }) === null, "local não atravessa clone");

// NEG — record não-secret não é tocado pelo guard
const normal = { sensitivity: { classification: "internal" }, portability: "portable", content: { qualquer: "coisa" } };
checar("NEG record internal não é afetado", recusa(normal) === null, "guard não adivinha sensibilidade alheia");

// STRUCT — secret sem content estruturado é recusado
checar("STRUCT secret sem content recusado", recusa({ ...ref, content: "string solta" }) !== null, "fail closed");

for (const p of provas) console.log(`  ${p.ok ? "PASS" : "FAIL"}  ${p.n} — ${p.detail}`);
const falhas = provas.filter((p) => !p.ok).length;
console.log(`\n${falhas === 0 ? "PASS" : "FAIL"} — ${provas.length - falhas}/${provas.length} provas\n`);
process.exit(falhas === 0 ? 0 : 1);
