"""Regressao local do console — rodar antes de cada commit de console.

    node console/build-console.mjs && python3 console/e2e-regressao.py

Padrao da skill webapp-testing (anthropics/skills, Apache-2.0): script Playwright
sobre o HTML estatico via file://, sem servidor. Chrome do sistema em headless com
perfil temporario — nunca o perfil do dono (nexos://decision/verificacao-de-ui-playwright).

Cada aba precisa: ficar selecionada, mostrar exatamente 1 painel, com conteudo, e
caber na largura da janela (rolagem horizontal reprova). Console do navegador sem erro.

Larguras cobrem o brief do PO (celular/tablet/desktop): 390 e 768 tambem cobram
alvo de toque e vazamento horizontal; 1440 reproduziu o overflow historico da aba
Saude. Em 390 o alvo de toque (WCAG 2.5.8, minimo 24px — o painel mede 44px) e
cobrado; em 768/1440 nao, porque mouse tolera alvo menor e a tabela de dados usa
linhas mais densas ali de proposito.

Fonte minima 12px e zero fontes abaixo de 12 valem nas tres larguras — e o motivo
de a barra de abas ter 1 linha so e vir ANTES do main no DOM tambem: os tres sao
criterio Must do brief-po.md, nao preferencia de estilo. A ordem no DOM troca por
geometria de rolagem (achado do QA): posicao de repouso apos rolar ate o fim NAO
reproduz sobreposicao de forma estavel (o sticky-bottom so cobre conteudo durante
a rolagem, nunca no repouso final — medido, deu falso-negativo), enquanto nav vir
depois de main e' determinismo puro: teclado alcanca o painel inteiro antes da
navegacao, e so se resolve movendo nav para antes de main no HTML.

"Vazam" exclui elemento alcancavel por rolagem propria (ancestral com
overflow-x:auto/scroll cuja PRÓPRIA caixa cabe na janela) — uma tabela larga
que rola dentro de si não é vazamento, é o design pretendido. Ancestral com
overflow:hidden mais perto do que a area rolavel continua contando como
corte de verdade, porque ali o conteudo nunca fica alcancavel. A logica roda
uma auto-verificacao contra HTML sintetico (`autoverificar_isencao`) antes do
gate de verdade — sem isso, um bug nela aprovaria ou reprovaria o console
inteiro por um motivo errado, em silencio.

Exige Playwright para Python e Google Chrome; no sandbox do Claude Code o Chrome nao
abre (socket do ProcessSingleton), entao roda fora dele.
"""
import json
import sys
import tempfile
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

#: 1200 reproduziu o overflow da aba Saude em 23/09; 1440 cobre o mesmo teto.
#: 1920 e 3440 entraram na rodada 3: telas reais do dono (1920x1080, 3440x1440,
#: 2560x1664 Retina — 1920 e 3440 cobrem as bordas dessa faixa) e nenhuma
#: largura >=1500 estava nos gates quando o layout de tela larga quebrou.
LARGURAS = (390, 768, 1440, 1920, 3440)
#: Altura por largura — o pareamento real das telas do dono, não um valor
#: generico repetido pra todas.
ALTURAS = {390: 844, 768: 1024, 1440: 900, 1920: 1080, 3440: 1440}
HTML = Path(__file__).resolve().parent / "console.html"

#: Corpo reutilizado dentro de duas funcoes-alvo do Playwright (a das
#: metricas reais e a da auto-verificacao contra HTML sintetico, mais
#: abaixo). Fica FORA de qualquer `(...) => {}`: `page.evaluate` só chama
#: a string como funcao se ela comecar por `(` — prefixado antes do corpo,
#: o texto deixaria de parecer uma funcao e o `id`/`vw` do argumento nunca
#: chegaria dentro.
ISENTO_POR_ROLAGEM_JS = """
  const isentoPorRolagem = (el, vw) => {
    const rEl = el.getBoundingClientRect();
    let node = el.parentElement;
    while (node) {
      const ox = getComputedStyle(node).overflowX;
      const r = node.getBoundingClientRect();
      if (ox === 'hidden' || ox === 'clip') {
        /**
         *   HIDDEN SO CORTA SE REALMENTE RECORTAR O ELEMENTO
         *
         * Medido: `.bar{overflow:hidden}` (arredonda o canto do
         * preenchimento) e' ancestral de `<i style="width:59%">` — e vira
         * "corte" numa leitura ingenua, mesmo a caixa de `.bar` cabendo na
         * janela e o `<i>` nunca passando dela (largura em % nunca excede
         * 100% do pai). Nada ali esta de fato invisivel; e' figurante.
         *
         * O ancestral hidden so bloqueia quando a caixa do ELEMENTO
         * verificado extrapola a DELE — aí sim uma parte fica cortada pra
         * sempre, sem rolagem que alcance. Cabendo inteiro dentro do
         * hidden, ele e' irrelevante pro alcance e a subida continua.
         */
        if (rEl.right > r.right + 1 || rEl.left < r.left - 1) return false;
      } else if (ox === 'auto' || ox === 'scroll') {
        /* A area de rolagem so isenta quem esta dentro dela se ELA MESMA
           couber na janela — senao o problema so subiu de nivel. */
        if (r.right <= vw + 1) return true;
      }
      node = node.parentElement;
    }
    return false;
  };
"""

METRICAS = """(id) => {
  const vw = window.innerWidth, painel = document.getElementById(id);""" + ISENTO_POR_ROLAGEM_JS + """
  const vis = (e) => { const r = e.getBoundingClientRect(); return r.width > 0 && r.height > 0; };
  const todos = [...document.querySelectorAll('body *')].filter(vis);
  /**
   *   CONTEUDO ALCANCAVEL POR ROLAGEM PROPRIA NAO E' "VAZAMENTO"
   *
   * Medido pelo coordenador: 100% dos "vazam" a 390px tinham ancestral
   * `<table>` com `overflow-x:auto` cuja propria caixa cabia na janela —
   * ou seja, rolando a tabela (nao a pagina) dava pra alcancar tudo. Isso
   * nao e' o defeito que "vazam" existe pra pegar (conteudo que NUNCA se
   * alcanca). Um ancestral com `overflow:hidden` continua contando como
   * corte de verdade — ver `isentoPorRolagem` acima.
   */
  const vazam = todos.filter(e => e.getBoundingClientRect().right > vw + 1 && !isentoPorRolagem(e, vw)).length;
  const clic = todos.filter(e => e.matches('a,button,[role=tab],[tabindex="0"],summary,input,select'));
  const pequenos = clic.filter(e => { const r = e.getBoundingClientRect(); return r.height < 44 || r.width < 44; }).length;
  const fontes = todos.filter(e => e.childNodes.length && [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim()))
                      .map(e => parseFloat(getComputedStyle(e).fontSize));
  const tabs = [...document.querySelectorAll('#tabs [role=tab]')];
  const topoTabs = new Set(tabs.filter(vis).map(t => Math.round(t.getBoundingClientRect().top)));
  /**
   * "nao intersecta painel": geometria de rolagem e' fragil (posicao de
   * repouso depende de quanto o conteudo excede a janela, e um sticky-bottom
   * so cobre conteudo de verdade NO MEIO da rolagem, nunca no repouso final —
   * medido: dava falso-negativo). O que e' estavel e' a ORDEM no DOM: nav
   * ANTES de main garante teclado alcancando a navegacao primeiro (achado do
   * QA) e, com nav sob o cabecalho em vez de preso ao rodape, elimina por
   * construcao a barra flutuando sobre o fim do conteudo.
   */
  const nav = document.getElementById('tabs'), main = document.getElementById('panes');
  const navAntesDoMain = !!(nav.compareDocumentPosition(main) & Node.DOCUMENT_POSITION_FOLLOWING);
  return {
    visiveis: [...document.querySelectorAll('[role="tabpanel"]')].filter(x => !x.hidden).length,
    caracteres: painel.innerText.trim().length,
    doc: document.documentElement.scrollWidth, janela: vw,
    vazam, alvos_pequenos: pequenos,
    fonte_min: fontes.length ? Math.min(...fontes) : null,
    fontes_abaixo_12: fontes.filter(f => f < 12).length,
    linhas_de_abas: topoTabs.size,
    nav_antes_do_main: navAntesDoMain,
  };
}"""


#: HTML sintetico pra provar `isentoPorRolagem` ANTES de confiar nela no
#: gate real. Quatro casos — os tres que o coordenador pediu como mutacao
#: obrigatoria mais um 4o que o proprio console real revelou (medido
#: depois: `.bar{overflow:hidden}` reprovava o preenchimento `<i>` mesmo
#: cabendo inteiro dentro da trilha, so por ter um hidden no caminho):
#:   fora            — largo, sem nenhum ancestral rolavel: tem que reprovar.
#:   dentro          — largo, dentro de uma area com overflow-x:auto que
#:                      cabe na janela: tem que passar (alcancavel rolando).
#:   dentroEscondido — largo, dentro de um hidden MENOR do que ele (recorta
#:                      de verdade — a caixa do elemento passa da caixa do
#:                      hidden), que por sua vez esta numa area rolavel: tem
#:                      que reprovar (o hidden corta ANTES de alcancar a
#:                      rolagem, e o que passa dele nunca fica visivel).
#:   dentroCosmetico — do TAMANHO do hidden que o contem (nada recortado de
#:                      verdade — igual `<i style="width:100%">` dentro de
#:                      `.bar`), com uma area rolavel que cabe mais acima:
#:                      tem que passar (o hidden aqui e' so figurante).
_MUTACAO_HTML = """<!doctype html><html><body style="margin:0">
  <div id="fora" style="width:2000px;height:10px">fora</div>
  <div id="rolavel" style="width:200px;overflow-x:auto;white-space:nowrap">
    <div id="dentro" style="width:2000px;height:10px;display:inline-block">dentro</div>
  </div>
  <div id="rolavel2" style="width:200px;overflow-x:auto;white-space:nowrap">
    <div id="escondeInterno" style="display:inline-block;width:40px;height:10px;overflow:hidden">
      <div id="dentroEscondido" style="width:2000px;height:10px">escondido</div>
    </div>
  </div>
  <div id="rolavel3" style="width:200px;overflow-x:auto;white-space:nowrap">
    <div id="trilhaCosmetica" style="display:inline-block;width:80px;height:5px;overflow:hidden">
      <div id="dentroCosmetico" style="width:100%;height:100%">preenchimento</div>
    </div>
  </div>
</body></html>"""


def autoverificar_isencao(p) -> None:
    """Prova a logica de `isentoPorRolagem` contra HTML sintetico antes de
    rodar o gate de verdade — sem isso, um bug nela reprovaria ou aprovaria
    o console inteiro por um motivo errado, em silencio.
    """
    browser = p.chromium.launch(channel="chrome", headless=True)
    page = browser.new_page(viewport={"width": 390, "height": 200})
    page.set_content(_MUTACAO_HTML)
    checagem = "() => {" + ISENTO_POR_ROLAGEM_JS + """
      return {
        fora: isentoPorRolagem(document.getElementById('fora'), 390),
        dentro: isentoPorRolagem(document.getElementById('dentro'), 390),
        dentroEscondido: isentoPorRolagem(document.getElementById('dentroEscondido'), 390),
        dentroCosmetico: isentoPorRolagem(document.getElementById('dentroCosmetico'), 390),
      };
    }"""
    r = page.evaluate(checagem)
    page.close()
    browser.close()
    esperado = {"fora": False, "dentro": True, "dentroEscondido": False, "dentroCosmetico": True}
    erros = [f"{k}: esperado isento={v}, veio {r[k]}" for k, v in esperado.items() if r[k] is not v]
    if erros:
        raise AssertionError("auto-verificacao de isentoPorRolagem falhou — " + "; ".join(erros))


def main() -> int:
    if not HTML.exists():
        print(f"console.html ausente em {HTML}: rode node console/build-console.mjs antes", file=sys.stderr)
        return 2
    shots = Path(tempfile.mkdtemp(prefix="console-e2e-"))
    t0, erros, falhas, abas = time.time(), [], [], 0
    with sync_playwright() as p:
        autoverificar_isencao(p)
        browser = p.chromium.launch(channel="chrome", headless=True)
        try:
            for largura in LARGURAS:
                page = browser.new_page(viewport={"width": largura, "height": ALTURAS[largura]})
                try:
                    page.on("console", lambda m: m.type == "error" and erros.append(m.text))
                    page.on("pageerror", lambda e: erros.append(f"pageerror: {e}"))
                    page.goto(HTML.as_uri())
                    page.wait_for_load_state("networkidle")
                    page.wait_for_timeout(150)
                    # Ordem do Tab, ANTES de qualquer clique — achado do
                    # verificador: scrollIntoView() na aba ativa (rodado no
                    # carregamento) reescrevia o ponto de partida da
                    # navegacao sequencial no Chrome, e o 1o Tab ia pra
                    # dentro do painel, pulando cabecalho e nav inteiros.
                    page.keyboard.press("Tab")
                    tab1 = page.evaluate("() => ({tag: document.activeElement.tagName, ehLinkDoCabecalho: !!document.activeElement.closest('header')})")
                    page.keyboard.press("Tab")
                    tab2 = page.evaluate("() => ({tag: document.activeElement.tagName, selecionada: document.activeElement.getAttribute('aria-selected'), naNav: !!document.activeElement.closest('#tabs')})")
                    if tab1["tag"] != "A" or not tab1["ehLinkDoCabecalho"]:
                        falhas.append(f"{largura}px: 1o Tab de pagina recem-carregada nao foi o link do cabecalho (veio {tab1['tag']})")
                    if tab2["tag"] != "BUTTON" or not tab2["naNav"] or tab2["selecionada"] != "true":
                        falhas.append(f"{largura}px: 2o Tab de pagina recem-carregada nao foi a aba ativa (veio {tab2['tag']}, na nav={tab2['naNav']}, selecionada={tab2['selecionada']})")
                    tabs = page.locator('#tabs [role="tab"]')
                    abas = tabs.count()
                    if abas == 0:
                        falhas.append(f"{largura}px: nenhuma aba encontrada")
                    for i in range(abas):
                        tab = tabs.nth(i)
                        tab.click()
                        painel = tab.get_attribute("aria-controls")
                        page.wait_for_selector(f"#{painel}:not([hidden])")
                        e = page.evaluate(METRICAS, painel)
                        nome = tab.inner_text().strip()
                        if nome == "Visão geral":
                            # Teto de 1680px (rodada 3): sem isto o HUD volta
                            # a esticar sem fim numa tela ultrawide — so' vira
                            # visivel a partir de 1680px de janela, entao o
                            # teste real esta em 1920/3440 (as demais larguras
                            # so provam que a checagem nao quebra abaixo do teto).
                            largura_secao = page.evaluate(
                                "() => { const s = document.querySelector('section[data-name=\"Visão geral\"]'); "
                                "return s ? Math.round(s.getBoundingClientRect().width) : null; }"
                            )
                            if largura_secao is not None and largura_secao > 1682:
                                falhas.append(f"{largura}px {nome}: seção mede {largura_secao}px, acima do teto de 1680px")
                        if tab.get_attribute("aria-selected") != "true":
                            falhas.append(f"{largura}px {nome}: aba nao ficou selecionada")
                        if e["visiveis"] != 1:
                            falhas.append(f"{largura}px {nome}: {e['visiveis']} paineis visiveis")
                        if e["caracteres"] == 0:
                            falhas.append(f"{largura}px {nome}: painel vazio")
                        if e["doc"] > e["janela"]:
                            falhas.append(f"{largura}px {nome}: rolagem horizontal (documento {e['doc']}px)")
                        if e["vazam"] > 0:
                            falhas.append(f"{largura}px {nome}: {e['vazam']} elemento(s) vazam da janela")
                        if largura == 390 and e["alvos_pequenos"] > 0:
                            falhas.append(f"{largura}px {nome}: {e['alvos_pequenos']} alvo(s) clicavel(is) abaixo de 44px")
                        if e["fonte_min"] is not None and e["fonte_min"] < 12:
                            falhas.append(f"{largura}px {nome}: fonte minima {e['fonte_min']}px (< 12px)")
                        if e["fontes_abaixo_12"] > 0:
                            falhas.append(f"{largura}px {nome}: {e['fontes_abaixo_12']} texto(s) abaixo de 12px")
                        if e["linhas_de_abas"] > 1:
                            falhas.append(f"{largura}px {nome}: barra de abas quebrou em {e['linhas_de_abas']} linhas")
                        if not e["nav_antes_do_main"]:
                            falhas.append(f"{largura}px {nome}: nav vem depois de main no DOM (teclado passa pelo painel antes da navegacao)")
                        page.screenshot(path=str(shots / f"{largura}-{i + 1:02d}-{painel}.png"))
                finally:
                    # Sem isto, uma excecao no meio do loop (ex.:
                    # page.evaluate lancando) pulava o fechamento e a pagina
                    # ficava aberta ate o processo do Chrome inteiro morrer.
                    page.close()
        finally:
            browser.close()
    falhas += [f"console: {m}" for m in erros]
    print(json.dumps({"abas": abas, "larguras": LARGURAS, "falhas": falhas, "screenshots": str(shots),
                      "segundos": round(time.time() - t0, 1), "RESULTADO": "PASSOU" if not falhas else "REPROVOU"},
                     ensure_ascii=False, indent=1))
    return 0 if not falhas else 1


if __name__ == "__main__":
    sys.exit(main())
