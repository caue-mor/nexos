/**
 * Coleta IMPURA para o console: executa o CLI e lê o Store do disco.
 * Fica separada das projeções de propósito — elas continuam puras e testáveis.
 *
 * ponytail: o leitor de YAML é por regex e cobre só os campos escalares que as
 * projeções usam. Teto conhecido: quebra em valor multilinha. Upgrade path: os
 * contratos `nexos boot --json` e a listagem de cadeia de checkpoints já foram
 * pedidos ao core; quando existirem, esta função sai inteira.
 */
import { execFileSync } from 'node:child_process';
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs';
import { join, resolve } from 'node:path';
import { projetarGraphify } from './graphify-projection.mjs';
import { cpus, homedir, loadavg } from 'node:os';

/** Raiz do checkout principal: é a única que tem dist/ (build não versionado). */

/**
 * Sentidos internos — 0,113ms medidos, contra ~2s do painel inteiro.
 *
 * Cada sentido é tentado ISOLADO: um negado não derruba os outros, e vira
 * linha em `denied` em vez de sumir. `DADO AUSENTE NÃO É ZERO`.
 */
function sampleMachine() {
  const denied = [];
  const tentar = (nome, f) => {
    try { return f(); } catch (e) { denied.push(`${nome}: ${e.code ?? 'erro'}`); return undefined; }
  };
  return {
    cores: tentar('os.cpus', () => cpus().length),
    load1: tentar('os.loadavg', () => loadavg()[0]),
    /** Contar sockets, nunca conectar: connect() é negado pelo sandbox e mtime não reflete atividade. */
    sessions: tentar('cc-socks', () => readdirSync('/tmp/cc-socks').filter((f) => f.endsWith('.sock')).length),
    projects: tentar('claude/projects', () => readdirSync(join(homedir(), '.claude', 'projects')).length),
    denied,
  };
}

export function findRoot(from = process.cwd()) {
  for (let dir = from, i = 0; i < 6; i += 1, dir = resolve(dir, '..')) {
    if (existsSync(join(dir, 'dist', 'index.js')) && existsSync(join(dir, 'bin', 'nexos.js'))) return dir;
  }
  return null;
}

/**
 * Uma fonte indisponível NÃO derruba o console inteiro.
 *
 * Medido ao vivo: o build da raiz apagou dist/index.js entre duas execuções
 * (outra sessão compilando) e o gerador morreu inteiro por causa de uma fonte.
 * Um painel de saúde que some quando algo está errado é o oposto de um painel
 * de saúde. Falha vira dado: a aba diz INDISPONÍVEL e por quê.
 */
export function runJson(root, args) {
  try {
    const out = execFileSync('node', ['bin/nexos.js', ...args], {
      cwd: root, encoding: 'utf8', timeout: 180000, maxBuffer: 64 * 1024 * 1024,
    });
    return { ok: true, data: JSON.parse(out) };
  } catch (err) {
    const why = (err?.stderr || err?.message || String(err)).toString().trim().split('\n')[0];
    return { ok: false, data: null, unavailable: `nexos ${args.join(' ')}: ${why}` };
  }
}

const scalar = (text, key) => (text.match(new RegExp(`^${key}: *"?([^"\\n]*)"?$`, 'm')) || [])[1] ?? null;
const nested = (text, key) => (text.match(new RegExp(`^  ${key}: *"?([^"\\n]*)"?$`, 'm')) || [])[1] ?? null;
const hasNested = (text, key) => new RegExp(`^  ${key}:`, 'm').test(text);
/** Indentação de 4: campos dentro de content.continuity, como o status de revogação. */
const deep = (text, key) => (text.match(new RegExp(`^    ${key}: *"?([^"\\n]*)"?$`, 'm')) || [])[1] ?? null;

/** @param {string} dir */
export function readFamily(dir) {
  if (!existsSync(dir)) return [];
  return readdirSync(dir)
    .filter((f) => f.endsWith('.yaml') && statSync(join(dir, f)).isFile())
    .map((f) => {
      const t = readFileSync(join(dir, f), 'utf8');
      return {
        id: scalar(t, 'id'),
        kind: scalar(t, 'kind'),
        created_at: scalar(t, 'created_at'),
        previous_checkpoint_id: scalar(t, 'previous_checkpoint_id'),
        content: {
          state: nested(t, 'state'),
          statement: nested(t, 'statement'),
          actor_ref: nested(t, 'actor_ref'),
          verification: hasNested(t, 'verification') ? {} : null,
          fact: nested(t, 'fact'),
          evidence: nested(t, 'evidence'),
          origin_note: nested(t, 'origin_note'),
          proposed_kind: nested(t, 'proposed_kind'),
          title: nested(t, 'title'),
          decision: nested(t, 'decision'),
          consequences: nested(t, 'consequences'),
          // ATENÇÃO: `  status` é admission.status e vale "admitted" em 100%
          // dos records. O status da DECISÃO mora em content.continuity.status,
          // indentado a 4. Ler o de cima reportava 0 revogadas onde havia 8.
          status: deep(t, 'status'),
          revocation_reason: deep(t, 'revocation_reason'),
          question: nested(t, 'question'),
          source_ref: nested(t, 'source_ref') ?? scalar(t, 'source_ref'),
          sources: hasNested(t, 'sources') ? ['(presente)'] : [],
        },
      };
    });
}

/**
 * Ids citados por evidence. Mora em `.nexos/.local/evidence` — diretorio
 * OCULTO, e glob com `**` nao entra la. Uma medicao que usou glob deu 0 de
 * 111 e teria "confirmado" a conclusao errada.
 */
export function readEvidenceSubjects(root) {
  const dir = join(root, '.nexos', '.local', 'evidence');
  const out = new Set();
  if (!existsSync(dir)) return out;
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try {
      const e = JSON.parse(readFileSync(join(dir, f), 'utf8'));
      if (e.subject_ref) out.add(e.subject_ref);
    } catch { /* evidence ilegivel nao derruba a coleta */ }
  }
  return out;
}

/** Records de evidence inteiros (nao so os subject_ref). */
export function readEvidence(root) {
  const dir = join(root, '.nexos', '.local', 'evidence');
  if (!existsSync(dir)) return [];
  const out = [];
  for (const f of readdirSync(dir)) {
    if (!f.endsWith('.json')) continue;
    try { out.push(JSON.parse(readFileSync(join(dir, f), 'utf8'))); }
    catch { /* evidence ilegivel nao derruba a coleta */ }
  }
  return out;
}

/**
 * Observa os quatro elos DIRETAMENTE, em vez de parsear a linha de texto do
 * doctor: só assim dá para medir a DISTÂNCIA em commits, que é o que torna o
 * achado acionável. Cada elo que não puder ser lido volta `value: null` —
 * nunca um palpite.
 */
export function observeReleaseChain(root) {
  const readJsonFile = (p) => { try { return JSON.parse(readFileSync(p, 'utf8')); } catch { return null; } };
  const git = (args) => {
    try { return execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim(); }
    catch { return null; }
  };
  const distance = (from) => {
    if (!from) return null;
    const n = git(['rev-list', '--count', `${from}..HEAD`]);
    return n == null ? null : Number(n);
  };

  const source = git(['rev-parse', 'HEAD']);
  const build = readJsonFile(join(root, 'dist', 'build-info.json'))?.commit ?? null;

  // O runtime é o dist que o binario do PATH executa — nao o do worktree.
  let runtime = null;
  let runtimeNote = null;
  try {
    const where = execFileSync('which', ['nexos'], { encoding: 'utf8' }).trim();
    const pkgRoot = resolve(where, '..', '..', 'lib', 'node_modules', 'nexos-cli');
    runtime = readJsonFile(join(pkgRoot, 'dist', 'build-info.json'))?.commit ?? null;
    if (runtime == null) runtimeNote = 'binario encontrado, build-info ilegivel';
  } catch { runtimeNote = 'nenhum binario nexos no PATH'; }

  const assetsRaw = readJsonFile(join(process.env.HOME ?? '', '.claude', '.nexos-version'));

  return {
    SOURCE: { value: source, distance: source ? 0 : null },
    BUILD: { value: build, distance: distance(build) },
    RUNTIME: { value: runtime, distance: distance(runtime), note: runtimeNote },
    // ASSETS é VERSÃO SEMÂNTICA, não commit: comparar com o hash do SOURCE
    // produzia DIVERGED permanente mesmo com tudo instalado corretamente —
    // alarme falso que ensina o usuário a ignorar a tela. A referência certa
    // é a versão declarada no package.json.
    ASSETS: {
      value: assetsRaw?.version ?? null,
      distance: null,
      compareTo: readJsonFile(join(root, 'package.json'))?.version ?? null,
      note: assetsRaw?.installedAt ? `instalado ${assetsRaw.installedAt}` : null,
    },
  };
}

export function collectAll(root) {
  const rec = (fam) => readFamily(join(root, '.nexos', 'records', fam));
  return {
    doctor: runJson(root, ['doctor', '--project', '--json']),
    machine: sampleMachine(),
    /**
     * Leitura pura de `graphify-out/`, sem subprocesso: o graphify já roda
     * por hook a cada commit. Custa um readFile — não entra no opt-in de
     * `--usage`, que existe para o que custa 34s.
     */
    graphify: projetarGraphify(root),
    capabilities: runJson(root, ['capabilities', '--json']),
    /**
     * OPT-IN por env var (`nexos console --usage`): varre 1665 transcritos e
     * custa ~34s, contra ~2s do resto do painel inteiro. Fora do caminho
     * padrão de propósito — o console é para olhar rápido.
     */
    capabilitiesUsage: process.env.NEXOS_CONSOLE_USAGE
      ? runJson(root, ['capabilities', '--usage', '--json'])
      : { ok: false, unavailable: 'não solicitado (use --usage)' },
    // O Store no disco não depende de build: continua legível mesmo enquanto
    // outra sessão recompila dist/.
    // FONTE CANÔNICA desde 84091e65: contrato de máquina, não regex sobre
    // YAML. `verification` e `actor_ref` vêm null EXPLÍCITO, então ausência e
    // omissão deixam de ser a mesma coisa no parse. Degrada para o leitor de
    // disco se o comando falhar — o achado dos 84 sem motivo não pode sumir
    // da tela só porque o build da raiz está no meio de uma recompilação.
    checkpoints: (() => {
      const r = runJson(root, ['checkpoint', '--json']);
      if (r.ok && Array.isArray(r.data?.checkpoints) && !r.data.error) return r.data.checkpoints;
      return rec('checkpoints');
    })(),
    // `boot --json` é leitura pura desde dc30823b. Verifiquei por conta
    // própria antes de ligar: 5 chamadas, bootstrap_proposal 5 → 5, knowledge
    // 1503 → 1503. (A primeira tentativa, por hash da árvore inteira, deu
    // falso positivo — num checkout compartilhado isso mede as outras sessões.)
    boot: runJson(root, ['boot', '--json']),
    // FONTE CANONICA da fila: o funil, nao o diretorio. 259 arquivos
    // kind=memory_candidate no disco correspondiam a 88 candidatos reais.
    memoryReview: runJson(root, ['memory', '--review', '--json']),
    // O diretorio CONTINUA sendo lido, de proposito: e a comparacao que torna
    // a diferenca visivel na tela. Numero honesto e rotulado vale mais que
    // numero certo e mudo.
    knowledge: rec('knowledge'),
    // FONTE CANONICA: `nexos decision` devolve os heads correntes em JSON.
    // Ler o diretorio dava 171 arquivos para 73 decisoes vigentes - o mesmo
    // defeito de contar historico que apareceu na memoria, por outro caminho.
    // Aqui existe comando canonico, entao corrige de verdade em vez de so
    // declarar a lacuna.
    decisions: (() => {
      const r = runJson(root, ['decision']);
      if (r.ok && Array.isArray(r.data)) {
        return r.data.map((d) => ({
          id: d.id,
          content: {
            title: d.content?.title ?? null,
            decision: d.content?.decision ?? null,
            consequences: d.content?.continuity?.conditions ?? null,
            status: d.content?.continuity?.status ?? null,
            revocation_reason: d.content?.continuity?.revocation_reason ?? null,
          },
        }));
      }
      return rec('decisions');
    })(),
    research: rec('research'),
    evidenceSubjects: [...readEvidenceSubjects(root)],
    evidence: readEvidence(root),
    releaseChain: observeReleaseChain(root),
    sessions: runJson(root, ['sessions', '--json']),
    collectedAt: new Date().toISOString(),
  };
}
