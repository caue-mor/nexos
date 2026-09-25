/**
 * C12.6 — discovery da classe GOTCHA. MEDE, não migra.
 *
 * Existe porque o formato do `gotchas.md` é DIFERENTE do `decisions.md` e
 * presumir semelhança foi a origem do GOTCHA-044. Aqui nada é publicado: o
 * script conta o conjunto e mede a cobertura de cada campo do `GotchaSchema`
 * contra rótulos MEDIDOS na fonte.
 *
 *   PARSER DID NOT FIND X != SOURCE DOES NOT CONTAIN X
 *   PARSE COMPLETE != PUBLISH EVERYTHING
 *
 * Uso:  npx tsx scripts/c12-gotcha-discovery.ts
 */
import fs from "fs-extra";

const SOURCE = ".nexos/memory/project/gotchas.md";

/**
 * Rótulos candidatos por campo do schema. Cada entrada foi LIDA da fonte, não
 * imaginada — a lista sai de `grep -oE "^- \*\*[^*]+\*\*:"` ordenado por
 * frequência. Variantes com e sem acento são formas reais do arquivo.
 */
const CANDIDATOS: Record<string, string[]> = {
  trigger: ["Gatilho", "O gatilho concreto", "Trigger", "Quando"],
  failure_mode: ["Problema", "Sintoma diagnostico", "Efeito", "Falha"],
  consequence: [
    "Consequencia",
    "Consequência",
    "Consequencia real",
    "Custo evitado",
    "Impacto",
  ],
  mitigation: [
    "Solucao",
    "Solução",
    "Solução medida",
    "Prevencao",
    "Prevenção",
    "Correcao aplicada",
    "Guard",
    "Regra",
  ],
  evidence: ["Data", "Medição", "Como foi medido", "Prova", "Observado"],
};

interface Bloco {
  id: string;
  titulo: string;
  linha: number;
  corpo: string;
}

const texto = await fs.readFile(SOURCE, "utf8");
const linhas = texto.split("\n");

const HEADING = /^### \[([A-Z-]+-\d+)\]\s*(.*)$/;

const blocos: Bloco[] = [];
const naoGotcha: string[] = [];
let atual: Bloco | undefined;

linhas.forEach((linha, i) => {
  const m = HEADING.exec(linha);
  if (m) {
    const [, id, titulo] = m;
    if (atual) blocos.push(atual);
    atual = { id: id ?? "", titulo: titulo ?? "", linha: i + 1, corpo: "" };
    if (!id?.startsWith("GOTCHA-")) naoGotcha.push(`${id} (linha ${i + 1}) — ${titulo}`);
    return;
  }
  if (atual) atual.corpo += linha + "\n";
});
if (atual) blocos.push(atual);

const headingsTotal = linhas.filter((l) => l.startsWith('### ')).length;
const gotchas = blocos.filter((b) => b.id.startsWith("GOTCHA-"));

/** Duplicata de id é defeito da FONTE: a chave de reconciliação deixa de identificar. */
const porId = new Map<string, Bloco[]>();
for (const b of gotchas) {
  const lista = porId.get(b.id);
  if (lista) lista.push(b);
  else porId.set(b.id, [b]);
}
const duplicados = [...porId.entries()].filter(([, lista]) => lista.length > 1);

const temRotulo = (corpo: string, rotulo: string): boolean =>
  new RegExp(`^- \\*\\*${rotulo.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\*\\*:`, "m").test(corpo);

const cobertura: Record<string, number> = {};
const presencaPorBloco = new Map<string, string[]>();

for (const campo of Object.keys(CANDIDATOS)) cobertura[campo] = 0;

for (const b of gotchas) {
  const presentes: string[] = [];
  for (const [campo, rotulos] of Object.entries(CANDIDATOS)) {
    if (rotulos.some((r) => temRotulo(b.corpo, r))) {
      cobertura[campo] = (cobertura[campo] ?? 0) + 1;
      presentes.push(campo);
    }
  }
  presencaPorBloco.set(`${b.id}@${b.linha}`, presentes);
}

console.log(`fonte                 ${SOURCE}`);
console.log(`headings '### '       ${headingsTotal}`);
console.log(`blocos GOTCHA-*       ${gotchas.length}`);
console.log(`ids distintos         ${porId.size}`);
console.log(`ids duplicados        ${duplicados.length}`);
console.log(`headings nao-GOTCHA   ${naoGotcha.length}`);
console.log(
  `\nconjunto fecha?       ${gotchas.length + naoGotcha.length === headingsTotal ? "SIM" : "NAO"} ` +
    `(${gotchas.length} + ${naoGotcha.length} vs ${headingsTotal})`
);

console.log(`\n── COBERTURA POR CAMPO DO GotchaSchema (todos obrigatorios hoje) ──`);
for (const [campo, n] of Object.entries(cobertura)) {
  const pct = ((n / gotchas.length) * 100).toFixed(0);
  const veredito = n === gotchas.length ? "" : "  ← NAO cobre todos";
  console.log(`  ${campo.padEnd(13)} ${String(n).padStart(3)}/${gotchas.length}  ${pct.padStart(3)}%${veredito}`);
}

const completos = [...presencaPorBloco.values()].filter(
  (p) => p.length === Object.keys(CANDIDATOS).length
).length;
console.log(`\n  blocos com os 5 campos: ${completos}/${gotchas.length}`);

const histograma = new Map<number, number>();
for (const p of presencaPorBloco.values()) histograma.set(p.length, (histograma.get(p.length) ?? 0) + 1);
console.log(`\n── quantos campos cada bloco tem ──`);
for (const n of [...histograma.keys()].sort((a, b) => b - a)) {
  console.log(`  ${n} campo(s): ${histograma.get(n)} bloco(s)`);
}

if (duplicados.length > 0) {
  console.log(`\n── IDS DUPLICADOS (a chave de reconciliacao nao identifica) ──`);
  for (const [id, lista] of duplicados) {
    for (const b of lista) console.log(`  ${id}  linha ${String(b.linha).padStart(4)}  ${b.titulo}`);
  }
}
if (naoGotcha.length > 0) {
  console.log(`\n── HEADINGS QUE NAO SAO GOTCHA ──`);
  for (const n of naoGotcha) console.log(`  ${n}`);
}
