/**
 * Critério 8 — AUTHORITY (autoridade de escrita canônica do Store, distinta
 * de autoridade de agente/permissão — ver nexos://decision/p1-0-remover-authorization-layer,
 * que não toca este critério).
 *
 *   SUPABASE IS NOT CANONICAL AUTHORITY
 *   REMOTE WRITE != CANONICAL ADMISSION
 *
 * Fluxo permitido:
 *   observation/proposal → admission → Canonical Store → réplica OPCIONAL
 *
 * `nexos-memory-sync.sh`, que estes testes travavam nominalmente (medido em
 * 14/08: rodava em `PostToolUse(Write|Edit)` e fazia POST direto em
 * `/rest/v1/` com a service key, a cada edição de markdown), saiu do pacote
 * por inteiro (nexos://decision/p1-0-remover-authorization-layer, P1.0b —
 * PostToolUse não é mais lane do NexOS). Os gates GERAIS contra qualquer
 * reintrodução de rede+segredo sobrevivem abaixo.
 *
 * Nenhum write remoto é executado aqui — os testes leem os assets distribuídos.
 */
import { describe, it, expect } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { auditarHooksEntregues } from "../src/lib/conformance.js";

const SETTINGS = "assets/settings.json";

interface Hook {
  command?: string;
}
interface Grupo {
  matcher?: string;
  hooks?: Hook[];
}
interface Settings {
  hooks?: Record<string, Grupo[]>;
}

const todosOsComandos = (s: Settings): string[] =>
  Object.values(s.hooks ?? {})
    .flat()
    .flatMap((g) => g.hooks ?? [])
    .map((h) => h.command ?? "");

describe("authority · nenhum writer canônico direto no remoto", () => {
  it("o settings distribuído NÃO ativa nenhum hook de sync remoto", async () => {
    const s = (await fs.readJson(SETTINGS)) as Settings;
    const suspeitos = todosOsComandos(s).filter((c) =>
      /memory-sync|supabase|rest\/v1|SERVICE_KEY/i.test(c)
    );
    expect(suspeitos).toEqual([]);
  });

  it("nenhum hook distribuído chama o script de sync — o arquivo nem existe mais no pacote", async () => {
    await expect(fs.pathExists("assets/hooks/nexos-memory-sync.sh")).resolves.toBe(false);
    const alcancado = await auditarHooksEntregues("assets/hooks");
    expect(alcancado.map((o) => o.arquivo)).not.toContain("nexos-memory-sync.sh");
  });

  /**
   * Gate contra reintrodução: nenhum hook que o instalador ENTREGA pode mandar
   * segredo para a rede.
   *
   *   DELIVERY IS NOT MENTION
   *
   * Os três assets rede+segredo medidos em 14/08 (deployment-health-monitor,
   * vercel-auto-deploy, langsmith-tracing) foram REMOVIDOS do pacote, não
   * desativados: eram de terceiros e não tinham valor documental próprio — ao
   * contrário de `nexos-memory-sync.sh`, mantido inerte de propósito porque
   * documenta o formato de replicação.
   *
   * P1.3i (nexos://decision/p1-3i-install-environment-boundary) removeu
   * profiles do instalador: `nexos install` entrega TODO arquivo de
   * `assets/hooks/`, sem filtro de stack. `auditarHooksEntregues` audita o
   * diretório inteiro — não há mais expansão por padrão a reproduzir.
   */
  it("nenhum hook ENTREGUE combina segredo com rede", async () => {
    const ofensores = await auditarHooksEntregues("assets/hooks");
    expect(ofensores.map((o) => o.arquivo)).toEqual([]);
  });

  /**
   * CONTRAFACTUAL — `A GREEN GATE THAT CANNOT GO RED IS NOT A GATE`.
   *
   * Reintroduz um asset equivalente aos removidos e prova que o gate FICA
   * VERMELHO. Sem isto, o teste acima passaria igualzinho se a auditoria
   * devolvesse `[]` por engano — exatamente o modo de falha do gate que ele
   * substitui.
   */
  it("o gate FICA VERMELHO se um asset rede+segredo aparecer em assets/hooks", async () => {
    const dir = await fs.mkdtemp(path.join(os.tmpdir(), "hooks-"));
    await fs.writeFile(
      path.join(dir, "automation--vercel-auto-deploy.json"),
      JSON.stringify({
        hooks: {
          PostToolUse: [
            {
              matcher: "Write|Edit",
              hooks: [{ command: 'curl -X POST https://api.vercel.com -H "Authorization: Bearer $VERCEL_TOKEN"' }],
            },
          ],
        },
      })
    );

    const vermelho = await auditarHooksEntregues(dir);
    expect(vermelho.map((o) => o.arquivo)).toEqual(["automation--vercel-auto-deploy.json"]);

    /**
     * E o inverso: o mesmo par rede+segredo com `exit 0` de guarda ANTES da
     * requisição não é ofensor. Sem esta metade, o gate poderia estar apenas
     * acusando qualquer arquivo, e passaria a proibir o padrão inerte que o
     * repo usa de propósito.
     */
    await fs.writeFile(
      path.join(dir, "nexos-desarmado.sh"),
      '#!/usr/bin/env bash\n# DESATIVADO\nexit 0\ncurl -H "Authorization: Bearer $KEY" https://x\n'
    );
    const so_o_ativo = await auditarHooksEntregues(dir);
    expect(so_o_ativo.map((o) => o.arquivo)).toEqual(["automation--vercel-auto-deploy.json"]);

    await fs.remove(dir);
  });

  /**
   * O Store canônico é o único destino de verdade admitida no código do produto.
   * Nenhum módulo do kernel fala com Supabase.
   */
  it("nenhum módulo do kernel conhece Supabase", async () => {
    for (const f of [
      "src/lib/capsule/store.ts",
      "src/lib/capsule/reader.ts",
      "src/lib/context-assembler.ts",
      "src/lib/session-brief.ts",
      "src/lib/bootstrap-context.ts",
      "src/lib/evidence.ts",
    ]) {
      const code = await fs.readFile(f, "utf-8");
      expect(code, `${f} menciona Supabase`).not.toMatch(/supabase|rest\/v1|SERVICE_KEY/i);
    }
  });
});
