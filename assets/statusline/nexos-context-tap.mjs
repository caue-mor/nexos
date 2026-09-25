#!/usr/bin/env node
// nexos-context-tap.mjs — derivação da statusLine para o aviso de contexto
// (nexos://decision/aviso-de-contexto-por-statusline).
//
// MEDIDO 23/09: uma sessão chegou a 95% do contexto e compactou sem aviso. O
// modelo não vê a porcentagem — só a statusLine recebe
// `context_window.used_percentage` (statusline.md #available-data). Este
// script roda NA FRENTE do renderer (`node tap | <renderer>`): grava a amostra
// da sessão em `<tmpdir>/nexos-context/<session_id>.json` e repassa o stdin
// intacto, byte a byte, para o renderer de quem for (NexOS ou outro dono).
// `assets/hooks/nexos-context-warn.sh` lê a amostra.
//
// Zero dependências, nunca lança, sempre repassa o stdin: statusLine com saída
// vazia apaga a linha. Grava ANTES de repassar e por rename atômico — o host
// cancela o script em voo quando chega atualização nova (statusline.md).

import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// LOW (rodada 3) — sem isto, o renderer do lado de cá do pipe (`tap | render`)
// fechando o stdin cedo (crash, saída antecipada) vira EPIPE em
// `process.stdout.write` abaixo: stack trace no stderr e exit != 0. Doutrina
// do arquivo inteiro é "nunca lança, sempre repassa" — EPIPE quebrando o
// processo é exatamente o que essa doutrina promete não fazer.
process.stdout.on("error", () => {});

// Diretório de estado em os.tmpdir() tem nome previsível: só é usado se for
// diretório de verdade (não symlink) e do próprio usuário — num /tmp
// compartilhado, outro usuário poderia apontar o nome para onde quisesse
// (achado MEDIUM do security-reviewer, 23/09). mode 0700 só vale na criação.
function dirSeguro(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== "function" || st.uid === process.getuid());
  } catch {
    return false;
  }
}

let raw = "";
try {
  raw = readFileSync(0, "utf8");
} catch {
  raw = "";
}

try {
  const payload = JSON.parse(raw);
  const sessionId = payload?.session_id;
  const usedPercentage = payload?.context_window?.used_percentage;
  const windowSize = payload?.context_window?.context_window_size;
  if (typeof sessionId === "string" && /^[\w-]{1,128}$/.test(sessionId) && typeof usedPercentage === "number") {
    const dir = path.join(os.tmpdir(), "nexos-context");
    if (!dirSeguro(dir)) throw new Error("diretório de estado inseguro");
    const file = path.join(dir, `${sessionId}.json`);
    const tmp = `${file}.${process.pid}`;
    const sample = {
      used_percentage: Math.round(usedPercentage),
      context_window_size: typeof windowSize === "number" && windowSize > 0 ? windowSize : null,
      at: Date.now(),
    };
    writeFileSync(tmp, JSON.stringify(sample), { mode: 0o600 });
    renameSync(tmp, file);
  }
} catch {
  // amostra perdida nunca derruba a linha
}

process.stdout.write(raw);
