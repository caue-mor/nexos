#!/usr/bin/env node
// nexos-statusline.mjs — statusLine renderer instalado por `nexos install`.
//
// Contrato (nexos://decision/statusline-global-terminal-observability,
// nexos://decision/statusline-renderer-escolha): zero dependências, zero
// rede, zero spawn de processo, nunca lança — qualquer erro cai no catch
// mais próximo e o script ainda imprime algo e sai 0. Saída vazia ou exit
// != 0 apaga a linha inteira no Claude Code (statusline.md, 17/09), então
// "não travar a linha" pesa mais que "mostrar tudo".
//
// Lê o payload JSON nativo do stdin (statusline.md #available-data) e o
// snapshot barato gravado por `nexos state`/`nexos checkpoint`
// (.nexos/.local/runtime/statusline.json). UNKNOWN é um valor legítimo:
// nunca vira 0 nem "default" por fallback silencioso.

import { readFileSync, statSync } from "node:fs";
import path from "node:path";
import os from "node:os";

const DIM = "\x1b[2m";
const RESET = "\x1b[0m";
const NO_COLOR = Boolean(process.env.NO_COLOR) || process.env.TERM === "dumb";

function dim(text) {
  return NO_COLOR ? text : `${DIM}${text}${RESET}`;
}

// ─── stdin ───────────────────────────────────────────────────────────────

function readStdinPayload() {
  try {
    // ponytail: leitura síncrona do fd 0 — Claude Code escreve o payload
    // inteiro e fecha stdin antes de esperar saída; medido mais simples e
    // mais rápido que acumular via eventos 'data'/'end' sem trazer nenhuma
    // dependência. Upgrade só se um host real do statusLine travar nisso.
    const raw = readFileSync(0, "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : {};
  } catch {
    return {};
  }
}

// ─── formatação ──────────────────────────────────────────────────────────

function formatWindowSize(n) {
  if (typeof n !== "number" || !Number.isFinite(n) || n <= 0) return null;
  if (n >= 1_000_000) {
    const millions = n / 1_000_000;
    return `${Number.isInteger(millions) ? millions : millions.toFixed(1)}M`;
  }
  if (n >= 1000) return `${Math.round(n / 1000)}k`;
  return String(n);
}

function formatDuration(ms) {
  if (typeof ms !== "number" || !Number.isFinite(ms) || ms < 0) return null;
  const totalSec = Math.floor(ms / 1000);
  const h = Math.floor(totalSec / 3600);
  const m = Math.floor((totalSec % 3600) / 60);
  const s = totalSec % 60;
  return h > 0 ? `${h}h${m}m` : `${m}m${s}s`;
}

function formatPercentage(n) {
  if (typeof n !== "number" || !Number.isFinite(n)) return null;
  return `${Math.round(n)}%`;
}

// ─── linha 1: modelo, effort, contexto, duração, rate limit ──────────────

function buildModelLine(data) {
  const parts = [];

  const modelName = data?.model?.display_name;
  parts.push(typeof modelName === "string" && modelName.length > 0 ? modelName : "UNKNOWN");

  // effort: ausente quando o modelo não suporta o parâmetro — omite o
  // segmento inteiro, nunca mostra "UNKNOWN" para um conceito que não existe.
  const effortLevel = data?.effort?.level;
  if (typeof effortLevel === "string" && effortLevel.length > 0) {
    parts.push(effortLevel);
  }

  const ctxWindow = data?.context_window;
  const usedPct = ctxWindow?.used_percentage;
  if (typeof usedPct === "number" && Number.isFinite(usedPct)) {
    const windowSize = formatWindowSize(ctxWindow?.context_window_size);
    parts.push(windowSize ? `ctx ${formatPercentage(usedPct)} de ${windowSize}` : `ctx ${formatPercentage(usedPct)}`);
  } else {
    // context_window ausente ou used_percentage null (início de sessão,
    // ou logo após /compact) — UNKNOWN nunca vira 0.
    parts.push("ctx UNKNOWN");
  }

  const durationMs = data?.cost?.total_duration_ms;
  const duration = formatDuration(durationMs);
  if (duration) parts.push(duration);

  // rate_limits só existe para assinantes Pro/Max após a primeira resposta —
  // "só se rate_limits vier", nunca UNKNOWN quando o campo inteiro está ausente.
  const fiveHourPct = data?.rate_limits?.five_hour?.used_percentage;
  if (typeof fiveHourPct === "number" && Number.isFinite(fiveHourPct)) {
    parts.push(`5h ${formatPercentage(fiveHourPct)}`);
  }

  return parts.join(dim(" · "));
}

// ─── branch: .git/HEAD lido direto, nunca `git` spawnado ─────────────────

function readGitBranch(startDir) {
  if (typeof startDir !== "string" || startDir.length === 0) return null;
  try {
    let dir = startDir;
    // ponytail: sobe até a raiz do filesystem — sem limite artificial de
    // profundidade, o próprio `path.dirname` converge em poucos passos.
    for (let i = 0; i < 64; i++) {
      const gitPath = path.join(dir, ".git");
      let stat;
      try {
        stat = statSync(gitPath);
      } catch {
        stat = null;
      }
      if (stat) {
        let headFile;
        if (stat.isDirectory()) {
          headFile = path.join(gitPath, "HEAD");
        } else {
          // worktree: `.git` é um arquivo "gitdir: <path>" apontando para o
          // HEAD real deste worktree, distinto do checkout principal.
          const pointer = readFileSync(gitPath, "utf8").trim();
          const match = /^gitdir:\s*(.+)$/.exec(pointer);
          if (!match) return null;
          const gitdir = path.isAbsolute(match[1]) ? match[1] : path.resolve(dir, match[1]);
          headFile = path.join(gitdir, "HEAD");
        }
        const head = readFileSync(headFile, "utf8").trim();
        const refMatch = /^ref:\s*refs\/heads\/(.+)$/.exec(head);
        if (refMatch) return refMatch[1];
        return head.length >= 7 ? head.slice(0, 7) : head || null; // detached HEAD
      }
      const parent = path.dirname(dir);
      if (parent === dir) break;
      dir = parent;
    }
  } catch {
    return null;
  }
  return null;
}

// ─── segmento NexOS: snapshot barato, nunca records, nunca processo ──────

function readManifestProjectName(nexosDir) {
  try {
    const raw = readFileSync(path.join(nexosDir, "manifest.yaml"), "utf8");
    const lines = raw.split("\n");
    let inProjectBlock = false;
    for (const line of lines) {
      if (/^project:\s*$/.test(line)) {
        inProjectBlock = true;
        continue;
      }
      if (!inProjectBlock) continue;
      if (/^\S/.test(line)) break; // saiu do bloco `project:` (voltou a coluna 0)
      const match = /^\s+name:\s*(.+?)\s*$/.exec(line);
      if (match) return stripYamlScalar(match[1]);
    }
  } catch {
    // sem manifest legível — sem nome
  }
  return null;
}

function stripYamlScalar(raw) {
  const trimmed = raw.trim();
  if (
    (trimmed.startsWith('"') && trimmed.endsWith('"')) ||
    (trimmed.startsWith("'") && trimmed.endsWith("'"))
  ) {
    return trimmed.slice(1, -1);
  }
  return trimmed;
}

function readStatuslineSnapshot(nexosDir) {
  try {
    const raw = readFileSync(path.join(nexosDir, ".local", "runtime", "statusline.json"), "utf8");
    const parsed = JSON.parse(raw);
    return parsed && typeof parsed === "object" ? parsed : null;
  } catch {
    // ausente (ENOENT) e corrompido (JSON inválido) caem no mesmo `catch` —
    // o chamador decide o que fazer com `null` em cada caso.
    return null;
  }
}

function buildNexosSegment(data) {
  const projectDir = data?.workspace?.project_dir ?? data?.cwd ?? data?.workspace?.current_dir;
  if (typeof projectDir !== "string" || projectDir.length === 0) return null;

  const nexosDir = path.join(projectDir, ".nexos");
  let nexosExists;
  try {
    nexosExists = statSync(nexosDir).isDirectory();
  } catch {
    nexosExists = false;
  }
  if (!nexosExists) return null; // sem NexOS no projeto — segmento vazio, sem erro

  let snapshotExists;
  try {
    snapshotExists = statSync(path.join(nexosDir, ".local", "runtime", "statusline.json")).isFile();
  } catch {
    snapshotExists = false;
  }

  if (!snapshotExists) {
    // `.nexos` sem snapshot ainda — nome do manifest, sem inventar estado.
    const name = readManifestProjectName(nexosDir);
    return name ? `NexOS ${name}` : "NexOS";
  }

  const snapshot = readStatuslineSnapshot(nexosDir);
  if (!snapshot) return null; // snapshot presente mas ilegível — silencioso

  const projectName = typeof snapshot.project_name === "string" ? snapshot.project_name : null;
  const checkpointState = typeof snapshot.checkpoint_state === "string" ? snapshot.checkpoint_state : null;
  const stateTitle = typeof snapshot.state_title === "string" ? snapshot.state_title : null;

  const pieces = [`NexOS${projectName ? ` ${projectName}` : ""}`];
  if (checkpointState) pieces.push(checkpointState);
  if (stateTitle) pieces.push(truncate(stateTitle, 40));
  return pieces.join(dim(" · "));
}

function truncate(text, maxLength) {
  return text.length > maxLength ? `${text.slice(0, maxLength - 1)}…` : text;
}

// ─── segmento Ponytail: só existe se o flag existir, nunca inferido ───────
//
// Requisito do dono ("Ponytail só como segmento se limpo, senão fora"): o
// badge lê SÓ `${CLAUDE_CONFIG_DIR:-$HOME/.claude}/.ponytail-active` — mesmo
// flag que o próprio plugin Ponytail escreve/apaga. Sem arquivo, sem
// segmento (não é "PONYTAIL:OFF", é AUSENTE). fs puro, nunca spawn.

function readPonytailBadge() {
  try {
    const configDir = process.env.CLAUDE_CONFIG_DIR || path.join(os.homedir(), ".claude");
    const raw = readFileSync(path.join(configDir, ".ponytail-active"), "utf8");
    const mode = (raw.split("\n")[0] ?? "").trim();
    if (mode === "" || mode.toLowerCase() === "full") return "PONYTAIL";
    return `PONYTAIL:${mode.toUpperCase()}`;
  } catch {
    return null; // flag ausente ou ilegível — segmento some, sem erro
  }
}

// ─── linha 2: branch · Ponytail · segmento NexOS ──────────────────────────

function buildSecondLine(data) {
  const cwd = data?.workspace?.current_dir ?? data?.cwd;
  const branch = readGitBranch(typeof cwd === "string" ? cwd : null);
  const ponytail = readPonytailBadge();
  const nexosSegment = buildNexosSegment(data);

  const parts = [];
  if (branch) parts.push(branch);
  if (ponytail) parts.push(ponytail);
  if (nexosSegment) parts.push(nexosSegment);
  return parts.length > 0 ? parts.join(dim(" · ")) : null;
}

// ─── main ──────────────────────────────────────────────────────────────

function main() {
  const data = readStdinPayload();
  const lines = [buildModelLine(data)];
  const second = buildSecondLine(data);
  if (second) lines.push(second);
  process.stdout.write(`${lines.join("\n")}\n`);
}

// EPIPE (consumidor fechou o pipe antes do write terminar) chega como evento
// assíncrono no stream, não como exceção síncrona — o try/catch de `main()`
// não alcança. Sem este handler, Node derruba o processo com exit != 0 e a
// linha inteira some (statusline.md: "saída vazia ou exit != 0 apaga a linha").
process.stdout.on("error", (err) => {
  if (err && err.code === "EPIPE") return;
});

try {
  main();
} catch {
  // Nunca deixa a statusline inteira sumir por uma exceção não prevista —
  // melhor uma linha mínima que nenhuma linha.
  try {
    process.stdout.write("NexOS\n");
  } catch {
    // stdout indisponível — nada mais a fazer.
  }
}
