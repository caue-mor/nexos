#!/usr/bin/env node
// Trava de publicação (nexos://decision/memoria-nunca-sai-da-maquina): nenhum
// termo privado de quem publica no que o `npm pack` levaria. A lista é LOCAL,
// nunca versionada: $NEXOS_TERMOS_PRIVADOS ou ~/.nexos/termos-privados.txt,
// um termo por linha (# comenta). Sem lista, só o home de quem empacota é
// checado. A saída cita o número do termo, nunca o termo.
import { execFileSync } from "node:child_process";
import { existsSync, readFileSync, readdirSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const lista = process.env.NEXOS_TERMOS_PRIVADOS ?? path.join(os.homedir(), ".nexos", "termos-privados.txt");
const termos = existsSync(lista)
  ? readFileSync(lista, "utf8")
      .split("\n")
      .map((l) => l.trim())
      .filter((l) => l.length > 0 && !l.startsWith("#"))
  : [];
const user = os.userInfo().username;
termos.push(`/Users/${user}/`, `-Users-${user}`, `/home/${user}/`);

// `--dir <pasta>` varre a árvore inteira (export do repo público); sem ele, o
// que o `npm pack` levaria.
const iDir = process.argv.indexOf("--dir");
function arvore(dir) {
  return readdirSync(dir, { withFileTypes: true }).flatMap((e) => {
    if (e.name === ".git" || e.name === "node_modules") return [];
    const p = path.join(dir, e.name);
    return e.isDirectory() ? arvore(p) : e.isFile() ? [p] : [];
  });
}
const arquivos =
  iDir > -1
    ? arvore(process.argv[iDir + 1] ?? ".")
    : JSON.parse(execFileSync("npm", ["pack", "--dry-run", "--json", "--ignore-scripts"], { encoding: "utf8" }))[0].files.map(
        (f) => f.path
      );
const achados = [];
for (const arquivo of arquivos) {
  let texto;
  try {
    texto = readFileSync(arquivo, "utf8").toLowerCase();
  } catch {
    continue;
  }
  termos.forEach((termo, i) => {
    if (texto.includes(termo.toLowerCase())) achados.push(`${arquivo}: termo #${i + 1}`);
  });
}

if (achados.length > 0) {
  console.error(`termos privados no pacote (${achados.length}) — nada publicado:`);
  for (const a of achados) console.error(`  ${a}`);
  process.exit(1);
}
console.log(`termos privados: 0 em ${arquivos.length} arquivos (${termos.length} termos, lista ${existsSync(lista) ? "local" : "ausente"})`);
