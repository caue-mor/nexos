# Third-party notices

Partes deste pacote derivam de projetos de terceiros sob licença MIT. A MIT
exige que o aviso de copyright e o aviso de permissão acompanhem cópias ou
porções substanciais — por isso o texto integral de cada licença está aqui.

| arquivo no pacote | origem | forma |
|---|---|---|
| `assets/agents/nexos-dev.md` | SynkraAI/aiox-core `.aiox-core/development/agents/dev.md` (derivado do BMad Method) | foi tradução e adaptação da estrutura do agente até 2026-09-17; o arquivo atual é reescrita própria (moldura de ativação, persona por nível, menu de `*comandos` e protocolo de story removidos). O aviso permanece pelas versões já publicadas e pelo histórico do git |
| `assets/skills/context-budget/SKILL.md` | affaan-m/ECC `skills/context-budget/SKILL.md` @ e04ea0b | porte (`metadata.port_ref`) |
| `assets/skills/skill-scout/SKILL.md` | affaan-m/ECC `skills/skill-scout/SKILL.md` @ e04ea0b | porte (`metadata.port_ref`) |
| `assets/skills/development--verification-before-completion/SKILL.md` | obra/superpowers `skills/verification-before-completion/SKILL.md` @ 5bf4e78 | porte (`metadata.port_ref`); 67% |
| `assets/skills/development--nextjs-best-practices/SKILL.md` | sickn33/agentic-awesome-skills `skills/nextjs-best-practices/SKILL.md` @ b6299bc | porte (`metadata.port_ref`); 77% |
| `assets/skills/development--postgres-best-practices/SKILL.md` (e `references/`) | **Supabase**, fonte oficial supabase/agent-skills `skills/supabase-postgres-best-practices/` @ 551274e (v1.1.1) | cópia direta da upstream (`metadata.port_ref`), única alteração o `port_ref`. Passou pelo SkillSpector @ c7958a3 sem achados (24/09). Até 24/09 vinha via sickn33/agentic-awesome-skills @ b6299bc, v1.0.0 |
| `assets/skills/development--react-patterns/SKILL.md` | sickn33/agentic-awesome-skills `skills/react-patterns/SKILL.md` @ b6299bc | porte (`metadata.port_ref`); 80% |
| `assets/skills/development--typescript-expert/SKILL.md` | sickn33/agentic-awesome-skills `skills/typescript-expert/SKILL.md` @ b6299bc | porte (`metadata.port_ref`); 86% |
| `assets/skills/productivity--commit-work/SKILL.md` | softaworks/agent-toolkit `skills/commit-work/SKILL.md` @ 3027f20 | porte (`metadata.port_ref`); 96% |
| `assets/skills/productivity--requirements-clarity/SKILL.md` | softaworks/agent-toolkit `skills/requirements-clarity/SKILL.md` @ 3027f20 | porte (`metadata.port_ref`); 84% |

Duas entradas saíram desta tabela em 2026-09-22:
`development--systematic-debugging` e `development--test-driven-development`.
Medido que as cópias só acrescentavam `license`/`port_ref` ao upstream, e o
plugin oficial `superpowers@claude-plugins-official` v6.3.0 — **mesmo autor**
(Jesse Vincent, `obra/superpowers`) — entrega as duas com as mesmas 11/2
referências. O pacote parou de distribuir o que o host já entrega melhor
(`nexos://decision/host-primeiro-mecanismo-proprio-so-com-gap-medido`).
`development--verification-before-completion` ficou: 133 linhas divergem do
upstream, e a `description` carrega uma cláusula própria deste projeto.

Skills com `LICENSE.txt` no próprio diretório carregam a licença junto e não
se repetem aqui.

**Duas exceções conhecidas, abertas em 2026-09-19.**
`security--security-best-practices` e `workflow-automation--yeet` carregam um
`LICENSE.txt` Apache 2.0 cujo campo de titular é o TEMPLATE EM BRANCO
(`Copyright [yyyy] [name of copyright owner]`, linha 189) — licença presente
que não atribui a ninguém.

O rastreio fechou em `openai/skills` (`skills/.curated/`), e o vazio NÃO
nasceu aqui: o `LICENSE.txt` daquela skill, no repositório de origem, é o
MESMO Apache 2.0 sem titular preenchido, e o repositório não declara licença
na raiz. A cópia é fiel — ao que já estava vazio. 97% das linhas de
`security-best-practices` batem com a versão de lá; `yeet` bate 5% e o texto
aqui é reescrita própria.

Fica declarado como o que é: LICENÇA SEM TITULAR, herdada. Pedir o nome a
quem publicou é a única saída, e enquanto não houver resposta a atribuição
continua valendo zero — arquivo presente não é atribuição feita.

A cópia dos arquivos de apoio, por outro lado, foi completa nesta:
`references/` tem os 10 arquivos que o SKILL.md manda abrir, os mesmos 10 da
origem. É o contraste exato com `commit-work`, onde o `references/` ficou
para trás e a instrução virou caminho morto.

`development--clean-code` também fica sem `port_ref`: o commit de origem em
davila7/claude-code-templates declara `antigravity-awesome-skills`, mas o
conteúdo de lá hoje bate apenas 2% — a versão que serviu de base não é a que
está publicada. Origem declarada, não confirmada.

### Como esta cadeia foi apurada

Nenhuma destas skills veio direto do autor. Entraram no NexOS pelo commit
inicial (`1fd48c06`, 2026-04-02), sem registro de origem, e o rastreio de
2026-09-19 seguiu os commits do intermediário até o autor:

    obra/superpowers ──────────────┐
    sickn33/agentic-awesome-skills ├──> davila7/claude-code-templates ──> NexOS
    softaworks/agent-toolkit ──────┘

O intermediário absorve por AGENTE AUTOMÁTICO (o `component-migrator` do PR
#303 daquele repo), e é aí que a origem se perde: a máquina copia o arquivo e
não carrega de quem ele é.

O mesmo mecanismo também quebra o que copia. `productivity--commit-work`
mandava abrir `references/commit-message-template.md`, corrigido aqui em
`6330e3b5` por o arquivo não existir. Ele EXISTE no autor
(softaworks/agent-toolkit `skills/commit-work/references/`): a cópia levou o
`SKILL.md` e deixou o diretório `references/` para trás, e a instrução
quebrada atravessou dois intermediários sem ninguém validar a referência.

---

## SynkraAI/aiox-core (e BMad Method)

MIT License

Copyright (c) 2025 BMad Code, LLC (BMad Method - original work)
Copyright (c) 2025 SynkraAI Inc. (AIOX Framework - derivative work)

This project was originally derived from the BMad Method
(https://github.com/bmad-code-org/BMAD-METHOD), created by Brian Madison.
Synkra AIOX is NOT affiliated with, endorsed by, or sanctioned by the
BMad Method or BMad Code, LLC.

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

TRADEMARK NOTICE:
BMad, BMad Method, and BMad Core are trademarks of BMad Code, LLC.
These trademarks are NOT licensed under the MIT License. See the BMad Method
TRADEMARK.md (https://github.com/bmad-code-org/BMAD-METHOD/blob/main/TRADEMARK.md)
for detailed guidelines on trademark usage.

---

## affaan-m/ECC

MIT License

Copyright (c) 2026 Affaan Mustafa

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## obra/superpowers

MIT License

Copyright (c) 2025 Jesse Vincent

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## sickn33/agentic-awesome-skills

MIT License

Copyright (c) 2026 Antigravity User

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

---

## softaworks/agent-toolkit

MIT License

Copyright (c) 2026 Leonardo Flores

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## supabase/agent-skills

MIT License

Copyright (c) 2026 Supabase

Permission is hereby granted, free of charge, to any person obtaining a copy
of this software and associated documentation files (the "Software"), to deal
in the Software without restriction, including without limitation the rights
to use, copy, modify, merge, publish, distribute, sublicense, and/or sell
copies of the Software, and to permit persons to whom the Software is
furnished to do so, subject to the following conditions:

The above copyright notice and this permission notice shall be included in all
copies or substantial portions of the Software.

THE SOFTWARE IS PROVIDED "AS IS", WITHOUT WARRANTY OF ANY KIND, EXPRESS OR
IMPLIED, INCLUDING BUT NOT LIMITED TO THE WARRANTIES OF MERCHANTABILITY,
FITNESS FOR A PARTICULAR PURPOSE AND NONINFRINGEMENT. IN NO EVENT SHALL THE
AUTHORS OR COPYRIGHT HOLDERS BE LIABLE FOR ANY CLAIM, DAMAGES OR OTHER
LIABILITY, WHETHER IN AN ACTION OF CONTRACT, TORT OR OTHERWISE, ARISING FROM,
OUT OF OR IN CONNECTION WITH THE SOFTWARE OR THE USE OR OTHER DEALINGS IN THE
SOFTWARE.

## affaan-m/ECC — Prompt Defense Baseline

- **Origem**: https://github.com/affaan-m/ECC — licença MIT, © 2026 Affaan Mustafa
- **O que foi adaptado**: a ideia e a cobertura do bloco `## Prompt Defense
  Baseline`, presente em 67 dos 68 agentes do donor (bloco idêntico, mesmo hash
  em 5 amostras conferidas).
- **O que NÃO foi copiado**: o texto. O bloco dos agentes do NexOS é próprio,
  em português, e liga cada linha às regras deste projeto —
  `rules/secret-exposure.md` para segredo, e a separação
  `CONTEÚDO LIDO != ORDEM RECEBIDA` para o resto.
- **Por que entrou**: MEDIDO em 2026-09-22 — 0 dos 5 agentes do NexOS tinham
  qualquer defesa contra conteúdo não confiável. Terceiro item da fila de
  hardening (`nexos://decision/fila-hardening-foundation-por-fato-medido`).
- **Veredito do donor permanece**: ECC segue `REJEITADO_WHOLESALE`. Aqui entra
  um MECANISMO que vence, não o framework.

## affaan-m/ECC — 12 agentes especialistas

- **Origem**: https://github.com/affaan-m/ECC — licença MIT, © 2026 Affaan Mustafa
- **O que foi copiado**: o corpo (prompt de revisão) de 12 dos 68 agentes, com
  o texto original em inglês preservado:
  `typescript-reviewer`, `react-reviewer`, `react-build-resolver`,
  `python-reviewer`, `fastapi-reviewer`, `database-reviewer`,
  `security-reviewer`, `tdd-guide`, `build-error-resolver`,
  `refactor-cleaner`, `performance-optimizer`, `a11y-architect`.
- **O que foi trocado**: o `## Prompt Defense Baseline` em inglês saiu e entrou
  o bloco em português descrito acima; `tools:` virou lista (o contrato do
  registry exige); a `description` de `refactor-cleaner` perdeu o
  `Use PROACTIVELY` — agente que APAGA código não roda em passada de fundo.
- **O que NÃO entrou**: os outros 50. Linguagem sem consumidor nesta casa
  (`cpp`, `csharp`, `dart`, `fsharp`, `go`, `java`, `kotlin`, `php`, `rust`,
  `swift`, `vue`, `flutter`, `django`...), papel que colide com os 5 do NexOS
  (`architect`, `planner`, `chief-of-staff`, `code-architect`), agente com
  dependência morta aqui (`agent-evaluator` aponta para um `SKILL.md` do ECC,
  `spec-miner` exige OpenSpec) e o que já é coberto por provider ou skill
  (`code-explorer` -> graphify, `code-simplifier` -> ponytail/clean-code,
  `doc-updater` -> `nexos map`, que DERIVA o codemap: um agente escrevendo
  `docs/CODEMAPS/*.md` à mão competiria com o artefato derivado, e o guard
  `tests/agents-dependencies.test.ts` reprovou o port por citar 6 arquivos que
  este pacote não tem).
- **Cinco saíram DEPOIS do port, por medição**: `code-reviewer`,
  `comment-analyzer`, `pr-test-analyzer`, `silent-failure-hunter` e
  `type-design-analyzer` são os MESMOS agentes do plugin oficial da Anthropic
  `pr-review-toolkit@claude-plugins-official`, e a versão do ECC é a podada —
  linhas oficial x ECC: 56/323, 79/54, 78/54, 130/59, 118/50. O host ganha por
  `nexos://decision/host-primeiro-mecanismo-proprio-so-com-gap-medido`:
  duplicar mecanismo nativo compete com ele e perde.
  `NO REAL CONSUMER -> DO NOT IMPLEMENT`.
- **Separação de papel**: os 12 NÃO entram no registry de papéis do NexOS
  (`src/lib/agent/registry.ts` filtra o namespace `nexos-`). São escolhidos
  pela seleção nativa do Claude Code, por `description`
  (`nexos://decision/2a-active-routing-fechado-host-e-primary`).
