/**
 * `nexos verify` — Critério 9: os gates de qualidade do projeto executados
 * PELO SISTEMA, virando Evidence, em QUALQUER projeto com o pacote instalado.
 *
 *   AGENT SAID TESTS PASS != SYSTEM OBSERVED TESTS PASS
 *   BUILDER != VERIFIER
 *
 * Nada aqui confia em quem chamou: cada gate roda por `runEvidencedCommand`
 * (`../lib/evidence.js`), o exit code do produtor é capturado, e o veredito
 * sai de `verifyFromEvidence` lendo o que foi gravado em
 * `.nexos/.local/evidence/` — operacional, fora do Store canônico e fora do
 * git. O QUE roda vem de `resolveProjectQualityRecipe`
 * (`../lib/quality-recipe.js`): uma receita por projeto (lê
 * `package.json.scripts`), nunca um array hardcoded aqui.
 *
 * Substitui `scripts/verified-gates.mts` (`nexos-cli` dev-only): esse script
 * nunca esteve em `package.json` `"files"`, então fora do repo do nexos-cli o
 * fechamento `VERIFYING -> SUCCEEDED` (`nexos checkpoint`, que já exige
 * Evidence amarrada por `subject_ref`) era mecanicamente inalcançável —
 * `knw_01M2QKATJDK1X7E8EPJHQWGT0T`. As mesmas três funções, agora dentro de
 * `dist/`, alcançáveis por `nexos verify` onde quer que o pacote esteja
 * instalado.
 *
 * Este comando só PRODUZ e REPORTA Evidence — a decisão que conta,
 * `VERIFYING -> SUCCEEDED`, continua sendo só de
 * `checkpoint.ts` (`verificarEvidenciaParaFechamento`), que amarra a
 * `subject_ref` do checkpoint na hora de fechar. Rodar `nexos verify` verde
 * não fecha nada sozinho; é o que torna `nexos checkpoint --state SUCCEEDED`
 * possível de aceitar.
 */
import path from "node:path";
import pc from "picocolors";
import { runEvidencedCommand, verifyFromEvidence, commitAtual } from "../lib/evidence.js";
import { resolveProjectQualityRecipe } from "../lib/quality-recipe.js";
import { resolveCheckpointHead } from "../lib/capsule/checkpoint.js";

export interface VerifyOptions {
  readonly root?: string;
  /** `chk_<ULID>` que esta rodada de gates verifica — ver `EvidenceRecord.subject_ref`. */
  readonly subject?: string;
}

export async function verify(options: VerifyOptions = {}): Promise<void> {
  const root = path.resolve(options.root ?? process.cwd());
  const subject = options.subject;

  const commit = await commitAtual(root);
  console.log(commit ? `commit ${commit.slice(0, 8)}\n` : pc.dim("(sem HEAD git observável neste diretório)\n"));

  const recipe = await resolveProjectQualityRecipe(root);
  if (!recipe.complete) {
    console.log(
      pc.red(`  x receita INCOMPLETA — categoria(s) obrigatória(s) sem implementação: ${recipe.missing.join(", ")}`)
    );
    console.log(pc.dim("    NOT VERIFIED — nenhum gate rodou; sem receita não há Evidence a produzir."));
    process.exitCode = 1;
    return;
  }

  for (const g of recipe.recipes) {
    const ev = await runEvidencedCommand(root, g.gate, g.command, g.args, subject);
    console.log(
      `  ${ev.observed_pass ? pc.green("PASS") : pc.red("FAIL")}  ${g.gate.padEnd(12)} exit=${String(ev.exit_code)}  ` +
        `${ev.stdout_bytes + ev.stderr_bytes} bytes observados  ${ev.id}`
    );
  }

  const verdict = await verifyFromEvidence({
    projectRoot: root,
    requiredGates: recipe.recipes.map((g) => g.gate),
    ...(commit ? { commit } : {}),
    ...(subject ? { subjectRef: subject } : {}),
  });

  console.log(pc.dim("\n── verificador independente (lê Evidence do disco) ──"));
  for (const f of verdict.findings) {
    console.log(`  ${f.ok ? pc.green("PASS") : pc.red("FAIL")}  ${f.gate.padEnd(12)} ${f.detail}`);
  }

  /**
   * VERIFIED aqui só significa "todo gate observado passou" — não prova que
   * `nexos checkpoint --state SUCCEEDED` vai aceitar. Ele exige
   * `subject_ref` == o head ATUAL em VERIFYING (`verificarEvidenciaParaFechamento`,
   * `checkpoint.ts`), e este comando não tem como garantir isso sozinho: sem
   * `--subject`, ou com um `--subject` que não é mais o head (a chain avançou
   * entre a chamada e agora), a Evidence sai sem essa amarração — ou amarrada
   * a um checkpoint que já não é o de cima da pilha.
   *
   *   VERDICT PASS != CLOSES THE OPEN CHECKPOINT
   *
   * `AGENT SAID TESTS PASS != SYSTEM OBSERVED TESTS PASS` vale também para
   * ESTE processo: nunca imprimir "VERIFIED" puro quando o fechamento
   * recusaria — um caller que encadeia `nexos verify && nexos checkpoint
   * --state SUCCEEDED` precisa que o exit code pare a cadeia aqui, não dois
   * comandos depois com uma mensagem de recusa que ninguém leu.
   */
  const head = await resolveCheckpointHead(root);
  if (verdict.pass && head.kind === "HEAD" && head.state === "VERIFYING" && subject !== head.id) {
    console.log(pc.yellow(`\nVERIFIED (sem amarração — não fecha ${head.id})`));
    console.log(
      pc.dim(
        `    gates passaram, mas a Evidence não está amarrada a este checkpoint ` +
          `(subject_ref exigido: ${head.id}${subject ? `, recebido: ${subject}` : " — nenhum --subject informado"}) — ` +
          `"nexos checkpoint --state SUCCEEDED" vai recusar.`
      )
    );
    process.exitCode = 1;
    return;
  }

  console.log(verdict.pass ? pc.green("\nVERIFIED") : pc.red("\nNOT VERIFIED"));
  /**
   * MEDIDO (frente OSS, 18/09): o guard acima só cobria o head em VERIFYING —
   * sem head, ou com head em READY/RUNNING/terminal, a Evidence nascia sem
   * `subject_ref` e ninguém dizia nada (282 records no acervo, 223 dos cinco
   * gates padrão). `GUARD CONDICIONAL A ESTADO NÃO É GUARD`.
   *
   * Decisão de produto (do dono, não minha): `--subject` continua opcional —
   * rodada de saúde avulsa é uso legítimo, e exigi-lo sempre trocaria um
   * problema por outro. O que muda é que a ausência vira aviso, sempre —
   * nunca silêncio — e o record em si já nasceu marcado
   * (`EvidenceRecord.deliberately_unbound`, `evidence.ts`) antes mesmo desta
   * linha rodar. `subject === undefined` é a MESMA condição que
   * `persistObservation` usa pra gravar o campo — nunca duas derivações que
   * podem discordar.
   */
  if (subject === undefined) {
    console.log(
      pc.dim("  (evidência avulsa — não amarra a nenhum checkpoint; use --subject <chk_id> para amarrar)")
    );
  }
  process.exitCode = verdict.pass ? 0 : 1;
}
