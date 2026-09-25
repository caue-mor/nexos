/**
 * O HUD virou navegação: rótulo, número e alerta que têm aba correspondente
 * levam até ela.
 *
 *   NÚMERO NA TELA É PERGUNTA, NÃO RESPOSTA
 *
 * O gate de execução do build NÃO cobre isto — ele prova que o script roda,
 * e a navegação pode estar morta com a página inteira renderizando. Medido:
 * neutralizei `irParaAba` e a geração passou verde.
 *
 * Este teste é estático sobre o template: lê os destinos declarados e as abas
 * que existem, e exige que todo destino tenha dona.
 */
import { describe, it, expect } from 'vitest';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const tpl = fs.readFileSync(
  path.join(path.dirname(fileURLToPath(import.meta.url)), 'console-template.html'),
  'utf-8'
);

/**
 *   O COMENTÁRIO QUE EXPLICA O BUG CASA COM O PADRÃO DO BUG
 *
 * Três vezes nesta suíte um teste reprovou com o código JÁ CORRIGIDO: o
 * regex encontrou a linha do comentário que cita o defeito antigo para
 * explicá-lo. A documentação honesta do erro virou o erro do teste.
 *
 * Quem verifica que algo NÃO existe no código usa esta versão. Quem
 * verifica presença pode usar o template inteiro — um padrão presente no
 * comentário e ausente no código seria pego pelo controle negativo.
 */
const tplCodigo = tpl
  .replace(/\/\*[\s\S]*?\*\//g, '')
  .replace(/<!--[\s\S]*?-->/g, '')
  .replace(/^\s*\/\/.*$/gm, '');

/** Nomes das abas: as chaves de `panes`, na ordem em que a tela as cria. */
const abas = [...tpl.matchAll(/^\s{2}'([^']+)':\s*\(\)\s*=>/gm)].map((m) => m[1]);
/**
 * Destinos declarados: literais passados a `secao`, `kv`, `metrica` e aos
 * alertas. `metrica` nasceu depois deste teste e o extrator ficou cego até o
 * próprio teste acusar — por isso as três funções entram nomeadas, não por
 * um padrão genérico que silenciosamente deixa de casar.
 */
const destinos = [
  ...tpl.matchAll(/secao\('[^']+',\s*'([^']+)'\)/g),
  ...tpl.matchAll(/\b(?:kv|metrica)\([^)]*?,\s*'([A-ZÀ-Ú][^']*)'\)/g),
  ...tpl.matchAll(/pendentes\.push\(\[[^\]]*?,\s*'([A-ZÀ-Ú][^']*)'\]\)/g),
].map((m) => m[1]);

describe('navegação do HUD aponta para abas que existem', () => {
  it('a tela declara abas e destinos', () => {
    expect(abas.length, 'nenhuma aba encontrada — o parser quebrou').toBeGreaterThan(5);
    expect(destinos.length, 'nenhum destino encontrado — a navegação sumiu').toBeGreaterThan(10);
  });

  /** ASSERÇÃO FORTE: destino órfão é clique que não faz nada — a queixa original. */
  it('nenhum destino aponta para aba inexistente', () => {
    const orfaos = [...new Set(destinos)].filter((d) => !abas.includes(d));
    expect(orfaos, `destinos sem aba correspondente: ${orfaos.join(', ')}`).toEqual([]);
  });

  it('o handler de navegação existe e é ligado a clique e teclado', () => {
    expect(tpl).toContain('const irParaAba =');
    /** `[^)]*` parava no primeiro `)` — o de `(ev`. Janela de caracteres, não classe negada. */
    expect(tpl).toMatch(/addEventListener\('click'[\s\S]{0,120}irParaAba/);
    expect(tpl).toMatch(/addEventListener\('keydown'[\s\S]{0,400}irParaAba/);
  });

  /**
   *   ATRIBUTO DUPLICADO É SILENCIOSO
   *
   * `class="ir"` colado ao lado de um `class=` existente faz o navegador
   * descartar o segundo sem erro: navega, mas não parece clicável.
   */
  it('nenhum elemento navegável emite dois atributos class', () => {
    const duplos = [...tpl.matchAll(/<[a-z0-9]+\s+class="[^"]*"\s*\$\{irPara\(/g)];
    expect(duplos.map((m) => m[0]), 'class= fixo ao lado de irPara() gera atributo duplicado').toEqual([]);
  });
});

/**
 * RÓTULO E DADOS PRECISAM SER UM ELEMENTO SÓ
 *
 * A primeira tentativa de distribuir o HUD em grid embaralhou os dados:
 * "Instalação" apareceu mostrando `ramo`, "Não medimos ainda" mostrando
 * `commit`. Título e pares eram IRMÃOS soltos na coluna, e o grid preenche
 * célula a célula sem saber o que pertence a quem.
 *
 * Dado sob rótulo errado é pior que layout feio — é afirmação falsa na tela,
 * e nenhum gate de execução pega.
 */
describe('cada seção do HUD carrega os próprios dados', () => {
  it('todo rótulo do HUD é gerado dentro de um bloco fechado', () => {
    /** `secao()` só pode ser chamada por `bloco()`, nunca solta no HUD. */
    const soltas = [...tpl.matchAll(/^\s*\$\{secao\(/gm)];
    expect(soltas.map((m) => m[0].trim()), 'secao() fora de bloco() volta a soltar o rótulo dos dados').toEqual([]);
    expect(tpl).toContain('const bloco = (titulo, aba, itens)');
  });

  /**
   * Sete, não seis: "Precisa de você" deixou de ser faixa solta embaixo e
   * virou bloco da coluna esquerda, para a tela concentrar tudo no painel.
   *
   * Ele é o PRIMEIRO da coluna, não o último: medido pelo QA a 1920x1080 e
   * 1470x956, o único bloco que pede ação ficava no fim da coluna — quase
   * todo fora da primeira tela (a 1470, inteiro fora). Ação pendente é o
   * que o dono precisa ver primeiro, não o que sobrou depois de rolar.
   */
  it('os blocos do HUD existem, na ordem, e cada um recebe seus itens', () => {
    const chamadas = [...tpl.matchAll(/\$\{bloco\('([^']+)'/g)].map((m) => m[1]);
    expect(chamadas).toEqual([
      'Precisa de você', 'Projeto', 'Instalação', 'Não medimos ainda',
      'Trabalho', 'Ferramentas', 'Sessões',
    ]);
  });

  /**
   * CONTROLE: o CSS distribui BLOCOS, nunca itens soltos.
   *
   * Era `display:grid` com `align-content:space-between` — rodada 3 mediu
   * que isso espalhava os blocos pela altura de CADA coluna
   * independentemente, e colunas com números diferentes de blocos
   * desalinhavam entre si (ex.: "Ferramentas" bem mais abaixo que seu par
   * na coluna oposta). `display:flex;flex-direction:column` empilha os
   * mesmos blocos sem essa distribuição — a garantia que este teste
   * existe pra proteger (bloco como unidade, nunca kv solto) não depende
   * de qual dos dois for usado.
   */
  it('o grid das colunas move blocos, não pares chave-valor', () => {
    expect(tpl).toMatch(/\.col\{[^}]*display:flex/);
    expect(tpl, 'nth-of-type sobre filhos da coluna foi o que embaralhou').not.toMatch(
      /\.hud\s*>\s*div[^{]*>\s*\.rotulo-hud:nth-of-type/
    );
  });
});

/**
 *   O QUE PASSA NO NAVEGADOR E VOLTA NA AUDITORIA SEGUINTE
 *
 * Os três defeitos abaixo foram medidos a 3440px, corrigidos, e dois deles
 * já haviam sido "corrigidos" antes por um caminho que não funcionava. Um
 * teste estático custa menos que a terceira rodada de auditoria.
 */
describe('regras de layout que a auditoria mediu', () => {
  /**
   * Medido: `max-width: 623px` computado numa coluna renderizada com
   * 2248px. `table-layout:auto` distribui pela largura do CONTEÚDO e
   * ignora o teto da célula — o teto só vale no elemento `table`.
   */
  it('o teto de largura fica na tabela, nunca na célula', () => {
    const regras = [...tpl.matchAll(/^\s*(td[^{]*)\{([^}]*)\}/gm)];
    expect(regras.length, 'nenhuma regra de td — o parser quebrou').toBeGreaterThan(0);
    const comTeto = regras.filter(([, sel, corpo]) =>
      /max-width\s*:\s*(?!none)/.test(corpo) && !sel.includes('.detalhe'));
    expect(comTeto.map(([, s]) => s.trim()),
      'max-width em td não é aplicado por table-layout:auto — põe na table'
    ).toEqual([]);
    expect(tpl, 'a tabela perdeu o teto de largura').toMatch(/^\s*table\{[^}]*max-width:\s*\d+ch/m);
  });

  /**
   *   ALVO CLICÁVEL SEM ANEL DE FOCO É ALVO CLICÁVEL INVISÍVEL NO TECLADO
   *
   * `.paginacao button` (paginação de "Estrutura do código") ficou fora das
   * duas regras de `:focus-visible` quando foi criada — achado do
   * verificador, rodada 3. O anel padrão do navegador some contra #060A08
   * (mesmo motivo documentado ao lado das outras regras de foco), então sem
   * isto o foco por teclado nesses botões simplesmente sumia. Nenhum teste
   * protegia a regra até agora.
   */
  it('.paginacao button tem anel de foco visível', () => {
    const blocos = [...tplCodigo.matchAll(/([^{}]*\.paginacao button:focus-visible[^{}]*)\{([^}]*)\}/g)];
    expect(blocos.length, '.paginacao button:focus-visible sumiu das regras de :focus-visible').toBeGreaterThanOrEqual(2);
    for (const [, , corpo] of blocos) {
      expect(corpo, `regra sem anel visível: ${corpo}`).toMatch(/outline\s*:\s*2px solid var\(--primary\)/);
    }
  });

  /**
   * Medido duas vezes: `aria-label="abrir Saúde"` reprovou em 15 elementos,
   * e `aria-label="estado CANONICAL, abrir Saúde"` reprovou em 11 — o texto
   * visível são spans colados, que o leitor lê como `estadoCANONICAL`.
   * Nome acessível montado à mão sempre pode divergir da tela; derivado
   * dela, não pode.
   */
  it('elemento clicável não monta o próprio nome acessível', () => {
    expect(tplCodigo, 'irPara voltou a escrever aria-label à mão').not.toMatch(/irPara[\s\S]{0,400}?aria-label/);
    expect(tpl, 'o sufixo lido sumiu — o destino deixou de ser anunciado').toMatch(/const sr = \(aba\)/);

    /**
     *   CONTAGEM NÃO É PAREAMENTO
     *
     * A primeira versão contava usos de `irPara` e usos de `sr` e exigia os
     * dois números iguais. Um verificador independente derrubou por mutação:
     * removeu um `${sr(aba)}` REAL de `kv()` — a regressão exata de
     * acessibilidade que este commit corrigiu — e plantou um `${sr(aba)}`
     * órfão dentro de um comentário, só para igualar a contagem. O teste
     * passou. Dois erros que se somam a zero passam em qualquer soma.
     *
     * Agora o par é conferido POR LINHA: os três usos são one-liners, e um
     * `sr` só conta se estiver ao lado do `irPara` que ele descreve.
     */
    const linhas = tpl.split('\n');
    const semSufixo = [];
    const orfaos = [];
    linhas.forEach((linha, i) => {
      const temIrPara = linha.includes('${irPara(');
      const temSr = /\$\{sr\(aba\)\}/.test(linha);
      if (temIrPara && !temSr) semSufixo.push(`${i + 1}: ${linha.trim().slice(0, 80)}`);
      if (temSr && !temIrPara) orfaos.push(`${i + 1}: ${linha.trim().slice(0, 80)}`);
    });
    expect(semSufixo,
      `clicável que não diz para onde leva:\n${semSufixo.join('\n')}`
    ).toEqual([]);
    expect(orfaos,
      `sufixo solto, longe do clicável que deveria descrever:\n${orfaos.join('\n')}`
    ).toEqual([]);
  });

  /**
   *   LIGHTHOUSE 100 NÃO SIGNIFICA ALVO CLICÁVEL DE TAMANHO USÁVEL
   *
   * Medido: 308x16px no rótulo de seção clicável da visão geral, contra o
   * mínimo de 24x24 do WCAG 2.2 (2.5.8, AA). O Lighthouse dava 100 — ele
   * não audita tamanho de alvo em desktop.
   *
   * O padding cresce a área e a margem negativa devolve o espaço: medido
   * nos 7 rótulos, cada um ocupa 26px no fluxo antes e depois, então o
   * alvo dobrou sem o layout andar.
   */
  it('rótulo de seção clicável tem alvo de 24px', () => {
    const regra = tpl.match(/h2\.rotulo-hud\.ir\{([^}]*)\}/);
    expect(regra, 'a regra do rótulo clicável sumiu').toBeTruthy();
    expect(regra[1], 'sem padding o alvo volta para 16px de altura').toMatch(/padding-block:\s*4px/);
    expect(regra[1], 'sem a margem negativa o layout anda 8px'
    ).toMatch(/margin-block:\s*-4px/);
  });

  /**
   * Sem esta chamada nenhum `.grupo` existe, o seletor `:has(> .grupo)`
   * nunca casa e as abas voltam a empilhar numa coluna só — silenciosamente,
   * porque o CSS simplesmente não se aplica.
   */
  it('os grupos são formados no render das abas', () => {
    expect(tpl).toMatch(/sec\.innerHTML = panes\[name\]\(\);\s*\n\s*agrupar\(sec\);/);
    expect(tpl, 'o grid dos grupos sumiu').toMatch(/:has\(> \.grupo\)\{[\s\S]*?grid-template-columns/);
  });
});

/**
 *   DICIONÁRIO INCOMPLETO NÃO AVISA QUE ESTÁ INCOMPLETO
 *
 * A tela traduzia três dos oito estados de tarefa, em dois dicionários
 * inline com o mesmo conteúdo parcial. Os outros cinco caíam no `?? s` e
 * apareciam crus, em inglês maiúsculo, numa tela em português — sem erro,
 * sem aviso, exatamente porque o fallback existe.
 *
 * Aqui o dicionário é conferido contra a FONTE, não contra si mesmo.
 */
describe('vocabulário da tela cobre o vocabulário do Store', () => {
  const schemas = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src', 'lib', 'capsule', 'schemas.ts'),
    'utf-8'
  );

  const canonicos = (() => {
    const bloco = schemas.match(/export const CHECKPOINT_STATES = \[([\s\S]*?)\] as const;/);
    expect(bloco, 'CHECKPOINT_STATES não foi encontrado — o parser quebrou').toBeTruthy();
    return [...bloco[1].matchAll(/"([A-Z_]+)"/g)].map((m) => m[1]);
  })();

  const traduzidos = (() => {
    const bloco = tpl.match(/const ESTADO_TAREFA = \{([\s\S]*?)\};/);
    expect(bloco, 'ESTADO_TAREFA sumiu da tela').toBeTruthy();
    return [...bloco[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
  })();

  it('a fonte e a tela foram lidas', () => {
    expect(canonicos.length, 'nenhum estado canônico lido').toBeGreaterThan(5);
    expect(traduzidos.length, 'nenhuma tradução lida').toBeGreaterThan(5);
  });

  it('todo estado que o Store pode gravar tem tradução na tela', () => {
    const semTraducao = canonicos.filter((e) => !traduzidos.includes(e));
    expect(semTraducao,
      `estes apareceriam crus em inglês na tela: ${semTraducao.join(', ')}`
    ).toEqual([]);
  });

  it('a tela não traduz estado que o Store não grava', () => {
    const inventados = traduzidos.filter((e) => !canonicos.includes(e));
    expect(inventados,
      `traduções órfãs — o estado sumiu do schema ou nunca existiu: ${inventados.join(', ')}`
    ).toEqual([]);
  });

  /**
   * `ESTADO_PROJETO` tinha o defeito que este bloco inteiro existe para
   * matar, só que do outro lado: nenhum teste conferia a completude dele.
   * O verificador removeu `CORRUPT` do dicionário e os 178 testes passaram
   * iguais. O dicionário estava certo — e continuaria certo por sorte, até
   * alguém acrescentar um estado numa das duas fontes.
   *
   * São DUAS fontes porque a tela mistura duas famílias: a identidade da
   * capsule (`BootStateLabel`) e a saúde do projeto (`ProjectDoctorState`).
   */
  const projetoCanonicos = (() => {
    const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..', 'src');
    const boot = fs.readFileSync(path.join(raiz, 'commands', 'boot.ts'), 'utf-8');
    const doctor = fs.readFileSync(path.join(raiz, 'lib', 'doctor', 'project-doctor.ts'), 'utf-8');
    const extrair = (txt, tipo) => {
      const m = txt.match(new RegExp(`export type ${tipo} =([\\s\\S]*?);`));
      expect(m, `${tipo} não foi encontrado — o parser quebrou`).toBeTruthy();
      return [...m[1].matchAll(/"([A-Z_]+)"/g)].map((x) => x[1]);
    };
    return [...new Set([
      ...extrair(boot, 'BootStateLabel'),
      ...extrair(doctor, 'ProjectDoctorState'),
    ])];
  })();

  const projetoTraduzidos = (() => {
    const bloco = tpl.match(/const ESTADO_PROJETO = \{([\s\S]*?)\};/);
    expect(bloco, 'ESTADO_PROJETO sumiu da tela').toBeTruthy();
    return [...bloco[1].matchAll(/^\s*([A-Z_]+):/gm)].map((m) => m[1]);
  })();

  it('as duas fontes de estado de projeto foram lidas', () => {
    expect(projetoCanonicos, 'BootStateLabel não entrou').toContain('CANONICAL');
    expect(projetoCanonicos, 'ProjectDoctorState não entrou').toContain('CORRUPT');
    expect(projetoCanonicos.length).toBeGreaterThan(10);
  });

  it('todo estado de projeto das duas fontes tem tradução', () => {
    const faltam = projetoCanonicos.filter((e) => !projetoTraduzidos.includes(e));
    expect(faltam,
      `apareceriam crus em inglês na tela: ${faltam.join(', ')}`
    ).toEqual([]);
  });

  it('a tela não traduz estado de projeto que nenhuma fonte declara', () => {
    const orfas = projetoTraduzidos.filter((e) => !projetoCanonicos.includes(e));
    expect(orfas,
      `traduções órfãs — o estado sumiu da fonte ou nunca existiu: ${orfas.join(', ')}`
    ).toEqual([]);
  });

  it('não sobrou dicionário parcial inline', () => {
    expect(tplCodigo, 'voltou um dicionário de estados escrito inline'
    ).not.toMatch(/\{\s*SUCCEEDED\s*:\s*'[^']*'\s*,\s*FAILED\s*:/);
  });
});

/**
 *   BRANCH SEM TESTE É BRANCH QUE JÁ PODE ESTAR QUEBRADO
 *
 * Um verificador independente trocou `> 4` por `> 400` em `agrupar()` — o
 * que faz NENHUMA tabela larga receber `.largo`, e espreme a tabela de seis
 * colunas de "Sessões" em meia tela — e os 160 testes do console passaram
 * iguais. O limiar não tinha cobertura nenhuma.
 *
 * Não há DOM nos testes deste projeto, então a função é extraída do
 * template e executada contra um stub mínimo, o mesmo caminho que
 * `build-console.mjs` já usa no gate de execução. O stub implementa só o
 * que `agrupar` chama — um stub que finge mais do que isso testaria a si
 * mesmo.
 */
describe('agrupar classifica tabela larga', () => {
  /** A função, tirada do template e ligada a um `document` de mentira. */
  const carregar = () => {
    const m = tpl.match(/const agrupar = \(sec\) => \{[\s\S]*?\n\};/);
    expect(m, 'agrupar() sumiu do template').toBeTruthy();
    const doc = { createElement: (tag) => el(tag) };
    return new Function('document', `${m[0]}; return agrupar;`)(doc);
  };

  /** Elemento mínimo: só o que `agrupar` toca. */
  function el(tag, colunas = 0) {
    const self = {
      tagName: tag.toUpperCase(),
      className: '',
      children: [],
      classList: { add: (c) => { self.className = `${self.className} ${c}`.trim(); } },
      querySelector: (sel) =>
        sel === ':scope > h2' ? self.children.find((c) => c.tagName === 'H2') ?? null : null,
      querySelectorAll: (sel) =>
        sel === 'thead th' ? Array.from({ length: colunas }, () => ({})) : [],
      appendChild: (filho) => { self.children.push(filho); },
      insertBefore: (novo, ref) => { self.children.splice(self.children.indexOf(ref), 0, novo); },
    };
    return self;
  }

  /** Monta uma aba: pares de `h2` + tabela com N colunas. */
  const aba = (...colunasPorTabela) => {
    const sec = el('section');
    for (const n of colunasPorTabela) {
      sec.children.push(el('h2'), el('div', n));
    }
    return sec;
  };

  const grupos = (sec) => sec.children.filter((c) => classes(c).includes('grupo'));
  /**
   * Classe EXATA, nunca substring. O controle negativo deste próprio teste
   * trocou `largo` por `largoX` e `toContain('largo')` passou: 'grupo
   * largoX' contém 'largo'. O CSS casa `.grupo.largo` e não casaria
   * `largoX` — o teste dizia sim para um painel quebrado.
   */
  const classes = (el) => el.className.split(/\s+/).filter(Boolean);

  it('o stub reproduz o que agrupar precisa', () => {
    const sec = aba(3);
    expect(sec.querySelector(':scope > h2')).toBeTruthy();
    expect(sec.children[1].querySelectorAll('thead th')).toHaveLength(3);
  });

  it('tabela de até 4 colunas fica em grupo normal', () => {
    for (const n of [1, 3, 4]) {
      const sec = aba(n);
      carregar()(sec);
      const g = grupos(sec);
      expect(g, `${n} colunas: deveria formar 1 grupo`).toHaveLength(1);
      expect(classes(g[0]), `${n} colunas não deveria virar largo`).toEqual(['grupo']);
    }
  });

  it('tabela de 5 colunas ou mais leva largo', () => {
    for (const n of [5, 6, 9]) {
      const sec = aba(n);
      carregar()(sec);
      const g = grupos(sec);
      expect(classes(g[0]), `${n} colunas deveria virar largo — senão a tabela é espremida em meia tela`)
        .toContain('largo');
    }
  });

  it('o limiar separa 4 de 5, que é onde ele vale', () => {
    const quatro = aba(4); carregar()(quatro);
    const cinco = aba(5); carregar()(cinco);
    expect(classes(grupos(quatro)[0])).not.toContain('largo');
    expect(classes(grupos(cinco)[0])).toContain('largo');
  });

  it('cada h2 abre um grupo próprio, e só a tabela larga é marcada', () => {
    const sec = aba(2, 6, 3);
    carregar()(sec);
    const g = grupos(sec);
    expect(g, 'três h2 deveriam formar três grupos').toHaveLength(3);
    expect(g.map((x) => classes(x).includes('largo'))).toEqual([false, true, false]);
  });

  it('a classe que o JS escreve é a que o CSS estiliza', () => {
    const sec = aba(6);
    carregar()(sec);
    for (const c of classes(grupos(sec)[0])) {
      expect(tpl, `o JS marca .${c} e o CSS não conhece essa classe`)
        .toMatch(new RegExp(`\\.${c}[\\s{,.:]`));
    }
    expect(tpl, 'a regra que põe a tabela larga em linha inteira sumiu')
      .toMatch(/\.grupo\.largo\{[^}]*grid-column:1\/-1/);
  });

  it('aba sem h2 não é tocada', () => {
    const sec = el('section');
    sec.children.push(el('div', 9));
    carregar()(sec);
    expect(grupos(sec), 'aba sem título não deveria ganhar grupo').toHaveLength(0);
  });
});

/**
 *   TRÊS DICIONÁRIOS TINHAM O MESMO FURO, ENTÃO O FURO NÃO ERA DO DICIONÁRIO
 *
 * `ESTADO_TAREFA` ganhou teste de completude, `ESTADO_PROJETO` não — e um
 * verificador independente achou. Ao contar, a tela tem SETE dicionários de
 * tradução e só dois estavam cobertos. Tapar um buraco de cada vez deixa os
 * outros parecendo resolvidos.
 *
 * Aqui os que têm fonte canônica são conferidos pela MESMA regra, declarada
 * numa tabela. Dicionário novo entra como uma linha, não como um teste.
 */
describe('todo dicionário de tradução cobre a fonte dele', () => {
  const raiz = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
  const ler = (...partes) => fs.readFileSync(path.join(raiz, ...partes), 'utf-8');

  /**
   * Chaves de um objeto literal declarado no template.
   *
   * A primeira versão ancorava em início de linha (`/^\s*(\w+):/gm`) e
   * perdia 3 das 5 chaves de `nivelPt`, que declara várias por linha. O
   * teste acusou "LISTED, INVOCABLE, EFFECTIVE sairiam crus" para um
   * dicionário que as tinha — o defeito estava no extrator, não no código
   * medido. Agora a chave é reconhecida depois de `{` ou `,`, que é onde
   * ela pode legitimamente aparecer — ou no início do trecho, porque o
   * grupo capturado começa DEPOIS da chave de abertura e a primeira chave
   * não tem separador atrás dela. Essa segunda falha só apareceu depois de
   * corrigir a primeira: EXTRATOR É CÓDIGO, E CÓDIGO NOVO ERRA DUAS VEZES.
   */
  const chavesDe = (nome) => {
    const m = tpl.match(new RegExp(`const ${nome} = \\{([\\s\\S]*?)\\n\\s*\\};`));
    expect(m, `${nome} sumiu do template`).toBeTruthy();
    return [...m[1].matchAll(/(?:^|[{,])\s*'?([A-Za-z_]+)'?\s*:/g)].map((x) => x[1]);
  };

  const DICIONARIOS = [
    {
      nome: 'nivelPt',
      oQueTraduz: 'os degraus da escada de prova',
      /** `LADDER` vive num .mjs do próprio console, não em src/. */
      canonicos: () => {
        const m = ler('console', 'capability-projection.mjs')
          .match(/export const LADDER = [\s\S]*?\[([\s\S]*?)\]\);/);
        expect(m, 'LADDER não foi encontrado').toBeTruthy();
        return [...m[1].matchAll(/'([A-Z_]+)'/g)].map((x) => x[1]);
      },
      omitidos: 'nivelOmitido',
    },
    {
      nome: 'tipoPt',
      oQueTraduz: 'os tipos de ferramenta',
      canonicos: () => {
        const m = ler('src', 'lib', 'capabilities', 'types.ts')
          .match(/export type CapabilityKind =([^;]*);/);
        expect(m, 'CapabilityKind não foi encontrado').toBeTruthy();
        return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
      },
    },
    {
      nome: 'origemPt',
      oQueTraduz: 'a origem das ferramentas',
      canonicos: () => {
        const m = ler('src', 'lib', 'capabilities', 'types.ts')
          .match(/export type CapabilitySource =([^;]*);/);
        expect(m, 'CapabilitySource não foi encontrado').toBeTruthy();
        return [...m[1].matchAll(/"([a-z]+)"/g)].map((x) => x[1]);
      },
    },
  ];

  for (const d of DICIONARIOS) {
    describe(`${d.nome} — ${d.oQueTraduz}`, () => {
      it('a fonte foi lida', () => {
        expect(d.canonicos().length, 'nenhum valor canônico — o parser quebrou').toBeGreaterThan(2);
      });

      it('cobre a fonte, ou declara por que não cobre', () => {
        const traduzidos = chavesDe(d.nome);
        const omitidos = d.omitidos ? chavesDe(d.omitidos) : [];
        const descobertos = [...traduzidos, ...omitidos];
        const faltam = d.canonicos().filter((v) => !descobertos.includes(v));
        expect(faltam,
          `sairiam crus na tela, ou precisam entrar em ${d.omitidos ?? 'um mapa de omissão declarada'}: ${faltam.join(', ')}`
        ).toEqual([]);
      });

      it('não traduz valor que a fonte não declara', () => {
        const orfas = chavesDe(d.nome).filter((v) => !d.canonicos().includes(v));
        expect(orfas, `traduções órfãs: ${orfas.join(', ')}`).toEqual([]);
      });
    });
  }

  it('a tabela da escada deriva do dicionário, não de uma lista à mão', () => {
    expect(tplCodigo, 'a lista de degraus voltou a ser escrita à mão — ela vai divergir de LADDER'
    ).not.toMatch(/\['INSTALLED',\s*'LISTED'/);
    expect(tpl).toMatch(/Object\.keys\(nivelPt\)\.map/);
  });
});

/**
 *   A MÉTRICA DE AUDITORIA FOI DESENHADA PARA O DEFEITO QUE EU JÁ CONHECIA
 *
 * A rodada anterior mediu "coluna desproporcional" como `max > 900px &&
 * max > min*6`. Uma tabela ESPREMIDA tem o `max` pequeno, então nunca
 * disparava: a auditoria deu dez abas limpas enquanto o dono via a faixa de
 * cartões esticada em 764x2122px e um caminho quebrando letra a letra.
 *
 * Os quatro defeitos abaixo foram vistos pelo dono, não pela medição.
 */
describe('o que a auditoria não viu e o dono viu', () => {
  /**
   * `display:grid` no painel transforma CADA filho direto em item de grid,
   * inclusive `.cards`, que tem layout próprio. Medido: a faixa virou uma
   * coluna de 764x2122px, esticada até a altura da linha.
   */
  it('a faixa de cartões ocupa a linha inteira e nada é esticado', () => {
    /*
     * A regra começou nomeando só `.cards` e foi generalizada quando a nota
     * de contexto da aba de estrutura virou uma coluna vazia de 900px ao
     * lado dela. O INVARIANTE não mudou — só `.grupo` é coluna, todo o
     * resto ocupa a linha — então o teste passou a exigir o invariante, e
     * não a expressão que o implementava naquele dia.
     */
    expect(tpl, 'sem isto a faixa de resumo vira uma coluna estreita'
    ).toMatch(/section\[role=tabpanel\] > :not\(\.grupo\)\{grid-column:1\/-1\}/);
    const grid = tpl.match(/section\[role=tabpanel\]:has\(> \.grupo\)\{([^}]*)\}/);
    expect(grid, 'a regra do grid sumiu').toBeTruthy();
    expect(grid[1], 'sem align-items:start um bloco curto estica até a altura do vizinho'
    ).toMatch(/align-items:\s*start/);
  });

  /**
   *   `anywhere` ENTRA NA LARGURA MÍNIMA INTRÍNSECA; `break-word` NÃO
   *
   * Medido na mesma tabela, trocando só o valor: `anywhere` dava 78px na
   * coluna e o caminho quebrava letra a letra; `break-word`, 286px. Os dois
   * quebram palavra longa — mas `anywhere` informa ao algoritmo de tabela
   * que a coluna pode encolher até um caractere, e ele acredita.
   */
  it('a célula não declara que cabe em um caractere', () => {
    const regra = tpl.match(/^\s*td\{([^}]*)\}/m);
    expect(regra, 'a regra base de td sumiu').toBeTruthy();
    expect(regra[1], 'overflow-wrap:anywhere deixa a coluna colapsar'
    ).not.toMatch(/overflow-wrap:\s*anywhere/);
    expect(regra[1]).toMatch(/overflow-wrap:\s*break-word/);
  });

  /**
   * `.na` nasceu para a PÁGINA vazia, com 120px de altura mínima para a
   * tela não parecer que falhou ao carregar. A mesma classe é usada na
   * CÉLULA sem valor, e ali os 120px inflavam cada linha: medido, linhas de
   * 133px e 219px para duas linhas de texto.
   */
  it('o vazio de célula não tem altura de vazio de página', () => {
    expect(tpl, 'sem isto cada linha da tabela ganha 120px'
    ).toMatch(/td \.na,td\.na\{[^}]*min-height:\s*0/);
  });

  /**
   *   DESISTIR NÃO É ESPERAR
   *
   * O quadro sem dimensão fazia `return` sem reagendar. Quando o primeiro
   * quadro pegava o canvas antes de o layout resolver, o loop encerrava e
   * NUNCA voltava — o `ResizeObserver` corrigia o tamanho e não havia quem
   * chamasse `draw()` de novo. O orbe ficava em branco até recarregar a
   * página. Bug de corrida não aparece na máquina de quem escreveu.
   */
  it('o orbe espera o layout em vez de desistir do desenho', () => {
    /*
     *   O COMENTÁRIO QUE EXPLICA O BUG TAMBÉM CASA COM O PADRÃO DO BUG
     *
     * A primeira versão deste teste reprovou com o código já corrigido: o
     * `.match()` pegou a PRIMEIRA ocorrência, que é a linha do comentário
     * citando `if (!w || !hh) { … return; }` para explicar o defeito
     * antigo. O lookahead descarta linha que começa com `*`, que é onde o
     * comentário vive.
     */
    const guarda = tplCodigo.match(/if \(!w \|\| !hh\)[^\n]*/);
    expect(guarda, 'a guarda de dimensão do orbe sumiu').toBeTruthy();
    expect(guarda[0], 'um return sem reagendar mata o loop para sempre'
    ).toMatch(/requestAnimationFrame\(draw\)/);
    expect(tpl, 'sem movimento o desenho é único: redimensionar exige redesenhar'
    ).toMatch(/ResizeObserver\(\(\) => \{ if \(ajustar\(\) && vel === 0\) draw\(\); \}\)/);
  });
});

/**
 *   TESTE DE MODO QUE DEIXOU DE EXISTIR VIROU FALSO SINAL
 *
 * Havia aqui um controle pra "nav alinhada ao topo" no modo de coluna
 * lateral (>=1500px, grid-areas, cabeçalho no rodapé da coluna). Rodada 3
 * removeu esse modo inteiro: o QA mediu que ele contradizia a direção B
 * aprovada (cabeçalho + faixa de seções em TODA largura, nunca coluna
 * lateral) — a 3440px, laterais de 268px, orbe gigante, muito vazio,
 * cabeçalho empurrado pro rodapé. Não sobrou `nav{}` de modo lateral pra
 * testar; manter o teste seria proteger um bug que não existe mais.
 */

/**
 *   ANÁLISE QUE NINGUÉM LÊ NÃO É ANÁLISE
 *
 * O graphify roda por hook a cada commit desde 2026-09-16 e escrevia em
 * `graphify-out/` para ninguém. A aba existe para ligar esse dado à tela —
 * e o que a torna útil, e não decorativa, é cada linha dizer ONDE a peça
 * mora. Sem o `onde`, "forProject() tem 35 ligações" não vira decisão.
 */
describe('a aba de estrutura mostra dado acionável', () => {
  const pane = tpl.match(/'Estrutura do código': \(\) => \{([\s\S]*?)\n  \},/);

  it('a aba existe e é uma aba de verdade', () => {
    expect(pane, 'o pane sumiu do template').toBeTruthy();
    expect(abas, 'a aba tem que entrar na lista de abas').toContain('Estrutura do código');
  });

  it('cada peça diz onde mora, e a linha abre detalhe', () => {
    expect(pane[1], 'sem o arquivo e a linha a tabela é só um ranking'
    ).toMatch(/onde mora/);
    expect(pane[1], 'a linha precisa abrir detalhe, senão não é clicável'
    ).toMatch(/linhaAbrivel/);
    expect(pane[1], 'o detalhe tem que trazer arquivo e linha').toMatch(/'arquivo e linha'/);
  });

  /**
   * A divergência de id entre os dois arquivos do graphify pode voltar numa
   * versão nova e derrubar todos os "onde" para vazio. Uma tabela com dez
   * linhas e nenhuma localização continua PARECENDO certa — por isso o
   * número de não-localizadas aparece na tela.
   */
  it('avisa quando não consegue localizar uma peça', () => {
    expect(pane[1]).toMatch(/localizados/);
    expect(pane[1], 'a tela tem que dizer quantas não localizou'
    ).toMatch(/não puderam ser localizadas/);
  });

  /** Projeto sem graphify não pode ver tela em branco. */
  it('degrada dizendo o que fazer', () => {
    expect(pane[1]).toMatch(/!G\.medido/);
    expect(pane[1], 'o motivo da lacuna tem que chegar à tela').toMatch(/G\.motivo/);
  });

  it('a leitura tem data à vista — análise velha é fato, não detalhe', () => {
    expect(pane[1]).toMatch(/G\.pasta/);
    expect(pane[1]).toMatch(/diasAtras/);
  });

  /**
   * `READ DOES NOT EXECUTE`: a tela lê o que a ferramenta escreveu e nunca
   * dispara a ferramenta. Rodar análise dentro de um gerador de painel
   * transformaria abrir uma tela em efeito colateral.
   */
  it('a projeção lê, nunca executa', () => {
    const proj = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'graphify-projection.mjs'), 'utf-8'
    );
    expect(proj, 'a projeção não pode disparar subprocesso'
    ).not.toMatch(/execFileSync|execSync|spawn/);
  });
});

/**
 *   ABA SEM ENDEREÇO NÃO É NAVEGAÇÃO, É ACORDEÃO
 *
 * As onze abas trocavam conteúdo sem tocar na URL: recarregar voltava para
 * a primeira, o botão voltar saía da página inteira em vez de voltar uma
 * aba, e não havia como mandar a alguém o link de uma aba. Medido no
 * navegador depois da correção: `#provas` abre em Provas, clicar escreve o
 * endereço, e voltar/avançar percorrem as abas.
 */
describe('cada aba tem endereço próprio', () => {
  it('o slug tira acento de verdade', () => {
    /*
     * Contra `tplCodigo`, não contra o template inteiro: o comentário que
     * explica esta regra CITA `normalize('NFD')`, e o controle negativo
     * provou que a citação sozinha satisfazia a asserção — mutar o slug
     * para `(n) => (n)` passava. A ressalva que eu tinha escrito ao criar
     * `tplCodigo` ("presença pode usar o template inteiro") estava errada,
     * e foi a mutação que mostrou.
     */
    expect(tplCodigo, "sem normalize('NFD') 'Visão geral' vira vis-o-geral"
    ).toMatch(/normalize\('NFD'\)/);
    expect(tplCodigo).toMatch(/const slug = \(n\)/);
  });

  it('trocar de aba escreve o endereço', () => {
    expect(tpl, 'sem isto a URL não acompanha a navegação'
    ).toMatch(/location\.hash = alvo/);
  });

  it('o endereço manda na abertura', () => {
    expect(tpl, 'abrir console.html#provas tem que cair em Provas'
    ).toMatch(/selecionar\(porSlug\(decodeURIComponent\(location\.hash\.slice\(1\)\)\) \?\? nomes\[0\]\)/);
  });

  it('voltar e avançar do navegador funcionam', () => {
    expect(tpl).toMatch(/addEventListener\('hashchange'/);
    /*
     * O `hashchange` dispara também quando é a própria `selecionar()` que
     * escreve o endereço. Comparar com a aba já ativa corta o laço sem
     * sinalizador de estado — a variável que alguém esquece de baixar num
     * caminho de erro.
     */
    expect(tpl, 'sem a checagem de aba ativa o hashchange entra em laço'
    ).toMatch(/jaAtiva/);
  });

  /**
   * O único link para o mapa vive no `<header>`. Já reprovou duas vezes por
   * caminhos diferentes: primeiro um layout de tela larga que fazia
   * `header{display:none}` (medido a 3440px, nenhum link pra
   * `graph-view.html` visível em lugar nenhum); a correção daquilo virou
   * outro layout (coluna lateral, rodada 2) que a rodada 3 removeu de novo
   * por contradizer a direção B aprovada. A direção B não tem NENHUM modo
   * que esconde ou reestrutura o cabeçalho — ele é sempre o mesmo elemento,
   * sempre visível, em toda largura. O controle que sobrevive aos dois
   * layouts é esse: nenhuma regra torna `header` invisível.
   */
  it('o caminho para o mapa não some em tela larga', () => {
    expect(tplCodigo, 'header:display:none esconde o único link para o mapa'
    ).not.toMatch(/header\{display:none\}/);
    expect(tplCodigo, 'header não pode ficar invisível em nenhuma largura'
    ).not.toMatch(/header\{[^}]*visibility:\s*hidden/);
  });

  it('o link para o mapa leva a aba de origem', () => {
    expect(tpl, 'sem isto voltar do mapa sempre cai na primeira aba'
    ).toMatch(/graph-view\.html#volta=\$\{alvo\}/);
  });

  it('o texto do link não é jargão', () => {
    expect(tplCodigo, '"abrir o grafo" não diz nada a quem não conhece a palavra'
    ).not.toMatch(/abrir o grafo/);
    expect(tpl).toMatch(/Mapa do código/);
  });

  it('o mapa devolve para a aba de origem', () => {
    const mapa = fs.readFileSync(
      path.join(path.dirname(fileURLToPath(import.meta.url)), 'view-template.html'), 'utf-8'
    );
    expect(mapa, 'o voltar tem que respeitar de onde veio'
    ).toMatch(/\^#volta=\(\[a-z0-9-\]\+\)\$/);
    expect(mapa).toMatch(/console\.html#\$\{m\[1\]\}/);
  });
});

/**
 *   CATÁLOGO NÃO É DISPONIBILIDADE
 *
 * O cartão anunciava "645 · DISPONÍVEIS" com 483 delas desligadas — 75%.
 * O número estava certo como contagem de catálogo e errado como resposta à
 * pergunta que o cartão fazia. É a mesma falsa competência que faz um
 * roteador sugerir skill de anúncios para uma tarefa de segurança porque as
 * de segurança estão desligadas: os dois dizem ao usuário que ele tem uma
 * capacidade que não tem.
 *
 * O campo `enabled` já vinha na saída de `capabilities --json`; a tela é
 * que não lia.
 */
describe('a tela não confunde catálogo com o que está ligado', () => {
  const proj = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'capability-projection.mjs'), 'utf-8'
  );

  it('a projeção conta ativas separado do total', () => {
    expect(proj, 'sem ler enabled não há como saber o que está ligado'
    ).toMatch(/it\.enabled !== false/);
    expect(proj).toMatch(/ativasPorKind/);
    expect(proj).toMatch(/desligadas: items\.length - ativas/);
  });

  /**
   * Ausência de `enabled` conta como ATIVA: o campo é recente e um item
   * antigo sem ele não pode ser declarado desligado por omissão — isso
   * inverteria o erro em vez de corrigi-lo.
   */
  it('ausência do campo não vira desligada', () => {
    expect(proj, 'a comparação tem que ser !== false, nunca === true'
    ).not.toMatch(/it\.enabled === true/);
  });

  it('o cartão mostra o que está pronto, não o tamanho do catálogo', () => {
    expect(tplCodigo, '"disponíveis" para o catálogo inteiro é a falsa competência'
    ).toMatch(/'prontas para usar'/);
    expect(tplCodigo).toMatch(/'desligadas'/);
    expect(tplCodigo, 'o catálogo continua visível, mas como contexto'
    ).toMatch(/'no catálogo'/);
  });

  it('a tabela por tipo separa pronto de catalogado', () => {
    expect(tplCodigo).toMatch(/\['o que é', 'prontas', 'no catálogo'/);
    expect(tplCodigo).toMatch(/\['de onde vem', 'prontas', 'no catálogo'/);
  });

  /**
   *   "—" É NÃO SEI; "0" É NENHUMA
   *
   * `ativasPor?.[k] ?? null` devolvia null para um tipo sem nenhuma ativa,
   * porque a chave só existe quando alguma foi contada. `lsp` aparecia como
   * "—" tendo 12 no catálogo e ZERO ligadas — justamente o caso que a
   * coluna existe para mostrar.
   */
  it('tipo sem nenhuma ligada mostra zero, não travessão', () => {
    expect(tplCodigo, 'mapa presente e chave ausente é zero, não desconhecido'
    ).toMatch(/ativasPor \? \(ativasPor\[k\] \?\? 0\) : null/);
  });
});

/**
 *   A PRIMEIRA TELA PRECISA DIZER O QUE ACONTECEU
 *
 * Teste real feito na tela: um experimento foi reprovado por gate,
 * revertido e registrado como decisão — e a visão geral não mencionava
 * nada disso. Mostrava estado, ramo, commit e instalação: o que o projeto
 * É, nunca o que aconteceu com ele.
 */
describe('a visão geral responde o que aconteceu', () => {
  const proj = fs.readFileSync(
    path.join(path.dirname(fileURLToPath(import.meta.url)), 'store-projection.mjs'), 'utf-8'
  );

  /**
   * Os ids são ULID: os dez caracteres após o prefixo são o instante em
   * base32 de Crockford. Ordenar por id É ordenar por tempo, e a data sai
   * sem campo novo. Id fora do formato devolve null — data errada num
   * painel é pior que campo vazio.
   */
  it('a data sai do próprio id, e id inválido não vira data inventada', () => {
    expect(proj).toMatch(/export function instanteDoId/);
    expect(proj, 'id fora do formato tem que devolver null').toMatch(/if \(!m\) return null/);
    expect(proj, 'as últimas saem ordenadas por tempo').toMatch(/sort\(\(a, b\) => b\.em - a\.em\)/);
  });

  it('a visão geral mostra as últimas decisões', () => {
    expect(tplCodigo).toMatch(/D\.decisions\?\.ultimas/);
    expect(tplCodigo).toMatch(/bloco\('Decidido por último', 'Decisões'/);
  });

  /**
   * O título de uma decisão no Store é um slug identificador
   * (`b-availability-abstention-v1-failed`), não uma frase. Quem lê a
   * primeira tela quer saber O QUE foi decidido, e isso está no corpo.
   */
  it('mostra o que foi decidido, não o identificador', () => {
    expect(tplCodigo, 'o slug sozinho não diz nada a quem lê'
    ).toMatch(/const frase = primeiraFrase\(u\.resumo\)/);
  });

  /**
   *   O MESMO DEFEITO MORAVA EM DOIS LUGARES
   *
   * A aba Ferramentas foi corrigida — "645 disponíveis" com 483
   * desligadas — e o bloco da primeira tela continuou anunciando o
   * catálogo inteiro. Corrigir onde o defeito foi MEDIDO não é corrigir o
   * defeito.
   */
  it('o bloco de ferramentas da primeira tela não anuncia o catálogo como capacidade', () => {
    const b = tplCodigo.match(/bloco\('Ferramentas', 'Ferramentas',([\s\S]*?)\)\}/);
    expect(b, 'o bloco sumiu da visão geral').toBeTruthy();
    expect(b[1], '"disponíveis" para o catálogo inteiro é a falsa competência'
    ).not.toMatch(/metrica\('disponíveis'/);
    expect(b[1], 'a fração mostra os dois números de uma vez'
    ).toMatch(/K\.stats\.ativas.*K\.stats\.total/s);
  });
});
