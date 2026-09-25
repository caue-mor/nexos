/**
 * P1.4 fatia A (A9) — vocabulário da COBERTURA do Project Map: por área,
 * `analyzed|partial|unsupported|not_examined|error` + detalhe. Escrito em
 * `.nexos/map/coverage.json` (via `p.mapRoot()`, já exposto por
 * `capsule/paths.ts` — nenhum path novo precisou ser adicionado lá).
 *
 *   NENHUM RESUMO IMPRIME 0 PARA ÁREA NÃO ANALISADA — a ausência de contagem
 *   é `not_examined`/`unsupported`/`error`, nunca um zero silencioso.
 */
export type CoverageArea = "routes" | "database" | "graph" | "auth" | "integrations";
export type CoverageStatus = "analyzed" | "partial" | "unsupported" | "not_examined" | "error";

export interface AreaCoverage {
  readonly area: CoverageArea;
  readonly status: CoverageStatus;
  readonly detail: string;
}

export interface SkippedFile {
  readonly path: string;
  readonly reason: string;
}

export interface ScanErrorEntry {
  readonly path: string;
  readonly detail: string;
}

export interface CoverageReport {
  readonly areas: readonly AreaCoverage[];
  readonly filesExamined: number;
  readonly skipped: readonly SkippedFile[];
  readonly errors: readonly ScanErrorEntry[];
}
