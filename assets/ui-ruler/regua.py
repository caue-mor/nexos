"""Régua de UI — varre 320-1920px de 40 em 40 e aplica R1..R10.

    python3 assets/ui-ruler/regua.py --fixture assets/ui-ruler/ruim.html
    python3 assets/ui-ruler/regua.py --fixture http://127.0.0.1:3000/pagina

Mesmo padrão de console/e2e-regressao.py e console/contraste.py: Chrome do
sistema headless, perfil temporário, roda fora do sandbox do Claude Code
(socket do ProcessSingleton — medido nesta sessão, `channel=chrome` recusa
`launch()` com "Failed to create a ProcessSingleton").

Lê a lógica de R1 R2 R3 R4 R5 R7 R8 R10 de `regua.page.js` — UMA fonte só,
o mesmo arquivo que o QA injeta via Playwright MCP (`browser_evaluate`).
Este script só orquestra: varredura de largura, o modal (R6, procedural —
Tab-trap e Esc exigem tecla de verdade, não dá para medir num retrato
estático) e console/pageerror (R9, que é do ciclo de vida da página, não
de um instante).

GOTCHA medido ao construir isto: redimensionar o viewport DEPOIS de navegar
e perto do instante em que um layout shift acontece faz o Chrome deixar de
contar esse shift (ele assume que é responsividade, não instabilidade) —
R5 nunca disparava assim, mesmo com o defeito real presente. correção:
o viewport nasce com a página (`new_page(viewport=...)`), nunca é
redimensionado numa página já carregada — mesmo padrão que
console/e2e-regressao.py já usa por outro motivo (isolar cada largura).

Resultado agregado por REGRA, não por leitura: uma página larga o bastante
para vazar em 10 das 41 larguras ainda conta como UMA violação de R1 — a
régua aprova com 0 regras em violação, não com 0 leituras ruins.

CORREÇÃO (achados HIGH do nexos-verifier em 64fcc68d): a régua aprovava sem
ter medido — folha de estilo cross-origin ilegível ou navegação com status
de erro simplesmente desapareciam da amostra, e o resultado saía PASSOU. Três
valores agora, nunca só dois:
  PASSOU       — medido, sem violação.
  REPROVOU     — pelo menos uma regra violada (confirmado no que foi lido).
  INCONCLUSIVO — pelo menos uma regra não pôde ser avaliada com confiança
                 (folha ilegível, PerformanceObserver sem suporte, ou uma
                 largura cuja navegação não voltou 2xx) e NENHUMA violação
                 confirmada cobre o caso — "não sei" nunca vira "passou".
Regra "não aplicável" (sem modal/header fixo/hero) é um terceiro balde,
`regras_nao_aplicaveis`, que NÃO participa do RESULTADO — ausência do alvo
não é cegueira.
"""
import json
import sys
import time
from pathlib import Path
from typing import Any

from playwright.sync_api import sync_playwright

AQUI = Path(__file__).resolve().parent
CONFIG = json.loads((AQUI / "regua.config.json").read_text("utf-8"))
REGUA_JS = (AQUI / "regua.page.js").read_text("utf-8")

MODAL_VW = CONFIG["modal_viewport"]["width"]
MODAL_VH = CONFIG["modal_viewport"]["height"]


def larguras_para(passo: int) -> list[int]:
    """320-1920 no passo pedido. Produção usa `CONFIG["step"]` (40px, sem
    `--passo`); teste automatizado passa um passo maior (`--passo 160` ~ 11
    larguras) para caber no timeout do CI sem mexer no que roda em produção
    — REGUA_JS e a lógica de detecção são as mesmas, só muda a amostragem."""
    return list(range(CONFIG["min_width"], CONFIG["max_width"] + 1, passo))


def altura_para(largura: int) -> int:
    """Par largura/altura realista — mesmo critério do e2e-regressao.py:
    celular mais alto que largo, desktop mais largo que alto."""
    return 844 if largura <= 480 else 900


def alvo_para(fixture: str) -> str:
    if fixture.startswith("http://") or fixture.startswith("https://"):
        return fixture
    return Path(fixture).resolve().as_uri()


def medir_largura(browser, url: str, largura: int, erros_console: list[str]) -> dict[str, Any]:
    """Uma página nova, viewport já no tamanho final — nunca redimensiona
    uma página carregada (gotcha do módulo). Devolve sempre a mesma forma;
    `status_problema` preenchido == o resto NÃO é confiável (a página pode
    ser uma tela de erro do servidor, não o conteúdo real)."""
    page = browser.new_page(viewport={"width": largura, "height": altura_para(largura)})
    try:
        page.on("console", lambda m: m.type == "error" and erros_console.append(f"{largura}px: {m.text}"))
        page.on("pageerror", lambda e: erros_console.append(f"{largura}px pageerror: {e}"))
        resp = page.goto(url)
        # `file://` não tem resposta HTTP (resp é None) — isso não é erro.
        # Um resp existente com status fora de 2xx é: página de erro do
        # servidor, conteúdo não é o que a régua pensa medir.
        if resp is not None and not (200 <= resp.status < 300):
            return {
                "violacoes": [],
                "folhas_nao_lidas": [],
                "nao_avaliadas": [],
                "nao_aplicaveis": [],
                "status_problema": {"largura": largura, "status": resp.status},
            }
        page.wait_for_load_state("networkidle")
        # Espera a animação/CLS assentar antes de medir — gotcha desta sessão
        # (print no meio da animação julgou o hero vazio).
        page.wait_for_timeout(300)
        page.evaluate("(c) => { window.__REGUA_CFG = c; }", CONFIG)
        resultado = page.evaluate(REGUA_JS)
        resultado["status_problema"] = None
        return resultado
    finally:
        page.close()


def medir_modal(browser, url: str, erros_console: list[str]) -> dict[str, Any]:
    """R6, procedural: abre, confere foco/trava/tamanho, prende Tab, fecha
    com Esc, confere retorno de foco. Sem `[data-modal-trigger]` na página,
    não há modal para auditar — vai para `nao_aplicaveis` com o motivo, não
    é silêncio nem violação."""
    page = browser.new_page(viewport={"width": MODAL_VW, "height": MODAL_VH})
    try:
        page.on("console", lambda m: m.type == "error" and erros_console.append(f"modal: {m.text}"))
        page.on("pageerror", lambda e: erros_console.append(f"modal pageerror: {e}"))
        resp = page.goto(url)
        if resp is not None and not (200 <= resp.status < 300):
            return {"violacoes": [], "nao_aplicaveis": [], "status_problema": {"largura": MODAL_VW, "status": resp.status}}
        page.wait_for_load_state("networkidle")
        gatilho = page.locator("[data-modal-trigger]")
        if gatilho.count() == 0:
            return {
                "violacoes": [],
                "nao_aplicaveis": [{"rule": "R6", "motivo": "sem modal (nenhum [data-modal-trigger] na página)"}],
                "status_problema": None,
            }

        gatilho.first.click()
        falhas = []
        foco_no_modal = page.evaluate("() => !!document.activeElement.closest('[role=dialog],[aria-modal=true],dialog')")
        if not foco_no_modal:
            falhas.append("foco não entrou no modal ao abrir")

        fundo_travado = page.evaluate(
            "() => ['hidden','clip'].includes(getComputedStyle(document.body).overflow) || "
            "['hidden','clip'].includes(getComputedStyle(document.documentElement).overflow)"
        )
        if not fundo_travado:
            falhas.append("fundo continua rolável com o modal aberto")

        cabe = page.evaluate(
            "() => { const d = document.querySelector('[role=dialog],[aria-modal=true],dialog'); "
            "if (!d) return true; const r = d.getBoundingClientRect(); "
            "return r.left >= 0 && r.top >= 0 && r.right <= window.innerWidth && r.bottom <= window.innerHeight; }"
        )
        if not cabe:
            falhas.append(f"modal não cabe em {MODAL_VW}x{MODAL_VH}")

        saiu = False
        for _ in range(6):
            page.keyboard.press("Tab")
            dentro = page.evaluate("() => !!document.activeElement.closest('[role=dialog],[aria-modal=true],dialog')")
            if not dentro:
                saiu = True
        if saiu:
            falhas.append("Tab escapou do modal (foco não preso)")

        page.keyboard.press("Escape")
        fechou = page.evaluate(
            "() => { const d = document.querySelector('[role=dialog],[aria-modal=true],dialog'); "
            "return !d || d.hidden || getComputedStyle(d).display === 'none'; }"
        )
        if not fechou:
            falhas.append("Esc não fechou o modal")
        foco_voltou = page.evaluate(
            "() => document.activeElement === document.querySelector('[data-modal-trigger]')"
        )
        if not foco_voltou:
            falhas.append("foco não voltou ao gatilho depois de fechar")

        return {
            "violacoes": [{"rule": "R6", "detail": f, "vw": MODAL_VW} for f in falhas],
            "nao_aplicaveis": [],
            "status_problema": None,
        }
    finally:
        page.close()


def main() -> int:
    if "--fixture" not in sys.argv:
        print("uso: regua.py --fixture <arquivo.html ou URL> [--passo <px>] [--json]", file=sys.stderr)
        return 2
    fixture = sys.argv[sys.argv.index("--fixture") + 1]
    url = alvo_para(fixture)
    passo = int(sys.argv[sys.argv.index("--passo") + 1]) if "--passo" in sys.argv else CONFIG["step"]
    larguras = larguras_para(passo)

    t0 = time.time()
    todas_violacoes: list[dict] = []
    todas_nao_avaliadas: set[str] = set()
    folhas_nao_lidas: set[str] = set()
    status_problemas: list[dict] = []
    erros_console: list[str] = []

    with sync_playwright() as p:
        browser = p.chromium.launch(channel="chrome", headless=True)
        try:
            leituras_largura = [medir_largura(browser, url, largura, erros_console) for largura in larguras]
            leitura_modal = medir_modal(browser, url, erros_console)
        finally:
            browser.close()

    # R7/R8 só entram no relatório de cada largura como "não aplicável" quando
    # o alvo de fato não existe NAQUELA largura (regua.page.js decide isso).
    # Globalmente, a regra só é "não aplicável" se NUNCA foi aplicável em
    # nenhuma das leituras de largura — um header fixo que só existe >=768px
    # não pode fazer R7 sumir do relatório como "não aplicável" por causa das
    # leituras <768px.
    #
    # CORREÇÃO (achado HIGH do nexos-verifier): a leitura do MODAL entrava no
    # MESMO laço que agrega R7/R8. `medir_modal()` nunca cita R7/R8 em
    # `nao_aplicaveis` (não é o que ele mede) — então "não citada aqui" fazia
    # a leitura do modal parecer "R7/R8 aplicável", mesmo com NENHUMA largura
    # tendo header fixo ou hero. `regras_nao_aplicaveis` saía vazio por
    # engano. R7/R8 só podem vir da varredura de largura; R6 só pode vir do
    # modal — os dois laços abaixo são SEPARADOS de propósito, cada um só
    # enxerga a leitura que de fato fala da regra dele.
    aplicavel_em_alguma_leitura: set[str] = set()
    motivo_nao_aplicavel: dict[str, str] = {}

    for leitura in leituras_largura:
        if leitura.get("status_problema"):
            status_problemas.append(leitura["status_problema"])
            continue  # página não confiável nesta leitura: nada mais dela entra na amostra
        todas_violacoes += leitura.get("violacoes", [])
        todas_nao_avaliadas |= set(leitura.get("nao_avaliadas", []))
        folhas_nao_lidas |= set(leitura.get("folhas_nao_lidas", []))

        # `citadas_aqui` só tem entradas para R7/R8 (regua.page.js nunca marca
        # R6) — motivo mais recente basta, o interessante é o conjunto final.
        citadas_aqui = {na["rule"]: na["motivo"] for na in leitura.get("nao_aplicaveis", [])}
        for r, motivo in citadas_aqui.items():
            motivo_nao_aplicavel[r] = motivo
        for r in ("R7", "R8"):
            # não citada como "não aplicável" nesta leitura == o alvo existia
            # aqui, mesmo que nenhuma violação tenha saído dele.
            if r not in citadas_aqui:
                aplicavel_em_alguma_leitura.add(r)

    # R6 vem SÓ do modal — nunca da varredura de largura, e vice-versa.
    if leitura_modal.get("status_problema"):
        status_problemas.append(leitura_modal["status_problema"])
    else:
        todas_violacoes += leitura_modal.get("violacoes", [])
        modal_nao_aplicavel = {na["motivo"] for na in leitura_modal.get("nao_aplicaveis", []) if na["rule"] == "R6"}
        if modal_nao_aplicavel:
            motivo_nao_aplicavel["R6"] = next(iter(modal_nao_aplicavel))
        else:
            aplicavel_em_alguma_leitura.add("R6")

    regras_nao_aplicaveis = {
        r: motivo for r, motivo in motivo_nao_aplicavel.items() if r not in aplicavel_em_alguma_leitura
    }

    if erros_console:
        todas_violacoes.append(
            {"rule": "R9", "detail": f"{len(erros_console)} erro(s) de console/hidratação: {erros_console[0]}", "vw": None}
        )

    por_regra: dict[str, dict] = {}
    for v in todas_violacoes:
        por_regra.setdefault(v["rule"], v)  # primeira ocorrência basta como amostra
    regras_violadas = sorted(por_regra.keys())

    # nao_avaliadas nunca conflita com uma violação confirmada da MESMA
    # regra: se já sabemos que ela falhou, "não avaliada em alguma leitura"
    # não muda o veredicto — REPROVOU é mais forte que INCONCLUSIVO.
    regras_nao_avaliadas = sorted(todas_nao_avaliadas - set(regras_violadas))

    if regras_violadas:
        veredicto = "REPROVOU"
    elif regras_nao_avaliadas or status_problemas:
        veredicto = "INCONCLUSIVO"
    else:
        veredicto = "PASSOU"

    resultado = {
        "fixture": fixture,
        "larguras_varridas": larguras,
        "regras_violadas": regras_violadas,
        "total_regras_violadas": len(regras_violadas),
        "regras_nao_avaliadas": regras_nao_avaliadas,
        "regras_nao_aplicaveis": regras_nao_aplicaveis,
        "folhas_nao_lidas": sorted(folhas_nao_lidas),
        "status_problemas": status_problemas,
        "amostra_por_regra": por_regra,
        "segundos": round(time.time() - t0, 1),
        "RESULTADO": veredicto,
    }
    print(json.dumps(resultado, ensure_ascii=False, indent=1))
    return {"PASSOU": 0, "REPROVOU": 1, "INCONCLUSIVO": 2}[veredicto]


if __name__ == "__main__":
    sys.exit(main())
