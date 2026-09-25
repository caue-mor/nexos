/**
 * PLUGIN REGISTRADO COM DIRETÓRIO AUSENTE.
 *
 *   INSTALLPATH DECLARADO != INSTALLPATH EXISTE
 *
 * MEDIDO em 2026-09-22 no host real: SETE plugins de `installed_plugins.json`
 * apontavam para diretório inexistente — dois ligados na mesma sessão só por
 * escrita em `enabledPlugins` (o download nunca rodou) e cinco antigos com
 * versão `unknown`. Todos apareciam `health=connected` no catálogo,
 * contribuindo zero skill, zero agente e zero comando.
 *
 * Cinco camadas afirmavam "instalado e ligado" sobre arquivo ausente:
 * `enabledPlugins`, `installed_plugins.json`, `claude plugin list` (`✔
 * enabled`), o `health` deste catálogo, e o silêncio de não haver nenhum aviso.
 *
 * `connected` sobre arquivo ausente é a mentira mais cara que um catálogo pode
 * contar — é exatamente a pergunta que ele existe para responder. Mesmo defeito
 * que o detector de referência quebrada tinha: confiar na DECLARAÇÃO em vez de
 * conferir o disco.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { scanAll } from "../src/lib/capabilities/scan.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;
let claudeDir: string;

const SKILL_MD = (name: string, d: string) => `---\nname: ${name}\ndescription: ${d}\n---\n\nCorpo.\n`;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "cap-path-"));
  claudeDir = path.join(ws, ".claude");
  const presente = path.join(claudeDir, "plugins", "cache", "market", "presente", "1.0.0");
  const ausente = path.join(claudeDir, "plugins", "cache", "market", "ausente", "1.0.0");

  /** Só o PRESENTE ganha arquivos; o AUSENTE existe apenas no registro. */
  await fs.ensureDir(path.join(presente, "skills", "uma-skill"));
  await fs.outputFile(
    path.join(presente, "skills", "uma-skill", "SKILL.md"),
    SKILL_MD("uma-skill", "Skill do plugin que realmente foi baixado.")
  );

  await fs.outputJson(path.join(claudeDir, "plugins", "installed_plugins.json"), {
    version: 2,
    plugins: {
      "presente@market": [{ scope: "user", installPath: presente, version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" }],
      "ausente@market": [{ scope: "user", installPath: ausente, version: "1.0.0", installedAt: "2026-01-01T00:00:00.000Z" }],
    },
  });
  /** Os DOIS ligados: é o estado que produziu o defeito no host real. */
  await fs.outputJson(path.join(claudeDir, "settings.json"), {
    enabledPlugins: { "presente@market": true, "ausente@market": true },
  });
});

afterEach(async () => {
  await fs.remove(ws);
});

const scan = () => scanAll(ws, { claudeDir, homeDir: ws, pathEnv: "", pathSep: ":" });

describe("plugin cujo installPath não existe no disco", () => {
  it("NÃO é reportado como connected, mesmo ligado e registrado", async () => {
    const { items } = await scan();
    const ausente = items.find((i) => i.kind === "plugin" && i.plugin_id === "ausente@market");
    expect(ausente, "o plugin registrado tem de continuar visível no inventário").toBeDefined();
    expect(ausente!.enabled, "o registro diz ligado — e é essa afirmação que não pode virar `connected`").toBe(true);
    expect(ausente!.health).not.toBe("connected");
  });

  it("CONTROLE: o plugin cujos arquivos existem continua connected", async () => {
    const { items } = await scan();
    const presente = items.find((i) => i.kind === "plugin" && i.plugin_id === "presente@market");
    expect(presente!.health).toBe("connected");
  });

  it("não inventa skill de um diretório que não existe", async () => {
    const { items } = await scan();
    const doAusente = items.filter((i) => i.plugin_id === "ausente@market" && i.kind !== "plugin");
    expect(doAusente, "plugin sem arquivos não pode contribuir componente nenhum").toEqual([]);
  });

  it("CONTROLE: o plugin presente contribui a skill dele", async () => {
    const { items } = await scan();
    const skills = items.filter((i) => i.plugin_id === "presente@market" && i.kind === "skill");
    expect(skills.length, "sem isto o teste acima passaria com um scanner que não lê nada").toBeGreaterThan(0);
  });

  it("o diretório ausente vira ACHADO nomeado, nunca silêncio", async () => {
    const { issues } = await scan();
    const achado = issues.find((i) => i.code === "PLUGIN_INSTALL_PATH_ABSENT");
    expect(achado, "ausência sem aviso é o defeito original com outro nome").toBeDefined();
    expect(achado!.detail).toContain("ausente@market");
  });
});
