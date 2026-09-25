/**
 * Os assets do NexOS em `~/.claude` são de uma versão anterior à do pacote que
 * está rodando?
 *
 *   INSTALLED CODE != INSTALLED ASSETS
 *
 * São duas instalações independentes e nada as sincroniza: o pacote npm traz o
 * CÓDIGO, e `nexos install` projeta os ASSETS (agents, skills, rules, hooks).
 * Atualizar o pacote não atualiza os assets — quem não roda `install` fica com
 * agente e skill de uma versão antiga enquanto o CLI é novo, e nada avisa.
 *
 * MEDIDO em 2026-09-18 nesta máquina: `.nexos-version` dizia 6.5.1 com o
 * pacote em 6.5.2, e o único jeito de saber era digitar `nexos doctor
 * --project`. Quem abre o Claude Code e trabalha nunca via.
 *
 * Barato de propósito: uma leitura de JSON pequeno, sem varrer `~/.claude` e
 * sem hash de árvore. `doctor --project` custa ~1s medido, o que é 37% do teto
 * de 2700ms do SessionStart — este predicado é a fatia que cabe no orçamento.
 * `null` significa "nada a dizer", nunca "não consegui olhar": marcador
 * ausente é instalação que nunca rodou, e isso é assunto de `install`, não
 * deste aviso.
 */
import fs from "fs-extra";
import { NEXOS_MARKER, getVersion } from "../constants.js";

export interface AssetDrift {
  readonly installed: string;
  readonly packaged: string;
}

export async function detectAssetDrift(markerPath: string = NEXOS_MARKER): Promise<AssetDrift | null> {
  try {
    const marker = (await fs.readJson(markerPath)) as { version?: unknown };
    const installed = marker.version;
    if (typeof installed !== "string" || installed === "") return null;
    const packaged = getVersion();
    if (installed === packaged) return null;
    return { installed, packaged };
  } catch {
    return null;
  }
}

/**
 * A linha pronta, ou `undefined`. O texto diz o que fazer, porque um aviso que
 * não diz o comando obriga quem lê a descobrir — e quem abriu a sessão para
 * trabalhar não vai descobrir.
 */
export function formatAssetDriftWarning(drift: AssetDrift | null): string | undefined {
  if (drift === null) return undefined;
  return (
    `AVISO: os assets do NexOS em ~/.claude são da versão ${drift.installed} e o pacote em execução é ${drift.packaged} ` +
    `— agents, skills, rules e hooks podem estar desatualizados. Rode \`nexos install\` para projetar a versão nova.`
  );
}
