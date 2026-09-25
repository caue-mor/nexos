/**
 * `assets/hooks/nexos-binding.sh` — a autoridade única de identidade
 * de projeto compartilhada pelos hooks que ainda escrevem no disco do
 * projeto (`nexos-memory-capture.sh`, `nexos-precompact-save.sh`).
 * `nexos-binding.js` (a gêmea JS) saiu com os hooks JS que a consumiam por
 * inteiro (nexos://decision/p1-0-remover-authorization-layer, P1.0b) — os
 * testes dela saíram junto.
 *
 * Duas garantias testadas aqui, nomeadas explicitamente na task:
 *
 *   1. MARKER GLOBAL != CHAVE DE CACHE — o binding e por SESSAO
 *      (`$HOME/.nexos/sessions/<session_id>.binding`), nao um arquivo global
 *      compartilhado (o defeito original: `/tmp/nexos-project-detected`).
 *      Duas sessoes ligadas a dois projetos diferentes nunca leem o binding
 *      uma da outra.
 *
 *   2. SESSION PROJECT IDENTITY != CURRENT PROCESS CWD — uma vez que a sessao
 *      vinculou a um projeto, um `cd` para uma SUBPASTA do mesmo projeto tem
 *      de devolver a MESMA raiz (estavel, nao recalculada do zero a cada
 *      chamada — o defeito que o `sha1(process.cwd())`/`git remote` antigos
 *      tinham). Um `cd` para um projeto REALMENTE diferente, com a MESMA
 *      sessao, tem de divergir (MISMATCH bash / null JS) — nunca escolher A
 *      ou B silenciosamente.
 *
 * Mais o guard fisico de $HOME (RC symlink, `/var` vs `/private/var` no
 * macOS) que o merge de nexos-session-init.sh preservou DENTRO do binding —
 * testado direto aqui nas duas linguagens, nao so indireto via CF-7 do hook.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import crypto from "node:crypto";
import { spawnSync, execFileSync } from "node:child_process";

const BINDING_SH = path.resolve(__dirname, "../assets/hooks/nexos-binding.sh");
const TMP_BASE = fs.realpathSync(os.tmpdir());

async function makeProject(marker: string): Promise<string> {
  const root = await fs.mkdtemp(path.join(TMP_BASE, `nb-${marker}-`));
  await fs.ensureDir(path.join(root, ".nexos"));
  return root;
}

/** `.nexos/manifest.yaml` com `project.id` — MESMA chave que `_nexos_project_id` (bash) e `manifestProjectId` (js) leem. */
async function writeManifest(root: string, projectId: string): Promise<void> {
  await fs.ensureDir(path.join(root, ".nexos"));
  await fs.writeFile(
    path.join(root, ".nexos", "manifest.yaml"),
    `schema_version: 1\nproject:\n  id: ${projectId}\n  name: fixture\ncapsule:\n  format_version: 1\n`
  );
}

/**
 * Escreve o CONTEÚDO literal de `manifest.yaml` — usada pelos casos A11-A14b
 * abaixo, onde o texto precisa ser exatamente o fixture medido (mesmo texto
 * de `tests/capsule-acceptance.test.ts`, describe "F"), não um id válido
 * dentro do template de `writeManifest`.
 */
async function writeManifestRaw(root: string, yaml: string): Promise<void> {
  await fs.ensureDir(path.join(root, ".nexos"));
  await fs.writeFile(path.join(root, ".nexos", "manifest.yaml"), yaml);
}

/**
 * Roda `nexos_binding_resolve` de verdade num processo bash isolado (HOME
 * proprio => `NEXOS_BINDING_DIR` cai num tmpdir, nunca no `~/.nexos/sessions`
 * real). Payload vai por argumento posicional (`$1`), nunca interpolado no
 * corpo do script — evita qualquer escaping de aspas do JSON.
 */
const RESOLVE_HARNESS = `
source "${BINDING_SH}"
nexos_binding_resolve "$1"
rc=$?
printf 'RC=%s\\n' "$rc"
printf 'ROOT=%s\\n' "\${NEXOS_PROJECT_ROOT:-}"
printf 'ID=%s\\n' "\${NEXOS_PROJECT_ID:-}"
printf 'SRC=%s\\n' "\${NEXOS_BINDING_SOURCE:-}"
printf 'MISMATCH_BOUND=%s\\n' "\${NEXOS_BINDING_MISMATCH_BOUND:-}"
printf 'MISMATCH_OBSERVED=%s\\n' "\${NEXOS_BINDING_MISMATCH_OBSERVED:-}"
`;

function parseKV(stdout: string): Record<string, string> {
  const out: Record<string, string> = {};
  for (const line of stdout.split("\n")) {
    const i = line.indexOf("=");
    if (i === -1) continue;
    out[line.slice(0, i)] = line.slice(i + 1);
  }
  return out;
}

function runBindingResolve(sessionId: string, cwd: string, home: string) {
  const payload = JSON.stringify({ session_id: sessionId, cwd });
  const r = spawnSync("bash", ["-c", RESOLVE_HARNESS, "harness", payload], {
    encoding: "utf-8",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  if (r.status === null) throw new Error(`harness crashou: ${r.stderr}`);
  return parseKV(r.stdout);
}

function bindingFile(home: string, sessionId: string): string {
  return path.join(home, ".nexos", "sessions", `${sessionId}.binding`);
}

const WALK_HARNESS = `
source "${BINDING_SH}"
out=$(_nexos_walk_to_capsule "$1")
rc=$?
printf 'RC=%s\\n' "$rc"
printf 'OUT=%s\\n' "$out"
`;

/** Roda `_nexos_walk_to_capsule` isolado, sem passar por `nexos_binding_resolve`. */
function runWalkToCapsule(cwd: string, home: string) {
  const r = spawnSync("bash", ["-c", WALK_HARNESS, "harness", cwd], {
    encoding: "utf-8",
    env: { HOME: home, PATH: "/usr/bin:/bin" },
  });
  if (r.status === null) throw new Error(`harness crashou: ${r.stderr}`);
  return parseKV(r.stdout);
}

describe("nexos-binding.sh — _nexos_walk_to_capsule, fronteira de repositório aninhado, F1", () => {
  it("a · subdiretório do MESMO repo continua resolvendo para a raiz", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
    const root = await makeProject("walk-boundary-a");
    execFileSync("git", ["init", "-q"], { cwd: root });
    const deep = path.join(root, "src", "deep", "path");
    await fs.ensureDir(deep);

    const r = runWalkToCapsule(deep, home);
    expect(r.RC).toBe("0");
    expect(r.OUT).toBe(root);

    await fs.remove(home);
    await fs.remove(root);
  });

  it("b · repo `.git` aninhado NUNCA herda a Capsule do ancestral", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
    const ancestor = await makeProject("walk-boundary-b-ancestor");
    execFileSync("git", ["init", "-q"], { cwd: ancestor });
    const nestedRoot = path.join(ancestor, "vendor", "nested-repo");
    await fs.ensureDir(nestedRoot);
    execFileSync("git", ["init", "-q"], { cwd: nestedRoot });
    const deep = path.join(nestedRoot, "src", "deep");
    await fs.ensureDir(deep);

    const atNestedRoot = runWalkToCapsule(nestedRoot, home);
    expect(atNestedRoot.RC).toBe("1"); // sem .nexos própria: fail closed, nunca sobe para o ancestor

    const fromDeep = runWalkToCapsule(deep, home);
    expect(fromDeep.RC).toBe("1");

    await fs.remove(home);
    await fs.remove(ancestor);
  });
});

describe("nexos-binding.sh — nexos_binding_resolve", () => {
  it("binding e por sessao, nao um marker global — duas sessoes/projetos nunca se leem", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
    const projA = await makeProject("leak-a");
    const projB = await makeProject("leak-b");
    const sidA = crypto.randomUUID();
    const sidB = crypto.randomUUID();

    const ra = runBindingResolve(sidA, projA, home);
    const rb = runBindingResolve(sidB, projB, home);

    expect(ra.RC).toBe("0");
    expect(ra.ROOT).toBe(projA);
    expect(rb.RC).toBe("0");
    expect(rb.ROOT).toBe(projB);

    // Dois arquivos SEPARADOS, um por sessao — nunca um marker unico.
    const fileA = await fs.readFile(bindingFile(home, sidA), "utf-8");
    const fileB = await fs.readFile(bindingFile(home, sidB), "utf-8");
    expect(fileA.split("\n")[0]).toBe(projA);
    expect(fileB.split("\n")[0]).toBe(projB);
    expect(fileA).not.toContain(projB);
    expect(fileB).not.toContain(projA);

    await fs.remove(home);
    await fs.remove(projA);
    await fs.remove(projB);
  });

  it("payload-derived session id estavel atraves de um cd para subpasta do MESMO projeto", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
    const projRoot = await makeProject("stable");
    const subdir = path.join(projRoot, "src", "deep");
    await fs.ensureDir(subdir);
    const sid = crypto.randomUUID();

    const primeira = runBindingResolve(sid, projRoot, home);
    expect(primeira.RC).toBe("0");
    expect(primeira.ROOT).toBe(projRoot);
    expect(primeira.SRC).toBe("HOOK_PAYLOAD_CWD_AT_BIND");

    const mtimeAntes = (await fs.stat(bindingFile(home, sid))).mtimeMs;

    // MESMA sessao, cwd numa subpasta — nunca recalcula do zero, so confirma
    // que o observado ainda pertence a raiz ja vinculada.
    const segunda = runBindingResolve(sid, subdir, home);
    expect(segunda.RC).toBe("0");
    expect(segunda.ROOT).toBe(projRoot);

    // Estavel de verdade: o arquivo de binding nao foi reescrito.
    const mtimeDepois = (await fs.stat(bindingFile(home, sid))).mtimeMs;
    expect(mtimeDepois).toBe(mtimeAntes);

    await fs.remove(home);
    await fs.remove(projRoot);
  });

  it("MESMA sessao, cwd de projeto REALMENTE diferente -> MISMATCH, zero contexto; nunca escolhe A nem B", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
    const projA = await makeProject("mismatch-a");
    const projB = await makeProject("mismatch-b");
    const sid = crypto.randomUUID();

    const primeira = runBindingResolve(sid, projA, home);
    expect(primeira.RC).toBe("0");
    expect(primeira.ROOT).toBe(projA);

    const segunda = runBindingResolve(sid, projB, home);
    expect(segunda.RC).toBe("2");
    expect(segunda.MISMATCH_BOUND).toBe(projA);
    expect(segunda.MISMATCH_OBSERVED).toBe(projB);
    // Nenhum dos dois lados vaza como resolvido.
    expect(segunda.ROOT).toBe("");

    // O binding em disco continua apontando para A — a divergencia nao
    // rebinda silenciosamente para B.
    const fileContent = await fs.readFile(bindingFile(home, sid), "utf-8");
    expect(fileContent.split("\n")[0]).toBe(projA);

    await fs.remove(home);
    await fs.remove(projA);
    await fs.remove(projB);
  });

  it("HOME alcancado por symlink nunca vira raiz de projeto, guard fisico, direto em _nexos_walk_to_capsule", async () => {
    const alvo = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-symlink-"));
    await fs.ensureDir(path.join(alvo, ".nexos"));
    const parent = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-parent-"));
    const viaSymlink = path.join(parent, "home-via-symlink");
    await fs.symlink(alvo, viaSymlink);

    const r = runBindingResolve(crypto.randomUUID(), viaSymlink, viaSymlink);
    expect(r.RC).toBe("1"); // NO_PROJECT: $HOME (mesmo via symlink) nunca conta.

    await fs.remove(alvo);
    await fs.remove(parent);
  });

  describe("G-BINDING — mismatch exige project_id canônico DIFERENTE, não raiz física diferente", () => {
    it("positivo — worktree do MESMO projeto canônico, raiz física diferente, MESMO project.id -> SEM mismatch, contexto da raiz vinculada", async () => {
      const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
      const canonicalRoot = await makeProject("worktree-canonical");
      const worktreeRoot = await makeProject("worktree-copy");
      const sid = crypto.randomUUID();
      await writeManifest(canonicalRoot, "prj_01M008F1FQWJSY1HP82RAZ9ZXG");
      await writeManifest(worktreeRoot, "prj_01M008F1FQWJSY1HP82RAZ9ZXG"); // mesmo project.id, manifest tracked identico entre worktrees

      const primeira = runBindingResolve(sid, canonicalRoot, home);
      expect(primeira.RC).toBe("0");
      expect(primeira.ROOT).toBe(canonicalRoot);

      const segunda = runBindingResolve(sid, worktreeRoot, home);
      expect(segunda.RC).toBe("0"); // sem mismatch
      expect(segunda.ID).toBe("prj_01M008F1FQWJSY1HP82RAZ9ZXG");
      // Sem rebind silencioso: a sessão continua servida pela raiz ORIGINALMENTE vinculada.
      expect(segunda.ROOT).toBe(canonicalRoot);
      expect(segunda.MISMATCH_BOUND).toBe("");
      expect(segunda.MISMATCH_OBSERVED).toBe("");

      await fs.remove(home);
      await fs.remove(canonicalRoot);
      await fs.remove(worktreeRoot);
    });

    it("negativo — dois projetos canônicos DIFERENTES, manifest próprio, project_id distinto -> MISMATCH mantido, mensagem preservada", async () => {
      const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
      const projA = await makeProject("canonical-diff-a");
      const projB = await makeProject("canonical-diff-b");
      const sid = crypto.randomUUID();
      await writeManifest(projA, "prj_AAAAAAAAAAAAAAAAAAAAAAAAAA");
      await writeManifest(projB, "prj_BBBBBBBBBBBBBBBBBBBBBBBBBB");

      const primeira = runBindingResolve(sid, projA, home);
      expect(primeira.RC).toBe("0");

      const segunda = runBindingResolve(sid, projB, home);
      expect(segunda.RC).toBe("2");
      expect(segunda.MISMATCH_BOUND).toBe(projA);
      expect(segunda.MISMATCH_OBSERVED).toBe(projB);
      expect(segunda.ROOT).toBe("");

      await fs.remove(home);
      await fs.remove(projA);
      await fs.remove(projB);
    });

    it("negativo — lado observado INDETERMINÁVEL, sem manifest, só fallback de caminho -> fail-closed, MISMATCH mantido mesmo com bound confiável", async () => {
      const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-"));
      const confiavel = await makeProject("indeterminate-bound");
      const semManifest = await makeProject("indeterminate-observed"); // .nexos/ sem manifest.yaml -> fallback prj_path_*
      const sid = crypto.randomUUID();
      await writeManifest(confiavel, "prj_01M008F1FQWJSY1HP82RAZ9ZXG");

      const primeira = runBindingResolve(sid, confiavel, home);
      expect(primeira.RC).toBe("0");
      expect(primeira.ID).toBe("prj_01M008F1FQWJSY1HP82RAZ9ZXG");

      const segunda = runBindingResolve(sid, semManifest, home);
      expect(segunda.RC).toBe("2"); // indeterminável nunca vira equivalência por heurística de caminho
      expect(segunda.MISMATCH_BOUND).toBe(confiavel);
      expect(segunda.MISMATCH_OBSERVED).toBe(semManifest);

      await fs.remove(home);
      await fs.remove(confiavel);
      await fs.remove(semManifest);
    });
  });
});

describe("nexos-binding.sh — _nexos_project_id nunca mais permissivo que a autoridade, A11-A14b", () => {
  /**
   * Mesmos fixtures medidos em `tests/capsule-acceptance.test.ts` (describe
   * "F · Manifest V1 lido com schema real"), agora do lado do HOOK: cada
   * caso escreve o manifest MALFORMADO no lado OBSERVADO, contra um lado
   * vinculado TRUSTED com manifest canônico válido. Prova que
   * `_nexos_project_id` nunca trata a forma malformada como id confiável —
   * o MISMATCH da divergence guard (RC=2) é mantido em todos os casos, nunca
   * vira equivalência por acidente de extração.
   */
  async function assertObservedUntrustedKeepsMismatch(
    home: string,
    manifestMalformado: string
  ): Promise<void> {
    const confiavel = await makeProject("identity-bound-trusted");
    const observado = await makeProject("identity-observed-untrusted");
    const sid = crypto.randomUUID();
    await writeManifest(confiavel, "prj_01M008F1FQWJSY1HP82RAZ9ZXG");
    await writeManifestRaw(observado, manifestMalformado);

    const primeira = runBindingResolve(sid, confiavel, home);
    expect(primeira.RC).toBe("0");
    expect(primeira.ID).toBe("prj_01M008F1FQWJSY1HP82RAZ9ZXG");

    const segunda = runBindingResolve(sid, observado, home);
    expect(segunda.RC).toBe("2"); // nunca confiável -> mismatch mantido
    expect(segunda.MISMATCH_BOUND).toBe(confiavel);
    expect(segunda.MISMATCH_OBSERVED).toBe(observado);

    await fs.remove(confiavel);
    await fs.remove(observado);
  }

  it("A11 · bootstrap locator prj_<12 hex> como project.id -> nao confiavel", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-id-a11-"));
    await assertObservedUntrustedKeepsMismatch(
      home,
      "schema_version: 1\nproject:\n  id: prj_a13f52c91d00\n  name: falso\ncapsule:\n  format_version: 1\n"
    );
    await fs.remove(home);
  });

  it("A12 · schema_version diferente de 1 -> id do manifest nao confiavel, mesmo sendo canonico", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-id-a12-"));
    await assertObservedUntrustedKeepsMismatch(
      home,
      "schema_version: 2\nproject:\n  id: prj_01J8ZQ9WXYZABCDEFGHJKMNPQR\n  name: futuro\ncapsule:\n  format_version: 1\n"
    );
    await fs.remove(home);
  });

  it("A13 · capsule.format_version diferente de 1 -> id do manifest nao confiavel", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-id-a13-"));
    await assertObservedUntrustedKeepsMismatch(
      home,
      "schema_version: 1\nproject:\n  id: prj_01J8ZQ9WXYZABCDEFGHJKMNPQR\n  name: futuro\ncapsule:\n  format_version: 9\n"
    );
    await fs.remove(home);
  });

  it("A14 · flow mapping e YAML valido mas este extrator nao le com confianca -> nao confiavel, mais restritivo que a autoridade por contrato", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-id-a14-"));
    await assertObservedUntrustedKeepsMismatch(
      home,
      'schema_version: 1\ncapsule: {format_version: 1}\nproject: {id: "prj_01J8ZQ9WXYZABCDEFGHJKMNPQR", name: \'flow style\'}\n'
    );
    await fs.remove(home);
  });

  it("A14b · YAML quebrado sob project.id -> nao confiavel, nunca devolve fragmento tipo colchete-nao-fechado", async () => {
    const home = await fs.mkdtemp(path.join(TMP_BASE, "nb-home-id-a14b-"));
    await assertObservedUntrustedKeepsMismatch(
      home,
      "schema_version: 1\ncapsule:\n  format_version: 1\nproject:\n  id: [nao\n fechado: :\n"
    );
    await fs.remove(home);
  });
});
