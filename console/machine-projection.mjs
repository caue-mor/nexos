/**
 * Sentidos internos da máquina — a parte do `nexosd` (doc 14) que NÃO exige
 * processo persistente nem permissão de sistema.
 *
 *   O DAEMON NÃO PRECISA EXISTIR PARA O DADO EXISTIR
 *
 * MEDIDO em 2026-09-19 na máquina do dono: a amostra inteira custa 0,113ms,
 * contra ~2s da geração do painel. Um daemon existe para amostrar CONTÍNUO e
 * NOTIFICAR; enquanto o console for gerado sob demanda e o dado custar isso,
 * o processo persistente não acrescenta nada que alguém consuma.
 *
 * O que ficou de fora porque o ambiente NEGA, não porque não interessa:
 *
 *   ps -eo ...           EPERM        processos e seu consumo
 *   os.uptime()          EPERM        tempo de máquina ligada
 *   connect(unix socket) EPERM        distinguir sessão viva de socket órfão
 *   sysctl vm.swapusage  negado       pressão de swap
 *
 * Essas são restrições do sandbox desta sessão, não da máquina. Afrouxá-las é
 * decisão do dono — aqui elas viram `null` declarado, nunca um palpite.
 *
 * Projeção PURA: recebe a amostra, não a colhe. Quem colhe é `collect.mjs`.
 */

/** Degrada para `null` — dado ausente é ausente, nunca estimado. */
const num = (v) => (typeof v === 'number' && Number.isFinite(v) ? v : null);

/**
 * `sessions` vem de contar sockets em `/tmp/cc-socks` (`collect.mjs`).
 *
 *   SOCKET EXISTE != SESSÃO ATIVA
 *
 * Medido: 4 sockets e 4 sessões reais (3 peers + esta) — o NÚMERO bate. O
 * `mtime` NÃO: o peer com quem esta sessão conversava tinha socket carimbado
 * 24h antes. Por isso `sessions` é "sessões registradas", e nunca se afirma
 * quantas estão trabalhando agora — para isso seria preciso conectar, que o
 * sandbox nega.
 */
export function projectMachine(raw) {
  if (!raw || typeof raw !== 'object') return { available: false, reason: 'amostra ausente' };

  const cores = num(raw.cores);
  const load = num(raw.load1);
  const perCore = cores && load !== null ? +(load / cores).toFixed(2) : null;

  return {
    available: true,
    cores,
    load1: load,
    /** Carga por core: 1.0 = saturado. Comparável entre máquinas, `load1` cru não é. */
    loadPerCore: perCore,
    loadLabel: perCore === null ? 'desconhecida' : perCore < 0.7 ? 'folgada' : perCore < 1 ? 'ocupada' : 'saturada',
    sessions: num(raw.sessions),
    sessionsMeaning: 'sessões Claude Code registradas neste computador (sockets locais) — registradas, não necessariamente trabalhando agora',
    projects: num(raw.projects),
    /** Declarado, nunca estimado: o que o ambiente recusou a medir. */
    denied: Array.isArray(raw.denied) ? raw.denied : [],
  };
}
