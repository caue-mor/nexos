#!/usr/bin/env node
/**
 * `scan:local-secrets` — NexOS LOCAL surfaces, named and bounded.
 *
 *   scan:secrets      = repo + portable Store + remote-delivery contract
 *   scan:local-secrets = THIS host's NexOS runtime state, three EXPLICIT dirs
 *
 * SECRET BOUNDARY V0 (slice B) had put `scanGlobalGovernanceLog()` inside
 * `scan-secrets.mjs` — that script's contract is "what reaches the remote",
 * and `~/.nexos/governance/` never does. Bolting a `$HOME`-adjacent scan onto
 * a repo/portable-store scanner blurred a clean contract; this script is the
 * MOVE, not an addition: `scan-secrets.mjs` goes back to its original
 * contract, and this one owns exactly the surfaces named in the task —
 * `~/.nexos/governance/`, `~/.nexos/instincts/`, `<repo>/.nexos/logs/` —
 * never a generic `$HOME` walk (that would sweep caches, browser profiles,
 * unrelated dotfiles: a different hazard, not a superset of this one).
 *
 * Reuses the SAME canonical pattern list the three hot-path hooks
 * (`nexos-governance-capture.js`, `nexos-instinct-observer.js`,
 * `nexos-exec-log.js`) require — real import (ESM importing a `.cjs` via
 * Node's CJS/ESM interop), not a fourth copy.
 *
 * FOUR STATES, never collapsed to pass/fail. Two axes, classified ONLY by
 * pattern NAME + the `ts` metadata every line these sinks already write —
 * NEVER by the matched VALUE (the value is never inspected, never printed):
 *
 *   TEMPORAL (existing, unchanged):
 *     CURRENT    — no parseable `ts`, or a `ts` at/after
 *                  REDACTION_COMPLETE_SINCE_MS (fail-closed: no proof it's old).
 *     HISTORICAL — `ts` is BEFORE the redact-before-persist cutover. Known,
 *                  pre-existing, awaiting the operator's manual credential
 *                  rotation (REGRA ABSOLUTA — never touched/truncated here).
 *
 *   CONFIDENCE (SECRET BOUNDARY V0 closeout, item 2/3):
 *     HIGH — pattern name is one of HIGH_CONFIDENCE_PATTERN_NAMES below, AND
 *            at least one occurrence matched on the line is NOT a known
 *            placeholder/public fixture (`isKnownPlaceholder`, imported from
 *            the same canonical file as `SECRET_PATTERNS` — never a second
 *            copy): format alone is unambiguous credential shape
 *            (provider-prefixed token, PEM header, JWT three-part
 *            structure, `Bearer <opaque token>`...) AND provenance is not a
 *            vendor-published example or this repo's own test fixture.
 *            `PATTERN NAME IS NOT PROVENANCE` — measured: `AKIAIOSFODNN7EXAMPLE`
 *            and this suite's own `FAKE_JWT` would both be
 *            HIGH_CONFIDENCE_LEAK if ever recaptured here after the cutover,
 *            with zero actual credential behind either. The matched VALUE is
 *            inspected ONLY for this exact-string placeholder comparison —
 *            never printed, never logged, compared only for full equality
 *            (`Set.has`, never substring) — see `summarize()` below: it
 *            counts occurrences, it never quotes one.
 *     LOW  — every other canonical pattern (`generic_secret`, `database_url`
 *            with no provider-specific marker, and any future broad
 *            heuristic): plausible, not proof. A gate that screams
 *            CURRENT/HIGH LEAK over `api_secret_name` in prose is a gate
 *            people learn to ignore — this axis exists so that stops being
 *            the only voice this scanner has.
 *
 *     A pattern name whose ONLY occurrence(s) on the line are known
 *     placeholders does not count as a match AT ALL for that name — not
 *     HIGH, not LOW. A line whose sole content is
 *     `AKIAIOSFODNN7EXAMPLE`/`FAKE_JWT`/... is CLEAN, exactly like a line
 *     with none of the canonical shapes: provenance is already resolved, so
 *     there is nothing left to advise about.
 *
 * The two axes collapse into ONE verdict per run, by priority (never hides a
 * lower-priority finding — see "reports both" tests below), CONTRATO DE EXIT:
 *
 *   1. HIGH_CONFIDENCE_LEAK  — any CURRENT line with a HIGH-confidence
 *                              pattern name. exit 1. Unambiguous, current.
 *   2. HISTORICAL_DEBT       — no (1), but any HISTORICAL line (any
 *                              confidence). exit 1, distinct text from CLEAN
 *                              — debt never reports as green.
 *   3. LOW_CONFIDENCE_FINDING — no (1) or (2), but any CURRENT line whose
 *                              ONLY matches are LOW-confidence. NOT called a
 *                              CURRENT/HIGH leak. Advisory: exit 0.
 *   4. CLEAN                 — no finding at all. exit 0.
 *
 * Detection itself is never weakened by this: every canonical pattern still
 * runs, every match is still reported (LOW-confidence findings print, they
 * just don't fail the gate on their own) — this only changes which findings
 * are allowed to be advisory instead of blocking.
 *
 *   uso: node scripts/scan-local-secrets.mjs
 */
import { readdir, readFile, lstat } from "node:fs/promises";
import path from "node:path";
import os from "node:os";
import { SECRET_PATTERNS, isKnownPlaceholder } from "../assets/hooks/nexos-secret-patterns.cjs";

/**
 * Instante em que a redação antes-de-persistir passou a cobrir os TRÊS sinks
 * (SECRET BOUNDARY V0, slice B). Uma linha com `ts` ANTES disto é dívida
 * conhecida; uma linha SEM `ts` legível, ou com `ts` NESTE instante ou depois,
 * é tratada como vazamento atual — não há como provar que é histórica, e
 * adivinhar a favor do estado mais confortável é o próprio erro que este
 * script existe para não cometer. Não é uma allowlist de credencial: nenhum
 * valor específico é comparado, só a DATA da linha que carrega o formato.
 */
const REDACTION_COMPLETE_SINCE_MS = Date.parse("2026-08-31T00:00:00.000Z");

/**
 * Presença de um destes NOMES (sujeita ao filtro de placeholder em
 * `matchedPatternNames`, abaixo) é credencial inequívoca por formato
 * (prefixo de provedor, cabeçalho PEM, estrutura de 3 partes de um JWT,
 * `Bearer <token opaco>`). `bearer_token` entrou nesta lista no fechamento do
 * SECRET BOUNDARY V0 (item 3) — decisão do operador: um bearer token real
 * tem exatamente essa forma inequívoca, e o filtro de placeholder (novo no
 * mesmo fechamento) é o que evita que a fixture pública `FAKE_BEARER` da
 * suíte de testes dispare HIGH_CONFIDENCE_LEAK se recapturada aqui.
 * `generic_secret` deliberadamente NÃO entrou — heurística ampla demais
 * (`secret|password|token|api_key` seguido de qualquer string) para
 * classificar como inequívoca só pelo nome, mesmo filtrando placeholder.
 * `database_url` também fica de fora, sem mudança de escopo.
 */
const HIGH_CONFIDENCE_PATTERN_NAMES = new Set(["supabase_key", "github_token", "aws_key", "jwt", "private_key", "bearer_token"]);

const SURFACES = [
  { name: "~/.nexos/governance/", dir: path.join(os.homedir(), ".nexos", "governance") },
  { name: "~/.nexos/instincts/", dir: path.join(os.homedir(), ".nexos", "instincts") },
  { name: "<repo>/.nexos/logs/", dir: path.join(process.cwd(), ".nexos", "logs") },
];

/** Teto de sanidade — mesmo valor usado por `scanGlobalGovernanceLog` antes
 * de mover para cá: eventos reais já medem ~9 MB neste host. */
const MAX_FILE_BYTES = 100_000_000;

/**
 * Nomes dos padrões canônicos que casam em `line` por ao menos UMA
 * ocorrência que NÃO é um placeholder/fixture pública conhecida. O valor
 * casado é lido aqui SÓ para essa comparação de igualdade exata contra
 * `isKnownPlaceholder` — nunca devolvido, nunca logado, nunca comparado por
 * substring. Um padrão cuja ÚNICA ocorrência na linha é um placeholder
 * conhecido não entra na lista — a linha fica exatamente como se aquele
 * padrão nunca tivesse casado.
 */
function matchedPatternNames(line) {
  const names = [];
  for (const { name, pattern } of SECRET_PATTERNS) {
    const global = new RegExp(pattern.source, pattern.flags.includes("g") ? pattern.flags : `${pattern.flags}g`);
    const matches = line.match(global);
    if (!matches) continue;
    if (matches.some((match) => !isKnownPlaceholder(match))) names.push(name);
  }
  return names;
}

/** `null` quando a linha não carrega segredo; senão `{ temporal, confidence }`. */
function classifyLine(line) {
  const names = matchedPatternNames(line);
  if (names.length === 0) return null;
  const confidence = names.some((n) => HIGH_CONFIDENCE_PATTERN_NAMES.has(n)) ? "HIGH" : "LOW";
  let ts;
  try {
    ts = JSON.parse(line)?.ts;
  } catch {
    /* linha não é JSON válido — cai no fail-closed abaixo */
  }
  if (typeof ts === "string") {
    const parsed = Date.parse(ts);
    if (!Number.isNaN(parsed) && parsed < REDACTION_COMPLETE_SINCE_MS) return { temporal: "HISTORICAL", confidence };
  }
  return { temporal: "CURRENT", confidence }; // sem `ts` legível, ou `ts` no/depois do corte — fail-closed
}

/** Walk recursivo das TRÊS raízes nomeadas — nunca de `$HOME` genérico.
 * Sem tratamento de symlink: são diretórios de runtime do PRÓPRIO NexOS,
 * escritos só pelos hooks, não árvore de repositório de terceiros — a
 * superfície de ataque que `scan-secrets.mjs` trata (symlink escapando a
 * raiz) não se aplica aqui. */
async function walkFiles(dir) {
  let entries;
  try {
    entries = await readdir(dir, { withFileTypes: true });
  } catch {
    return [];
  }
  const files = [];
  for (const entry of entries) {
    const target = path.join(dir, entry.name);
    if (entry.isDirectory()) {
      files.push(...(await walkFiles(target)));
    } else if (entry.isFile()) {
      files.push(target);
    }
  }
  return files;
}

async function scanSurface(surface) {
  const findings = [];
  for (const file of await walkFiles(surface.dir)) {
    const stat = await lstat(file).catch(() => null);
    if (!stat || stat.size > MAX_FILE_BYTES) continue;
    const content = await readFile(file, "utf-8").catch(() => "");
    for (const line of content.split("\n")) {
      if (!line.trim()) continue;
      const classified = classifyLine(line);
      if (classified) findings.push({ surface: surface.name, file, ...classified });
    }
  }
  return findings;
}

const allFindings = (await Promise.all(SURFACES.map(scanSurface))).flat();

const currentHigh = allFindings.filter((f) => f.temporal === "CURRENT" && f.confidence === "HIGH");
const currentLow = allFindings.filter((f) => f.temporal === "CURRENT" && f.confidence === "LOW");
const historicalDebt = allFindings.filter((f) => f.temporal === "HISTORICAL");

function summarize(findings) {
  const bySurface = new Map();
  for (const f of findings) bySurface.set(f.surface, (bySurface.get(f.surface) ?? 0) + 1);
  return [...bySurface.entries()].map(([surface, count]) => `${surface} (${count})`).join(", ");
}

// CONTRATO DE EXIT (ver cabeçalho): reporta TODOS os grupos não-vazios —
// nunca esconde debt atrás de leak, nem low-confidence atrás de high — mas o
// exit code só reage a HIGH_CONFIDENCE_LEAK e HISTORICAL_DEBT. LOW_CONFIDENCE
// sozinho é advisory (exit 0): não é chamado de CURRENT/HIGH leak.
if (currentHigh.length > 0) {
  process.stderr.write(
    `scan:local-secrets — CURRENT LEAK (HIGH_CONFIDENCE_LEAK): ${currentHigh.length} linha(s) com formato de credencial inequívoco, SEM proveniência histórica: ${summarize(currentHigh)}\n`
  );
}
if (historicalDebt.length > 0) {
  process.stderr.write(
    `scan:local-secrets — HISTORICAL DEBT (HISTORICAL_DEBT): ${historicalDebt.length} linha(s) pré-existente(s) com formato de credencial, anteriores à correção de redação (rotação manual do operador ainda pendente): ${summarize(historicalDebt)}\n`
  );
}
if (currentLow.length > 0) {
  process.stderr.write(
    `scan:local-secrets — LOW_CONFIDENCE_FINDING (advisory, NÃO é CURRENT/HIGH leak): ${currentLow.length} linha(s) com heurística ampla (generic_secret/database_url/outra), sem provar credencial real: ${summarize(currentLow)}\n`
  );
}

if (currentHigh.length > 0 || historicalDebt.length > 0) process.exit(1);

if (currentLow.length > 0) {
  process.stdout.write("scan:local-secrets — LOW_CONFIDENCE_FINDING (advisory) — exit 0\n");
  process.exit(0);
}

process.stdout.write("scan:local-secrets — CLEAN\n");
