# Changelog

## 7.0.5 (2026-09-25) — install no Windows e upgrade limpo a partir da 6.x

Reproduzido a partir de um relato da comunidade (Windows, 6.3.1 → 7.0.3), instalando a
6.3.1 publicada num HOME isolado e rodando o install novo por cima.

### Fixed
- **`nexos install` no Windows** — o `$HOME` do `settings.json` do pacote entrava cru no
  texto JSON: `C:\Users\...` virava o escape inválido `\U` e o install abortava antes de
  escrever qualquer coisa. Agora o caminho entra escapado e com barra normal
  (`C:/Users/...`), que funciona no Git Bash e no PowerShell, onde os hooks rodam.
- **`CLAUDE.md` duplicado no upgrade da 6.x** — o `CLAUDE.md` global das versões 1.0.0 a
  6.3.2 não era reconhecido como seção NexOS antiga, e o bloco novo era anexado embaixo das
  ~670 linhas antigas, com instruções que se contradiziam. Agora ele fica intacto e o
  install avisa para remover a seção antiga, o que libera a inserção do bloco novo.
- **statusLine da 6.x** — `hooks/nexos-status-line.sh`, gravada por 21 versões, era tratada
  como de outro dono e continuava rodando depois do upgrade. Agora é trocada pela atual.
- **`nexos memory` fora de projeto** — `--review` dizia "Nenhum candidato esperando
  decisão" numa pasta sem Store. Agora diz que a pasta não tem Store e sai com erro; em
  `--json`, o mesmo `STORE_ILEGIVEL` de `state` e `gotcha`.
- **pesquisa publicada volta ao recall** — `nexos research` publicava e nem
  `memory --search` nem a memória por prompt a devolviam. Agora a pergunta conta como
  título e o achado como corpo, também no desempate.

### Changed
- **`nexos install` remove o que sobrou de versão anterior** — arquivo que uma versão
  anterior instalou, que saiu do pacote e continua idêntico ao que o NexOS gravou (hash do
  manifesto) é removido, com backup em `~/.claude/backups/pre-nexos-install-<data>/`. Fica
  e é listado o que você editou e o que o seu `settings.json` ainda chama. No upgrade da
  6.3.1: `~/.claude` de 2.444 para 192 arquivos (1.886 → 106 em skills). `--dry-run` mostra
  a lista antes.
- **regra de pesquisa** — pesquisa com fonte vai ao Store por `nexos research`, que publica
  direto e entra no recall; `nexos memory --fact` fica para afirmação sobre o projeto.

## 7.0.3 (2026-09-25) — mapa do projeto sem fatos repetidos

### Fixed
- **`nexos map` não repete mais fatos** — o refresh incremental (roda em `nexos map` e em
  toda abertura de sessão em que o HEAD andou) reaproveitava o `project.json` anterior
  inteiro e somava de novo os fatos de auth, integração e dependência que a varredura
  recalcula: cada execução acrescentava uma cópia de cada um. Medido neste repo: 253 → 445
  fatos em 8 execuções, sempre 41 distintos. Agora só os fatos de stack são reaproveitados;
  um mapa já inflado volta ao tamanho certo na próxima atualização (445 → 41 aqui).

## 7.0.2 (2026-09-24) — pacote sem comentários internos, doctor mais rápido

### Security
- **pacote sem comentários do código** — o `dist/` levava os comentários do `src/`, e a 7.0.1
  publicada citava o nome de um projeto do autor num deles. O build agora usa
  `removeComments`: 1,7 → 1,1 MB comprimido. Varredura de segredos e de termos privados
  seguem limpas.
- **links corrigidos** — `assets/skills.json` apontava para `github.com/nexos-team`, organização
  que não existe (qualquer um poderia registrá-la).
- **repositório público** — código em github.com/caue-mor/nexos, com
  `repository`, `homepage` e `bugs` no `package.json`; publicação pelo repositório público
  traz proveniência (prova de onde o pacote foi compilado).

### Changed
- **`nexos doctor --project` 35% mais rápido** — as checagens independentes (cadeia de
  versões, fatos do git, map, CLAUDE.md, avisos de memória) rodam juntas em vez de uma
  depois da outra; a evidência sai na mesma ordem. Medido neste repo, 9 execuções: p50
  1190 → 777 ms. Roda em todo `/nexos`.
- **README** — seção "What you'll see" com a saída real do resumo de sessão e da memória
  por prompt num projeto de exemplo, e o caminho até o primeiro resultado.

## 7.0.1 (2026-09-24) — primeira versão 7 no npm

Primeira publicação da linha 7 no npm (a 7.0.0 foi release local). Quem vem da 6.3.2 recebe
também tudo da entrada 7.0.0 abaixo, inclusive as correções de segurança.

### Changed
- **skill postgres-best-practices** — sincronizada com a fonte oficial do Supabase
  (supabase/agent-skills, v1.1.1): SECURITY DEFINER, `auth.role()` deprecado, BOLA,
  restrições de schema em migração. (6280402d)

### New
- **hook de afirmação de ausência** — `nexos-absence-claim.mjs` (Stop e SubagentStop):
  quando a resposta afirma que algo não existe ("não encontrei", "sem definição", "does
  not exist"), pede as 3 rotas independentes antes de encerrar. Uma cobrança por turno,
  ignora texto citado. Medido no histórico: dispara em 3,0% dos fins de turno.

### Fixed
- **README** — descrevia o bundle 6.x (16 agentes, 315 skills, Squads, `/NexOS:help`) e
  mandava rodar `npx nexos install`, que resolve para o pacote npm `nexos` de outro autor.
  Agora descreve o pacote real e instala com `npm install -g nexos-cli`. (0d708a5b)
- **memória por prompt** — decisão que a poda deixou fora do índice deixava de ser tratada
  como "mudada": ia ao corpo inteira nos prompts seguintes e ligava
  `CONTINUITY_CONTEXT_INCOMPLETE` em quase todo prompt. Agora a primeira chamada grava a
  linha de base da janela; a não nomeada volta só pelo nome no índice, e decisão nova,
  revisada ou revogada continua indo como corpo. Medido numa cópia do Store deste repo
  (10 prompts reais): 31 KB → 12,9 KB nas chamadas 2-10, 58 → 1 corpo de decisão,
  INCOMPLETE 9/10 → 0/10.
- **CI** — o gate de bijeção ADR saiu do CI: sem `.nexos/` no git ele só respondia
  `NOT_APPLICABLE` (bbb13594). Teste H3 com orçamento de 6s, que falhava intermitente no
  runner (9bb9b4e1). A ligação de prazo e descarte do gate de promoção ganhou teste que a
  mutação pega (f044df27). Teste de performance do hook SQL desconta a partida do processo,
  que sozinha passava do orçamento no Node 24 do CI.

## 7.0.0 (2026-09-24) — memória que não sai da máquina, painel do projeto, hooks que não seguram o prompt

**BREAKING:** exige Node >= 22.12 (Node 20 deixa de ser suportado). Major porque, desde a
última versão no npm (6.3.2), entraram comandos novos e essa quebra de compatibilidade; de
6.4.0 a 6.5.2 foram releases locais. Esta entrada cobre o que mudou desde a 6.5.2.

### Security
- **repositório** — actions dos workflows fixadas por SHA, npm fixado (11.20.0) e sem o
  fallback `npm ci || npm install`, job de publicação duplicado removido do CI, Dependabot
  (npm + actions), CodeQL e `SECURITY.md` com relato privado de vulnerabilidade.
  (0bf511cf, e2c58795)

### New
- **régua de UI** (`assets/ui-ruler/`) — varre 320→1920 px e reprova por critério medido
  (R1–R10: estouro, texto cortado, tokens, animação, CLS, modal, âncora, hero, console, alvo
  de toque). Resultado PASSOU | REPROVOU | INCONCLUSIVO: nunca aprova o que não conseguiu
  medir. O qa roda, o verifier cobra em diff de UI, o ux entrega SPEC medível.
  (64fcc68d, db70d596, 7a35f4f8, 7fa85389, de3c01b3)
- **aviso de escrita SQL via MCP** — hook PostToolUse avisa para chamar o database-reviewer
  quando `execute_sql`/`apply_migration` escrevem no banco; nunca bloqueia, nunca repete o SQL.
  Medido antes: 450 escritas em 30 dias, 13 revisadas. (e89e3f09, 51bdc904, ac16e469)
- **build vermelho com dono** — reprovação de build/typecheck vai para os
  `*-build-resolver` em vez de voltar ao construtor genérico. (64fcc68d)


### Fixed
- **`nexos doctor`** — a sonda do aviso de contexto não derruba mais o comando. Um
  `nexos-context` inválido no diretório temporário (ENOTDIR/EACCES) saía em stack trace
  com zero checks. Agora vira `warn CONTEXT_TAP_PROBE_FAILED` com a causa, e o relatório
  sai inteiro. (a7544114)
- **`--json` de leitura (`state`, `gotcha`, `research`)** — Store divergente ou malformado
  não sai mais como lista vazia com exit 0: vira `STORE_DIVERGENTE`, exit 1. Anomalia em
  outra family não derruba o comando, e `gotcha --json` decide pelo kind real do head.
  `research --json` passa a trazer as `sources`. (be0458d7, 3d6f7378, 182011b6)
- **`nexos research`** — pesquisa gravada ficava invisível: todas caíam na mesma linhagem,
  que saía como DIVERGED, e repetir a pergunta apagava as duas. Agora cada pergunta tem
  linhagem própria e a resposta nova substitui a anterior. (30f7c192, cfb59458)
- **hooks de `UserPromptSubmit`** — os hooks que sobem o CLI ganharam um teto de 5 s. Sob
  carga eles passavam de 30 s, e o host mostrava `hook timed out` a cada prompt. No
  estouro sai uma linha de diagnóstico em stderr, e a saída que já estava completa não é
  mais descartada. Falha ao gravar depois da resposta também deixa rastro em stderr, em
  vez de sumir. (a2f56341, 6efe0682, 58858121, 0735f8d3)
- **recall de memória** — decisão alterada não expulsa mais do prompt a memória que casa
  com ele: um terço do orçamento fica reservado ao que é relevante. Recall, roteamento e
  lembrete de docs não disparam em notificação de tarefa nem em mensagem de subagente,
  teammate ou outra sessão. (25ea1015, 3b26df5a, eadb1a43, 52eed9f1)
- **`nexos install`** — recusa escrever ou apagar através de symlink em qualquer segmento
  do destino. Com `~/.claude/skills` apontando para fora, o arquivo ia parar no alvo
  externo. EPERM do sandbox do host vira mensagem que diz de quem é o bloqueio e qual a
  saída. Grupos de hook em outra ordem no `settings.json` deixaram de contar como drift.
  (2d2082cb, fcd23306, 49d95d9b)
- **`nexos verify`** — registrar no Store (`map`, `memory`, `decision`, `checkpoint`)
  sujava a árvore, e a evidência era recusada como "árvore suja". Mudanças em `.nexos/`
  não entram mais no `tree_state`. O gate continua exigindo árvore limpa no resto. (1d8aa43e)
- **hooks de fim de sessão** — `nexos-memory-capture` lia um log que não tinha mais
  produtor e estava 100% inerte. Agora lê o transcript nativo do evento Stop. O fechamento
  de sessão que pula por ambiente quebrado (`CLAUDE_PROJECT_DIR` ou `session_id` ausente)
  diz o motivo em stderr, em vez de sair idêntico ao sucesso. (c97de7e3, 1ec50f29)

### New Commands
- **`nexos console`** — gera o painel do projeto e abre no navegador: saúde, trabalho
  feito, aprendizados pendentes, ferramentas, provas, pesquisas e o mapa do código. É um
  arquivo HTML auto-contido, sem servidor, e cada aba tem endereço próprio
  (`console.html#provas`). Flags: `--no-open`, `--no-graph`, `--root`, `--out`.
  (3d94d2b2, 1f8ce87c, 42106c4d)
- **`nexos usage`** — uso real de tools, skills, agentes, hooks e providers, medido nos
  transcritos do host. Escopo do projeto por padrão, `--all` para o host inteiro, e
  `--json`. É caro (varre transcritos) e mostra o que não conseguiu ler, em vez de contar
  como zero. `capabilities --usage` usa o mesmo scan.
  (1ff9bb02, 6a742b17, 218917f7, 81eebc57, 94a6a39c)
- **`nexos sessions`** — registro por sessão do Claude Code (host, cwd, agente,
  checkpoint), gravado pelo SessionStart/SessionEnd. `--forget <id> --why "<motivo>"` tira
  uma sessão de circulação sem apagar nada do disco. (05d44179, 118ae354)
- **`nexos memory --review` / `--retrieval`** — `--review` é a fila de decisão dos
  candidatos a memória: agrupa por tema, marca o que um gotcha promovido já cobre, sugere
  supersede, mostra os mais velhos primeiro e aceita `--json`. Nunca promove.
  `--retrieval` mostra o que o recall injetou, quantas vezes e com quantos bytes, sem
  gravar o prompt. (12ecf841, 4815c618, 3e2856fe, 3f282c8c, a8bbe491)
- **`nexos checkpoint --state SUPERSEDED --superseded-by nexos://decision/<chave>`** —
  estado terminal para trabalho retirado por decisão, que não falhou nem terminou. É
  recusado sem uma decisão viva no Store, e o checkpoint sai da linha "próximo:". (a7ff5848)
- **`--json` de leitura em `state`, `research`, `gotcha`, `checkpoint` e `boot`** —
  contrato de máquina, com só o JSON no stdout e nada gravado. Em `state`/`research`/`gotcha`,
  combinar com escrita é recusado (`JSON_SO_LEITURA`). `boot --json` nunca escreve no
  Store. (0f230114, 84091e65, dc30823b)

### Changed
- **Node >= 22.12** — BREAKING: Node 20 (em EOL) deixa de ser suportado. (0e79d296)
- **memória fora do git** — `.nexos/records/`, `memory/` e `evidence/` deixam de ser
  versionados. `nexos init` grava essas linhas no `.gitignore` do projeto (cria o arquivo
  se faltar e nunca apaga linha sua) e põe `.nexos` no `.dockerignore` quando há
  Dockerfile. `doctor --project` avisa quando há memória rastreada, com o
  `git rm -r --cached` que resolve, e aponta o `origem:linha` da negação que a reinclui.
  (b2edaf11, 689434e1, 0c731b88)
- **aviso de contexto** — o modelo não vê a porcentagem de contexto. Agora um tap na
  statusLine grava essa porcentagem, e o hook avisa uma vez a 70% e outra a 85%.
  `nexos install` põe o tap na frente do renderer que já existe (inclusive de outro dono),
  com `|| cat` caso o tap falte. `doctor` confere que o aviso funciona e que a statusLine
  instalada passa pelo tap, não só que o arquivo existe.
  (ab2183bb, 7bde73fa, db00f47d, c5ce6387, 865cca6e)
- **escudo de segredo** — novo primeiro hook do `UserPromptSubmit`. Prompt com chave de
  API de formato conhecido é bloqueado (o host apaga o texto), e a mensagem nomeia o
  padrão, nunca o valor. Formas genéricas ficam de fora de propósito, e falha do escudo
  deixa o prompt passar. O guard de escrita do Store foi de 8 para 15 formas. (b2ccec9f, 2143f292)
- **lembretes no prompt** — `nexos-docs-route` lembra de consultar a doc (ctx7) com a
  versão instalada quando o prompt cita, ou o arquivo importa, uma dependência declarada.
  `nexos-team-route` injeta a delegação quando o pedido é de um papel do time. Cada um
  dispara uma vez por pacote ou papel por sessão. O estado deles em TMPDIR não segue
  symlink, e os arquivos saem 0600. (8f115fb7, f46a63d2, 168eb75b)
- **time e agentes instalados** — cinco papéis novos (`nexos-po`, `nexos-planner`,
  `nexos-qa`, `nexos-devops`, `nexos-ux`). Duas skills novas: `nexos-deliver` (fluxo de
  entrega com verificação) e `nexos-time` (roteia pedido de papel). `nexos-verifier`
  dispara revisores por tipo de arquivo. Entram também 12 agentes especialistas e as
  regras `secret-exposure` e `research-persistence`.
  (bb4ca98d, a2102ddd, 8de5a02b, d2f6633c, d55b1959, fafde88b, f3a85e5f)
- **brief do SessionStart** — avisa quando os assets instalados estão atrás do pacote e
  quando o runtime em execução está desatualizado. Anuncia por ponteiro os comandos de
  capability, research e verificação. (84b57278, 9c19cd1b, 708c7972)
- **`nexos capabilities`** — o inventário de MCP passa a ver os conectores da conta e os
  servidores de plugin, não só `mcpServers`. A saúde de MCP é observada sem executar
  (binário presente vira `unknown`, nunca `connected`). Plugin só conta como instalado se
  o diretório existe. Skill com `SKILL.MD` em outra caixa deixa de sumir.
  (b8dcee3e, dc9e1ca6, 86276d33, e466273b)
- **desempenho** — `nexos boot` lê o Store 2 vezes em vez de 4 (10,4 s → 5,2 s sob
  carga). `doctor --project` consulta o git 4 vezes em vez de 7. 120 escritas seguidas de
  `decision` caem de 7,9 s para 1,3 s. (0d4e6b7b, 1b89c3fc, b98457b8, b362d961)

### Removed
- **injeção automática `[NEXOS ARQUIVOS RELEVANTES]`** — medida em 30 dias: 5% de
  precisão por arquivo e ~350 tokens por prompt. Saem o hook `nexos-source-route` e o
  comando `claude-source-route`. A consulta sob demanda continua em
  `nexos relevant-files --task`. (3b26df5a)
- **hook PreCompact `nexos-precompact-save.sh`** — lia projeção legada e a saída não tinha
  leitor. Saem também as skills `development--systematic-debugging` e
  `development--test-driven-development`, idênticas às do plugin oficial `superpowers`.
  (ab2183bb, 088721fa)

## 6.5.2 (2026-09-18) — o gate de aprovação chega ao runtime que o usuário executa

### Fixed
- **`nexos memory --promote`** — pede aprovação humana de verdade. `promover()` passava
  `humanApproved: true` fixo e carimbava `policy:nexos-memory-promote`: o gate existia e
  nunca era avaliado. Sem terminal controlador a promoção agora é recusada (exit 1) e o
  candidato continua candidato; com terminal, pergunta `[y/N]` e carimba `human:tty`.
  (0d966eef)
- **`nexos capabilities`** — sombreamento é por NOME, nunca por conteúdo: duas skills de
  nomes diferentes coexistem ativas por mais idêntico que seja o corpo, e a precedência é
  resolvida por nome dentro do grupo. `porAcao` conta peças e `porTipo` conta achados — antes
  as duas unidades se misturavam no mesmo objeto. (cbf1bd66, b8c37009, 6fd2025b)

A 6.5.1 fica retirada: o mesmo número descreveu dois códigos, e o global instalado não
tinha o gate acima.

## 6.5.1 (2026-09-18) — o piso de gotchas passa a reservar de verdade

### Fixed
- **montagem de contexto** — o piso de 25% para gotchas não reservava nada: a fatia de
  decisões de continuidade rodava antes, contra o orçamento inteiro, e quando passava de 25%
  o piso fechava sem admitir nenhum gotcha. (2efa311f)

## 6.5.0 (2026-09-18) — aprendizado automático no SUCCEEDED

### New Commands
- **`nexos office`** — "onde estamos" em uma página: objetivo, estado, próxima ação,
  blocker, decisão pendente, o que está aberto, o que entregou, decisões ativas e lições.
  Nenhum dado novo: monta o que estava espalhado por cinco comandos. (6bf58cd1)

### Changed
- **gatilho de aprendizado** — checkpoint que fecha `SUCCEEDED` propõe candidato a memória
  pelo mesmo funil de `nexos learn`, sem ninguém lembrar de digitar. Propõe, nunca promove;
  idempotente pelo dedupe existente. (51c3ef35)

### Fixed
- **gatilho de aprendizado** — lia `previous_checkpoint_id` do conteúdo em vez do envelope e
  nunca disparava, em silêncio (0df83266); citava só o primeiro de vários gates red→green
  (7f566bd9); cortava no meio da palavra (1cae4b60); e soldava o statement do checkpoint aos
  red→green de outro trabalho, produzindo um fato falso (f5f6e08b).

## 6.4.2 (2026-09-17) — Project Health honesto, guarda que não é teatro, proof que compila

### Fixed
- **`doctor --project`** — `ACERVO INERTE != MEMÓRIA CONCORRENTE`. Só superfície de
  memória do PROJETO que realmente compete com o Store (lida em sessão OU escrita
  agora) promove `warn` a `DEGRADED`. Acervo congelado e `.nexos/memory/project`
  (legado que o próprio `lifecycle` já isenta) viram evidência. O relatório deixava
  de se contradizer: a mesma execução isentava `memory/` numa linha e o condenava em
  outra. Consequência prática: sem isso, os 11 projetos legados sairiam do
  `init --repair` já marcados `DEGRADED` — medido em cópias, 10 deles fecham
  `LEGACY → HEALTHY` com o fix e nenhum fecha sem ele.
- **`evidence.project-memory`** — novo, simétrico ao `host-hygiene`: o inventário do
  lado projeto agora sai SEMPRE, degradando ou não. Antes sumia justo quando o estado
  ficava bom.
- **`fresh-install-proof`** — `npm run build` antes do `npm pack`. `prepublishOnly`
  não roda em `pack`, então o proof empacotava o `dist/` largado no worktree:
  mutação só em `src/` sem rebuild devolvia "TODOS OS CHECKS PASSARAM". O tarball
  também deixou de ser escolhido por `readdir().sort().pop()` (ordenação
  lexicográfica, em que `6.9.0` vence `6.10.0`) e passa a vir do stdout do `pack`.

### New Commands
- **`nexos learn --from <chk_id>`** — trabalho verificado vira candidato a memória
  pelo funil que já existia. Exige checkpoint `SUCCEEDED`, lê Evidence por
  `subject_ref`, detecta red→green ATRAVESSANDO commit (das 16 transições no acervo,
  10 eram no mesmo commit — re-run, árvore suja, flaky) e publica só
  `memory_candidate`. Nunca promove: `single-canonical-writer` intacto.
- **`nexos research`** — pesquisa indexada com fonte citada por afirmação. A família
  `Research` já existia no schema e o brief já a lia; o acervo tinha zero records.
  `--search` reencontra.
- **`nexos context --for "<assunto>"`** — o que o projeto já sabe, em camadas:
  L0 quanto existe · L1 títulos e ids · L2 corpo sob demanda.

### Changed
- **papel `nexos-master`** — `MAIN != BUILDER` é FALSO: o agente principal executa
  T0/T1 diretamente quando delegar não reduz risco, tempo ou carga cognitiva. A
  proibição de implementar passa a valer para T2+. `BUILDER != VERIFIER` intacto, e
  o gate de verificação de T1+ é **incondicional** — o executor não julga se cabe.
- **guarda da invariante** — a separação builder/verifier passou a ser testada. Antes,
  apagá-la do papel matava zero testes em 1818. A régua é allowlist de forma: a célula
  de pipeline de T1+ casa INTEIRA, já normalizada (acento, travessão, espaço), uma das
  redações aprovadas — afrouxar a política exige uma segunda edição deliberada no teste.
  Três verificações independentes furaram as versões anteriores 16 vezes no total; a
  última fechou exceção escondida após `;`/`·` sem repetir a âncora, rótulo `**T1**` em
  negrito, coluna extra carregando a redação aprovada, e exceção migrada para a coluna
  "quem executa". Teto declarado: condição em prosa fora da tabela e token vivo com
  sentido morto não são alcançáveis por detector textual.
- **`dist/build-info.json`** — `buildTime` sai do COMMIT, não do relógio, quando a
  árvore está limpa. Três `npm pack` do mesmo commit produziam três sha256 distintos:
  o hash publicado identificava um EVENTO de build que ninguém conseguia reproduzir, e
  como evidência era infalsificável. Árvore suja continua carimbando o instante — ali
  não há reprodutibilidade a prometer, e `dirty: true` diz por quê.
- **`nexos research`** — erro de input virou recusa legível em vez de stack trace:
  `--source` sem `--claim` pareado e `--confidence` fora do enum estouravam exceção
  dentro de um `.map()`. Fail-closed nos dois casos, mas só um deles é legível.

## Unreleased

### Changed
- **`nexos install`** — now only installs the NexOS surface into `~/.claude`. Removed
  `-y/--yes`, `--profile`, `--advanced`, `--skip-skills`, `--skip-hooks` and the
  interactive Greenfield/Brownfield/stack wizard; `install` is fully non-interactive,
  never reads `process.cwd()`, and prints a deterministic create/update/unchanged/
  preserve/remove plan (`--dry-run` shows it without writing). `nexos update --force`
  replaces the old profile-based force-overwrite path.
- **`assets/settings.json`** — now declares only `hooks`; `env`/`permissions`/`language`
  removed. `hooks` projection rewrites every NexOS-owned handler from the asset on each
  install/update instead of merging — a legacy handler (e.g. a pre-P1.0 `PreToolUse`
  entry) never survives.
- Removed `src/lib/profiles.ts` (install profiles) — no consumer left.

## 6.2.0 (2026-04-16) — awesome-claude-skills Patterns Absorbed

### New Commands
- **`nexos review-memory`** (alias: `review`) — Analyze past Claude Code conversations
  to find improvements for memory files. Reads `~/.claude/projects/-<cwd>/*.jsonl`,
  extracts user/assistant turns from the N most recent sessions (default 15), loads
  `CLAUDE.md` + `.nexos/memory/project/*.md`, and generates a ready-to-use review prompt
  at `.nexos/memory/review-prompt.md`. Flags: `--limit <n>`, `--output <path>`, `--dry-run`.

  Pattern absorbed from ykdojo/claude-code-tips `review-claudemd` (MIT). Closes the
  self-learning loop started by `nexos-instinct-observer.js` + `nexos-instinct-analyzer.js`
  in v6.0: the observer captures data, review-memory proposes instruction improvements.

### New Hooks
- **`nexos-agnix-check.sh`** (PreToolUse, opt-in via `NEXOS_AGNIX=1`) — Validates agent
  config files (`CLAUDE.md`, `SKILL.md`, `.claude/settings*.json`, `agent.yaml`,
  `AGENTS.md`) against agnix's 399 rules on every Edit/Write/MultiEdit. Blocks with
  exit 2 on errors; warnings pass through.

  Pattern absorbed from agent-sh/agnix (MIT/Apache-2.0). Chose integration via
  `npx agnix` over absorbing the 399 Rust rules into JS — keeps the NexOS codebase
  small and leverages upstream maintenance.

### Modified
- **`assets/settings.json`** — Added agnix-check hook to PreToolUse lifecycle.
- **`src/index.ts`** — Registered `review-memory` command.
- **`package.json`** — Version bump 6.1.1 -> 6.2.0.

### ADRs
- **ADR-013**: Comando `review-memory` (absorvido de review-claudemd)
- **ADR-014**: Hook agnix opt-in (agent-sh/agnix, 399 rules)

### Why this matters
v6.0 shipped instinct learning hooks that capture tool-use observations, but had no
mechanism to turn those observations into actionable memory updates. v6.2 adds the
missing half: `review-memory` reviews past conversations against memory and proposes
concrete improvements. Combined with the opt-in agnix hook, agent config quality is
now enforced at two layers — static (lint on edit) and dynamic (review after use).

---

## 6.1.1 (2026-04-14) — Skill Activation Fix

### Bug Fixes
- **Bootstrap skill counter** — `bootstrap_graph.py` was counting `.yaml/.yml/.json` in
  `.nexos/skills/` which is the legacy path. Claude Code skills actually live in
  `~/.claude/skills/*/SKILL.md`. The fix scans the correct path and counts `SKILL.md`
  files, so the bootstrap banner now reports the true count (753 instead of 0).
  Mirrored in `assets/engine/bootstrap_graph.py` for future installs.

### New Files
- **assets/skills-index.md** (111 KB, 864 lines) — Curated domain map of all 753 skills
  across 23 domains, organized hierarchically with descriptions. Agents reference this
  via `@skills-index.md` import in CLAUDE.md. Solves the problem of skills being
  installed but never activated because no agent knew they existed.
- **assets/engine/bootstrap_graph.py** — Canonical fixed bootstrap counter shipped
  with the package so `nexos install` propagates the fix to new users.

### Modified
- **assets/CLAUDE.md** — Added "SKILLS DISPONÍVEIS" section listing top 10 domains by
  volume and linking to @skills-index.md. Updated final signature from "5300+ skills"
  to "760 skills organized by domain" (truth in advertising).
- **assets/agents/nexos-frontend.md** — Added "Skills Relevantes (Pixel)" section with
  32 curated frontend/design/perf/testing skills Pixel should reference. Establishes
  the pattern for other agents: **before implementing, cite 1-3 skills from your domain
  block**. This biases Claude Code's semantic activation toward the right skill.

### Why this matters
Prior to 6.1.1 NexOS installed 760 skills but the bootstrap counter reported `skills=0`
(wrong path + wrong extension), CLAUDE.md didn't tell the model where skills lived, and
no agent file referenced specific skills. Net result: 760 skills sitting on disk,
effectively invisible to the runtime. This release makes them visible, counted, and
actively used by agents. Follow-up: apply the same Skills Relevantes pattern to the
remaining 16 agents.

## 6.1.0 (2026-04-14) — Absorption: opc-skills + claude-code-best-practice

### New Skills (5, from ReScienceLab/opc-skills)
- **requesthunt** — User demand research from Reddit, X, GitHub (CLI-first, TOON output)
- **domain-hunter** — Domain search, registrar price comparison, promo codes
- **logo-creator** — AI logo generation with crop, bg remove, SVG export
- **banner-creator** — AI banner generation for GitHub/Twitter/LinkedIn headers
- **nanobanana** — Google Gemini 3 Pro Image (Nano Banana Pro), 2K/4K output

Total skills: 755 → **760**.

### New Features
- **assets/skills.json** — Declarative catalog of 753 skills (name/path/description).
  Solves bootstrap `skills=0` problem by providing a single manifest instead of
  forcing discovery via filesystem scan. Pattern absorbed from opc-skills.
- **triggers[] + dependencies{} + auth{}** on the 5 new skills via
  `.claude-plugin/plugin.json`. Enables dependency-aware install cascade
  (banner-creator → nanobanana, logo-creator → nanobanana, requesthunt → reddit+twitter).
- **nexos-drift-detector agent** (Vigil) — Read-only auditor that compares NexOS
  against official Claude Code docs via WebFetch and emits drift-report.md with
  P0/P1/P2/P3 gap classification. Pattern absorbed from
  shanraisshan/claude-code-best-practice workflow agents.
- **Hook lifecycle expansion** (+5 events): SessionEnd, PostCompact, SubagentStop,
  PermissionDenied, CwdChanged. Total event types: 6 → **11**.
- **nexos-lifecycle-logger.sh** — Append-only JSONL observability logger at
  `~/.nexos/memory/metrics/lifecycle.jsonl`, consumed by drift-detector.

### Upgrades
- Agents: 16 → **17** (added nexos-drift-detector)
- agent.yaml spec updated to 6.1.0

### Patterns Absorbed
1. Declarative skills manifest (opc-skills/skills.json)
2. triggers[] array for explicit auto-activation (opc)
3. dependencies{} graph between skills (opc)
4. auth{} schema with env/url declarative setup (opc)
5. references/ + examples/ progressive disclosure folders (opc)
6. Drift-detection workflow agents with WebFetch (shanraisshan)
7. Hook lifecycle coverage expansion (shanraisshan/claude-code-best-practice)

## 5.0.0 (2026-04-08) — Installation Wizard

### New Features
- **Installation Wizard** — Interactive step-by-step installer replacing silent install
- **Greenfield vs Brownfield** — Asks project type and adapts install strategy
- **Tech Preset Selection** — Choose stack (Next.js, Python, Go, Rust, Full-Stack, Auto)
- **CLAUDE.md Conflict Resolution** — Merge, Backup+Overwrite, Overwrite, or Skip
- **Post-Install Validation Report** — 6-check validation with pass/fail for each
- **Quick Start Guide** — Shows next steps with agent examples after install
- **Silent mode preserved** — `nexos install -y` still works for automation

### Validation Checks
- Agents installed (16)
- CLAUDE.md configured
- settings.json configured
- Hook session-init present
- Rules installed (17+)
- Agent Memory paired (16)

## 4.0.0 (2026-04-08) — BREAKING: Agent Redesign

### Breaking Changes
- **89 generic agents replaced by 16 deep specialists** — each with persona, MEMORY.md, authority matrix, activation protocol
- Old agents moved to `assets/agents-legacy/` (not installed)
- Agent IDs changed: all now use `nexos-` prefix consistently

### New Features
- **`nexos init`** — Initialize .nexos/memory/project/ in current project with state, decisions, gotchas, research, patterns + CLAUDE.md
- **`nexos register`** — Register projects in global registry (~/.nexos/projects.json)
- **Project Registry** — Central registry of all known projects with status and pending tasks
- **Agent MEMORY.md** — Each specialist has individual persistent memory that learns across sessions
- **Hook v3** — Session init hook now falls back to project registry when no .nexos/ found in CWD
- **Workspace mode** — Hook scans subdirectories for projects when in workspace root

### The 16 Specialists
| Agent | Persona | Role |
|-------|---------|------|
| nexos-master | Nova | Orchestrator, governance |
| nexos-dev | Dex | Full-stack implementation |
| nexos-qa | Quinn | Quality gates, 10-phase review |
| nexos-architect | Aria | System design, ADRs |
| nexos-dba | Dara | Schema, RLS, migrations |
| nexos-devops | Gage | git push EXCLUSIVE, CI/CD |
| nexos-pm | Morgan | PRDs, epics, spec pipeline |
| nexos-po | Pax | Story validation, backlog |
| nexos-sm | River | Story creation, sprints |
| nexos-analyst | Atlas | Market research, discovery |
| nexos-ux | Luna | Design system, a11y |
| nexos-security | Shield | OWASP, audit, hardening |
| nexos-performance | Blaze | Core Web Vitals, profiling |
| nexos-ai-engineer | Neuron | RAG, prompts, LLM integration |
| nexos-frontend | Pixel | React, Next.js, components |
| nexos-backend | Forge | APIs, auth, integrations |

### Inspired By
- AIOX-Core v5.0.3 (SynkraAI) — agent MEMORY.md, authority matrix, handoff protocol
- Everything Claude Code — pattern capture, de-sloppify, cost tracking
- Oh-My-ClaudeCode — multi-agent orchestration patterns

## 3.2.0 (2026-04-05)
- **ECC patterns absorbed** — 10 patterns from Everything Claude Code (140k stars)
- **npm published** — v3.2.0 live on npm

## 3.0.0 (2026-04-02)
- **Profiles** — `nexos install --profile=nextjs|python|fullstack|full` installs curated subset
- **Plugin system** — `nexos plugin add/remove/list` to extend with npm packages
- **Dashboard TUI** — `nexos dashboard` shows visual status of entire installation
- **Tests** — 13 TypeScript tests (vitest) + 223 Python engine tests = 236 total
- **CI/CD** — GitHub Actions: build, test, security scan, auto-publish on tag
- **Auto-rollback** — install/update restores backup automatically on failure

## 2.3.0 (2026-04-02)
- Tests, CI/CD pipeline, auto-rollback on failure

## 2.2.0 (2026-04-02)
- **nexos sync** — compare, pull, and push assets between local install and repo
- **nexos changelog** — view what changed between versions
- **Engine auto-setup** — auto-installs Python dependencies on install
- **Hooks auto-register** — nexos hooks registered in settings.json automatically
- Updated counts: 87 agents, 98 hooks, 5300+ skills

## 2.1.0 (2026-04-02)
- **Smart merge** — update compares file hashes; preserves dev customizations
- **MEMORY.md template** — new installs get persistent memory file
- **Auto-doctor** — health check runs after install/update
- **chmod .py hooks** — Python hooks now executable
- **Version sync** — reads from package.json (single source of truth)
- Fixed 36 Python deprecation warnings (datetime.utcnow)

## 2.0.1 (2026-03-25)
- Security fix: removed hardcoded machine_id from memory-sync hook
- Synced 7 writer agents and 6 hooks from installed to assets

## 2.0.0 (2026-03-25)
- Initial release with Hermes Engine
- 80 agents, 5300+ skills, 366 commands, 12 rules
- Python runtime with memory, security, routing, cron
- Install/update/doctor/uninstall/info commands
