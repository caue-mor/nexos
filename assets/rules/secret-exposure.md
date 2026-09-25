# Exposição de segredo — regra de saída

Vale para TODA saída que o agente produz: texto ao usuário, comando de shell,
comentário, commit, record do Store e transcript.

```
VALOR DE SEGREDO NUNCA SAI — NEM MASCARADO, NEM PREFIXO, NEM TAMANHO ÚTIL
```

## O que fazer em vez de imprimir

| quero saber | reporto |
|---|---|
| a variável existe? | `PRESENTE` / `AUSENTE` |
| qual credencial é? | o NOME da variável, nunca o valor |
| que tipo é? | o nome do padrão que casou (`supabase_key`), nunca o texto que casou |
| onde está? | arquivo e linha |
| mudou? | compare hashes, reporte igual/diferente |

Prefixo NÃO é máscara. `sbp_2f…` entrega o prefixo estrutural mais entropia
real, e vai para o transcript, que é persistido e pode ser compartilhado.
Tamanho em caracteres também é sinal — só reporte quando for a pergunta.

## Comandos proibidos em diagnóstico

`env`, `printenv`, `set`, `export -p`, `NODE_DEBUG=child_process` e qualquer
`echo`/`console.log` de variável com nome de credencial. Para inspecionar o
ambiente, itere sobre os NOMES e imprima só o veredito de presença.

  MEDIDO neste projeto: `NODE_DEBUG=child_process` despeja `envPairs` inteiro
  e derrama as chaves de API no log — diagnóstico que imprime o ambiente É
  vazamento. Medir um spawn nunca pode custar uma credencial.

## Ao ler arquivo que pode conter segredo

Passe pelo `redact()` de `assets/hooks/nexos-secret-patterns.cjs` ANTES de
imprimir qualquer linha. Não reimplemente máscara: a que existe é a canônica e
é testada.

## Quando encontrar um segredo exposto

Reporte local, nome do padrão e o raio (quantas cópias, quem herda). Diga o que
é MEDIDO e o que é premissa de terceiro — recomendar rotação sem evidência
própria queima a confiança no aviso e no avisador.

```
PREMISSA DO USUÁRIO != FATO MEDIDO
```
