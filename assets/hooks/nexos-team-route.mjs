#!/usr/bin/env node
// nexos-team-route.mjs — roteamento de papel do time (UserPromptSubmit).
// nexos://decision/time-scrum-completo
//
// MEDIDO 23/09 em clones limpos dum projeto piloto: pedido direto de papel ("testa a
// tela no navegador", "revisa o deploy", "define o layout") foi feito pelo agente
// principal em 3 de 5 sessões — ele começa investigando e nunca carrega a skill
// nexos-time. Este hook reconhece o pedido ANTES da primeira ação e injeta a
// delegação. Uma vez por papel por sessão; só additionalContext.
//
// Zero dependências, nunca lança, exit sempre 0.

import { readFileSync, writeFileSync, mkdirSync, renameSync, lstatSync } from "node:fs";
import os from "node:os";
import path from "node:path";

// O campo `prompt` do hook difere do texto gravado no transcript (medido 23/09: relatório de
// subagente disparou os hooks mesmo com o cabeçalho no transcript) — por isso também a marca
// da mensagem nos primeiros 400 caracteres, onde quer que o cabeçalho esteja.
// `<cross-session-message from="...">` é o wrapper documentado da ferramenta
// SendMessage ("Your message arrives wrapped as..."), achado HIGH #4 da
// rodada 3 — faltava aqui e nas duas cópias irmãs (`nexos-docs-route.mjs`,
// `memory-recall.ts`). As 3 cópias têm que ficar IDÊNTICAS — ver
// `tests/nao-humano-regex-paridade.test.ts`, fonte única por verificação.
const NAO_HUMANO = /^(?:<task-notification>|<channel\s|Another Claude session sent a message:)|^[\s\S]{0,400}?(?:<agent-message from=|<teammate-message|<cross-session-message from=|\[Subagent hand-back\])/;

// Ordem = ordem do fluxo (PO → planejador → UX → QA → DevOps).
const PAPEIS = [
  ["nexos-po", "Lia, PO", /hist[óo]rias? de usu[áa]rio|crit[ée]rios? de aceite|\bbacklog\b|levantar requisitos|requisitos d[aeo]/i],
  ["nexos-planner", "Téo, planejador", /\bsprint\b|\bchecklist\b|cronograma|plano de a[çc][ãa]o|quebr[ae]\w* (isso|isto|esse|essa|este|esta|o projeto|a feature|em (tarefas|etapas))|em tarefas com/i],
  ["nexos-ux", "Uma, UX", /\blayout\b|\bux\b|\bui\/ux\b|hierarquia (da|de) (tela|informa)|identidade visual|melhor[ae]r? o visual|design da tela|define o design/i],
  ["nexos-qa", "Quinn, QA", /\btest[ae]r? (a |o )?(tela|fluxo|p[áa]gina|app|site|login|checkout)|no navegador|\bqa\b|ponta a ponta|\be2e\b|regress[ãa]o visual/i],
  ["nexos-devops", "Otto, DevOps", /\bdeploy|publica[rç]|\bpipeline\b|\bci\b|github actions|\brailway\b|\bvercel\b|vari[áa]ve(l|is) de ambiente|\bcron\b|\bdocker/i],
];

// Diretório de estado em os.tmpdir() tem nome previsível: só é usado se for
// diretório de verdade (não symlink) e do próprio usuário — num /tmp
// compartilhado, outro usuário poderia apontar o nome para onde quisesse
// (achado MEDIUM do security-reviewer, 23/09). mode 0700 só vale na criação.
function dirSeguro(dir) {
  try {
    mkdirSync(dir, { recursive: true, mode: 0o700 });
    const st = lstatSync(dir);
    return st.isDirectory() && !st.isSymbolicLink() && (typeof process.getuid !== "function" || st.uid === process.getuid());
  } catch {
    return false;
  }
}

function main() {
  let input;
  try {
    input = JSON.parse(readFileSync(0, "utf8"));
  } catch {
    return;
  }
  const sid = input?.session_id;
  const prompt = input?.prompt;
  if (input?.hook_event_name !== "UserPromptSubmit" || typeof prompt !== "string") return;
  if (typeof sid !== "string" || !/^[\w-]{1,128}$/.test(sid)) return;
  if (typeof input.agent_id === "string" && input.agent_id !== "") return;
  if (NAO_HUMANO.test(prompt.trimStart())) return;

  const achados = PAPEIS.filter(([, , re]) => re.test(prompt));
  if (achados.length === 0) return;

  const dir = path.join(os.tmpdir(), "nexos-team");
  const arquivo = path.join(dir, `${sid}.json`);
  let vistos = [];
  try {
    const lido = JSON.parse(readFileSync(arquivo, "utf8"));
    if (Array.isArray(lido)) vistos = lido;
  } catch {
    vistos = [];
  }
  const novos = achados.filter(([agente]) => !vistos.includes(agente));
  if (novos.length === 0) return;
  if (!dirSeguro(dir)) return;
  const tmp = `${arquivo}.${process.pid}`;
  writeFileSync(tmp, JSON.stringify([...vistos, ...novos.map(([a]) => a)]), { mode: 0o600 });
  renameSync(tmp, arquivo);

  const lista = novos.map(([agente, nome]) => `${nome} (${agente})`).join(", depois ");
  const texto =
    `[NEXOS TIME] Este pedido é do papel ${lista}. Delegue antes de investigar: skill nexos-time, bloco da skill ` +
    `nexos-handoff e Agent(subagent_type: "${novos[0][0]}"). O agente principal orquestra e confere; não faça o ` +
    `trabalho do papel. Pergunta simples ou uma linha: responda direto.`;
  process.stdout.write(JSON.stringify({ hookSpecificOutput: { hookEventName: "UserPromptSubmit", additionalContext: texto } }));
}

try {
  main();
} catch {
  // silêncio: exit 0 sempre
}
