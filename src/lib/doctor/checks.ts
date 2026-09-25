/**
 * Checks de `Check` compartilhados entre `commands/doctor.ts` (o doctor de
 * ambiente global, legado) e `lib/doctor/project-doctor.ts` (G1, `nexos
 * doctor --project`) — extraídos para cá para que os dois módulos possam
 * reusar as MESMAS funções sem um importar o outro (import circular).
 *
 * Reexportado por `commands/doctor.ts` — nenhum call-site existente
 * (`tests/doctor-global-root.test.ts`, `nexos doctor`) muda de import.
 */
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { spawnSync } from "node:child_process";
import { resolveCanonicalNow } from "../project-state-inspector.js";
import { buildContextTapCommand } from "../installer.js";
import {
  scanMemorySurfaces,
  isWriteOnly,
  isFrozen,
  type MemorySurface,
  type MemorySurfaceId,
} from "../host/memory-surfaces.js";
import { readCurrentRecords, type ReadResult } from "../capsule/reader.js";
import { forProject } from "../capsule/paths.js";
import { scanIntegrity } from "../capsule/integrity.js";
import type { IntegrityIssue } from "../capsule/integrity.js";
import { GLOBAL_ROOT, ASSETS_DIR, INSTALL_TARGETS, CLAUDE_DIR } from "../constants.js";
import { loadRegistry } from "../agent/registry.js";
import { settingsChain } from "../host/memory-authority.js";

export interface Check {
  name: string;
  status: "pass" | "warn" | "fail";
  message: string;
  /** Código estável para consumo por máquina — ausente quando o check não tem um. */
  code?: string;
}

/**
 * Replica LOCALMENTE o gate `options.failOnAnomaly` de `readCurrentRecords`
 * (`reader.ts` linhas ~487-497) sobre um `ReadResult` já lido SEM esse flag —
 * mesmas `records`/`anomalies`, então o resultado é byte-idêntico ao de uma
 * segunda chamada com `{ failOnAnomaly: true }`. Existe para que
 * `medirStoreCanonico` possa REUSAR a leitura de `medirVazamentoEntreProjetos`
 * (`commands/doctor.ts`) em vez de escanear o Store do projeto uma segunda
 * vez — knw_01M2R7JXZ5V1Y4BHRT2ARX4G3V (doctor completo lia e validava o
 * Store ~5 vezes). `.nexos/.local` fica fora do alcance do doctor, que roda
 * também sobre clones/cópias de inspeção (ver docstring de
 * `ScanIntegrityOptions.cache`, `integrity.ts`), então a dedução é só por
 * PROCESSO — nunca o `IntegrityCache` opt-in em disco.
 */
function withFailOnAnomaly(raw: ReadResult): ReadResult {
  if (!raw.ok || raw.anomalies.length === 0) return raw;
  return {
    ok: false,
    reason: "UNREADABLE",
    issues: raw.anomalies.map((a) => ({
      code: a.state,
      file: a.sourceRef,
      detail: a.detail,
    })) as unknown as IntegrityIssue[],
  };
}

/**
 * `preloadedRead` — OPT-IN, ver `withFailOnAnomaly` acima. Quando ausente,
 * comportamento idêntico ao de sempre: uma leitura própria com
 * `failOnAnomaly: true`. `commands/doctor.ts` passa a leitura já feita por
 * `medirVazamentoEntreProjetos` (mesmo `rootPath`, mesmas opções relevantes —
 * nenhuma além do gate, aplicado aqui).
 */
export async function medirStoreCanonico(rootPath: string, preloadedRead?: ReadResult): Promise<Check> {
  const canonical = await resolveCanonicalNow(rootPath);
  if (!canonical.ok) {
    return {
      name: "Canonical Store",
      status: "pass",
      message: "projeto do diretório atual não é NexOS-governed — check N/A",
      code: "CANONICAL_STORE_NOT_APPLICABLE",
    };
  }

  const store = withFailOnAnomaly(preloadedRead ?? (await readCurrentRecords(rootPath)));
  if (!store.ok) {
    const details = store.issues
      .map((issue) => `${issue.code}${issue.detail ? `:${issue.detail}` : ""}`)
      .slice(0, 3)
      .join("; ");
    return {
      name: "Canonical Store",
      status: "fail",
      message: `UNREADABLE — ${details || "leitura estrita falhou"}`,
      code: "CANONICAL_STORE_UNREADABLE",
    };
  }

  return {
    name: "Canonical Store",
    status: "pass",
    message: `${store.records.length} records correntes · leitura estrita PASS`,
    code: "CANONICAL_STORE_READABLE",
  };
}

/**
 * INVENTÁRIO das memórias paralelas — quantas existem, quantas têm conteúdo,
 * quantas ninguém lê e quantas ninguém mais escreve. `warn`, nunca `fail`:
 * acervo paralelo é condição PREEXISTENTE do host, não defeito de instalação.
 * Ver `commands/doctor.ts` (histórico completo do comentário original) para o
 * raciocínio de cada ramo — preservado integralmente aqui.
 */
/**
 * O MESMO check, separado por dono da superfície.
 *
 *   PROJECT HEALTH != HOST HYGIENE
 *
 * Medido num projeto piloto (2026-09-17): adoção correta, projeto
 * saudável, e o `doctor --project` dizia DEGRADED porque `~/.claude/agent-memory`
 * — que é da máquina e pode ser de outro projeto — tinha conteúdo sem leitor.
 * Misturar os dois faz o dono ler "o projeto que acabei de adotar está
 * degradado" quando o que está sujo é o host. Uma varredura, dois vereditos.
 */
/**
 * Legado que OUTRO diagnóstico do mesmo relatório já isenta: o `lifecycle`
 * imprime "memory/ preservado como legado (referência, não degrada)" sobre
 * `.nexos/memory/project` — que é exatamente a superfície `project-markdown`.
 * Contá-la como veredito fazia a MESMA saída se contradizer sobre o MESMO
 * diretório (medido no nexos-cli com o 6.4.1). Segue no inventário, nunca no
 * veredito.
 */
const LEGADO_ISENTO: ReadonlySet<MemorySurfaceId> = new Set<MemorySurfaceId>(["project-markdown"]);

/**
 * `ACERVO INERTE != MEMÓRIA CONCORRENTE`
 *
 * Só compete com o Store o acervo que alguém LÊ numa sessão ou que alguém
 * ESCREVE agora. Superfície congelada (`isFrozen`: tem conteúdo, nada mais a
 * escreve) e sem leitor é arquivo parado — inventário, não defeito. O sinal
 * que PRECISA sobreviver é o oposto: escrita ativa sem leitor
 * (`isWriteOnly` + `writable`) é acervo órfão CRESCENDO ao lado do Store.
 */
export function competeComOStore(s: MemorySurface): boolean {
  if (s.items === 0 || LEGADO_ISENTO.has(s.id)) return false;
  return s.writable || s.readBy !== null;
}

export async function medirMemoriasParalelasPorDono(
  rootPath: string
): Promise<{ readonly projeto: Check; readonly host: Check; readonly concorrentesDoProjeto: readonly MemorySurface[] }> {
  const canonical = await resolveCanonicalNow(rootPath);
  const scan = await scanMemorySurfaces(rootPath, {
    projectId: canonical.ok ? canonical.projectId : undefined,
  });

  const porDono = (dono: "project" | "host"): Check => {
    const comConteudo = scan.surfaces.filter((s) => s.owner === dono && s.items > 0);
    const nome = dono === "project" ? "Parallel memories (projeto)" : "Parallel memories (host)";
    if (comConteudo.length === 0) {
      return {
        name: nome,
        status: "pass",
        message:
          dono === "project"
            ? "nenhuma memória paralela no projeto — o Store é o acervo único"
            : "nenhuma memória paralela na máquina",
      };
    }
    const inventario = comConteudo.map((s) => `${s.id}=${s.items}`).join(" ");
    const semLeitor = comConteudo.filter(isWriteOnly);
    const congeladas = comConteudo.filter(isFrozen);
    const partes = [`${comConteudo.length} superfície(s) com conteúdo: ${inventario}`];
    if (semLeitor.length > 0) partes.push(`sem leitor: ${semLeitor.map((s) => s.id).join(", ")}`);
    if (congeladas.length > 0) partes.push(`congeladas: ${congeladas.map((s) => s.id).join(", ")}`);
    if (dono === "host") {
      /** Inventariar antes de apagar: o acervo da máquina pode ser de OUTRO projeto. */
      partes.push("higiene da máquina, não do projeto — inventarie a origem antes de arquivar ou apagar");
    }
    return { name: nome, status: "warn", message: partes.join(" · ") };
  };

  return {
    projeto: porDono("project"),
    host: porDono("host"),
    concorrentesDoProjeto: scan.surfaces.filter((s) => s.owner === "project" && competeComOStore(s)),
  };
}

export async function medirMemoriasParalelas(rootPath: string): Promise<Check> {
  const canonical = await resolveCanonicalNow(rootPath);
  const scan = await scanMemorySurfaces(rootPath, {
    projectId: canonical.ok ? canonical.projectId : undefined,
  });

  const comConteudo = scan.surfaces.filter((s) => s.items > 0);
  if (
    comConteudo.length === 0 &&
    scan.quarantined.length === 0 &&
    scan.crossProjectReferences.length === 0 &&
    scan.foreignMemoryCiting.length === 0
  ) {
    return {
      name: "Parallel memories",
      status: "pass",
      message: "nenhuma memória paralela com conteúdo — o Store é o acervo único",
    };
  }

  const writeOnly = comConteudo.filter(isWriteOnly);
  const frozen = comConteudo.filter(isFrozen);
  const inventario = comConteudo.map((s) => `${s.id}=${s.items}`).join(" ");

  const partes = [`${comConteudo.length} superfície(s) com conteúdo: ${inventario}`];
  if (writeOnly.length > 0) {
    partes.push(`sem leitor: ${writeOnly.map((s) => s.id).join(", ")}`);
  }
  if (frozen.length > 0) {
    partes.push(`congeladas (nada mais escreve): ${frozen.map((s) => s.id).join(", ")}`);
  }
  const decl = scan.subagentMemoryDeclarations;
  const totalDecl = decl.user + decl.project + decl.local;
  if (totalDecl > 0 && !scan.autoMemoryEnabled) {
    partes.push(`${totalDecl} subagente(s) declaram \`memory:\` sem efeito — auto memory desligado`);
  }
  if (scan.quarantined.length > 0) {
    partes.push(`auto memory fora do path do host (quarentena manual): ${scan.quarantined.join(", ")}`);
  }

  if (scan.crossProjectReferences.length > 0) {
    const fortes = scan.crossProjectReferences.filter((c) => c.otherRoot !== null);
    const amostra = [...fortes, ...scan.crossProjectReferences.filter((c) => c.otherRoot === null)]
      .slice(0, 3)
      .map((c) => `${path.basename(c.file)} cita ${c.citedPath}${c.otherRoot ? " [projeto do host]" : ""}`)
      .join("; ");
    partes.push(
      `memória citando path fora do projeto em ${scan.crossProjectReferences.length} caso(s) (${fortes.length} em projeto do host) — confira se é referência ou memória de OUTRO projeto: ${amostra}`
    );
  }

  if (scan.foreignMemoryCiting.length > 0) {
    const amostra = scan.foreignMemoryCiting
      .slice(0, 3)
      .map((f) => `${path.basename(f.projectDir)}/memory/${path.basename(f.file)}`)
      .join("; ");
    partes.push(`${scan.foreignMemoryCiting.length} arquivo(s) de memória de OUTRO projeto citam este: ${amostra}`);
  }

  const suspeito = writeOnly.length > 0 || frozen.length > 0 || scan.quarantined.length > 0;
  return {
    name: "Parallel memories",
    status: suspeito ? "warn" : "pass",
    message: partes.join(" | "),
    ...(suspeito ? { code: "PARALLEL_MEMORY_UNRECONCILED" } : {}),
  };
}

/**
 * T9 — saúde do root GLOBAL (`GLOBAL_ROOT`, hoje `~/.nexos`). `warn`, nunca
 * `fail`: root global ausente é condição válida em qualquer máquina que nunca
 * rodou `nexos init --global`.
 */
export async function medirSaudeRootGlobal(): Promise<Check> {
  const manifestPath = forProject(GLOBAL_ROOT).manifest();
  if (!(await fs.pathExists(manifestPath))) {
    return {
      name: "Global root",
      status: "warn",
      message: `manifest global ausente em ${GLOBAL_ROOT} — rode: nexos init --global`,
      code: "GLOBAL_ROOT_ABSENT",
    };
  }

  const report = await scanIntegrity(GLOBAL_ROOT);
  const registro = await medirRegistroDeProjetos();

  const base = report.ok
    ? `íntegro — ${report.recordsScanned} record(s), 0 issues`
    : `${report.recordsScanned} record(s), ${report.issues.length} issue(s): ${report.issues
        .slice(0, 3)
        .map((i) => i.code)
        .join(", ")}`;

  return {
    name: "Global root",
    status: report.ok && registro.orfaos === 0 ? "pass" : "warn",
    message: `${base} · ${registro.detalhe}`,
    code: !report.ok
      ? "GLOBAL_ROOT_ISSUES"
      : registro.orfaos > 0
        ? "GLOBAL_PROJECT_REGISTRY_STALE"
        : "GLOBAL_ROOT_HEALTHY",
  };
}

/**
 * O registro de projetos (`~/.nexos/projects/<id>/authority.yaml`) — a coisa
 * mais parecida com um ÍNDICE DE PROJETOS que o NexOS tem — não era medido por
 * nada, e o check acima dizia "íntegro" contando só os RECORDS ao lado.
 *
 *     GLOBAL ROOT ÍNTEGRO != CAMADA GLOBAL SAUDÁVEL
 *
 * MEDIDO em 2026-09-19 nesta máquina: 2477 entradas de authority, das quais
 * 2403 (97%) apontam para diretórios temporários de teste que não existem mais
 * (`/private/var/folders/.../T/promo-XMdqcx/proj`). Todas de 2026-09, ZERO nos
 * últimos 7 dias — resíduo anterior a `tests/isolate-nexos-home.ts`, que fechou
 * o vazamento. O defeito está fechado; o lixo, não, e enquanto ele estiver ali
 * qualquer feature que leia este índice nasce sobre 97% de ruído.
 *
 * Read-only e tolerante por construção: entrada ilegível conta como ilegível,
 * nunca derruba o diagnóstico. Não apaga nada — `~/.nexos` é da máquina, não
 * deste projeto, e poda de estado do usuário é decisão dele.
 */
export async function medirRegistroDeProjetos(
  nexosHome: string = path.join(GLOBAL_ROOT, ".nexos")
): Promise<{ total: number; vivos: number; orfaos: number; detalhe: string }> {
  const dir = path.join(nexosHome, "projects");
  let ids: string[];
  try {
    ids = await fs.readdir(dir);
  } catch {
    return { total: 0, vivos: 0, orfaos: 0, detalhe: "registro de projetos: ausente" };
  }

  let total = 0;
  let vivos = 0;
  for (const id of ids) {
    let bruto: string;
    try {
      bruto = await fs.readFile(path.join(dir, id, "authority.yaml"), "utf-8");
    } catch {
      continue;
    }
    total += 1;
    const raiz = /^active_root:\s*(.+)$/m.exec(bruto)?.[1]?.trim();
    if (raiz && (await fs.pathExists(raiz))) vivos += 1;
  }

  const orfaos = total - vivos;
  if (total === 0) return { total, vivos, orfaos, detalhe: "registro de projetos: vazio" };

  const pct = Math.round((orfaos / total) * 100);
  return {
    total,
    vivos,
    orfaos,
    detalhe:
      orfaos === 0
        ? `registro de projetos: ${total} entrada(s), todas apontam para diretório existente`
        : `registro de projetos: ${total} entrada(s), ${orfaos} (${pct}%) apontam para diretório que não existe mais — índice de projetos é ${vivos} real(is), não ${total}`,
  };
}

/**
 * A superfície que o host DEVERIA ter sai do pacote em execução, nunca de uma
 * lista escrita à mão.
 *
 *   DECLARED SURFACE != SHIPPED SURFACE
 *
 * Medido em 2026-09-17: `nexos doctor` esperava 6 hooks e 4 agentes fixos no
 * código, enquanto `assets/hooks` tinha 9 arquivos (o installer instala TODOS,
 * `planAssetComponent`) e o registry tinha 5 agentes — o `nexos-analyst` nunca
 * era checado e um hook novo nasceria invisível. Lista congelada envelhece
 * calada e o diagnóstico mente com cara de verde.
 */
export interface ExpectedHostSurface {
  /** Nomes de arquivo que `nexos install` grava em `~/.claude/hooks`. */
  readonly hooks: readonly string[];
  /** Arquivos de agente que PASSAM no contrato do registry (os projetáveis). */
  readonly agents: readonly string[];
}

export async function expectedHostSurface(): Promise<ExpectedHostSurface> {
  const hooksDir = path.join(ASSETS_DIR, "hooks");
  const hooks = (await fs.pathExists(hooksDir))
    ? (await fs.readdir(hooksDir, { withFileTypes: true }))
        .filter((entry) => entry.isFile())
        .map((entry) => entry.name)
        .sort()
    : [];

  const { agents } = await loadRegistry(
    path.join(ASSETS_DIR, "agents"),
    path.join(ASSETS_DIR, "policies", "agent-registry.yaml")
  );

  return { hooks, agents: agents.map((a) => a.file).sort() };
}

/**
 * N2 (MEDIUM, revisão independente rodada 2) — o fallback `{ node <tap> ||
 * cat; }` do tap da statusLine (MEDIUM #6, mesma rodada) troca falha VISÍVEL
 * por SILENCIOSA: com `node` ausente do PATH ou o arquivo do tap corrompido,
 * a statusLine continua renderizando (o `cat` repassa o payload cru) mas o
 * AVISO DE CONTEXTO morre calado — `nexos-context-warn.sh` não acha amostra
 * e sai sem avisar nada. Esse aviso existe por causa de uma sessão real que
 * compactou a 95% sem aviso nenhum (nexos://decision/aviso-de-contexto-por-
 * statusline); um `|| cat` que escondesse justamente esse aviso reabriria o
 * problema que ele resolveu.
 *
 *   RENDERIZA != AVISA
 *
 * Roda o MESMO comando que `nexos install` grava em `settings.json`
 * (`buildContextTapCommand`, `installer.ts` — nunca uma segunda fórmula
 * reconstruída à mão, que divergiria do real na primeira mudança ali) via
 * shell, com um payload SINTÉTICO (`session_id` de sonda, nunca uma sessão
 * real) — exatamente como a statusLine do host invoca. Se `node` não estiver
 * no PATH deste shell, o `|| cat` do próprio comando entra em ação e a
 * amostra nunca é gravada, que é o sintoma real medido. A amostra da sonda é
 * apagada depois, sempre — nunca deixa lixo em `os.tmpdir()`.
 *
 * `statuslineDir`/`env` — mesmo padrão de `expectedAgentCount(assetsDir)`
 * (`commands/doctor.ts`): parâmetros, nunca `INSTALL_TARGETS.statusline`/
 * `process.env` direto, porque `CLAUDE_DIR` é uma constante fixada em
 * `os.homedir()` no import — um teste não consegue isolar isso trocando
 * `HOME`/`PATH` no MESMO processo. Default preserva o comportamento real de
 * sempre; `env` é o que deixa um teste provar o cenário "`node` ausente do
 * PATH" sem mexer no PATH real de quem roda o doctor.
 */
/** Camadas de settings que o check lê — injetáveis para teste; produção usa as reais. */
export interface CamadasDeSettings {
  readonly settingsPath?: string;
  readonly rootPath?: string;
  readonly managedSettingsPath?: string;
}

type StatusLineEfetiva =
  | { readonly ok: true; readonly command: string | undefined; readonly origem: string; readonly desligadaPor?: string }
  | { readonly ok: false; readonly erro: string };

/**
 * A statusLine que o host RODA, não a de um arquivo só (revisão rodada 3,
 * HIGH). settings.md: managed > local > projeto > usuário.
 * settings-reference.md ("Off entirely" / "Narrowed to managed settings"):
 * `disableAllHooks` NAS managed desliga a statusLine por inteiro;
 * `allowManagedHooksOnly` nas managed, ou `disableAllHooks` fora delas, deixam
 * rodar só a statusLine managed. Arquivo ilegível devolve o erro — nunca vira
 * "ausente". `desligadaPor` já é a frase inteira, com o remédio de quem pode agir.
 *
 * ponytail: `--settings`, `--safe-mode` e o trust do workspace não são
 * observáveis daqui; se um dia pesarem, entram nesta função.
 */
async function statusLineEfetiva(camadas: CamadasDeSettings): Promise<StatusLineEfetiva> {
  const lidas: Array<{ readonly source: string; readonly file: string; readonly conteudo: Record<string, unknown> }> = [];
  const cadeia = settingsChain(camadas.rootPath ?? process.cwd(), {
    ...(camadas.managedSettingsPath !== undefined ? { managedSettingsPath: camadas.managedSettingsPath } : {}),
    ...(camadas.settingsPath !== undefined ? { userSettingsPath: camadas.settingsPath } : {}),
  });
  for (const [source, file] of cadeia) {
    if (!(await fs.pathExists(file))) continue;
    try {
      const raw: unknown = await fs.readJson(file);
      const conteudo = typeof raw === "object" && raw !== null && !Array.isArray(raw) ? (raw as Record<string, unknown>) : {};
      lidas.push({ source, file, conteudo });
    } catch (error) {
      return { ok: false, erro: `${file}: ${error instanceof Error ? error.message : String(error)}` };
    }
  }
  const comandoDe = (conteudo: Record<string, unknown>): string | undefined => {
    const command = (conteudo.statusLine as { command?: unknown } | undefined)?.command;
    return typeof command === "string" ? command : undefined;
  };
  const managed = lidas.find((l) => l.source === "managed");
  if (managed?.conteudo.disableAllHooks === true) {
    return {
      ok: true,
      command: undefined,
      origem: managed.file,
      desligadaPor: `disableAllHooks nas managed settings (${managed.file}) desliga a statusLine por inteiro — só quem administra essas settings muda isso`,
    };
  }
  const soManaged = (motivo: string): StatusLineEfetiva => ({
    ok: true,
    command: managed ? comandoDe(managed.conteudo) : undefined,
    origem: managed?.file ?? "managed settings",
    desligadaPor: motivo,
  });
  if (managed?.conteudo.allowManagedHooksOnly === true) {
    return soManaged(`allowManagedHooksOnly nas managed settings (${managed.file}) deixa rodar só a statusLine managed — sem o tap nela, só quem administra essas settings muda isso`);
  }
  const quemDecideHooks = lidas.find((l) => l.source !== "managed" && typeof l.conteudo.disableAllHooks === "boolean");
  if (quemDecideHooks?.conteudo.disableAllHooks === true) {
    return soManaged(`disableAllHooks em ${quemDecideHooks.file} deixa rodar só a statusLine managed — remova a chave ou ponha false nesse arquivo`);
  }
  const efetiva = lidas.find((l) => comandoDe(l.conteudo) !== undefined);
  const userFile = cadeia.find(([source]) => source === "user")?.[1] ?? "settings.json";
  return { ok: true, command: efetiva ? comandoDe(efetiva.conteudo) : undefined, origem: efetiva?.file ?? userFile };
}

export async function medirTapDeContexto(
  statuslineDir: string = INSTALL_TARGETS.statusline,
  env: NodeJS.ProcessEnv = process.env,
  camadas: CamadasDeSettings = {}
): Promise<Check> {
  const tapFile = path.join(statuslineDir, "nexos-context-tap.mjs");
  if (!(await fs.pathExists(tapFile))) {
    return {
      name: "Context tap (statusLine)",
      status: "warn",
      message: "nexos-context-tap.mjs não instalado — aviso de contexto (70%/85%) não vai disparar. Rode: nexos install",
      code: "CONTEXT_TAP_NOT_INSTALLED",
    };
  }

  /**
   * COMANDO RECONSTRUÍDO != COMANDO INSTALADO (revisão rodada 3): rodar só o
   * comando reconstruído dava pass com a statusLine reescrita e o tap fora do
   * pipeline. `nexos install` sempre põe o tap na FRENTE — próprio ou alheio
   * (`installer.ts`, `projectStatusLineSettings`) —, então é isso que se cobra.
   */
  const efetiva = await statusLineEfetiva(camadas);
  if (!efetiva.ok) {
    return {
      name: "Context tap (statusLine)",
      status: "warn",
      message: `settings ilegível (${efetiva.erro}) — não dá para saber qual statusLine o host roda; conserte o arquivo antes de reinstalar`,
      code: "CONTEXT_TAP_SETTINGS_UNREADABLE",
    };
  }
  // As duas formas que o tap já teve na frente: a atual (`{ node <tap> || cat; }`)
  // e a de antes do fallback (`node <tap>`), que o install migra — as duas avisam.
  const tapAtual = buildContextTapCommand(statuslineDir);
  const tapSemFallback = tapAtual.replace(/^\{ (.*) \|\| cat; \}$/, "$1");
  const comando = efetiva.command;
  if (typeof comando !== "string" || ![tapAtual, tapSemFallback].some((tap) => comando.startsWith(`${tap} | `))) {
    const remedio = efetiva.desligadaPor
      ? efetiva.desligadaPor
      : efetiva.origem === (camadas.settingsPath ?? path.join(CLAUDE_DIR, "settings.json"))
        ? "Rode: nexos install"
        : `${efetiva.origem} tem precedência sobre o settings do usuário — ponha o tap nela ou remova a statusLine dali`;
    return {
      name: "Context tap (statusLine)",
      status: "warn",
      message: `a statusLine que o host roda (${efetiva.origem}) não passa pelo tap — aviso de contexto (70%/85%) NÃO vai disparar. ${remedio}`,
      code: "CONTEXT_TAP_NOT_WIRED",
    };
  }

  const sessionId = `nexos-doctor-probe-${process.pid}-${Date.now()}`;
  const amostraPath = path.join(os.tmpdir(), "nexos-context", `${sessionId}.json`);
  const usedPercentageSonda = 42;
  const payload = JSON.stringify({
    session_id: sessionId,
    context_window: { used_percentage: usedPercentageSonda, context_window_size: 1_000_000 },
  });

  try {
    await fs.remove(amostraPath); // sonda anterior morta a meio caminho, se sobrou
    const resultado = spawnSync("bash", ["-c", buildContextTapCommand(statuslineDir)], {
      input: payload,
      encoding: "utf8",
      timeout: 10_000,
      env,
    });
    if (resultado.error) {
      return {
        name: "Context tap (statusLine)",
        status: "warn",
        message: `não foi possível rodar o comando do tap (${resultado.error.message}) — aviso de contexto (70%/85%) pode estar quebrado. Rode: nexos install --force`,
        code: "CONTEXT_TAP_SPAWN_FAILED",
      };
    }
    const amostra = await fs.readJson(amostraPath).catch(() => undefined);
    if (!amostra || amostra.used_percentage !== usedPercentageSonda) {
      // O que o shell disse, não um palpite entre causas: symlink recusado pelo
      // tap, node ausente e tap corrompido pedem remédios diferentes.
      const stderr = (resultado.stderr ?? "").trim().replace(/\s+/g, " ").slice(0, 200);
      return {
        name: "Context tap (statusLine)",
        status: "warn",
        message:
          `o comando do tap rodou mas não gravou a amostra esperada (status ${resultado.status ?? "?"}, stderr: ${stderr || "vazio"}) — aviso de contexto (70%/85%) NÃO vai disparar. Rode: nexos install --force`,
        code: "CONTEXT_TAP_SAMPLE_MISSING",
      };
    }
    return {
      name: "Context tap (statusLine)",
      status: "pass",
      message: "amostra de contexto gravada corretamente pelo comando instalado",
    };
  } catch (error) {
    // A sonda nunca derruba o doctor: `<tmpdir>/nexos-context` como arquivo
    // (ENOTDIR) ou de outro usuário (EACCES) lançava da pré-limpeza e
    // `commands/doctor.ts` saía sem imprimir check nenhum.
    return {
      name: "Context tap (statusLine)",
      status: "warn",
      message: `sonda do tap falhou antes de medir (${error instanceof Error ? error.message : String(error)}) — aviso de contexto (70%/85%) não verificado`,
      code: "CONTEXT_TAP_PROBE_FAILED",
    };
  } finally {
    await fs.remove(amostraPath).catch(() => undefined);
  }
}
