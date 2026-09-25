/**
 * Régua de UI — checagem R1..R10 num viewport JÁ REDIMENSIONADO pelo chamador.
 *
 * Arquivo é o próprio literal de função: lido como texto e passado direto
 * para `page.evaluate()` (Playwright Python) ou para o `function` do
 * `mcp__playwright__browser_evaluate` (QA). UMA fonte só — nada reescreve
 * esta lógica num segundo lugar (nexos://gotcha, ver navegacao-contract.test.mjs
 * "três dicionários tinham o mesmo furo").
 *
 * Cobre as 8 regras que dá para medir num retrato estático da página:
 * R1 R2 R3 R4 R5 R7 R8 R10. R6 (modal) e R9 (console/hidratação) são
 * procedurais — ver assets/ui-ruler/regua.py e assets/agents/nexos-qa.md.
 *
 * O chamador injeta limiares em `window.__REGUA_CFG` (conteúdo de
 * regua.config.json) ANTES de chamar; sem isso os limiares abaixo (mesmos
 * valores, citados na fonte em regua.config.json) valem como default.
 *
 * GOTCHA desta sessão: animação em andamento no instante da leitura derruba
 * o hero como "sem fundo" e sobreposição como falso positivo. Quem chama
 * espera a animação assentar (ver regua.py) — esta função não espera nada,
 * é um retrato do instante em que foi chamada.
 *
 * GOTCHA (medido ao construir isto): `performance.getEntriesByType('layout-shift'
 * | 'largest-contentful-paint')` devolve SEMPRE vazio — os dois tipos só existem
 * via `PerformanceObserver`, nunca pela lista direta. `buffered:true` funciona
 * mesmo criando o observer DEPOIS do evento (confirmado: 95 entradas recuperadas
 * de um shift disparado antes do observer existir) — por isso não precisa de
 * `add_init_script`/hook antes da navegação, só a função virar async.
 *
 * PRINCÍPIO (revisão do verifier, achado HIGH): a régua NUNCA aprova por não
 * ter conseguido medir. Toda fonte de cegueira (folha cross-origin ilegível,
 * PerformanceObserver sem suporte) marca a regra afetada em `nao_avaliadas` —
 * quem agrega (regua.py) transforma isso em RESULTADO=INCONCLUSIVO, nunca em
 * PASSOU silencioso. "Não hÁ alvo para medir" (sem header fixo, sem hero) é
 * outra coisa — vai para `nao_aplicaveis`, com o motivo, e NÃO bloqueia PASSOU.
 */
async () => {
  const cfg = window.__REGUA_CFG || {};
  const touchMin = cfg.touch_target_min_px ?? 24;
  const mobileMaxW = cfg.mobile_touch_target_max_width ?? 480;
  const clsMax = cfg.cls_max ?? 0.1;
  const lcpMaxMs = cfg.lcp_max_ms ?? 2500;
  const contrastMin = cfg.contrast_min_ratio ?? 4.5;

  const vw = window.innerWidth;
  const violations = [];
  const naoAvaliadas = new Set();
  const naoAplicaveis = [];
  const add = (rule, detail) => violations.push({ rule, detail, vw });

  const visible = (e) => {
    const r = e.getBoundingClientRect();
    return r.width > 0 && r.height > 0;
  };
  const all = [...document.querySelectorAll('body *')].filter(visible);

  // ---- R1: estouro horizontal ----------------------------------------
  // Mesma isenção do console/e2e-regressao.py: conteúdo alcançável por
  // rolagem PRÓPRIA (ancestral com overflow-x:auto/scroll cuja caixa cabe
  // na janela) não é vazamento — é design. `hidden`/`clip` mais perto do
  // que a área rolável continua contando como corte de verdade.
  const isentoPorRolagem = (el) => {
    const rEl = el.getBoundingClientRect();
    let node = el.parentElement;
    while (node) {
      const cs = getComputedStyle(node);
      const r = node.getBoundingClientRect();
      if (cs.overflowX === 'hidden' || cs.overflowX === 'clip') {
        if (rEl.right > r.right + 1 || rEl.left < r.left - 1) return false;
      } else if (cs.overflowX === 'auto' || cs.overflowX === 'scroll') {
        if (r.right <= vw + 1) return true;
      }
      node = node.parentElement;
    }
    return false;
  };
  const vazam = all.filter((e) => e.getBoundingClientRect().right > vw + 1 && !isentoPorRolagem(e));
  if (vazam.length) {
    const ex = vazam[0];
    add('R1', `${vazam.length} elemento(s) vazam da janela (<${ex.tagName.toLowerCase()}${ex.id ? '#' + ex.id : ''}>)`);
  }

  // ---- R2: texto cortado ou sobreposto ---------------------------------
  const comTexto = all
    .filter((e) => [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim()))
    .slice(0, 300); // mesmo teto de amostra do console/contraste.py — página real não vira O(n^2) sem fim
  const cortados = comTexto.filter((e) => {
    const cs = getComputedStyle(e);
    const semAviso = cs.textOverflow !== 'ellipsis' && cs.webkitLineClamp === 'none';
    return (cs.overflowX === 'hidden' || cs.overflowX === 'clip') && semAviso && e.scrollWidth > e.clientWidth + 1;
  });
  if (cortados.length) {
    add('R2', `${cortados.length} texto(s) cortado(s) sem elipse/line-clamp`);
  } else {
    let sobreposto = null;
    for (let i = 0; i < comTexto.length && !sobreposto; i++) {
      for (let j = i + 1; j < comTexto.length; j++) {
        const a = comTexto[i];
        const b = comTexto[j];
        if (a.contains(b) || b.contains(a)) continue;
        const ra = a.getBoundingClientRect();
        const rb = b.getBoundingClientRect();
        const ix = Math.max(0, Math.min(ra.right, rb.right) - Math.max(ra.left, rb.left));
        const iy = Math.max(0, Math.min(ra.bottom, rb.bottom) - Math.max(ra.top, rb.top));
        const menor = Math.min(ra.width * ra.height, rb.width * rb.height);
        if (menor > 0 && (ix * iy) / menor > 0.4) {
          sobreposto = `texto sobreposto entre <${a.tagName.toLowerCase()}> e <${b.tagName.toLowerCase()}>`;
          break;
        }
      }
    }
    if (sobreposto) add('R2', sobreposto);
  }

  // ---- coleta RECURSIVA de regras CSS (usada por R3 e R4) ----------------
  // Desce por QUALQUER profundidade de @media/@supports/@layer/@container e
  // segue @import (CSSImportRule.styleSheet) — achado do verifier: a versão
  // anterior só achatava um nível, e uma folha cross-origin ilegível (CORS)
  // simplesmente desaparecia da amostra sem deixar rastro. Toda folha/import
  // que não puder ser lida entra em `folhasNaoLidas`; quem chama (regua.py)
  // transforma isso em R3/R4 = nao_avaliadas, nunca em "sem violação".
  const folhasNaoLidas = [];
  const flatRules = []; // regras "folha" com .style (inclui :root, .classe, etc.)
  const keyframesRules = []; // CSSKeyframesRule, em qualquer profundidade
  const mediaRules = []; // CSSMediaRule, em qualquer profundidade (reduced-motion)
  const TETO_PROFUNDIDADE = 12; // guarda contra @import cíclico/patológico

  function visitarRegra(rule, profundidade) {
    if (!rule || profundidade > TETO_PROFUNDIDADE) return;
    if (typeof CSSKeyframesRule !== 'undefined' && rule instanceof CSSKeyframesRule) {
      keyframesRules.push(rule);
      return;
    }
    if (typeof CSSImportRule !== 'undefined' && rule instanceof CSSImportRule) {
      let folha = null;
      try {
        folha = rule.styleSheet;
      } catch {
        folha = null;
      }
      if (!folha) {
        folhasNaoLidas.push(rule.href || '(@import sem href)');
        return;
      }
      let regrasImportadas;
      try {
        regrasImportadas = [...folha.cssRules];
      } catch {
        folhasNaoLidas.push(rule.href || folha.href || '(@import ilegível — cross-origin sem CORS)');
        return;
      }
      for (const r of regrasImportadas) visitarRegra(r, profundidade + 1);
      return;
    }
    if (typeof CSSMediaRule !== 'undefined' && rule instanceof CSSMediaRule) {
      mediaRules.push(rule);
      for (const r of [...rule.cssRules]) visitarRegra(r, profundidade + 1);
      return;
    }
    // @supports, @layer, @container: agrupadores de verdade, nunca têm
    // `.style` própria — desce recursivamente e para por aqui.
    //
    // GOTCHA (medido ao construir isto): `rule.cssRules` NÃO serve para
    // distinguir "é um agrupador" de "é uma regra folha" — desde CSS
    // Nesting, TODO `CSSStyleRule` (até `.r1 { width: 3000px }`, sem nada
    // aninhado dentro) devolve um `CSSRuleList` VAZIO mas verdadeiro em
    // `.cssRules`. `if (rule.cssRules)` sozinho tratava toda folha como
    // container, recursava em zero filhos e RETORNAVA antes de chegar no
    // `if (rule.style)` — R3 sumia da amostra inteira, sem folha ilegível
    // nenhuma no caminho. Por isso o agrupador é reconhecido por TIPO
    // (`instanceof`), nunca pela presença de `.cssRules`.
    const EH_AGRUPADOR =
      (typeof CSSSupportsRule !== 'undefined' && rule instanceof CSSSupportsRule) ||
      (typeof CSSLayerBlockRule !== 'undefined' && rule instanceof CSSLayerBlockRule) ||
      (typeof CSSContainerRule !== 'undefined' && rule instanceof CSSContainerRule);
    if (EH_AGRUPADOR) {
      for (const r of [...rule.cssRules]) visitarRegra(r, profundidade + 1);
      return;
    }
    if (rule.style) flatRules.push(rule);
    // CSS Nesting: uma CSSStyleRule pode ELA MESMA conter regras aninhadas
    // (`.card { .title { color: red } }`) — se houver, também descem.
    if (rule.cssRules && rule.cssRules.length) {
      for (const r of [...rule.cssRules]) visitarRegra(r, profundidade + 1);
    }
  }

  for (const sheet of [...document.styleSheets]) {
    let rules;
    try {
      rules = [...sheet.cssRules];
    } catch {
      folhasNaoLidas.push(sheet.href || '(<style> inline ilegível)');
      continue;
    }
    for (const r of rules) visitarRegra(r, 0);
  }
  if (folhasNaoLidas.length) {
    naoAvaliadas.add('R3');
    naoAvaliadas.add('R4');
  }

  // ---- R3: borda/sombra/raio fora dos tokens ---------------------------
  // Token = variável CSS declarada em `:root` (arquitetura: "tokens = as
  // variáveis do :root quando não houver SPEC"). Literal isento: valores
  // que desligam a decoração, não escolhem uma (none/0/transparent/...).
  const rootTokens = new Set();
  for (const rule of flatRules) {
    if (rule.selectorText !== ':root' || !rule.style) continue;
    for (let i = 0; i < rule.style.length; i++) {
      const p = rule.style[i];
      if (p.startsWith('--')) rootTokens.add(p.toLowerCase());
    }
  }
  const EXEMPT = new Set(['none', '0', '0px', 'transparent', 'inherit', 'initial', 'unset', 'currentcolor']);
  const usesOnlyTokens = (val) => {
    const vars = [...val.matchAll(/var\(\s*(--[a-z0-9-]+)/gi)].map((m) => m[1].toLowerCase());
    if (!vars.length) return EXEMPT.has(val.trim().toLowerCase());
    return vars.every((v) => rootTokens.has(v));
  };
  // `border: ...` reseta as longhands de `border-image-*` para o valor
  // INICIAL delas (100%/1/stretch) mesmo sem ninguém pedir — MEDIDO: o CSSOM
  // devolve essas três em toda regra que declara `border`, mesmo quando a
  // folha nunca menciona `border-image`. Regra fala de contorno/sombra/raio,
  // não da propriedade de imagem — fora do escopo de R3.
  const decorBad = new Set();
  for (const rule of flatRules) {
    if (!rule.style) continue;
    for (let i = 0; i < rule.style.length; i++) {
      const prop = rule.style[i];
      if (!/^border|^box-shadow/.test(prop) || prop.includes('image')) continue;
      const val = rule.style.getPropertyValue(prop).trim();
      if (val && !usesOnlyTokens(val)) decorBad.add(`${prop}: ${val}`);
    }
  }
  if (decorBad.size) add('R3', [...decorBad].slice(0, 3).join(' · '));

  // ---- R4: animação fora de transform/opacity, ou sem reduced-motion ---
  const kfProps = new Set();
  for (const r of keyframesRules) {
    for (const step of r.cssRules) {
      for (let i = 0; i < step.style.length; i++) kfProps.add(step.style[i].toLowerCase());
    }
  }
  const transProps = new Set();
  for (const rule of flatRules) {
    if (!rule.style) continue;
    const tp = rule.style.getPropertyValue('transition-property');
    if (!tp) continue;
    for (const p of tp.split(',').map((s) => s.trim().toLowerCase()).filter(Boolean)) {
      if (p !== 'none') transProps.add(p);
    }
  }
  const foraDoPermitido = [...new Set([...kfProps, ...transProps])].filter((p) => p !== 'transform' && p !== 'opacity');
  const temReducedMotion = mediaRules.some((r) =>
    /prefers-reduced-motion\s*:\s*reduce/i.test(r.conditionText || r.media.mediaText)
  );
  if (foraDoPermitido.length) {
    add('R4', `anima propriedade(s) fora de transform/opacity: ${foraDoPermitido.join(', ')}`);
  } else if ((kfProps.size || transProps.size) && !temReducedMotion) {
    add('R4', 'anima sem bloco @media (prefers-reduced-motion: reduce)');
  }

  // ---- R5: CLS > limiar ---------------------------------------------------
  // `buffered:true` recupera shifts anteriores à criação do observer — não
  // depende de a régua ter sido injetada antes do load (ver gotcha acima).
  // Achado do verifier (LOW): sem PerformanceObserver ou sem suporte ao tipo,
  // a versão anterior resolvia com o valor INICIAL (0) — indistinguível de
  // "medido e limpo". Agora `suportado:false` marca a regra como não avaliada.
  const observarBufferado = (tipo, reduzir, timeoutMs = 150) =>
    new Promise((resolve) => {
      const suportaTipo =
        typeof PerformanceObserver !== 'undefined' &&
        (!PerformanceObserver.supportedEntryTypes || PerformanceObserver.supportedEntryTypes.includes(tipo));
      if (!suportaTipo) {
        resolve({ valor: reduzir.inicial, suportado: false });
        return;
      }
      try {
        let acc = reduzir.inicial;
        const obs = new PerformanceObserver((list) => {
          acc = reduzir.passo(acc, list.getEntries());
        });
        obs.observe({ type: tipo, buffered: true });
        setTimeout(() => {
          obs.disconnect();
          resolve({ valor: acc, suportado: true });
        }, timeoutMs);
      } catch {
        resolve({ valor: reduzir.inicial, suportado: false });
      }
    });

  const clsResult = await observarBufferado('layout-shift', {
    inicial: 0,
    passo: (acc, entries) => acc + entries.filter((e) => !e.hadRecentInput).reduce((s, e) => s + e.value, 0),
  });
  if (!clsResult.suportado) naoAvaliadas.add('R5');
  else if (clsResult.valor > clsMax) add('R5', `CLS ${clsResult.valor.toFixed(3)} > ${clsMax}`);

  // ---- R7: âncora escondida sob header fixo -----------------------------
  const fixos = all.filter((e) => {
    const p = getComputedStyle(e).position;
    return p === 'fixed' || p === 'sticky';
  });
  const headerH = fixos.reduce((m, e) => Math.max(m, e.getBoundingClientRect().height), 0);
  if (headerH > 0) {
    const alvos = [...document.querySelectorAll('a[href^="#"]')]
      .map((a) => a.getAttribute('href').slice(1))
      .filter(Boolean)
      .map((id) => document.getElementById(id))
      .filter(Boolean);
    const semMargem = alvos.filter((el) => parseFloat(getComputedStyle(el).scrollMarginTop || '0') < headerH - 1);
    if (semMargem.length) {
      add('R7', `${semMargem.length} âncora(s) sem scroll-margin-top >= ${Math.round(headerH)}px (altura do cabeçalho fixo)`);
    }
  } else {
    naoAplicaveis.push({ rule: 'R7', motivo: 'nenhum elemento position:fixed/sticky encontrado nesta largura' });
  }

  // ---- R8: hero (fundo, dimensão de imagem, contraste, LCP) -------------
  const hero = document.querySelector('[data-hero], .hero, header.hero, section.hero');
  if (!hero) {
    naoAplicaveis.push({ rule: 'R8', motivo: 'nenhum elemento [data-hero]/.hero/header.hero/section.hero encontrado' });
  } else {
    const bgOf = (e) => {
      while (e) {
        const cs = getComputedStyle(e);
        if (cs.backgroundImage !== 'none' || !/rgba\(0, 0, 0, 0\)|transparent/.test(cs.backgroundColor)) {
          return { cor: cs.backgroundColor, img: cs.backgroundImage };
        }
        e = e.parentElement;
      }
      return { cor: 'rgb(255, 255, 255)', img: 'none' };
    };
    const bg = bgOf(hero);
    if (bg.img === 'none' && /rgba\(0, 0, 0, 0\)|transparent/.test(bg.cor)) {
      add('R8', 'hero sem fundo (nem cor nem imagem cobrindo a caixa)');
    }
    const imgsSemDim = [...hero.querySelectorAll('img')].filter(
      (img) => !(img.hasAttribute('width') && img.hasAttribute('height')) && getComputedStyle(img).aspectRatio === 'auto'
    );
    if (imgsSemDim.length) add('R8', `${imgsSemDim.length} <img> no hero sem width/height (fonte de CLS)`);

    const lum = (c) => {
      const m = c.match(/[\d.]+/g);
      if (!m) return 0;
      const [r, g, b] = m.slice(0, 3).map((v) => {
        v /= 255;
        return v <= 0.03928 ? v / 12.92 : Math.pow((v + 0.055) / 1.055, 2.4);
      });
      return 0.2126 * r + 0.7152 * g + 0.0722 * b;
    };
    const heroTextos = [...hero.querySelectorAll('*')].filter((e) =>
      [...e.childNodes].some((n) => n.nodeType === 3 && n.textContent.trim())
    );
    const baixos = heroTextos.filter((e) => {
      const fg = getComputedStyle(e).color;
      const fundo = bgOf(e).cor;
      const a = lum(fg);
      const b = lum(fundo);
      const razao = (Math.max(a, b) + 0.05) / (Math.min(a, b) + 0.05);
      return razao < contrastMin;
    });
    if (baixos.length) add('R8', `${baixos.length} texto(s) do hero abaixo de ${contrastMin}:1 de contraste`);

    const lcpResult = await observarBufferado('largest-contentful-paint', {
      inicial: 0,
      passo: (_acc, entries) => (entries.length ? entries[entries.length - 1].startTime : _acc),
    });
    if (!lcpResult.suportado) naoAvaliadas.add('R8');
    else if (lcpResult.valor > lcpMaxMs) add('R8', `LCP ${Math.round(lcpResult.valor)}ms > ${lcpMaxMs}ms`);
  }

  // ---- R10: alvo de toque < mínimo em largura de celular -----------------
  // WCAG 2.2 SC 2.5.8 isenta link em MEIO A TEXTO corrido (a exceção
  // "targets in a sentence or block of text") — `display:inline` sem
  // padding é a assinatura de um link de frase, não um botão disfarçado.
  if (vw <= mobileMaxW) {
    const clicaveis = all.filter((e) => e.matches('a,button,[role=button],[role=tab],[tabindex="0"],summary,input,select,textarea'));
    const pequenos = clicaveis.filter((e) => {
      const cs = getComputedStyle(e);
      if (e.tagName === 'A' && cs.display === 'inline') return false; // link em texto corrido: isento
      const r = e.getBoundingClientRect();
      return r.width > 0 && r.height > 0 && (r.height < touchMin || r.width < touchMin);
    });
    if (pequenos.length) add('R10', `${pequenos.length} alvo(s) clicável(is) abaixo de ${touchMin}px em ${vw}px`);
  }

  return {
    violacoes: violations,
    folhas_nao_lidas: [...new Set(folhasNaoLidas)],
    nao_avaliadas: [...naoAvaliadas],
    nao_aplicaveis: naoAplicaveis,
  };
}
