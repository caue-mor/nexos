/**
 * `nexos capabilities` — composição. Único ponto que junta leitura
 * (`scan.ts`) + análise (`analyze.ts`) + a stack observada do Project Map
 * (`.nexos/map/project.json`, best-effort — projeto sem mapa não falha,
 * `--for` só perde o bônus de stack). Consumido pelo comando
 * (`commands/capabilities.ts`) — SÓ sob demanda; o HOT brief não chama isto
 * (removido: `NO CONSUMER -> NO CODE`, ver `map/hot-brief.ts`).
 */
import fs from "fs-extra";
import { forProject } from "../capsule/paths.js";
import { scanAll, type ScanRoots } from "./scan.js";
import { groupDuplicates, groupVariants, totalListingChars, suggestCapabilities } from "./analyze.js";
import type { CapabilityCatalog, CapabilitySuggestResult } from "./types.js";
import type { MapFact } from "../map/stack-detector.js";

export async function loadCapabilityCatalog(root: string, opts: ScanRoots = {}): Promise<CapabilityCatalog> {
  const { items, issues } = await scanAll(root, opts);
  return {
    items,
    duplicates: groupDuplicates(items),
    variants: groupVariants(items),
    listing_chars_total: totalListingChars(items),
    issues,
  };
}

async function readStackFacts(root: string): Promise<readonly MapFact[]> {
  const file = forProject(root).mapProjectJson();
  try {
    const raw: unknown = await fs.readJson(file);
    if (raw && typeof raw === "object" && Array.isArray((raw as { facts?: unknown }).facts)) {
      return (raw as { facts: MapFact[] }).facts;
    }
  } catch {
    // Mapa ausente/ilegível: `--for` degrada para ranking sem bônus de stack, nunca falha.
  }
  return [];
}

export async function suggestForRoot(
  root: string,
  task: string,
  opts: ScanRoots & { readonly limit?: number } = {}
): Promise<CapabilitySuggestResult> {
  const catalog = await loadCapabilityCatalog(root, opts);
  const stackFacts = await readStackFacts(root);
  return suggestCapabilities(catalog.items, task, { stackFacts, ...(opts.limit ? { limit: opts.limit } : {}) });
}
