/**
 * NEXOS — projeção de sessões.
 *
 * `status` é OBSERVADO, não verificado: ACTIVE significa "nenhum close foi
 * visto", jamais "confirmadamente rodando". A tela mostra `started_at` e
 * deixa quem lê julgar — inferir "provavelmente morreu" seria inventar um
 * estado que ninguém mediu.
 */

/**
 * ZERO REGISTRADAS != ZERO RODANDO.
 *
 * O registro de sessão é recente: sessões abertas ANTES dele não aparecem, e
 * só entram quando reiniciam. Medido em 2026-09-18: a tela mostrou 0 enquanto
 * TRÊS sessões reais operavam o mesmo checkout.
 *
 * E ha um segundo caminho para o mesmo zero: record removido a mao. Apagar
 * com `rm` e indistinguivel, para o consumidor, de record perdido — aconteceu
 * hoje e produziu uma conclusao de instabilidade sobre premissa falsa.
 *
 * Por isso a tela declara o que o zero significa em vez de deixar o leitor
 * concluir "não há ninguém trabalhando".
 */
export const EMPTY_MEANING = 'zero sessões registradas não é zero sessões rodando: o registro é recente e sessões abertas antes dele só aparecem ao reiniciar; remoção manual de record produz o mesmo zero';

/**
 * AMOSTRA PEQUENA DEMAIS PARA AFIRMAR COBERTURA — e o caminho até aqui é o
 * próprio aviso.
 *
 * Duas sessões mediram este número e as duas erraram igual, na mesma hora:
 *
 *   por arquivo MODIFICADO   7 e 10 "sessões"   <- errado nas duas
 *   por st_birthtime          0 sessões criadas  <- o que de fato houve
 *
 *   ARQUIVO MODIFICADO != SESSÃO INICIADA
 *
 * Sessões antigas continuam escrevendo no próprio transcript, então aparecem
 * como novas em qualquer contagem por data de modificação. A conclusão
 * anterior — "o produtor perde 8 de 10" — era uma fração inventada: não houve
 * oportunidade nenhuma de registro no período.
 *
 * O que o Store tem de fato: 1 record de uma sessão real e 1 probe de teste.
 * O produtor funcionou na única vez em que foi chamado. Isso NÃO prova
 * cobertura; prova que a cadeia fecha quando exercitada.
 *
 *   ZERO OPORTUNIDADE != ZERO FUNCIONAMENTO
 */
export const REGISTRY_INCOMPLETE = {
  medido: '1 sessão real registrada + 1 probe · 0 fechamentos · 0 sessões novas no período (2026-09-19)',
  porque: 'o registro nasceu em 18/09 20:12 e nenhuma sessão começou desde então — não houve oportunidade',
  consequencia: 'amostra pequena demais para afirmar cobertura; este número não representa as sessões reais',
};


export const OBSERVED_STATUS = /** @type {const} */ ({
  ACTIVE: 'sem close observado — não é prova de que está rodando',
  CLOSED: 'close observado',
});

export function isSameCheckout(a, b) {
  return a.cwd != null && a.cwd === b.cwd;
}

export function projectSessions(records, now = new Date()) {
  if (!Array.isArray(records)) throw new TypeError('sessions não é lista');

  const byStatus = {};
  const byCwd = {};
  for (const s of records) {
    byStatus[s.status ?? '(sem status)'] = (byStatus[s.status ?? '(sem status)'] || 0) + 1;
    const k = s.cwd ?? '(sem cwd)';
    (byCwd[k] = byCwd[k] || []).push(s);
  }

  const rows = records.map((s) => ({
    ...s,
    ageMinutes: s.started_at ? Math.floor((now.getTime() - Date.parse(s.started_at)) / 60000) : null,
    // null é NÃO SABIDO, nunca "nunca teve atividade".
    lastActivityKnown: s.last_activity_at != null,
  })).sort((a, b) => (b.ageMinutes ?? -1) - (a.ageMinutes ?? -1));

  /** Mais de uma sessão ACTIVE no mesmo checkout é a colisão que custou caro hoje. */
  const sharedCheckouts = Object.entries(byCwd)
    .filter(([, list]) => list.filter((s) => s.status === 'ACTIVE').length > 1)
    .map(([cwd, list]) => ({ cwd, active: list.filter((s) => s.status === 'ACTIVE').length }));

  return {
    rows, byStatus, sharedCheckouts,
    observedStatus: OBSERVED_STATUS,
    registryIncomplete: REGISTRY_INCOMPLETE,
    emptyMeaning: records.length === 0 ? EMPTY_MEANING : null,
    stats: {
      total: records.length,
      active: byStatus.ACTIVE ?? 0,
      closed: byStatus.CLOSED ?? 0,
      withoutLastActivity: records.filter((s) => s.last_activity_at == null).length,
      sharedCheckouts: sharedCheckouts.length,
    },
  };
}
