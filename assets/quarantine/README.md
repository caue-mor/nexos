# Quarentena de agentes

Decisão `poda-superficie-tres-baldes` (balde C): sai da superfície ativa sem ser
apagado. Nada aqui é instalado por `nexos install`; a instalação seguinte remove a
cópia de `~/.claude/agents` com backup em `~/.claude/backups/pre-nexos-install-<data>/`.

| Agente | Motivo | Medido (26/09, `nexos usage --all`, 30 dias) |
|---|---|---|
| `performance-optimizer` | nenhuma rota do verifier ou do nexos-deliver o chama | 0 invocações |
| `refactor-cleaner` | só por pedido explícito de limpeza; nenhuma rota | 0 invocações |
| `tdd-guide` | nenhuma rota; TDD vem do plugin oficial superpowers | 0 invocações |

Restaurar: `git mv assets/quarantine/agents/<nome>.md assets/agents/`, devolver a
linha na tabela de especialistas de `assets/CLAUDE.md` e rodar `nexos install`.
