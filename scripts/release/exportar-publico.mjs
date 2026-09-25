#!/usr/bin/env node
// Monta o repositório PÚBLICO do NexOS (nexos://decision/publicacao-repo-publico-limpo):
// foto do HEAD com 1 commit e sem histórico — o histórico privado tem memória
// (.nexos/records) e docs internos. Só entra o que está em INCLUIR, menos
// PRIVADO. Varre segredo e termo privado ANTES do commit. Não publica nada:
// sem remote, sem push.
//
//   node scripts/release/exportar-publico.mjs [destino]          repo novo, 1 commit
//   node scripts/release/exportar-publico.mjs --sobre <clone>    commit novo por cima
//                                                                 de um clone do público
//
// Autor do commit: passe GIT_AUTHOR_NAME/EMAIL e GIT_COMMITTER_NAME/EMAIL com o
// email noreply (decisão repo-publico-caue-mor-nexos) — nunca o email real.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readdirSync, rmSync } from "node:fs";
import os from "node:os";
import path from "node:path";

const INCLUIR = [
  "src", "bin", "assets", "console", "scripts", "tests", ".github/workflows",
  "README.md", "LICENSE", "CHANGELOG.md", "SECURITY.md", ".github/dependabot.yml", "agent.yaml",
  "package.json", "package-lock.json", "tsconfig.json", "tsconfig.check.json", "tsconfig.scripts.json",
  "vitest.config.ts", ".gitignore", ".gitattributes", ".npmignore",
];
// Memória e inventário da máquina de quem desenvolve: nunca no público. Os
// testes listados só existem para a migração do formato monolítico antigo e
// leem essas fixtures.
const PRIVADO = [
  "tests/fixtures/decisions-monolith.md",
  "tests/fixtures/gotchas-monolith.md",
  "tests/fixtures/host-surface-resolver/pre-cutover-evidence.json",
  "tests/adr-overrides.test.ts",
  "tests/capsule-gotcha-accounting.test.ts",
  "tests/capsule-gotcha-migrator.test.ts",
  "tests/capsule-gotcha-parser.test.ts",
  "tests/capsule-gotcha-rehearsal.test.ts",
  "tests/capsule-gotcha-split.test.ts",
];

const repo = execFileSync("git", ["rev-parse", "--show-toplevel"], { encoding: "utf8" }).trim();
const sha = execFileSync("git", ["-C", repo, "rev-parse", "--short", "HEAD"], { encoding: "utf8" }).trim();
const versao = JSON.parse(execFileSync("git", ["-C", repo, "show", "HEAD:package.json"], { encoding: "utf8" })).version;
const tar = execFileSync(
  "git",
  ["-C", repo, "archive", "--format=tar", "HEAD", "--", ...INCLUIR, ...PRIVADO.map((p) => `:(exclude)${p}`)],
  { maxBuffer: 1 << 30 }
);
const varrer = (dir) => {
  const rodar = (args) => execFileSync("node", args, { cwd: dir, encoding: "utf8", stdio: ["ignore", "pipe", "inherit"] }).trim();
  console.log(rodar([path.join(repo, "scripts", "scan-secrets.mjs")]));
  console.log(rodar([path.join(repo, "scripts", "scan-termos-privados.mjs"), "--dir", "."]));
};

// ── --sobre <clone>: a release vira UM commit novo no histórico público existente.
// As varreduras rodam numa pasta temporária ANTES de tocar o clone: falha = clone intacto.
if (process.argv[2] === "--sobre") {
  const clone = path.resolve(process.argv[3] ?? "");
  const git = (...args) => execFileSync("git", ["-C", clone, ...args], { encoding: "utf8" }).trim();
  if (!existsSync(path.join(clone, ".git"))) {
    console.error(`não é um clone git: ${clone}`);
    process.exit(1);
  }
  if (git("status", "--porcelain") !== "") {
    console.error(`clone com mudança não commitada: ${clone}`);
    process.exit(1);
  }
  const staging = mkdtempSync(path.join(os.tmpdir(), "nexos-publico-"));
  try {
    execFileSync("tar", ["-x", "-C", staging], { input: tar });
    varrer(staging);
  } finally {
    rmSync(staging, { recursive: true, force: true });
  }
  const antes = git("rev-parse", "--short", "HEAD");
  git("rm", "-rq", "--ignore-unmatch", "--", ".");
  execFileSync("tar", ["-x", "-C", clone], { input: tar });
  git("add", "-A");
  if (git("status", "--porcelain") === "") {
    console.log(`nada mudou em relação a ${antes} — nenhum commit`);
    process.exit(0);
  }
  git("commit", "-q", "-m", `NexOS ${versao}`);
  console.log(`commit ${git("rev-parse", "--short", "HEAD")} "NexOS ${versao}" sobre ${antes} em ${clone} (foto de ${sha}), sem push`);
  process.exit(0);
}

const destino = path.resolve(process.argv[2] ?? path.join(os.homedir(), "NEXOS", "releases", `nexos-cli-publico-${sha}`));

if (existsSync(destino) && readdirSync(destino).length > 0) {
  console.error(`destino não está vazio: ${destino}`);
  process.exit(1);
}
mkdirSync(destino, { recursive: true });

execFileSync("tar", ["-x", "-C", destino], { input: tar });

// Varreduras no que vai sair, com cwd no destino. Falha = nada é commitado.
varrer(destino);

execFileSync("git", ["init", "-q", destino]);
execFileSync("git", ["-C", destino, "add", "-A"]);
execFileSync("git", ["-C", destino, "commit", "-q", "-m", `NexOS ${versao}`]);
const arquivos = execFileSync("git", ["-C", destino, "ls-files"], { encoding: "utf8" }).split("\n").filter(Boolean).length;
console.log(`repo público montado em ${destino}: ${arquivos} arquivos, 1 commit (foto de ${sha}), sem remote`);
