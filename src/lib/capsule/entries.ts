/**
 * Fonte única das entradas reconhecidas em `.nexos/` (ROUND 3 cleanup).
 *
 * Antes deste módulo, `initializer.ts` (`ALLOWED_ENTRIES`) e
 * `migration-classifier.ts` (`CANONICAL_ENTRIES`/`LOCAL_ENTRIES`) mantinham
 * dois Sets hardcoded independentes para o MESMO propósito. Os dois
 * classificadores DERIVAM daqui — nunca redeclaram o próprio Set.
 *
 * `project-effects.yaml` (ADR-071) saiu da lista no corte
 * presence/capability/observations (nexos://decision/p0-corte-presence-capability-observations):
 * era o formato de política do TaskGrant/remote-authorization, removido por
 * inteiro. Um `project-effects.yaml` remanescente de antes do corte agora
 * cai, corretamente, em "estrutura não reconhecida" — FAIL CLOSED, não
 * validação silenciosa de um formato cujo dono saiu.
 *
 * P1.3c (nexos://decision/p1-3-bootstrap-e-migrate-repair) — `project.yaml`
 * (projeção legível do manifest) saiu daqui pelo mesmo motivo: dois produtores
 * do mesmo fato (`manifest.yaml` e a projeção) é a divergência que este módulo
 * existe para impedir. `manifest.yaml` é o ÚNICO contrato agora; um
 * `project.yaml` remanescente cai em "estrutura não reconhecida", removido por
 * nome explícito no plano de reparo (`repair.ts`), igual `project-effects.yaml`.
 */

/**
 * P1.3 (nexos://decision/p1-3-bootstrap-e-migrate-repair) — `map/`
 * (`.nexos/map/project.json`, fatos OBSERVED com proveniência) entra como
 * canônico: escrito por `nexos init` (BOOTSTRAP), portável, nunca sob
 * `.local/`.
 */
export const CANONICAL_ENTRIES: ReadonlySet<string> = new Set([
  "manifest.yaml",
  ".gitignore",
  "records",
  "map",
]);

/** Área local declarada — reconhecida pelos DOIS classificadores. */
export const LOCAL_ENTRIES: ReadonlySet<string> = new Set([".local"]);
