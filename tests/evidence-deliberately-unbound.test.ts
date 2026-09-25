/**
 * `EvidenceRecord.deliberately_unbound` — o irmão de `outcome` no eixo da
 * amarração (handoff 18/09, frente OSS). CONTROLE 4 do handoff: 282 records
 * legados (anteriores a este campo) não têm `subject_ref` NEM
 * `deliberately_unbound` — o parser precisa continuar lendo, sem fabricar
 * intenção retroativa que o record nunca teve a chance de declarar.
 *
 * Controles 1-3 (grava avulsa/sai 0; com --subject não marca; guard de
 * VERIFYING não regride) estão em `tests/verify-command.test.ts`, no nível
 * do comando real — este arquivo cobre só o schema/parse de `evidence.ts`.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { loadEvidence } from "../src/lib/evidence.js";

const TMP = fs.realpathSync(os.tmpdir());

/** Forma EXATA de um record gravado antes deste campo existir — sem `subject_ref`, sem `deliberately_unbound`. */
function legacyRecordJson(id: string): Record<string, unknown> {
  return {
    id,
    kind: "command_observation",
    gate: "test",
    command: "npm",
    args: ["run", "test"],
    cwd: "/tmp/legado",
    started_at: new Date().toISOString(),
    finished_at: new Date().toISOString(),
    exit_code: 0,
    observed_pass: true,
    stdout_tail: "",
    stderr_tail: "",
    stdout_bytes: 0,
    stderr_bytes: 0,
    producer: "nexos-evidence-v1",
    // sem outcome, sem subject_ref, sem deliberately_unbound — a forma real do acervo legado.
  };
}

describe("CONTROLE 4 (handoff 18/09) — legado sem o campo continua legível", () => {
  it("record sem subject_ref nem deliberately_unbound é lido sem erro, e o campo novo fica ausente (nunca fabricado)", async () => {
    const root = await fs.mkdtemp(path.join(TMP, "ev-legacy-"));
    try {
      const dir = path.join(root, ".nexos", ".local", "evidence");
      await fs.mkdir(dir, { recursive: true });
      await fs.writeFile(
        path.join(dir, "ev_LEGADO0000000000000001.json"),
        JSON.stringify(legacyRecordJson("ev_LEGADO0000000000000001"), null, 2),
        "utf-8"
      );

      const records = await loadEvidence(root);
      expect(records).toHaveLength(1);
      const rec = records[0]!;
      // Nunca lança, nunca recusa o record antigo — é o próprio requisito do controle.
      expect(rec.subject_ref).toBeUndefined();
      // A ausência do campo NUNCA vira `true` fabricado: o record nunca teve a
      // chance de declarar intenção, e inventar retroativamente violaria
      // SOURCE ABSENCE != INVENTED CANONICAL FACT.
      expect(rec.deliberately_unbound).toBeUndefined();
      // outcome legado continua derivado normalmente (comportamento já existente, não regrediu).
      expect(rec.outcome).toBe("passed");
    } finally {
      await fs.remove(root);
    }
  });
});
