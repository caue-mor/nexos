# Terceiros embutidos em jarvis/

## vis-network 9.1.6

- Origem: https://unpkg.com/vis-network@9.1.6/standalone/umd/vis-network.min.js
- Licença: Apache-2.0 / MIT (dual, declarada no cabeçalho do próprio arquivo)
- sha384: `Ux6phic9PEHJ38YtrijhkzyJ8yQlH8i/+buBR8s3mAZOJrP1gwyvAcIYl3GWtpX1`
- Tamanho: 702.611 bytes

O sha384 do arquivo local foi conferido contra o `integrity` que
`graphify-out/graph.html` já usava para a mesma versão: **idênticos**. Mesmo
binário, verificado, não "provavelmente o mesmo".

Vendorizado em vez de CDN porque o shell desktop do Visual SDK é offline. A
tela gerada embute este arquivo inline: `graph-view.html` faz zero requisição
de rede — as URLs que sobram no bundle são texto de licença, nenhuma é
carregada (conferido com grep por `src=`/`href=` apontando para http).
