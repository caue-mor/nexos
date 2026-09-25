/**
 * HOST MEMORY AUTHORITY — a cadeia de precedência real (D5, casos 5 e 6).
 *
 *   NAIVE CHECK != EFFECTIVE VALUE
 *
 * `managed` e `user` (`~/.claude/settings.json` real da máquina) não são
 * testados aqui: `CLAUDE_DIR` é resolvido de `constants.ts` na importação do
 * módulo, antes de qualquer `beforeEach` poder isolar `HOME` — escrever no
 * `~/.claude/settings.json` REAL do executor, ou no path de sistema do
 * managed-settings, não é o que um teste unitário deveria tocar. Todo teste
 * aqui fixa `project`/`local` explicitamente, então nunca cai nessas duas
 * camadas — hermético por construção, não por acaso.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { resolveEffectiveAutoMemory } from "../src/lib/host/memory-authority.js";

let ws: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "mauth-"));
});
afterEach(async () => {
  await fs.remove(ws);
});

async function writeSettings(rel: string, content: Record<string, unknown>): Promise<void> {
  const p = path.join(ws, rel);
  await fs.ensureDir(path.dirname(p));
  await fs.writeJson(p, content);
}

describe("resolveEffectiveAutoMemory · precedência real do host", () => {
  it("project decide quando não há local", async () => {
    await writeSettings(".claude/settings.json", { autoMemoryEnabled: false });
    expect(await resolveEffectiveAutoMemory(ws)).toEqual({ enabled: false, source: "project" });
  });

  it("caso 5 · local vence project — a armadilha de precedência PRECISA disparar", async () => {
    await writeSettings(".claude/settings.json", { autoMemoryEnabled: false });
    await writeSettings(".claude/settings.local.json", { autoMemoryEnabled: true });

    expect(await resolveEffectiveAutoMemory(ws)).toEqual({ enabled: true, source: "local" });
  });

  it("arquivo ilegível não decide — cai para a próxima camada da cadeia", async () => {
    const local = path.join(ws, ".claude", "settings.local.json");
    await fs.ensureDir(path.dirname(local));
    await fs.writeFile(local, "{{{ não fecha");
    await writeSettings(".claude/settings.json", { autoMemoryEnabled: false });

    expect(await resolveEffectiveAutoMemory(ws)).toEqual({ enabled: false, source: "project" });
  });
});

/**
 * D11 · o tier `managed` ficava UNPROVEN — provar precedência e remediação
 * exigiria escrever em `/Library/Application Support/ClaudeCode/managed-settings.json`,
 * um path real de máquina inteira que nenhum teste pode tocar. `managedSettingsPath`
 * agora é injetável (mesmo formato do antigo `MemoryAuthorityLoader`, removido de
 * `bootstrap-context.ts`): produção nunca passa a opção — só o teste, contra
 * um arquivo dentro de `ws`. Zero escrita fora do tmpdir do teste.
 */
describe("managed tier · injetável para teste, path real do sistema JAMAIS tocado", () => {
  it("managed vence TUDO — local e project dizem false, managed diz true", async () => {
    const managedPath = path.join(ws, "managed-settings.json");
    await fs.writeJson(managedPath, { autoMemoryEnabled: true });
    await writeSettings(".claude/settings.json", { autoMemoryEnabled: false });
    await writeSettings(".claude/settings.local.json", { autoMemoryEnabled: false });

    const effective = await resolveEffectiveAutoMemory(ws, { managedSettingsPath: managedPath });
    expect(effective).toEqual({ enabled: true, source: "managed" });
  });

  it("managed ausente (arquivo não existe no path injetado) cai para a próxima camada normalmente", async () => {
    const managedPath = path.join(ws, "managed-nao-existe.json");
    await writeSettings(".claude/settings.json", { autoMemoryEnabled: false });

    const effective = await resolveEffectiveAutoMemory(ws, { managedSettingsPath: managedPath });
    expect(effective).toEqual({ enabled: false, source: "project" });
  });
});

/**
 * P1.3i (B9, direção §7/§9) — `checkHostMemoryAuthority`,
 * `describeAutoMemoryRemediation` e os blocos que os testavam ("o check tem
 * de poder ficar vermelho", "fixable por tier", "laço mecânico") foram
 * RETIRADOS junto com a função de produção. Auto Memory ligado nunca foi um
 * `HOST_MEMORY_AUTHORITY_CONFLICT` a corrigir — é o comportamento padrão do
 * host — e `nexos project --local --execute` (a remediação que esses testes
 * mediam byte a byte) nunca existiu como comando real no CLI (`index.ts` não
 * registra `project`). `resolveEffectiveAutoMemory` — a cadeia de
 * precedência em si, que ESTES testes continuam cobrindo acima — é tudo que
 * sobrevive: ainda é a fonte correta para uma linha informativa
 * (`doctor.ts`/`boot.ts`), só sem o "conflito" e sem o "remédio".
 */
