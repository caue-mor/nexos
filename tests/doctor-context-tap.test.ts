/**
 * N2 (MEDIUM, revisão independente rodada 2) — `medirTapDeContexto`.
 *
 * O check de "Hooks" do doctor global só olha se o ARQUIVO do hook está
 * presente — nunca se o AVISO DE CONTEXTO de fato funciona. `{ node <tap> ||
 * cat; }` (fallback do MEDIUM #6, mesma rodada) troca falha VISÍVEL por
 * SILENCIOSA: com `node` ausente do PATH, a statusLine continua renderizando
 * (o `cat` repassa o payload cru) e o aviso de contexto (70%/85%) nunca dispara, sem sinal
 * nenhum — o mesmo tipo de silêncio que a decisão
 * nexos://decision/aviso-de-contexto-por-statusline existe para fechar.
 *
 *   RENDERIZA != AVISA
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { medirTapDeContexto } from "../src/lib/doctor/checks.js";
import { buildContextTapCommand } from "../src/lib/installer.js";

const REPO = path.resolve(__dirname, "..");
const TAP_REAL = path.join(REPO, "assets", "statusline", "nexos-context-tap.mjs");
const TMP = fs.realpathSync(os.tmpdir());

let statuslineDir: string;
let settingsPath: string;

/** Cadeia isolada: projeto e managed no tmp do teste, nunca os reais da máquina. */
function camadas(): { settingsPath: string; rootPath: string; managedSettingsPath: string } {
  return { settingsPath, rootPath: statuslineDir, managedSettingsPath: path.join(statuslineDir, "managed-settings.json") };
}

beforeEach(async () => {
  statuslineDir = await fs.mkdtemp(path.join(TMP, "doctor-tap-"));
  settingsPath = path.join(statuslineDir, "settings.json");
  // O que `nexos install` grava: o tap na frente de um renderer qualquer.
  await fs.writeJson(settingsPath, {
    statusLine: { type: "command", command: `${buildContextTapCommand(statuslineDir)} | node renderer.mjs` },
  });
});
afterEach(async () => {
  await fs.remove(statuslineDir);
});

/** Sonda deixada por uma chamada — usado para confirmar que a limpeza (finally) sempre roda. */
async function contarSondas(): Promise<number> {
  const dir = path.join(TMP, "nexos-context");
  if (!(await fs.pathExists(dir))) return 0;
  return (await fs.readdir(dir)).filter((f) => f.startsWith("nexos-doctor-probe-")).length;
}

describe("medirTapDeContexto", () => {
  it("tap não instalado → warn com o remédio, nunca fail", async () => {
    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.status).toBe("warn");
    expect(check.code).toBe("CONTEXT_TAP_NOT_INSTALLED");
    expect(check.message).toContain("nexos install");
  });

  it("tap instalado, ambiente normal → pass, amostra sintética gravada e depois apagada", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));

    const antes = await contarSondas();
    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.status).toBe("pass");
    expect(check.code).toBeUndefined();

    // A sonda nunca fica para trás — nem em sucesso, nem em falha (`finally`).
    expect(await contarSondas()).toBe(antes);
  });

  /**
   * A prova direta do achado: `node` ausente do PATH (binário removido, ou
   * PATH minimalista de um shell não-interativo) faz o `|| cat` do próprio
   * comando entrar em ação — a statusLine renderizaria normalmente (o `cat`
   * devolve o payload cru), mas NENHUMA amostra é gravada. Sem este check,
   * isso passava batido: warn não é fail, mas agora existe um SINAL.
   */
  it("tap instalado, PATH sem node (fallback `|| cat` entra em ação) → warn, nenhuma amostra gravada", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));

    const antes = await contarSondas();
    const semNode = { PATH: "/usr/bin:/bin", TMPDIR: process.env.TMPDIR ?? "" };
    const check = await medirTapDeContexto(statuslineDir, semNode, camadas());
    expect(check.status).toBe("warn");
    expect(check.code).toBe("CONTEXT_TAP_SAMPLE_MISSING");
    expect(check.message).toContain("NÃO vai disparar");
    // Diagnóstico com o que o shell disse, não palpite entre duas causas.
    expect(check.message).toMatch(/stderr: .*node/);
    expect(await contarSondas()).toBe(antes);
  });

  /**
   * Revisão independente da rodada 3 (HIGH): a PRÓPRIA sonda não pode derrubar
   * o doctor. Com `<tmpdir>/nexos-context` sendo arquivo (ENOTDIR) — ou de
   * outro usuário num `/tmp` compartilhado (EACCES) — a pré-limpeza lançava,
   * `commands/doctor.ts` não captura, e `nexos doctor` saía com stack crua e
   * ZERO checks impressos: um check quebrado apagava o relatório inteiro.
   */
  it("sonda que lança (nexos-context não é diretório) → warn com a causa, nunca exceção", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    const tmpQuebrado = await fs.mkdtemp(path.join(TMP, "doctor-tap-enotdir-"));
    await fs.writeFile(path.join(tmpQuebrado, "nexos-context"), "");
    const tmpOriginal = process.env.TMPDIR;
    process.env.TMPDIR = tmpQuebrado;
    try {
      const check = await medirTapDeContexto(statuslineDir, { ...process.env, TMPDIR: tmpQuebrado }, camadas());
      expect(check.status).toBe("warn");
      expect(check.code).toBe("CONTEXT_TAP_PROBE_FAILED");
      expect(check.message).toContain("ENOTDIR");
    } finally {
      if (tmpOriginal === undefined) delete process.env.TMPDIR;
      else process.env.TMPDIR = tmpOriginal;
      await fs.remove(tmpQuebrado);
    }
  });

  /**
   * Revisão da rodada 3 (MEDIUM): o check rodava o comando RECONSTRUÍDO e dava
   * pass sem olhar a statusLine que o host executa. Reescrita a statusLine, o
   * tap sai do pipeline e o aviso de contexto (70%/85%) morre calado com o doctor em pass.
   *
   *   COMANDO RECONSTRUÍDO != COMANDO INSTALADO
   */
  it("statusLine do settings.json sem o tap → warn, mesmo com o tap no disco", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    await fs.writeJson(settingsPath, { statusLine: { type: "command", command: "ccstatusline" } });

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.status).toBe("warn");
    expect(check.code).toBe("CONTEXT_TAP_NOT_WIRED");
    expect(check.message).toContain("nexos install");
    // Os limiares reais do hook (nexos-context-warn.sh), não um número inventado.
    expect(check.message).toContain("70%/85%");
  });

  /**
   * Verificador (MEDIUM): statusLine gravada ANTES do fallback `|| cat`
   * (`node "<tap>" | ...`) passa pelo tap e o aviso dispara. `nexos install`
   * migra essa forma (`installer.ts`, `projectStatusLineSettings`); o check
   * não pode chamá-la de desligada.
   */
  it("statusLine na forma antiga, sem `|| cat`, conta como ligada", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    const semFallback = buildContextTapCommand(statuslineDir).replace(/^\{ (.*) \|\| cat; \}$/, "$1");
    await fs.writeJson(settingsPath, { statusLine: { type: "command", command: `${semFallback} | node renderer.mjs` } });

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.code).not.toBe("CONTEXT_TAP_NOT_WIRED");
    expect(check.status).toBe("pass");
  });

  it("settings.json ausente → warn NOT_WIRED, nunca pass", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    await fs.remove(settingsPath);

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.status).toBe("warn");
    expect(check.code).toBe("CONTEXT_TAP_NOT_WIRED");
  });

  /**
   * Revisão silent-failure (HIGH): o host junta camadas de settings
   * (settings.md: managed > local > projeto > usuário) e desliga a statusLine
   * com disableAllHooks fora de managed (statusline.md, Troubleshooting). Ler
   * só o do usuário dava pass sem medir o que roda.
   */
  it("statusLine do projeto sem o tap vence a do usuário → NOT_WIRED, nomeando o arquivo", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    const doProjeto = path.join(statuslineDir, ".claude", "settings.local.json");
    await fs.outputJson(doProjeto, { statusLine: { type: "command", command: "ccstatusline" } });

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.code).toBe("CONTEXT_TAP_NOT_WIRED");
    expect(check.message).toContain(doProjeto);
  });

  it("disableAllHooks fora de managed desliga a statusLine → NOT_WIRED citando o motivo", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    await fs.outputJson(path.join(statuslineDir, ".claude", "settings.json"), { disableAllHooks: true });

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.code).toBe("CONTEXT_TAP_NOT_WIRED");
    expect(check.message).toContain("disableAllHooks");
  });

  it("allowManagedHooksOnly nas managed sem statusLine managed → NOT_WIRED", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    await fs.outputJson(camadas().managedSettingsPath, { allowManagedHooksOnly: true });

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.code).toBe("CONTEXT_TAP_NOT_WIRED");
    expect(check.message).toContain("allowManagedHooksOnly");
  });

  /** Revisão silent-failure (MEDIUM): settings ilegível virava "rode nexos install", que não conserta JSON quebrado. */
  it("settings.json com JSON inválido → warn com a causa, nunca 'rode nexos install'", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    await fs.writeFile(settingsPath, "{ quebrado");

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.code).toBe("CONTEXT_TAP_SETTINGS_UNREADABLE");
    expect(check.message).toContain(settingsPath);
  });

  /**
   * Verificador (HIGH): settings-reference.md, "Off entirely" — disableAllHooks
   * nas MANAGED desliga a statusLine por inteiro, até a managed. O resolvedor
   * só olhava disableAllHooks fora de managed e dava pass com o tap no usuário.
   */
  it("disableAllHooks nas managed desliga a statusLine inteira → NOT_WIRED, mesmo com o tap no usuário", async () => {
    await fs.copy(TAP_REAL, path.join(statuslineDir, "nexos-context-tap.mjs"));
    await fs.outputJson(camadas().managedSettingsPath, { disableAllHooks: true });

    const check = await medirTapDeContexto(statuslineDir, process.env, camadas());
    expect(check.code).toBe("CONTEXT_TAP_NOT_WIRED");
    expect(check.message).toContain("desliga a statusLine por inteiro");
  });
});
