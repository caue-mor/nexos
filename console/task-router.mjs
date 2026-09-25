/**
 * NEXOS — roteador por TAREFA, não por palavra.
 *
 * PROBLEMA MEDIDO (knw_01M2VZNAYAHD01KH9X370NSA0M):
 * o recall casa termo literal do prompt, então a regra só chega a quem já
 * conhece a palavra que ela usa — exatamente quem NÃO precisa dela. Medido:
 * buscar "funnel" acha ONE WRITE FUNNEL; o prompt em português "quantos
 * candidatos existem no diretório" não traz nada, e foi esse o erro que três
 * sessões cometeram no mesmo dia com a regra guardada.
 *
 * PADRÃO DE ORIGEM: Abilityai/trinity, AGENTS.md (Apache 2.0). Não é porte de
 * código — é o formato da tabela de roteamento:
 *
 *   | Your task | Go to | Done when |
 *
 * e cada procedimento carrega comandos exatos, verificação e fatos-chave.
 *
 * O QUE MUDA: em vez de perguntar "que memória parece com este texto?",
 * pergunta-se "que TAREFA é esta?" e a tarefa carrega o que precisa ser
 * sabido. Uma tarefa não muda de nome porque quem a descreve usa outras
 * palavras.
 *
 * LIMITE DESTE PROTÓTIPO, declarado: as rotas são escritas à mão. Isso prova
 * que o roteamento por tarefa resolve o caso que o recall perde — NÃO prova
 * que rotas podem ser derivadas automaticamente do Store.
 */

/**
 * Cada rota tem o que o AGENTS.md do Trinity tem: gatilhos, o que saber,
 * o comando exato e o critério de pronto.
 */
export const ROTAS = [
  {
    tarefa: 'contar registros de uma família do Store',
    gatilhos: [
      'quantos', 'contar', 'total de', 'ls ', 'wc -l',
      'candidatos', 'records', 'registros', 'diretório', 'diretorio', 'arquivos em .nexos',
    ],
    saiba: 'O Store guarda HISTÓRICO: cada correção, promoção ou deprecação cria um record novo e o antigo continua no disco. Contar arquivos conta o passado inteiro como se fosse pendência. Medido: 259 arquivos no diretório para 87 candidatos reais.',
    regra: 'ONE WRITE FUNNEL != ONE READ FUNNEL',
    comando: 'nexos memory --review --json   # heads correntes, não arquivos',
    naoFaca: 'ls .nexos/records/<família> | wc -l',
    prontoQuando: 'o número citado veio de um comando que resolve heads, não de contagem de arquivo',
  },
  {
    tarefa: 'medir se algo está sendo usado no código',
    gatilhos: ['está sendo usado', 'tem consumidor', 'é morto', 'morto', 'posso remover', 'dead code', 'sem uso', 'isolado'],
    saiba: 'grep com padrão errado devolve zero e parece ausência. Um import pode vir por caminho relativo diferente do que você procurou. Medido hoje: procurei `from "./session-events"` e o import real era `from "../../lib/capsule/session-events.js"` — conclui cadeia morta sobre função viva.',
    regra: 'NOT FOUND BY GREP != ABSENT · MENÇÃO != USO',
    comando: 'grep -rn "<símbolo>" src/ tests/ console/   # só o símbolo, sem supor o caminho',
    naoFaca: 'grep por caminho de import adivinhado',
    prontoQuando: 'cada menção foi classificada como declaração, implementação ou uso — separadamente',
  },
  {
    tarefa: 'medir cobertura ou taxa de alguma coisa',
    gatilhos: ['cobertura', 'taxa', 'quantos de', 'porcentagem', '%', 'perde', 'perdeu', 'falha em'],
    saiba: 'Fração exige denominador medido. Duas sessões contaram transcripts por data de MODIFICAÇÃO e chegaram a 7 e 10 "sessões"; por st_birthtime eram ZERO criadas. Sessão antiga continua escrevendo no próprio arquivo e aparece como nova.',
    regra: 'ARQUIVO MODIFICADO != SESSÃO INICIADA · ZERO OPORTUNIDADE != ZERO FUNCIONAMENTO',
    comando: 'stat -f %B <arquivo>   # criação, não modificação',
    naoFaca: 'find -newermt para contar "quantos aconteceram"',
    prontoQuando: 'o denominador foi medido por um caminho diferente do numerador',
  },
  {
    tarefa: 'afirmar que um contrato ou integração está pronto',
    gatilhos: ['está pronto', 'implementado', 'aplicado', 'integrado', 'funciona', 'ligado', 'contrato'],
    saiba: 'Existir arquivo, tipo ou schema não é estar em uso. Medido: dos 8 contratos do NexOS, 2 estão em CONSUMED, 1 em PRESENT e 5 em DECLARED — e nenhum em EVIDENCED.',
    regra: 'escada-de-prova-de-aplicacao: DECLARED, PRESENT, INSTALLED, WIRED, INVOKED, EFFECTIVE, CONSUMED, TESTED, NEGATIVE CONTROL, EVIDENCED',
    comando: 'nexos decision --key escada-de-prova-de-aplicacao',
    naoFaca: 'chamar de aplicado porque o arquivo existe',
    prontoQuando: 'o degrau foi nomeado e a evidência dele citada',
  },
  {
    tarefa: 'mexer no Store de um worktree',
    gatilhos: ['worktree', '.worktrees', 'branch separada', 'store do worktree'],
    saiba: 'O .nexos dentro de um worktree é cópia COMMITADA: não tem .local/, onde moram evidências e caches. Medido: 822 evidências na raiz, 0 no worktree — um painel gerado de lá mostrava "0 provas" para um projeto com 822.',
    regra: 'STORE VIVE NO WORKTREE PRINCIPAL',
    comando: 'git rev-parse --path-format=absolute --git-common-dir   # resolve o checkout principal',
    naoFaca: 'ler .nexos relativo ao cwd dentro de um worktree',
    prontoQuando: 'a leitura foi ancorada no checkout principal',
  },
];

/** Normaliza para casar "diretorio" com "diretório" e ignorar caixa. */
const normalizar = (t) => String(t ?? '').toLowerCase()
  .normalize('NFD').replace(/[̀-ͯ]/g, '');

/**
 * Roteia por TAREFA. Devolve TODAS as rotas que casam, ordenadas por força —
 * uma tarefa pode cair em duas regras, e esconder a segunda é como o recall
 * de 3 itens perde a que importa.
 * @param {string} texto
 */
export function rotear(texto) {
  const t = normalizar(texto);
  const achados = [];
  for (const rota of ROTAS) {
    const casou = rota.gatilhos.filter((g) => t.includes(normalizar(g)));
    if (casou.length) achados.push({ ...rota, forca: casou.length, casouPor: casou });
  }
  return achados.sort((a, b) => b.forca - a.forca);
}

/** Formato de injeção: curto, com o comando certo e o critério de pronto. */
export function formatar(rotas) {
  if (!rotas.length) return null;
  return rotas.map((r) => [
    `TAREFA: ${r.tarefa}`,
    `SAIBA: ${r.saiba}`,
    `REGRA: ${r.regra}`,
    `FAÇA: ${r.comando}`,
    `NÃO FAÇA: ${r.naoFaca}`,
    `PRONTO QUANDO: ${r.prontoQuando}`,
  ].join('\n')).join('\n\n');
}
