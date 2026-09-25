/**
 * `nexos capabilities` — LEITURA das superfícies nativas do Claude Code
 * (skills, agents, commands, plugins, MCP, LSP): fonte, invocação, `paths`,
 * `compatibility`, override, custo de listagem, duplicata por hash.
 * `--for "<tarefa>"` cruza a tarefa com a stack do Project Map e sugere no
 * máximo 3 skills/agents ativos, com motivo — Claude decide, o NexOS sugere
 * (nexos://decision/nexos-project-intelligence-os, refinamento §1).
 *
 * READ-ONLY: nunca escreve em `~/.claude`, nunca instala, nunca resolve.
 */
import path from "node:path";
import fs from "fs-extra";
import pc from "picocolors";
import { auditarCapabilities, type AuditItem, type AuditReport } from "../lib/capabilities/audit.js";
import { CLAUDE_DIR, ASSETS_DIR, HASH_MANIFEST } from "../lib/constants.js";
import { listSkillDirsComCaseErrado } from "../lib/capabilities/scan.js";
import { scanCapabilityUsage, usoDe, resumoDeLeitura } from "../lib/capabilities/usage.js";
import { fileHash } from "../lib/installer.js";
import type { HashTriple } from "../lib/capabilities/audit.js";
import { loadCapabilityCatalog, suggestForRoot } from "../lib/capabilities/catalog.js";
import { recorteParaAudit } from "../lib/capabilities/analyze.js";
import type { CapabilityCatalog, CapabilityItem, CapabilityKind, CapabilitySuggestResult } from "../lib/capabilities/types.js";

const VALID_KINDS: readonly CapabilityKind[] = ["skill", "agent", "command", "plugin", "mcp", "lsp"];

export interface CapabilitiesOptions {
  readonly root?: string;
  readonly json?: boolean;
  readonly for?: string;
  readonly kind?: string;
  readonly limit?: string;
  /** Cruza o catálogo com o disco: referência quebrada, duplicata, variante, custo. Nunca escreve. */
  readonly audit?: boolean;
  /**
   * Mede INVOCAÇÃO REAL nos transcritos do host. OPT-IN porque é caro:
   * 1665 arquivos e ~900 mil linhas neste HOME, ~34s. Nunca roda em hook.
   */
  readonly usage?: boolean;
}

export async function capabilities(options: CapabilitiesOptions = {}): Promise<void> {
  const root = path.resolve(options.root ?? process.cwd());

  if (options.kind !== undefined && !(VALID_KINDS as readonly string[]).includes(options.kind)) {
    console.error(pc.red(`--kind inválido: "${options.kind}" (use ${VALID_KINDS.join("|")})`));
    process.exitCode = 1;
    return;
  }

  if (options.for !== undefined) {
    const task = options.for.trim();
    if (!task) {
      console.error(pc.red("--for precisa de texto: descreva a tarefa"));
      process.exitCode = 1;
      return;
    }
    let limit: number | undefined;
    if (options.limit !== undefined) {
      limit = Number(options.limit);
      if (!Number.isFinite(limit) || limit < 1) {
        console.error(pc.red(`--limit inválido: ${options.limit}`));
        process.exitCode = 1;
        return;
      }
    }
    const result = await suggestForRoot(root, task, limit !== undefined ? { limit } : {});
    if (options.json) {
      console.log(JSON.stringify(result, null, 2));
    } else {
      printSuggestions(task, result);
    }
    return;
  }

  const catalog = await loadCapabilityCatalog(root);

  /**
   * INVOKED — o degrau que o audit não sabia medir.
   *
   *   DERIVED != MEASURED
   *
   * Todo o resto da superfície é DERIVADO de `skillOverrides`; isto é
   * OBSERVADO no transcript do host. Por isso vem em bloco próprio e diz o
   * denominador: sem transcritos lidos, "0 invocações" não é ausência de uso,
   * é ausência de medição.
   */
  if (options.usage === true) {
    const scan = await scanCapabilityUsage();
    const comUso = catalog.items.filter((i) => (usoDe(scan, i.name)?.invocations ?? 0) > 0);
    const linhas = comUso
      .map((i) => ({ nome: i.name, kind: i.kind, uso: usoDe(scan, i.name)! }))
      .sort((a, b) => b.uso.invocations - a.uso.invocations);
    if (options.json === true) {
      console.log(
        JSON.stringify(
          {
            scan: {
              transcriptsRead: scan.transcriptsRead,
              linesRead: scan.linesRead,
              unreadable: scan.unreadable,
              unreadableDirs: scan.unreadableDirs,
              malformedLines: scan.malformedLines,
            },
            invoked: linhas,
          },
          null,
          2
        )
      );
      return;
    }
    console.log(pc.bold(`\nINVOKED — invocação medida no transcript do host\n`));
    console.log(pc.dim(`  ${resumoDeLeitura(scan)}`));
    console.log(pc.dim(`  ${linhas.length} de ${catalog.items.length} peças do catálogo foram invocadas alguma vez\n`));
    for (const l of linhas.slice(0, 40)) {
      console.log(`  ${String(l.uso.invocations).padStart(5)}x  ${String(l.uso.sessions).padStart(3)} sessões  ${(l.uso.lastUsedAt ?? "—").slice(0, 10)}  ${pc.dim(l.kind.padEnd(8))} ${l.nome}`);
    }
    console.log(
      pc.dim(
        `\n  ZERO INVOCAÇÃO != INÚTIL: peça recém-instalada e peça morta têm o mesmo número. ` +
          `O que separa é "sessões" — quantas oportunidades a peça teve.\n`
      )
    );
    return;
  }
  const recorte = recorteParaAudit(catalog, options.kind);
  const { items, duplicates, variants } = recorte;

  if (options.audit === true) {
    const report = auditarCapabilities(
      {
        items: await comCorpo(items),
        duplicates,
        variants,
        nexosFiles: await triplasDeHash(),
        // skill invisível é, por construção, um achado de SKILL: fora do recorte
        // `--kind agent|command|...` ela é vazamento, não achado.
        invisibleSkills: recorte.incluiSkillsInvisiveis
          ? await listSkillDirsComCaseErrado(path.join(CLAUDE_DIR, "skills"))
          : [],
      },
      (alvo) => fs.pathExistsSync(alvo)
    );
    if (options.json) {
      console.log(JSON.stringify(report, null, 2));
    } else {
      printAudit(report);
    }
    return;
  }

  if (options.json) {
    console.log(
      JSON.stringify(
        {
          items,
          duplicates: catalog.duplicates,
          variants: catalog.variants,
          listing_chars_total: catalog.listing_chars_total,
          issues: catalog.issues,
        },
        null,
        2
      )
    );
    return;
  }

  printCatalog(items, catalog);
}

function printCatalog(items: readonly CapabilityItem[], catalog: CapabilityCatalog): void {
  const byKind = new Map<string, CapabilityItem[]>();
  for (const item of items) {
    const list = byKind.get(item.kind) ?? [];
    list.push(item);
    byKind.set(item.kind, list);
  }

  console.log(`\n${pc.bold("Capabilities observadas")} (${items.length})\n`);
  for (const [kind, list] of byKind) {
    console.log(pc.bold(`  ${kind} (${list.length})`));
    for (const item of list) {
      const flags = [
        item.enabled ? undefined : pc.yellow("disabled"),
        item.override ? `override=${item.override}` : undefined,
        item.health ? `health=${item.health}` : undefined,
      ]
        .filter((x): x is string => x !== undefined)
        .join(" ");
      console.log(`    ${pc.cyan(item.name)} ${pc.dim(`[${item.source}${item.plugin_id ? `:${item.plugin_id}` : ""}]`)} ${flags}`);
      console.log(`      invocation=${item.invocation} listing_chars=${item.listing_chars}`);
    }
  }

  if (catalog.duplicates.length > 0) {
    console.log(`\n${pc.bold(pc.yellow("DUPLICATAS"))} (${catalog.duplicates.length})\n`);
    for (const group of catalog.duplicates) {
      console.log(`  hash=${group.content_hash.slice(0, 12)}`);
      for (const dup of group.items) console.log(`    - ${dup.id} (${dup.file})`);
    }
  }

  if (catalog.variants.length > 0) {
    console.log(`\n${pc.bold(pc.yellow("VARIANTES"))} (mesmo nome, hash diferente, fontes distintas — ${catalog.variants.length})\n`);
    for (const group of catalog.variants) {
      console.log(`  nome=${group.name}`);
      for (const v of group.items) console.log(`    - ${v.id} (${v.source}) hash=${v.content_hash.slice(0, 12)}`);
    }
  }

  if (catalog.issues.length > 0) {
    console.log(`\n${pc.bold(pc.red("ISSUES"))}`);
    for (const issue of catalog.issues) console.log(`  ${issue.code}: ${issue.detail}`);
  }

  console.log(`\n${pc.dim(`listing_chars_total=${catalog.listing_chars_total}`)}\n`);
}

function printSuggestions(task: string, result: CapabilitySuggestResult): void {
  console.log(`\n${pc.bold("SUGESTÕES")} para "${task}"\n`);
  if (result.suggestions.length === 0) {
    console.log(pc.dim("  nenhuma correspondência — nenhuma skill/agent ativo casa com o vocabulário da tarefa\n"));
  }
  for (const s of result.suggestions) {
    console.log(`  ${pc.cyan(s.item.name)} ${pc.dim(`[${s.item.kind}:${s.item.source}]`)} score=${s.score}`);
    console.log(`    ${s.why}`);
  }

  if (result.gaps.length > 0) {
    console.log(`\n${pc.bold(pc.yellow("CAPABILITIES AUSENTES"))}\n`);
    for (const gap of result.gaps) {
      console.log(`  ${pc.yellow(gap.name)} — ${gap.reason}`);
      console.log(`    remédio: ${gap.remedy}`);
    }
  }
  console.log("");
}

/** Lê o corpo de cada capability que tem arquivo — leitura, nunca escrita. */
/**
 * Projeta `CapabilityItem` (catálogo) em `AuditItem` (auditoria). EXPORTADA só
 * para teste: é um elo que não aparece em suíte nenhuma se ninguém o chamar, e
 * já quebrou em silêncio uma vez.
 *
 *   UNIT GREEN != WIRED
 *
 * MEDIDO: apagar a linha do `override` aqui zera a superfície inteira do audit
 * (`off 0`, `notInvocable 0`) com os 1931 testes passando — porque nenhum
 * arquivo de teste importava este módulo. O teste que o commit anterior
 * chamava de "integração" montava um `AuditItem` à mão e nunca atravessava
 * esta função. Verificador independente reproduziu a mutação e ela sobreviveu.
 */
export async function comCorpo(items: readonly CapabilityItem[]): Promise<readonly AuditItem[]> {
  const out: AuditItem[] = [];
  const doNexos = await caminhosDoManifesto();
  for (const item of items) {
    const base: AuditItem = {
      id: item.id,
      name: item.name,
      kind: item.kind,
      source: item.source,
      ...(item.file !== undefined ? { file: item.file } : {}),
      ...(item.listing_chars !== undefined ? { listing_chars: item.listing_chars } : {}),
      ...(item.file !== undefined && doNexos.has(item.file) ? { nexosOwned: true } : {}),
      /**
       * `skillOverrides` JÁ RESOLVIDO pelo scan. Esquecer esta linha zera a
       * superfície inteira em silêncio — MEDIDO: o audit passou a reportar
       * `off 0` e `0/14 explicadas` com todos os testes unitários verdes,
       * porque eles constroem `AuditItem` à mão e nunca atravessam este mapeamento.
       *
       *   UNIT GREEN != WIRED
       */
      ...(item.override !== undefined ? { override: item.override } : {}),
      enabled: item.enabled,
    };
    if (item.file === undefined) {
      out.push(base);
      continue;
    }
    try {
      out.push({ ...base, body: await fs.readFile(item.file, "utf-8") });
    } catch {
      out.push(base); // ilegível: some da auditoria de referência, nunca vira achado inventado
    }
  }
  return out;
}

/**
 * Os quatro planos, com a BASE de cada afirmação à vista.
 *
 * O verificador independente reprovou a versão anterior porque o texto nunca
 * dizia que as afirmações eram DERIVADAS da config, não observadas: só o JSON
 * carregava o `basis`. Quem lia o terminal achava que tinha sido medido.
 *
 *   DERIVED != MEASURED, e esconder isso é afirmar mais do que se sabe.
 */
function printSurface(s: AuditReport["surface"]): void {
  console.log(pc.bold("\n  superficie  ") + pc.dim("DISK != LISTED != INVOCABLE"));
  console.log(
    pc.dim(
      `    descobertas ${s.discovered} - governadas por skillOverrides ${s.discovered - s.naoGovernadas} - ` +
        `fora do alcance de overrides ${s.naoGovernadas} (plugin/command/mcp/lsp/agent)`
    )
  );
  console.log(
    pc.dim(
      `    override: on ${s.porOverride.on} - off ${s.porOverride.off} - ` +
        `name-only ${s.porOverride["name-only"]} - user-invocable-only ${s.porOverride["user-invocable-only"]}`
    )
  );
  console.log(
    `    ${pc.yellow("o modelo NAO invoca")}: ${s.notInvocable.length}  ` +
      pc.dim("(off + user-invocable-only - integras; OFF != BROKEN)")
  );
  console.log(
    `    ${pc.yellow("representacao reduzida")}: ${s.reduced.length}  ` +
      pc.dim("(name-only - listadas sem descricao: discovery degradada)")
  );
  console.log(
    pc.dim(
      `    invocabilidade DESCONHECIDA: ${s.invocabilidadeDesconhecida} - ninguem mediu. ` +
        "LISTED != INVOCABLE, e so o host responde listagem."
    )
  );
  console.log(
    pc.dim(
      `    MEDIDAS diretamente contra o host: ${s.medidasDiretamente} - ` +
        "todo o resto acima e DERIVADO de skillOverrides, nao observado. DERIVED != MEASURED."
    )
  );
  /**
   * O ÚLTIMO DEGRAU PRECISA DIZER QUE NÃO EXISTE.
   *
   *   AUSENTE DO RELATÓRIO != NÃO MEDIDO != NÃO MENSURÁVEL
   *
   * A escada ia até INVOCABLE aqui e INVOKED em `--usage`. `EFFECTIVE` não
   * aparecia em lugar nenhum — e silêncio no último degrau é pior que um
   * número ruim: quem lê não sabe se ninguém mediu ou se não há o que medir.
   *
   * MEDIDO em 2026-09-19 (outra sessão, 108 invocações lidas no transcript):
   * o host registra QUE a skill rodou e nunca se o resultado foi aceito. Não
   * é lacuna de coleta — é ausência de sinal na fonte. Enquanto for assim, o
   * produto declara `UNOBSERVABLE` em vez de calar ou de inferir.
   *
   * Inferir aceitação de `tool_result` foi explicitamente recusado: o campo
   * prova entrega de resultado, nunca julgamento sobre ele.
   */
  console.log(
    pc.dim(
      "    EFFECTIVE: UNOBSERVAVEL - o transcript do host registra QUE a peca rodou, " +
        "nunca se o resultado foi aceito. Sem sinal na fonte, nao se infere."
    )
  );
}

function printAudit(report: AuditReport): void {
  const { totals, findings, surface } = report;
  console.log(`\n${pc.bold("Auditoria de capabilities")} — ${totals.items} peças descobertas`);
  printSurface(surface);
  console.log(
    pc.dim(
      `  proveniência: NexOS ${totals.porProveniencia.NEXOS_OWNED} · projeto ${totals.porProveniencia.PROJECT_MANAGED} · ` +
        `plugin ${totals.porProveniencia.PLUGIN_MANAGED} · usuário ${totals.porProveniencia.USER_MANAGED} · ` +
        `não classificada ${totals.porProveniencia.UNCLASSIFIED}`
    )
  );
  console.log(
    pc.dim(
      `  achados: quebradas ${totals.porTipo["broken-reference"]} · desatualizadas ${totals.porTipo.stale} · ` +
        `editadas ${totals.porTipo.modified} · órfãs ${totals.porTipo.orphaned} · sombreadas ${totals.porTipo.shadowed} · ` +
        `duplicadas ${totals.porTipo.duplicate} · variantes ${totals.porTipo.variant} · ` +
        `invisíveis ${totals.porTipo.invisible}`
    )
  );
  console.log(
    pc.dim(
      `  ação: manter ${totals.porAcao.KEEP} · consertar ${totals.porAcao.REPAIR} · atualizar ${totals.porAcao.UPDATE} · ` +
        `remover ${totals.porAcao.REMOVE} · revisar ${totals.porAcao.REVIEW}  ` +
        // A frase anterior dizia que eval com Δ medido "ainda não existe".
        // Existe desde a semana 37 (7-11/09): `claude plugin eval` repete cada
        // caso COM e SEM o plugin e devolve os dois scores, cuja diferença é o
        // Δ — negative control embutido, a mesma disciplina de
        // `escada-de-prova-de-aplicacao`. A frase era verdadeira quando foi
        // escrita e envelheceu sem que ninguém revisasse.
        //
        //   PROBLEMA REGISTRADO != PROBLEMA VIGENTE
        //
        // O que impede ADOPT hoje não é a falta de mecanismo: é que cada caso
        // custa execuções de modelo cobradas na conta do dono, e das 626
        // capabilities 603 não são nossas. Medir capability alheia não é
        // trabalho deste projeto.
        `(ADOPT não é emitido: exige Δ medido por eval, que custa execuções de modelo — decisão do dono, não limitação de mecanismo)`
    )
  );
  /**
   *   MANTER NÃO AFIRMA USO
   *
   * `KEEP` aqui significa "nenhum achado nesta peça" — nunca "esta peça é
   * usada" nem "algo a alcança". Medido em 2026-09-19 na máquina do dono:
   * das 531 peças em `manter`, 24 tinham invocação em transcript e 27 tinham
   * referência em instrução viva. O resto é ausência de achado.
   *
   * A distinção existe porque colapsá-la foi o que quase apagou `graphify`,
   * `last30days` e `notebooklm` — os três providers roteados pelo CLAUDE.md,
   * nenhum deles jamais invocado num transcript. Quatro estados diferentes
   * caíam na mesma palavra:
   *
   *   NÃO OBSERVADO != NÃO ALCANÇÁVEL != NÃO NECESSÁRIO != MORTO
   *
   * O vocabulário de poda (nexos://decision/poda-superficie-tres-baldes)
   * nomeia o que sustenta cada decisão, e é isso que esta linha lembra a quem
   * lê o número de cima e conclui demais.
   */
  console.log(
    pc.dim(
      `  "manter" = sem achado nesta peça. NÃO afirma uso nem alcance — decidir remoção exige ` +
        `nomear o que sustenta: uso medido, referência viva, ownership, ou desconhecido (que vira quarentena, não descarte).`
    )
  );
  console.log(
    pc.dim(
      `  superfície descoberta: ${totals.surfaceChars} caracteres (${totals.surfaceCharsComAchado} nas peças com achado). ` +
        `NÃO é o que entra na janela: o host lista nome+descrição com teto de 1% do contexto e ENCURTA as descrições ` +
        `para caber — quando estoura, some a palavra-chave que faria a peça casar. Meça o injetado com /context e /skill-doctor.`
    )
  );
  /**
   * O conselho prático, e é o oposto do que este comando sugeria antes.
   *
   *   DESLIGAR CORTA CONTEXTO — APAGAR NÃO É NECESSÁRIO
   *
   * Doc do host (skills.md): `off` fica oculta na listagem E no menu, então
   * some do contexto sem ninguém apagar arquivo. E o overflow não é cego —
   * o host derruba descrição começando pelas MENOS invocadas, de modo que a
   * poluição degrada primeiro quem já não era usado. Quem quiser mais
   * orçamento sobe `skillListingBudgetFraction` em vez de podar.
   */
  console.log(
    pc.dim(
      `  para reduzir: "off" em skillOverrides oculta da listagem e do menu (reversível, nada é apagado), ` +
        `"name-only" mantém a peça listada sem descrição; plugin não obedece skillOverrides — é /plugin. ` +
        `No overflow o host derruba a descrição das MENOS invocadas primeiro, e skillListingBudgetFraction sobe o teto.`
    )
  );

  if (findings.length === 0) {
    console.log(`\n  ${pc.green("nenhum achado")} — nada citado está ausente e nenhum nome se sombreia.\n`);
    return;
  }

  console.log("");
  for (const f of findings) {
    const rotulo =
      f.kind === "broken-reference"
        ? pc.red("quebrada ")
        : f.kind === "orphaned"
          ? pc.red("órfã     ")
          : f.kind === "stale"
            ? pc.yellow("desatual.")
            : f.kind === "modified"
              ? pc.cyan("editada  ")
              : f.kind === "shadowed"
                ? pc.yellow("sombreada")
                : f.kind === "duplicate"
                  ? pc.yellow("duplicada")
                  : pc.yellow("variante ");
    console.log(
      `  ${rotulo} ${pc.cyan(f.name)} ${pc.dim(`[${f.provenance}] (${f.listingChars} chars)`)} ${pc.bold(f.action)}`
    );
    console.log(`            ${f.detail}`);
    if (f.file) console.log(pc.dim(`            ${f.file}`));
  }
  console.log(pc.dim("\n  READ-ONLY: o NexOS classifica; remover, mover ou desligar é decisão do dono.\n"));
}

/**
 * Caminhos absolutos que o `nexos install` declara ter gravado. É a ÚNICA
 * prova de autoria: sem ela, "não é nosso" viraria "órfão" e as centenas de
 * skills do usuário apareceriam como lixo.
 */
async function caminhosDoManifesto(): Promise<ReadonlySet<string>> {
  try {
    /** `HASH_MANIFEST` É `CLAUDE_DIR/.nexos-hashes.json` — repetir o literal aqui era o mesmo caminho declarado em dois lugares. */
    const manifesto = (await fs.readJson(HASH_MANIFEST)) as Record<string, string>;
    return new Set(Object.keys(manifesto).map((rel) => path.join(CLAUDE_DIR, rel)));
  } catch {
    return new Set(); // sem manifesto (NexOS nunca instalado aqui): ninguém é NEXOS_OWNED
  }
}

/**
 * Os três hashes que decidem frescor, só para o que o NexOS gravou:
 * manifesto (o que o install declarou), pacote (canônico de hoje) e disco (o
 * que está lá). Conteúdo, nunca data — `FRESCOR É DO CONTEÚDO`.
 */
async function triplasDeHash(): Promise<ReadonlyMap<string, HashTriple>> {
  const out = new Map<string, HashTriple>();
  let manifesto: Record<string, string>;
  try {
    manifesto = (await fs.readJson(path.join(CLAUDE_DIR, ".nexos-hashes.json"))) as Record<string, string>;
  } catch {
    return out; // NexOS nunca instalado aqui: nada tem canônico conhecido
  }

  for (const [rel, hashManifesto] of Object.entries(manifesto)) {
    const noDisco = path.join(CLAUDE_DIR, rel);
    if (!(await fs.pathExists(noDisco))) continue;
    const noPacote = path.join(ASSETS_DIR, rel);
    out.set(noDisco, {
      manifest: hashManifesto,
      package: (await fs.pathExists(noPacote)) ? await fileHash(noPacote) : null,
      disk: await fileHash(noDisco),
    });
  }
  return out;
}
