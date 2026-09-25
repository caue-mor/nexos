/**
 * PROJEÇÃO DA ANÁLISE DO GRAPHIFY — de símbolo, não de arquivo.
 *
 *   ANÁLISE QUE NINGUÉM LÊ NÃO É ANÁLISE
 *
 * O graphify roda a cada commit por hook (`[graphify hook] launching
 * background rebuild`) e escreve em `graphify-out/<data>/` desde 2026-09-16.
 * Ele já calcula quais peças concentram ligação demais, quais ligações
 * surpreendem e quais perguntas o grafo levanta — e nada disso chegava a
 * nenhuma tela. Seis dias de análise diária lidos por ninguém.
 *
 * Esta projeção NÃO executa o graphify e NÃO recalcula nada: lê o que ele
 * já escreveu. `READ DOES NOT EXECUTE` vale aqui como vale no resto do
 * Store.
 *
 *   DOIS GRAFOS, GRANULARIDADES DIFERENTES, NENHUM SUBSTITUI O OUTRO
 *
 * `.nexos/map/graph.json` liga ARQUIVO a arquivo (669 nós) e alimenta o
 * mapa visual. O graphify liga SÍMBOLO a símbolo (5705 nós) — função,
 * classe, tipo, com o arquivo e a LINHA de cada um. Um responde "o que
 * importa o quê"; o outro, "o que chama o quê". Misturar os dois numa
 * contagem só produziria um número que não descreve nem um nem outro.
 */
import { readdirSync, readFileSync, existsSync, statSync } from 'node:fs';
import { join } from 'node:path';

/** Quantas linhas de cada tabela a tela recebe. Acima disso vira ruído. */
const TETO_GRUPOS = 40;
/** Quantas peças mais ligadas a tela mostra. */
const TETO_CONCENTRADORES = 15;

/**
 * O grafo mistura arquivo, função, classe, documento e conceito no mesmo
 * saco. `schemas.ts` e `forProject()` são peças muito diferentes, e tratar
 * as duas como "nó" esconde do leitor o que ele está vendo.
 */
function tipoDeNo(no) {
  if (!no) return null;
  if (no.chamavelClasse) return 'classe';
  if (no.chamavel) return 'função';
  if (no.tipoArquivo === 'document') return 'documento';
  if (no.tipoArquivo === 'concept') return 'conceito';
  if (no.linha === '1') return 'arquivo';
  return 'tipo ou constante';
}

/**
 *   A PASTA COM DATA É BACKUP; O ESTADO VIVO ESTÁ NA RAIZ
 *
 * Medido: `graphify-out/graph.json` tem mtime de hoje 15:31, e
 * `graphify-out/2026-09-21/graph.json` tem OUTRO hash. O log da ferramenta
 * explica — "backed up curated graph (5 files) -> 2026-09-20/" — as pastas
 * datadas são cópias feitas ANTES de cada reconstrução, não a análise
 * daquele dia. Ler a pasta é ler um ciclo atrasado, sempre.
 *
 * Hoje a diferença é de 1 nó em 5720. Amanhã pode não ser, e nada avisaria.
 */
export function fonteViva(dirGraphify) {
  if (!existsSync(dirGraphify)) return null;
  if (existsSync(join(dirGraphify, 'graph.json'))) return { dir: dirGraphify, tipo: 'viva' };
  const bkp = pastaMaisRecente(dirGraphify);
  return bkp ? { dir: bkp, tipo: 'backup' } : null;
}

/**
 * A cópia mais recente, quando a raiz não tem o estado vivo.
 *
 * As pastas são nomeadas por data (`2026-09-21`), então ordenar por nome
 * ordena por data — mas só enquanto o formato for esse. Um nome fora do
 * padrão é ignorado em vez de quebrar a ordenação em silêncio.
 */
export function pastaMaisRecente(dirGraphify) {
  if (!existsSync(dirGraphify)) return null;
  const datas = readdirSync(dirGraphify)
    .filter((n) => /^\d{4}-\d{2}-\d{2}$/.test(n))
    .sort();
  const ultima = datas[datas.length - 1];
  return ultima ? join(dirGraphify, ultima) : null;
}

const lerJson = (caminho) => {
  try {
    return JSON.parse(readFileSync(caminho, 'utf8'));
  } catch {
    return null;
  }
};

/**
 * Índice id → { arquivo, linha, chamavel, grupo }.
 *
 * A análise identifica os símbolos só por `id` e `label`. Quem tem o
 * arquivo e a linha é o `graph.json`. Sem este cruzamento a tela mostraria
 * `forProject()` sem dizer ONDE ele mora, que é a única coisa que torna a
 * informação acionável.
 */
function indexarNos(grafo) {
  const idx = new Map();
  const porRotulo = new Map();
  const ambiguos = new Set();
  for (const n of grafo?.nodes ?? []) {
    if (!n?.id) continue;
    const info = {
      rotulo: n.label ?? n.id,
      arquivo: n.source_file ?? null,
      linha: typeof n.source_location === 'string' ? n.source_location.replace(/^L/, '') : null,
      chamavel: n._callable === true,
      chamavelClasse: n._callable_class === true,
      tipoArquivo: n.file_type ?? null,
      grupo: typeof n.community === 'number' ? n.community : null,
      grupoNome: n.community_name ?? null,
    };
    idx.set(n.id, info);
    /* Segundo índice, por nome — ver `resolver` abaixo. Nome repetido não
       escolhe vencedor: entra em `ambiguos` e deixa de resolver. */
    if (n.label) {
      if (porRotulo.has(n.label)) ambiguos.add(n.label);
      else porRotulo.set(n.label, info);
    }
  }
  return { idx, porRotulo, ambiguos };
}

/**
 *   QUEDA GRACIOSA MASCARA A CAUSA QUE ELA CONTORNA
 *
 * Aqui existia um `resolver()` que, quando o id da análise não batia com o
 * do grafo, caía para o NOME do símbolo e localizava assim. Funcionava — e
 * por isso escondeu o que importava.
 *
 * Uma verificação independente mediu o que a queda abafava: ZERO dos 10
 * ids cruzam, e o motivo não é formato, é que os dois arquivos saem de
 * EXECUÇÕES DIFERENTES da ferramenta. A análise não é regenerada desde
 * 15/08; só o grafo é. A divergência de id era a assinatura disso, e eu a
 * tratei como um detalhe a contornar.
 *
 * O contorno saiu. No lugar dele, a taxa de cruzamento de id vira MEDIDA
 * (`coerencia`) e a tela avisa. Um sintoma que aparece vale mais que um
 * sintoma que alguém contornou com elegância.
 */
/** `src/lib/capsule/paths.ts` + `67` → `src/lib/capsule/paths.ts:67`. */
const ondeMora = (no) => {
  if (!no?.arquivo) return null;
  return no.linha ? `${no.arquivo}:${no.linha}` : no.arquivo;
};

/**
 * Traduz o tipo de pergunta que o graphify gera.
 *
 *   NOME INTERNO NÃO É NOME DE TELA
 *
 * Os três tipos vêm crus em inglês (`bridge_node`, `isolated_nodes`,
 * `low_cohesion`). Um tipo novo do graphify cai em `null` e a tela mostra o
 * cru — visível, não escondido, para alguém traduzir.
 */
export const PERGUNTA_PT = {
  bridge_node: 'peça que costura grupos distantes',
  isolated_nodes: 'peças que ninguém chama',
  low_cohesion: 'grupo com pouca coisa em comum',
};


/** Percentual legível. `0.05493863237872589` é ruído, `5,5%` é informação. */
const pc = (n) => `${(n * 100).toFixed(1).replace('.', ',')}%`;

/** `Community 12` → o nome que a ferramenta deu ao grupo, quando existe. */
const nomeGrupo = (n, rotulos) => {
  const r = rotulos[String(n)];
  return r ? `«${r}»` : `grupo ${n}`;
};

/**
 *   TRADUZIR A FRASE É FRÁGIL; REMONTAR A PARTIR DOS DADOS NÃO É
 *
 * As perguntas chegam como texto em inglês com o dado embutido:
 * "Should `Community 0` be split…", "Cohesion score 0.05493863237872589".
 * Traduzir a string palavra por palavra manteria `Community 0`, que não
 * diz nada — o nome legível daquele grupo ("Matriz pós-MVP — Capabilities,
 * Memory…") está no arquivo de rótulos, ao lado.
 *
 * Então cada tipo conhecido é DESMONTADO por padrão e REMONTADO em
 * português com o nome do grupo e o número arredondado. Padrão que não
 * casa devolve o texto original — visível em inglês, que é melhor do que
 * uma tradução inventada ou uma linha em branco.
 */
function reescrever(q, rotulos) {
  const tipo = q.type ?? null;
  const original = q.pergunta ?? q.question ?? '';
  const porqueOriginal = q.why ?? null;
  let pergunta = original;
  let porque = porqueOriginal;

  if (tipo === 'bridge_node') {
    const m = original.match(/Why does `(.+?)` connect `Community (\d+)` to (.+)\?/);
    if (m) {
      const outros = [...m[3].matchAll(/Community (\d+)/g)].map((x) => nomeGrupo(x[1], rotulos));
      /* Nove nomes numa frase não se leem. Três e a contagem do resto, sim. */
      const mostra = outros.slice(0, 3).join(', ');
      const resto = outros.length - 3;
      pergunta = outros.length === 1
        ? `Por que \`${m[1]}\` liga o ${nomeGrupo(m[2], rotulos)} ao ${outros[0]}?`
        : `Por que \`${m[1]}\` liga o ${nomeGrupo(m[2], rotulos)} a outros ${outros.length} grupos — ${mostra}${resto > 0 ? ` e mais ${resto}` : ''}?`;
    }
    const c = porqueOriginal?.match(/centrality \(([\d.]+)\)/);
    if (c) porque = `Fica no caminho entre grupos que não se falam direto (centralidade de ponte ${pc(Number(c[1]))}). Mexer aqui alcança todos eles.`;
  }

  if (tipo === 'isolated_nodes') {
    const m = original.match(/What connects (.+?) to the rest of the system\?/);
    if (m) pergunta = `O que liga ${m[1]} ao resto do sistema?`;
    const c = porqueOriginal?.match(/(\d+) weakly-connected nodes/);
    if (c) porque = `${c[1]} peças quase sem ligação. Pode ser código que ninguém usa mais, ou ligação que o leitor não enxergou — as duas pedem conferência.`;
  }

  if (tipo === 'low_cohesion') {
    const m = original.match(/Should `Community (\d+)` be split/);
    if (m) pergunta = `O grupo ${nomeGrupo(m[1], rotulos)} deveria ser dividido em partes menores?`;
    const c = porqueOriginal?.match(/Cohesion score ([\d.]+)/);
    if (c) porque = `As peças deste grupo se usam pouco entre si (coesão ${pc(Number(c[1]))}) — costuma significar mais de um assunto no mesmo lugar.`;
  }

  return {
    tipo,
    tipoPt: PERGUNTA_PT[tipo] ?? null,
    pergunta,
    porque,
    /** `true` quando o padrão não casou e o texto seguiu em inglês. */
    cru: pergunta === original && /^(Why|What|Should|How)\b/.test(original),
  };
}

/**
 * O `why` das ligações inesperadas vem de um conjunto fechado de frases.
 * Repetido igual em todas as cinco linhas, ele não distingue nada — o que
 * distingue é O QUE cruza, que já está nas outras colunas.
 */
const PORQUE_INESPERADA = {
  'connects across different repos/directories; bridges separate communities':
    'cruza pastas distantes e costura grupos que normalmente não se tocam',
  'bridges separate communities': 'costura grupos que normalmente não se tocam',
  'connects across different repos/directories': 'cruza pastas distantes',
};

/**
 * Projeta a análise para a tela.
 *
 * Devolve SEMPRE o mesmo formato. Quando o graphify nunca rodou, `medido`
 * é `false` e `motivo` diz o que fazer — a tela mostra a lacuna, nunca uma
 * tela vazia que parece defeito.
 */
export function projetarGraphify(root, { agora = Date.now() } = {}) {
  const dir = join(root, 'graphify-out');
  const fonte = fonteViva(dir);
  if (!fonte) {
    return {
      medido: false,
      motivo: existsSync(dir)
        ? 'graphify-out existe mas não tem graph.json nem pasta de backup'
        : 'o graphify ainda não rodou neste projeto — rode `graphify .`',
    };
  }
  const pasta = fonte.dir;
  const nomePasta = fonte.tipo === 'viva' ? 'estado atual' : pasta.split('/').pop();
  const analise = lerJson(join(pasta, '.graphify_analysis.json'));
  const grafo = lerJson(join(pasta, 'graph.json'));
  if (!analise || !grafo) {
    return {
      medido: false,
      motivo: `a análise de ${nomePasta} não pôde ser lida (arquivo ausente ou JSON inválido)`,
    };
  }

  const rotulos = lerJson(join(pasta, '.graphify_labels.json')) ?? {};
  const indice = indexarNos(grafo);

  /**
   *   O NOME DA PASTA É A DATA DO GRAFO, NÃO A DA ANÁLISE
   *
   * Esta parte já esteve errada DUAS vezes, nas duas direções:
   *
   * 1. A primeira versão leu `mtime` e mostrou "37 dias". Parecia absurdo
   *    para uma pasta chamada `2026-09-21`, e eu "corrigi" para o nome da
   *    pasta — trocando um aviso CERTO por um erro.
   * 2. Uma verificação independente mediu o que eu não tinha medido:
   *    `.graphify_analysis.json` tem HASH IDÊNTICO nas seis pastas diárias,
   *    todas com mtime de 15 de agosto, enquanto `graph.json` tem seis
   *    hashes diferentes e mtime do dia. O graphify regenera o grafo todo
   *    dia e NÃO regenera a análise: ela é copiada para dentro da pasta
   *    nova.
   *
   * Então são DUAS datas e elas divergem de verdade. Mostrar só uma delas
   * é mentir em alguma das duas direções. A tela recebe as duas e o número
   * de dias entre elas.
   */
  const mtime = (f) => { try { return statSync(join(pasta, f)).mtime.getTime(); } catch { return null; } };
  const grafoEm = mtime('graph.json');
  const analiseEm = mtime('.graphify_analysis.json');
  const dias = (t) => (t === null ? null : Math.max(0, Math.floor((agora - t) / 86400000)));
  const iso = (t) => (t === null ? null : new Date(t).toISOString().slice(0, 10));

  /**
   *   O QUE DÁ PARA CALCULAR DO DADO FRESCO NÃO SE LÊ DO DADO VELHO
   *
   * A análise listava 10 concentradores com `degree: 35` para
   * `forProject()`. No grafo de hoje o grau dele é 148 — a análise é de
   * agosto, de um grafo muito menor. Exibir 35 como número de hoje é
   * errado, e não havia como saber pela análise sozinha.
   *
   * Grau é contagem de arestas: o grafo de hoje basta para calcular. Então
   * esta tabela deixa de depender da análise velha. O que NÃO dá para
   * recalcular — surpresas, perguntas, coesão — continua vindo dela, com a
   * data dela à vista.
   */
  const grau = new Map();
  for (const l of grafo.links ?? grafo.edges ?? []) {
    for (const ponta of [l.source, l.target]) {
      if (ponta != null) grau.set(ponta, (grau.get(ponta) ?? 0) + 1);
    }
  }
  const concentradores = [...grau.entries()]
    .sort((a, b) => b[1] - a[1])
    .slice(0, TETO_CONCENTRADORES)
    .map(([id, ligacoes]) => {
      const no = indice.idx.get(id);
      return {
        rotulo: no?.rotulo ?? id,
        ligacoes,
        onde: ondeMora(no),
        via: no ? 'grafo' : 'não encontrado',
        tipo: tipoDeNo(no),
        grupo: no?.grupoNome ?? (no?.grupo != null ? rotulos[String(no.grupo)] ?? `grupo ${no.grupo}` : null),
      };
    });

  /**
   * Coerência entre os dois arquivos, MEDIDA e não suposta.
   *
   * O sinal forte não é data — é se os identificadores se encontram. Zero
   * cruzamentos significa que os dois arquivos saíram de execuções
   * diferentes da ferramenta, e nenhum número de um descreve o outro.
   */
  const idsDoGrafo = indice.idx;
  const idsDaAnalise = (analise.gods ?? []).map((g) => g.id);
  const cruzam = idsDaAnalise.filter((id) => idsDoGrafo.has(id)).length;
  const coerencia = {
    idsConferidos: idsDaAnalise.length,
    idsQueCruzam: cruzam,
    /** `false` = análise e grafo são de execuções diferentes da ferramenta. */
    mesmaExecucao: idsDaAnalise.length === 0 ? null : cruzam > 0,
  };

  /** Ligações que cruzam fronteiras que ninguém esperava que cruzassem. */
  const inesperadas = (analise.surprises ?? []).map((s) => ({
    de: s.source ?? '?',
    para: s.target ?? '?',
    arquivos: Array.isArray(s.source_files) ? s.source_files : [],
    relacao: s.relation ?? null,
    /** EXTRACTED = lido do código. INFERRED = hipótese. Nunca achatar os dois. */
    certeza: s.confidence ?? null,
    porque: PORQUE_INESPERADA[s.why] ?? s.why ?? null,
  }));

  const perguntas = (analise.questions ?? []).map((q) => reescrever(q, rotulos));

  /**
   * Grupos: tamanho e coesão juntos, porque nenhum dos dois sozinho diz
   * nada. Coesão baixa num grupo de 3 peças é normal; num de 200 é sinal.
   */
  /**
   * Tamanho vem do grafo de hoje (contável); coesão vem da análise, que é
   * a única que a calcula. Quando as duas são de execuções diferentes, a
   * coesão fica `null` em vez de ser casada com um tamanho que não é dela
   * — número certo ao lado de número velho é o pior dos dois mundos.
   */
  const tamanhoPorGrupo = new Map();
  for (const n of indice.idx.values()) {
    if (n.grupo == null) continue;
    tamanhoPorGrupo.set(n.grupo, (tamanhoPorGrupo.get(n.grupo) ?? 0) + 1);
  }
  const coesaoConfiavel = coerencia.mesmaExecucao !== false;
  const comunidades = [...tamanhoPorGrupo.entries()]
    .map(([id, tamanho]) => ({
      id: String(id),
      nome: rotulos[String(id)] ?? `grupo ${id}`,
      tamanho,
      coesao: coesaoConfiavel && typeof analise.cohesion?.[String(id)] === 'number'
        ? analise.cohesion[String(id)]
        : null,
    }))
    .sort((a, b) => b.tamanho - a.tamanho);

  const comCoesao = comunidades.filter((c) => c.coesao !== null);

  return {
    medido: true,
    pasta: nomePasta,
    /** 'viva' = raiz de graphify-out; 'backup' = cópia datada, um ciclo atrás. */
    fonte: fonte.tipo,
    /**
     * Duas procedências, nunca achatadas numa só. `grafo` é recalculado a
     * cada commit; `analise` não é regenerada desde 15/08 neste projeto.
     */
    grafo: { em: iso(grafoEm), diasAtras: dias(grafoEm) },
    analise: { em: iso(analiseEm), diasAtras: dias(analiseEm) },
    /** Dias entre as duas leituras — 0 quando saíram juntas. */
    defasagemDias:
      grafoEm !== null && analiseEm !== null
        ? Math.max(0, Math.floor((grafoEm - analiseEm) / 86400000))
        : null,
    coerencia,
    totais: {
      simbolos: (grafo.nodes ?? []).length,
      ligacoes: (grafo.links ?? grafo.edges ?? []).length,
      grupos: comunidades.length,
      concentradores: concentradores.length,
      /** Peças sem nenhuma ligação no grafo de hoje. */
      semLigacao: [...indice.idx.keys()].filter((id) => !grau.has(id)).length,
      inesperadas: inesperadas.length,
      perguntas: perguntas.length,
      /** Chamáveis: função e método. O resto é tipo, constante, documento. */
      chamaveis: [...indice.idx.values()].filter((n) => n.chamavel).length,
      /**
       * Quantos concentradores a tela consegue apontar no código. Fica à
       * vista porque a divergência de id entre os dois arquivos do graphify
       * pode voltar numa versão nova e derrubar este número para zero — e
       * uma tabela com dez linhas e nenhum "onde" continua parecendo certa.
       */
      localizados: concentradores.filter((c) => c.onde).length,
      coesaoMedia: comCoesao.length
        ? comCoesao.reduce((s, c) => s + c.coesao, 0) / comCoesao.length
        : null,
    },
    concentradores,
    inesperadas,
    perguntas,
    /** O teto corta a CAUDA, que é ruído; os maiores grupos são o sinal. */
    comunidades: comunidades.slice(0, TETO_GRUPOS),
    comunidadesOmitidas: Math.max(0, comunidades.length - TETO_GRUPOS),
  };
}
