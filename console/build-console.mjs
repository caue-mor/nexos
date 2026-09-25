/**
 * Gera console/console.html — o control center: health, checkpoints, memória,
 * capabilities, decisões e research numa tela só, com navegação entre elas.
 *
 * Auto-contido, zero dependência: abre por duplo clique em file://.
 */
import { existsSync, readFileSync, writeFileSync } from 'node:fs';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { collectAll, findRoot } from './collect.mjs';
import { projectHealth, HEALTH_GAPS } from './health-projection.mjs';
import { evidenceReachability, projectCheckpoints } from './checkpoint-projection.mjs';
import { projectMemory } from './memory-projection.mjs';
import { projectCapabilities } from './capability-projection.mjs';
import { projectMachine } from './machine-projection.mjs';
import { projectDecisions, projectResearch } from './store-projection.mjs';
import { projectEvidence } from './evidence-projection.mjs';
import { projectSessions } from './session-projection.mjs';
import { projectRelease } from './release-projection.mjs';

const here = dirname(fileURLToPath(import.meta.url));
const root = process.argv[2] ?? findRoot();
if (!root) { console.error('raiz do checkout não encontrada (precisa de dist/ + bin/)'); process.exit(2); }

const raw = collectAll(root);
/** Projeta se a fonte veio; senão registra a indisponibilidade como dado. */
const guard = (src, fn) => (src.ok ? { ok: true, value: fn(src.data) } : { ok: false, unavailable: src.unavailable });
const healthSrc = guard(raw.doctor, projectHealth);
const capsSrc = guard(raw.capabilities, (d) => projectCapabilities(d, raw.capabilitiesUsage?.ok ? raw.capabilitiesUsage.data : undefined));
const health = healthSrc.ok ? healthSrc.value : null;
const checkpoints = projectCheckpoints(raw.checkpoints);
const reach = evidenceReachability(raw.checkpoints, new Set(raw.evidenceSubjects));
const memory = projectMemory(raw.knowledge);
const review = raw.memoryReview.ok ? raw.memoryReview.data : null;
const capabilities = capsSrc.ok ? capsSrc.value : null;
const machine = projectMachine(raw.machine);
const decisions = projectDecisions(raw.decisions);
const research = projectResearch(raw.research);
const evidence = projectEvidence(raw.evidence);
const release = projectRelease(raw.releaseChain);
const sessions = raw.sessions.ok ? projectSessions(raw.sessions.data.sessions ?? []) : null;

/** Só o que a tela mostra. Mapa e Set não sobrevivem a JSON. */
const payload = {
  collectedAt: raw.collectedAt,
  root,
  boot: raw.boot.ok ? raw.boot.data : { unavailable: raw.boot.unavailable },
  health: !health ? { unavailable: healthSrc.unavailable } : {
    state: health.state, severity: health.severity, known: health.known, reasons: health.reasons,
    areas: health.areas, actionable: health.actionable, advisoryOnly: health.advisoryOnly,
    stats: health.stats, gaps: HEALTH_GAPS,
  },
  checkpoints: {
    byState: checkpoints.byState, byStateHead: checkpoints.byStateHead, reasonGap: checkpoints.reasonGap, stats: checkpoints.stats, reach,
    danglingLinks: checkpoints.danglingLinks.slice(0, 50),
    withoutReason: checkpoints.withoutReason.slice(0, 200).map((c) => ({
      id: c.id, state: c.content.state, statement: (c.content.statement ?? '').slice(0, 160), actor: c.content.actor_ref,
    })),
  },
  memory: {
    stats: memory.stats, byBucket: memory.byBucket, promotion: memory.promotion, countSource: memory.countSource,
    canonical: review
      ? { stats: review.stats, queue: review.queue.slice(0, 200) }
      : { unavailable: raw.memoryReview.unavailable },
    byProposer: Object.fromEntries(Object.entries(memory.byProposer).sort((a, b) => b[1] - a[1]).slice(0, 12)),
    queue: memory.queue.slice(0, 200).map((q) => ({
      id: q.id, days: q.days, bucket: q.bucket, hasEvidence: q.hasEvidence,
      fact: (q.fact ?? '').slice(0, 200), proposedBy: q.proposedBy, proposedKind: q.proposedKind,
    })),
  },
  machine,
  /* Já projetado em `collect.mjs` — aqui só atravessa para a tela. */
  graphify: raw.graphify,
  capabilities: !capabilities ? { unavailable: capsSrc.unavailable } : {
    byRung: capabilities.byRung, byKind: capabilities.byKind, bySource: capabilities.bySource,
    ativasPorKind: capabilities.ativasPorKind, ativasPorSource: capabilities.ativasPorSource,
    stats: capabilities.stats, unmeasured: capabilities.unmeasured, usageScan: capabilities.usageScan,
    byIssue: capabilities.byIssue, issueMeaning: capabilities.issueMeaning,
    unreadable: capabilities.items.filter((i) => !i.description || !i.description.trim())
      .slice(0, 200).map((i) => ({ kind: i.kind, name: i.name, source: i.source, chars: i.listing_chars })),
  },
  decisions: {
    stats: decisions.stats,
    /* As últimas decisões, para a visão geral responder "o que aconteceu". */
    ultimas: decisions.ultimas,
    withoutConsequences: decisions.withoutConsequences.slice(0, 100).map((d) => ({ id: d.id, title: d.content?.title })),
  },
  research: { stats: research.stats, emptyIsTheFinding: research.emptyIsTheFinding, diverged: research.diverged },
  release: { links: release.links, stats: release.stats, remedy: release.remedy, healthy: release.healthy, reference: release.reference },
  evidence: {
    stats: evidence.stats, byOutcome: evidence.byOutcome, byBinding: evidence.byBinding,
    gaps: evidence.gaps,
    byGate: Object.fromEntries(Object.entries(evidence.byGate).sort((a, b) => b[1] - a[1]).slice(0, 12)),
  },
  sessions: sessions
    ? { stats: sessions.stats, rows: sessions.rows.slice(0, 100), sharedCheckouts: sessions.sharedCheckouts, observedStatus: sessions.observedStatus, emptyMeaning: sessions.emptyMeaning, registryIncomplete: sessions.registryIncomplete }
    : { unavailable: raw.sessions.unavailable },
};

const html = readFileSync(join(here, 'console-template.html'), 'utf8')
  .replace('/*__PAYLOAD__*/null', () => JSON.stringify(payload))
  /**
   *   O USUÁRIO FINAL NÃO TEM TAILWIND, E NÃO PRECISA TER
   *
   * O painel é um HTML único aberto por `file://`. O CSS do sistema de
   * design é gerado em desenvolvimento (`npm run console:css`), versionado
   * em `console/tailwind.css` e INJETADO aqui. Quem instala o pacote npm
   * recebe o arquivo pronto; nada de bundler no caminho dele.
   *
   * Ausência do arquivo não derruba a geração — o painel perde os tokens
   * novos e segue com o CSS embutido, que é degradação visível e não
   * silenciosa (o console avisa).
   */
  .replace('/*__TAILWIND__*/', () => {
    const css = join(here, 'tailwind.css');
    if (!existsSync(css)) {
      console.error('  (aviso: console/tailwind.css ausente — rode `npm run console:css`)');
      return '';
    }
    return readFileSync(css, 'utf8');
  });
// Destino explícito via NEXOS_CONSOLE_OUT. Sem isso, qualquer execução com
// outro --root sobrescreve o painel do projeto real — foi o que aconteceu:
// o teste rodou num diretório temporário e o painel do usuário passou a
// mostrar "0/4 partes em dia" de um projeto vazio.
const out = process.env.NEXOS_CONSOLE_OUT ?? join(here, 'console.html');
writeFileSync(out, html);

// GATE DE EXECUÇÃO. O conteúdo da tela é gerado por JS inline, e nenhum teste
// de projeção alcança o artefato concatenado — eles testam os módulos.
//
//     SINTAXE VÁLIDA != CÓDIGO QUE RODA
//
// O gate anterior só chamava `new Function(src)`, que compila sem executar.
// Três defeitos reais passaram por ele E por 129 testes verdes, num bloco de
// 12 linhas, e só apareceram quando a página foi ABERTA num navegador:
//
//     M is not defined          renomeação por prefixo (`M.` -> `MAQ.`)
//                               não alcança `M` usado sem ponto
//     out is not defined        padrão copiado de uma seção que acumula em
//                               variável para outra que retorna expressão
//     rows.join is not a function  `.join('')` a mais num argumento que já
//                               esperava array
//
// Agora cada renderizador de aba é EXECUTADO com o payload real. Não prova
// aparência — prova que cada aba produz algo em vez de explodir.
{
  const blocos = [...html.matchAll(/<script>([\s\S]*?)<\/script>/g)].map((m) => m[1]);
  /**
   * Stub que absorve qualquer uso de DOM: devolve a si mesmo em qualquer
   * propriedade, é chamável, e é iterável (para `[...document.querySelectorAll()]`).
   * O objetivo é deixar o código de APRESENTAÇÃO rodar, não simular navegador.
   */
  const qualquer = new Proxy(function () {}, {
    get: (_t, prop) => (prop === Symbol.iterator ? function* () {} : prop === Symbol.toPrimitive ? () => '' : qualquer),
    apply: () => qualquer,
    construct: () => qualquer,
    set: () => true,
    has: () => true,
  });
  for (const [i, src] of blocos.entries()) {
    let panes;
    try {
      panes = new Function(
        'document', 'window', 'location', 'navigator', 'requestAnimationFrame', 'matchMedia',
        `${src}\n;return typeof panes !== 'undefined' ? panes : null;`
      )(qualquer, qualquer, qualquer, qualquer, qualquer, qualquer);
    } catch (err) {
      console.error(`\nO SCRIPT ${i + 1}/${blocos.length} NÃO RODA: ${err.message}`);
      console.error('A tela ficaria em branco. Nada foi publicado como válido.');
      process.exit(1);
    }
    if (!panes) continue;
    for (const [nome, render] of Object.entries(panes)) {
      try {
        const saida = render();
        if (typeof saida !== 'string' || saida.length === 0) {
          console.error(`\nA ABA "${nome}" não produziu conteúdo (${typeof saida}).`);
          process.exit(1);
        }
      } catch (err) {
        console.error(`\nA ABA "${nome}" EXPLODE ao renderizar: ${err.message}`);
        console.error('Ela ficaria em branco na tela. Nada foi publicado como válido.');
        process.exit(1);
      }
    }
  }
}

console.log(`gerado ${out}  (${(html.length / 1024).toFixed(0)}KB)`);
console.log(`  evidencia alcancavel ${reach.reachable}/${reach.terminals} (nao alcancam ${reach.unreachable})`);
console.log(`  boot ${payload.boot.state ?? "?"}/${payload.boot.workState ?? "?"} · health ${payload.health.state ?? "INDISPONÍVEL"} · checkpoints ${checkpoints.stats.total} (${checkpoints.stats.terminalsWithoutReason} sem motivo)`);
console.log(`  fila canonica ${review?.stats.total ?? "INDISPONIVEL"} (diretorio ${memory.stats.candidatesInDirectory}) · mais velho ${review?.stats.oldestDays ?? "?"}d · capabilities ${capabilities?.stats.total ?? "INDISPONÍVEL"}`);
console.log(`  release ${release.stats.inSync}/${release.stats.total} em dia · pior distância ${release.stats.worstDistance} commits · desconhecidos ${release.stats.unknown}`);
console.log(`  evidence ${evidence.stats.total} (${evidence.stats.legacy} legadas) · sessions ${sessions?.stats.total ?? "INDISPONIVEL"} (${sessions?.stats.sharedCheckouts ?? "?"} checkout compartilhado)`);
console.log(`  decisões ${decisions.stats.total} (${decisions.stats.revoked} revogadas) · research ${research.stats.readable}/${research.stats.onDisk} legíveis`);
