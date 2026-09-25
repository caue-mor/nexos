# Pesquisa e persistência — regra de roteamento e destino

```
PESQUISA NÃO PERSISTIDA NÃO ACONTECEU
CAPABILITY INSTALADA SEM CONSUMO NÃO É CAPABILITY
```

MEDIDO em 2026-09-22 neste ambiente, e é por isso que esta regra existe:
4 research records no Store inteiro, o último de 18/09; vault do Obsidian com
203 notas e **zero** modificadas em 7 dias; `notebooklm` com o MCP morto
(`CONNECTION_CLOSED`) desde o boot. Tudo instalado, nada consumido.

## Roteamento — a pergunta escolhe o provider, nunca a disponibilidade

| A pergunta é sobre | Provider | Antes de usar |
|---|---|---|
| API, config, sintaxe de biblioteca/framework/CLI | `ctx7` | sempre, mesmo "sabendo" a resposta |
| arquitetura e call path DESTE repo, em repo grande ou alheio | `graphify` | grafo existir não obriga consulta; a pergunta decide |
| o que mudou / o que se discute nos últimos ~30 dias | `last30days` | é sinal de discussão, nunca autoridade sobre verdade |
| síntese citada entre muitos documentos | `notebooklm` | **checar saúde do MCP primeiro** — falha em silêncio |
| comportamento do Claude Code | `code.claude.com/docs` | ler o gêmeo `.md`; blog nunca é fonte |

Fato verificável em doc oficial vai à doc oficial, não ao provider social.

## Persistência — obrigatória, não opcional

Pesquisa que rendeu conhecimento durável termina em DOIS lugares:

1. **Obsidian**, `03-Resources/<assunto>/`, com nome datado:
   `<assunto>-AAAA-MM-DD_HHMM.md`
   Frontmatter: `tipo`, `fonte`, `capturado_em`, `versao_host`, `autor`,
   `status`. Fonte bruta arquivada ao lado quando existir (`llms.txt`, dump de
   API, export) — o bruto é o que permite diff entre capturas.
2. **Store**, como pesquisa publicada: `nexos research --question "<pergunta>"
   --findings "<achado>" --source <url> --claim "<o que a fonte sustenta>"`, uma
   `--claim` por `--source`. Pesquisa entra no recall e em `nexos memory --search`
   sem esperar promoção. `nexos memory --fact` fica para afirmação sobre ESTE
   projeto, que precisa do humano para virar memória: candidato não aparece na
   busca até ser promovido.

Captura sem data é captura sem validade: o Claude Code muda toda semana, e
comparar duas capturas é o que mostra o que a doc ganhou ou perdeu.

## Marcar o que NÃO foi verificado

Toda nota separa o que foi **lido na fonte** do que veio de terceiro ou de
memória. Sem essa separação, a nota vira autoridade falsa na próxima sessão e o
erro se propaga com a assinatura de "documentado".

```
PREMISSA DO TERCEIRO != FATO MEDIDO
CAPACIDADE DOCUMENTADA != CAPACIDADE INSTALADA
```

Antes de ordenar trabalho a partir de uma recomendação externa, medir o estado
no host: connector autenticado? app instalado? chave com consumidor? A ordem do
plano muda quando se mede.

## Provider quebrado é achado, não silêncio

MCP que não conecta, CLI ausente, conta não autenticada: registrar como gotcha
com o erro exato. Fallback silencioso para "respondi de memória" é a falha que
faz meses passarem sem uma pesquisa.
