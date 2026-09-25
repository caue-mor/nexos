import pc from "picocolors";
import fs from "fs-extra";
import path from "node:path";
import { readCurrentRecords } from "../lib/capsule/reader.js";
import { classifyForReconciliation } from "../lib/capsule/migration-classifier.js";
import { resolveCommandRoot } from "../lib/project-resolver.js";
import { forProject } from "../lib/capsule/paths.js";
import type { CapsuleRecord } from "../lib/capsule/schemas.js";

/**
 * `nexos context --for "<assunto>"` — o que o projeto JÁ SABE, em camadas.
 *
 *   RETRIEVABLE != PRESENT AT BOOT
 *
 * O brief do SessionStart carrega o HOT (objetivo, estado, próxima ação) e para
 * — de propósito: ele já chegou a ~7,9k e um brief que despeja o acervo inteiro
 * deixa de ser brief. Mas então, no meio da sessão, "o que já sabemos sobre X?"
 * não tinha resposta barata: ou se lia o Store inteiro, ou se perguntava ao
 * humano, ou se refazia o trabalho.
 *
 * As três camadas não são estética:
 *
 *   L0  quanto existe        — responde "vale a pena olhar?" em uma linha
 *   L1  títulos e ids        — responde "o que exatamente?" sem abrir nada
 *   L2  o comando que abre   — o conteúdo vem sob demanda, nunca por padrão
 *
 * O erro que isto evita é o mesmo do brief: `ZERO ENCONTRADO != ZERO EXISTENTE`
 * de um lado, e despejar 1900 records do outro. A camada 0 diz o tamanho antes
 * de o leitor decidir o custo.
 *
 * REUSE: as áreas vêm do `coverage.json` que o `nexos map` já produz; os
 * records vêm de `readCurrentRecords`; os arquivos continuam sendo de
 * `nexos relevant-files`, que já é chamado pelo hook de prompt e não se
 * reimplementa aqui.
 */
export interface ContextOptions {
  cwd?: string;
  for?: string;
  /** 0 = só o tamanho · 1 = títulos e ids (padrão) · 2 = inclui o corpo do topo. */
  depth?: string;
}

interface Achado {
  readonly id: string;
  readonly tipo: string;
  readonly titulo: string;
  readonly corpo: string;
  readonly score: number;
}

function termos(texto: string): Set<string> {
  return new Set(
    texto
      .toLowerCase()
      .normalize("NFD")
      .replace(/[̀-ͯ]/g, "")
      .split(/[^a-z0-9]+/)
      .filter((t) => t.length > 3)
  );
}

export function descrever(r: CapsuleRecord): { tipo: string; titulo: string; corpo: string } {
  const c = r.content as Record<string, unknown>;
  const str = (k: string): string => (typeof c[k] === "string" ? (c[k] as string) : "");
  if (r.family === "Decision") return { tipo: "decisão", titulo: str("title"), corpo: str("decision") };
  if (r.family === "Research") return { tipo: "pesquisa", titulo: str("question"), corpo: str("findings") };
  /**
   * `kind` mora no ENVELOPE, não em `content`. Lê-lo de dentro do conteúdo
   * devolvia string vazia para TODO gotcha do acervo, e os 13 achados saíam
   * rotulados como "KnowledgeRecord" — a família, não o que eles são.
   */
  const envelopeKind = (r as unknown as Record<string, unknown>)["kind"];
  const kind = typeof envelopeKind === "string" ? envelopeKind : "";
  if (kind === "gotcha") return { tipo: "gotcha", titulo: str("title"), corpo: `${str("rule")} ${str("failure_mode")}` };
  if (kind === "project_state") return { tipo: "estado", titulo: str("title"), corpo: str("current_state") };
  return { tipo: kind === "" ? r.family : kind, titulo: str("title") || str("fact"), corpo: str("fact") };
}

export async function context(options: ContextOptions = {}): Promise<void> {
  const root = await resolveCommandRoot(options.cwd ?? process.cwd());

  const pre = await classifyForReconciliation(root);
  if (!pre.hasCanonical) {
    console.log(pc.yellow("  ! este projeto não tem Store — rode `nexos init`."));
    process.exitCode = 1;
    return;
  }

  const assunto = options.for?.trim();
  if (!assunto) {
    console.log(pc.red("  x `--for <assunto>` é obrigatório."));
    console.log(pc.dim("    contexto sem assunto é o acervo inteiro, que é exatamente o que este comando existe para evitar."));
    process.exitCode = 1;
    return;
  }
  const profundidade = Number.parseInt(options.depth ?? "1", 10);
  if (!Number.isInteger(profundidade) || profundidade < 0 || profundidade > 2) {
    console.log(pc.red(`  x --depth precisa ser 0, 1 ou 2 — recebeu "${options.depth}".`));
    process.exitCode = 1;
    return;
  }

  const leitura = await readCurrentRecords(root);
  if (!leitura.ok) {
    /** `CANNOT OBSERVE != DOES NOT EXIST` — Store ilegível não é Store vazio. */
    console.log(pc.red("  x Store ilegível — o silêncio abaixo seria mentira, então não há saída."));
    process.exitCode = 1;
    return;
  }

  const alvo = termos(assunto);
  const achados: Achado[] = [];
  for (const { record } of leitura.records) {
    const d = descrever(record);
    const t = termos(`${d.titulo} ${d.corpo}`);
    const score = [...alvo].filter((x) => t.has(x)).length;
    if (score > 0) achados.push({ id: record.id, tipo: d.tipo, titulo: d.titulo, corpo: d.corpo, score });
  }
  achados.sort((a, b) => b.score - a.score);

  /** Áreas do map que o assunto toca — derivadas, nunca inventadas. */
  const areas: string[] = [];
  const coveragePath = path.join(forProject(root).derived(), "coverage.json");
  if (await fs.pathExists(coveragePath)) {
    try {
      const cov = (await fs.readJson(coveragePath)) as { areas?: { area?: string }[] };
      for (const a of cov.areas ?? []) {
        if (typeof a.area === "string" && alvo.has(a.area.toLowerCase())) areas.push(a.area);
      }
    } catch {
      /** Map ilegível é derivado — degrada o detalhe, nunca o comando. */
    }
  }

  // ─── L0 · quanto existe ───────────────────────────────────────────────────
  const porTipo = new Map<string, number>();
  for (const a of achados) porTipo.set(a.tipo, (porTipo.get(a.tipo) ?? 0) + 1);
  const resumo = [...porTipo.entries()].map(([t, n]) => `${n} ${t}`).join(" · ");

  console.log(pc.bold(`\n  contexto · "${assunto}"`));
  console.log(
    achados.length === 0
      ? pc.dim(`  nada no Store casa com este assunto (${leitura.records.length} records varridos)`)
      : pc.dim(`  ${resumo}   [de ${leitura.records.length} records]`)
  );
  if (areas.length > 0) console.log(pc.dim(`  áreas do map: ${areas.join(", ")}`));

  if (profundidade === 0 || achados.length === 0) {
    if (achados.length > 0) console.log(pc.dim(`\n  aprofundar:  nexos context --for "${assunto}" --depth 1`));
    console.log(pc.dim(`  arquivos:    nexos relevant-files --task "${assunto}"`));
    return;
  }

  // ─── L1 · títulos e ids ───────────────────────────────────────────────────
  console.log("");
  for (const a of achados.slice(0, 8)) {
    console.log(pc.cyan(`  ${a.id}`) + pc.dim(` · ${a.tipo} · score ${a.score}`));
    console.log(`    ${a.titulo.slice(0, 110)}`);
    // ─── L2 · corpo do topo, só quando pedido ───────────────────────────────
    if (profundidade >= 2 && a.corpo.trim() !== "") {
      console.log(pc.dim(`    ${a.corpo.slice(0, 300)}`));
    }
  }
  if (achados.length > 8) console.log(pc.dim(`\n  +${achados.length - 8} não exibido(s) — refine o assunto`));

  console.log(pc.dim(`\n  corpo completo:  nexos memory --search "${assunto}"`));
  console.log(pc.dim(`  arquivos:        nexos relevant-files --task "${assunto}"`));
}
