"""Contraste do console — 0 elementos abaixo de 4,5:1 (WCAG 2.2 AA) em toda aba x largura.

    node console/build-console.mjs && python3 console/contraste.py

Promovido do scratchpad de UX (media original rodava so a 1440px, so a aba
"Trabalho feito"): o Must do brief-po.md e' "contraste sem regressao (0/400 <4,5)"
sem recorte de aba nem largura, entao a leitura cobre as 11 abas nas 3 larguras
do e2e-regressao.py.

Mesmo padrao do e2e-regressao.py: Chrome do sistema headless, perfil temporario,
roda fora do sandbox do Claude Code (socket do ProcessSingleton).
"""
import json
import sys
import time
from pathlib import Path

from playwright.sync_api import sync_playwright

#: Mesma faixa do e2e-regressao.py (rodada 3: 1920 e 3440 entraram porque
#: nenhuma largura >=1500 estava em nenhum gate quando o layout de tela
#: larga quebrou).
LARGURAS = (390, 768, 1440, 1920, 3440)
ALTURAS = {390: 844, 768: 1024, 1440: 900, 1920: 1080, 3440: 1440}
HTML = Path(__file__).resolve().parent / "console.html"

# Mesma formula do medidor original (scratchpad/contraste.py): luminancia
# relativa WCAG, razao de contraste, cor de fundo herdada do primeiro
# ancestral opaco. `slice(0, 400)` limita a amostra por painel, como o Must
# do brief pede ("0/400").
CONTRASTE = """() => {
  const lum = (c) => { const m = c.match(/[\\d.]+/g).map(Number); const [r,g,b] = m.slice(0,3).map(v => { v/=255; return v<=0.03928? v/12.92 : Math.pow((v+0.055)/1.055,2.4); }); return 0.2126*r+0.7152*g+0.0722*b; };
  const bgOf = (e) => { while (e) { const c = getComputedStyle(e).backgroundColor; if (!/rgba\\(0, 0, 0, 0\\)|transparent/.test(c)) return c; e = e.parentElement; } return 'rgb(255,255,255)'; };
  const opac = (e) => { let o = 1; while (e) { o *= parseFloat(getComputedStyle(e).opacity); e = e.parentElement; } return o; };
  const painel = document.querySelector('[role=tabpanel]:not([hidden])');
  const alvos = [...painel.querySelectorAll('p, td, th, span, small, div, h2, h3, label, li')].filter(e => [...e.childNodes].some(n => n.nodeType === 3 && n.textContent.trim().length > 3)).slice(0, 400);
  const razoes = alvos.map(e => { const fg = getComputedStyle(e).color, bg = bgOf(e); const a = lum(fg), b = lum(bg); const r = (Math.max(a,b)+0.05)/(Math.min(a,b)+0.05); return {r: Math.round(r*10)/10, op: Math.round(opac(e)*100)/100, fg, bg, t: e.textContent.trim().slice(0,30), fs: getComputedStyle(e).fontSize}; });
  const abaixo = razoes.filter(x => x.r < 4.5);
  return {amostra: razoes.length, abaixo_de_4_5: abaixo.length, opacidade_min: razoes.length ? Math.min(...razoes.map(x=>x.op)) : 1, piores: abaixo.sort((a,b)=>a.r-b.r).slice(0,6)};
}"""


def main() -> int:
    if not HTML.exists():
        print(f"console.html ausente em {HTML}: rode node console/build-console.mjs antes", file=sys.stderr)
        return 2
    t0, linhas, falhas = time.time(), [], []
    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        try:
            for largura in LARGURAS:
                page = browser.new_page(viewport={"width": largura, "height": ALTURAS[largura]})
                try:
                    page.goto(HTML.as_uri())
                    page.wait_for_load_state("networkidle")
                    tabs = page.locator('#tabs [role="tab"]')
                    for i in range(tabs.count()):
                        tab = tabs.nth(i)
                        nome = tab.inner_text().strip()
                        tab.click()
                        painel = tab.get_attribute("aria-controls")
                        page.wait_for_selector(f"#{painel}:not([hidden])")
                        # A animacao de entrada dura ate .26s; ler antes dela
                        # assentar pegaria opacidade em transicao e
                        # inventaria baixo contraste.
                        page.wait_for_timeout(300)
                        r = page.evaluate(CONTRASTE)
                        linhas.append({"largura": largura, "aba": nome, **r})
                        if r["abaixo_de_4_5"] > 0:
                            falhas.append(
                                f"{largura}px {nome}: {r['abaixo_de_4_5']}/{r['amostra']} abaixo de 4,5:1 "
                                f"— pior {r['piores'][0]['r']}:1 em \"{r['piores'][0]['t']}\""
                            )
                finally:
                    # Sem isto, uma excecao no meio do loop deixava a pagina
                    # (e, se acontecesse cedo o bastante, o browser) aberta.
                    page.close()
        finally:
            browser.close()
    print(json.dumps({"linhas": linhas, "larguras": LARGURAS, "falhas": falhas,
                      "segundos": round(time.time() - t0, 1),
                      "RESULTADO": "PASSOU" if not falhas else "REPROVOU"}, ensure_ascii=False, indent=1))
    return 0 if not falhas else 1


if __name__ == "__main__":
    sys.exit(main())
