#!/usr/bin/env node
/**
 * NEXOS SECRET SHIELD — o consumidor que faltava para `redact()`.
 *
 *   CAPABILITY INSTALADA SEM CONSUMO NÃO É CAPABILITY
 *
 * MEDIDO em 2026-09-22/23, depois de o dono colar uma chave de API no chat e
 * perguntar por que nada a protegeu sozinho. A cadeia inteira foi medida:
 *
 *   1. `assets/hooks/nexos-secret-patterns.cjs` exporta `redact()`, e `redact()`
 *      tinha ZERO consumidores vivos. Os três que existiam
 *      (`nexos-governance-capture.js`, `nexos-instinct-observer.js`,
 *      `nexos-exec-log.js`) foram removidos em `abbcb4d3`; sobrou uma única
 *      menção ao nome, num COMENTÁRIO histórico de `scan-local-secrets.mjs`.
 *   2. O NexOS instala três hooks em `UserPromptSubmit` — o único evento que vê
 *      o que o humano digita — e NENHUM deles menciona segredo, credencial ou
 *      redação.
 *   3. O gate que protegia a lista canônica (`verify-secret-pattern-conformance.mts`)
 *      estava morto desde o mesmo commit: `ENOENT` no bloco 1, antes de qualquer
 *      prova rodar, mesmo estando no CI.
 *
 * Ou seja: não era limitação do host. A doc oficial (`code.claude.com/docs/en/hooks.md`)
 * é explícita — `UserPromptSubmit` com exit code 2 "blocks prompt processing and
 * ERASES the prompt", e o prompt bloqueado não é gravado no transcript. O
 * mecanismo existia e ninguém o ligou.
 *
 * ── POR QUE SÓ UM SUBCONJUNTO DOS PADRÕES ──
 *
 *   BLOQUEAR O PROMPT É DESTRUTIVO — O TEXTO DO HUMANO É APAGADO
 *
 * Exit 2 apaga o que a pessoa escreveu. Um falso positivo aqui não é ruído: é
 * trabalho perdido. Por isso este hook NÃO usa a lista canônica inteira. Ele
 * usa uma allowlist POR NOME das formas com prefixo próprio + entropia, que os
 * controles negativos de `tests/secret-guard-chaves-de-provider.test.ts`
 * provaram não disparar em prosa que apenas MENCIONA o prefixo.
 *
 * Ficam DE FORA, de propósito, as três formas genéricas:
 *   `generic_secret`  — casa `token: "qualquer-coisa"`, que aparece em todo
 *                       trecho de código legítimo que alguém cola para revisar.
 *   `bearer_token`    — casa o `Authorization:` de qualquer exemplo de curl.
 *   `database_url`    — casa `postgres://localhost/dev` de qualquer README.
 * Bloquear o prompt por uma dessas seria trocar um vazamento raro por perda de
 * trabalho frequente, e a pessoa desligaria o hook na terceira vez.
 *
 * A allowlist é por NOME, não por índice nem "todos menos N": quando alguém
 * acrescentar um padrão ao canônico, ele NÃO entra no bloqueio por acidente —
 * entra quando um humano escrever o nome aqui e disser que a forma é
 * inequívoca o bastante para apagar o prompt de alguém.
 */
'use strict';

const path = require('node:path');

/** Formas inequívocas o bastante para justificar apagar o prompt. Por NOME —
 * ver o bloco acima sobre por que não é "a lista toda". */
const FORMAS_QUE_BLOQUEIAM = new Set([
  'ctx7_key',
  'anthropic_key',
  'openai_key',
  'npm_token',
  'slack_token',
  'google_api_key',
  'gitlab_token',
  'github_token',
  'supabase_key',
  'aws_key',
  'private_key',
]);

/**
 * FAIL OPEN, e é uma escolha, não um descuido: se este hook não conseguir
 * carregar o canônico ou parsear o payload, ele deixa o prompt passar. Um
 * escudo quebrado que engole todo prompt do dono é pior que um escudo ausente
 * — ele torna a sessão inutilizável e será arrancado no mesmo dia. O Store
 * continua FAIL CLOSED atrás disto (`assertNoSecretPatternMatch`), que é onde
 * fechar custa barato.
 */
function main() {
  let canonico;
  try {
    canonico = require(path.join(__dirname, 'nexos-secret-patterns.cjs'));
  } catch {
    process.exit(0);
  }

  let bruto = '';
  try {
    bruto = require('node:fs').readFileSync(0, 'utf-8');
  } catch {
    process.exit(0);
  }

  let prompt = '';
  try {
    const payload = JSON.parse(bruto);
    prompt = typeof payload.prompt === 'string' ? payload.prompt : '';
  } catch {
    process.exit(0);
  }
  if (!prompt) process.exit(0);

  const casadas = [];
  for (const { name, pattern } of canonico.SECRET_PATTERNS) {
    if (!FORMAS_QUE_BLOQUEIAM.has(name)) continue;
    const global = new RegExp(pattern.source, pattern.flags.includes('g') ? pattern.flags : `${pattern.flags}g`);
    const achados = prompt.match(global);
    if (!achados) continue;
    // Fixture pública conhecida não é credencial — mesma regra do canônico.
    if (achados.every((m) => canonico.isKnownPlaceholder(m))) continue;
    casadas.push(name);
  }

  if (casadas.length === 0) process.exit(0);

  /**
   * A mensagem nomeia o PADRÃO e nunca o valor — nem mascarado, nem prefixo,
   * nem tamanho. É a mesma regra que o resto do repo segue, e vale em dobro
   * aqui: stderr de hook bloqueador é exibido, e exibir metade da chave
   * derrotaria o motivo de ter bloqueado.
   */
  process.stderr.write(
    [
      '',
      `NEXOS SECRET SHIELD — prompt bloqueado e apagado (${casadas.length} forma(s): ${casadas.join(', ')}).`,
      '',
      'O texto tinha a FORMA de uma credencial conhecida. O prompt foi apagado antes',
      'de entrar no transcript, que e persistido e pode ser compartilhado.',
      '',
      'O que fazer:',
      '  1. Poe o valor numa variavel de ambiente e cita o NOME dela, nunca o valor.',
      '  2. Se o valor ja circulou em outro lugar, trate-o como comprometido.',
      '  3. Falso positivo? Reescreva sem o literal — descrever o formato basta.',
      '',
      'FORMA DE CREDENCIAL != CREDENCIAL: casar um padrao prova a forma, nunca a',
      'procedencia. Este escudo erra para o lado de apagar.',
      '',
    ].join('\n')
  );
  process.exit(2);
}

main();
