/**
 * Três eixos ortogonais para responder o que UM enum não consegue.
 *
 *     PORTABLE TRUTH TRAVELS · PORTABLE PROOF DOES NOT
 *
 * MEDIDO em 2026-09-20 neste repositório: 837 registros de Evidence no disco,
 * ZERO versionados (`.nexos/.gitignore` exclui `.local/`), contra 2282 records
 * canônicos versionados dos quais 400 citam `evidence_refs` e 54 apontam para
 * `ev_*` que só existem NESTA máquina. O record atravessa afirmando
 * "verificado"; a prova fica para trás.
 *
 * Confirmado por acidente no mesmo dia: um verificador independente, em
 * worktree isolado da MESMA máquina, não pôde conferir afirmações porque
 * `.nexos/.local/evidence` não existe num worktree. Quem clonar de outro
 * computador está no mesmo lugar, só que pior.
 *
 * ## Por que eixos, e não um enum
 *
 * Há DUAS perguntas independentes, e cada uma tem seu instrumento:
 *
 *     a prova está disponível e íntegra?   -> o hash responde
 *     a afirmação continua válida?         -> a reexecução responde
 *
 * Um enum único não representa `evidence local adulterada + reexecução atual
 * concordando` — e esse estado é POSSÍVEL. Modelar em eixos impede escrever o
 * impossível sem esconder o real.
 *
 *     ESTADO IMPOSSÍVEL DE REPRESENTAR > ESTADO ERRADO REPRESENTÁVEL
 *
 * ## A distinção que este módulo existe para não perder
 *
 *     UNVERIFIABLE_HERE != FALSE != FAILED != DIVERGED
 *     TAMPERED         != nenhum dos quatro — é "a prova mudou", não
 *                         "a afirmação é falsa"
 *
 * E a que custou uma correção de contrato antes de virar código:
 *
 *     PROVA ÍNTEGRA != PROVA REEXECUTADA
 *
 * Hash bater prova que a evidência local é a MESMA que foi registrada. Só
 * isso. `VERIFIED_HERE` fica reservado para quem de fato reexecutou aqui —
 * chamar hash-bate de verificado seria repetir, no contrato, o erro
 * epistemológico que este projeto passou o dia inteiro corrigindo no código.
 *
 * O gap concreto que isto fecha: os 29 records que carregam `evidence_sha256`
 * transportam a âncora e **ninguém a confere**. Uma evidência adulterada passa
 * hoje como prova boa, em silêncio.
 */
import { hashEvidence } from "./verification-basis.js";
import type { VerificationBasis } from "./verification-basis.js";
import type { EvidenceRecord } from "../evidence.js";

/** Eixo 1 — o corpo da evidência existe neste ambiente? */
export type EvidenceAvailability = "AVAILABLE" | "MISSING";

/**
 * Eixo 2 — o corpo presente é o mesmo que foi registrado?
 *
 * `UNKNOWN` não é "acho que sim": é a resposta honesta quando não há hash
 * gravado para comparar (basis antigo, anterior ao campo). Colapsar `UNKNOWN`
 * em `MATCH` transformaria ausência de verificação em aprovação — que é
 * exatamente a classe de defeito que este módulo existe para acabar.
 */
export type EvidenceIntegrity = "MATCH" | "MISMATCH" | "UNKNOWN";

/**
 * Eixo 3 — a AFIRMAÇÃO continua válida?
 *
 * `NOT_REVALIDATED` é o estado inicial de todo record, e é o correto: nada foi
 * reexecutado ainda. Os outros três exigem execução real neste ambiente.
 */
export type ClaimVerification =
  | "NOT_REVALIDATED"
  | "VERIFIED_HERE"
  | "DIVERGED"
  | "FAILED"
  /**
   * O instrumento não existe neste ambiente. Irmão de `UNVERIFIABLE_HERE` um
   * nível acima: lá falta a PROVA, aqui falta o MEIO de produzi-la.
   *
   *     AUSÊNCIA DE INSTRUMENTO NÃO É REPROVAÇÃO
   *
   * MEDIDO: 25 das 112 bases trazem `npm run test:all`, script que não existe
   * mais — e existia nos `repo_commit` que elas carregam. Reexecutar hoje dá
   * `Missing script` e exit 1; o gate não reprovou, ele nunca rodou.
   *
   * Este estado é decidido ANTES de executar, por pré-checagem, e NUNCA
   * inferido do exit code depois. A razão é medida e não é estilo:
   *
   *     npm run <script inexistente>  -> exit 1
   *     vitest <arquivo inexistente>  -> exit 1
   *
   * O mesmo 1 para "não rodou" e para "rodou e reprovou". Inferir depois
   * obrigaria a parsear `"Missing script"` do stderr do npm — string de
   * terceiro, que muda de versão, e a classe de guard que este repositório já
   * enterrou em `ASSERÇÃO DE TEXTO-FONTE PEGA REVERSÃO`. Pior: colapsaria
   * reprovação real em "não deu para medir", que é o espelho invertido do que
   * `UNKNOWN -> MATCH` teria sido no eixo 2. Lá ausência viraria aprovação;
   * aqui reprovação viraria ausência, e ninguém investiga o que não é vermelho.
   *
   * Por ser decidido sem executar, cabe no caminho de leitura sem violar
   * `READ DOES NOT EXECUTE` (`nexos://decision/revalidacao-sob-demanda-nunca-automatica`).
   */
  | "UNRUNNABLE_HERE";

export interface EvidenceVerifiability {
  readonly availability: EvidenceAvailability;
  readonly integrity: EvidenceIntegrity;
  readonly claim: ClaimVerification;
  /**
   * Há `command`/`args`/`repo_commit` suficientes para alguém TENTAR reproduzir.
   *
   *     REPRODUCIBLE != REPRODUCED != VERIFIED
   *
   * É por isso que este campo é separado de `claim`: poder reproduzir não é ter
   * reproduzido, e ter reproduzido não é o mesmo que a afirmação valer. A
   * apresentação precisa manter os três em linhas distintas, senão o leitor lê
   * instrução como prova.
   */
  readonly reproducible: boolean;
}

/**
 * `TAMPERED` é derivado, nunca um quarto valor de eixo nenhum: é a COMBINAÇÃO
 * "o corpo está aqui e não é o que foi registrado".
 *
 * Evidência AUSENTE nunca é `TAMPERED` — não há o que comparar, e acusar
 * adulteração onde só há ausência inverteria o significado. É controle
 * negativo obrigatório do contrato.
 */
export function isTampered(v: EvidenceVerifiability): boolean {
  return v.availability === "AVAILABLE" && v.integrity === "MISMATCH";
}

/**
 * O instrumento do basis existe neste ambiente?
 *
 * Pura e sem execução: recebe os scripts que o `package.json` deste checkout
 * declara e responde por comparação. Ler o manifesto é leitura; rodar o
 * comando seria outra coisa, e não acontece aqui.
 *
 * TETO CONHECIDO, nomeado de propósito: só decide sobre `npm run <script>`,
 * que é a forma de 112 das 112 bases medidas. Qualquer outra forma volta
 * `true` — "não sei checar" vira "deixa tentar", nunca "declara ausente".
 * Errar para o lado de tentar produz um FAILED investigável; errar para o
 * outro produziria um UNRUNNABLE_HERE que esconde gate quebrado, e esse é o
 * erro que não se percebe.
 *
 * ponytail: cobre o caso medido; estender para binário no PATH quando
 * aparecer uma base que não seja `npm run`.
 */
export function instrumentoDisponivel(
  basis: VerificationBasis,
  scriptsDoAmbiente: readonly string[] | undefined
): boolean {
  if (scriptsDoAmbiente === undefined) return true;
  if (basis.command !== "npm" || basis.args[0] !== "run") return true;
  const script = basis.args[1];
  if (script === undefined) return true;
  return scriptsDoAmbiente.includes(script);
}

/**
 * Resolve os três eixos para UMA base de verificação, contra o que este
 * ambiente tem.
 *
 * Read-only e puro: não toca disco, não reexecuta nada. `claim` sai
 * `NOT_REVALIDATED` ou `UNRUNNABLE_HERE` — nunca os três que afirmam sobre a
 * execução, porque reexecutar é decisão de quem chama, com custo e efeito, e
 * uma função de leitura não decide isso por ninguém.
 *
 * `UNRUNNABLE_HERE` não é exceção a isso: ele é decidido pela AUSÊNCIA do
 * instrumento, por comparação com o manifesto que o chamador já leu, sem rodar
 * coisa alguma.
 */
export function resolveVerifiability(
  basis: VerificationBasis,
  evidenciasLocais: readonly EvidenceRecord[],
  /**
   * Scripts declarados pelo `package.json` DESTE checkout. `undefined` = não
   * foi possível ler, e então nada se declara sobre o instrumento: ausência de
   * leitura não é ausência de instrumento.
   */
  scriptsDoAmbiente?: readonly string[]
): EvidenceVerifiability {
  const local = evidenciasLocais.find((e) => e.id === basis.evidence_id);
  /**
   * `UNRUNNABLE_HERE` sobrepõe `NOT_REVALIDATED` porque diz mais: os dois
   * significam "nada foi reexecutado", mas este acrescenta POR QUE não pode
   * ser, e é o que impede o passo de revalidação de produzir 25 falsos
   * `FAILED`. Não toca os eixos 1 e 2 — a prova pode estar aqui e íntegra
   * enquanto o instrumento sumiu, e esses são fatos independentes.
   */
  const claim: ClaimVerification = instrumentoDisponivel(basis, scriptsDoAmbiente)
    ? "NOT_REVALIDATED"
    : "UNRUNNABLE_HERE";

  /**
   * Basis sem `repo_commit` ainda é reproduzível: `command` + `args` bastam
   * para tentar. O commit torna a tentativa HONESTA (reproduzir noutro commit
   * responde outra pergunta), e sua ausência é registrada pelo próprio campo,
   * não por este booleano.
   */
  const reproducible = basis.command.trim().length > 0;

  if (!local) {
    return { availability: "MISSING", integrity: "UNKNOWN", claim, reproducible };
  }

  /**
   * Hash gravado vazio/ausente ⇒ `UNKNOWN`, nunca `MATCH`. O schema exige
   * 64 hex, mas basis vindo de disco pode ser mais antigo que o campo — e
   * ausência de hash é ausência de verificação, não verificação bem-sucedida.
   */
  if (!/^[a-f0-9]{64}$/.test(basis.evidence_sha256)) {
    return { availability: "AVAILABLE", integrity: "UNKNOWN", claim, reproducible };
  }

  const integrity: EvidenceIntegrity = hashEvidence(local) === basis.evidence_sha256 ? "MATCH" : "MISMATCH";
  return { availability: "AVAILABLE", integrity, claim, reproducible };
}

/**
 * A linha de status, para quem apresenta. Nunca mistura o comando de
 * reprodução — isso é responsabilidade de quem renderiza, em linha separada.
 */
export function descreverVerificabilidade(v: EvidenceVerifiability): string {
  /**
   * Vem antes dos eixos 1 e 2 na apresentação porque responde a pergunta mais
   * urgente para quem lê: não adianta saber que a prova está aqui e íntegra se
   * o meio de reconferi-la sumiu. E jamais é pintado como falha —
   * `AUSÊNCIA DE INSTRUMENTO NÃO É REPROVAÇÃO`.
   */
  if (v.claim === "UNRUNNABLE_HERE") {
    return "UNRUNNABLE_HERE — o comando registrado não existe neste ambiente (não é reprovação)";
  }
  if (v.availability === "MISSING") {
    return v.reproducible
      ? "UNVERIFIABLE_HERE — prova não disponível neste ambiente (reproduzível)"
      : "UNVERIFIABLE_HERE — prova não disponível neste ambiente";
  }
  if (isTampered(v)) {
    return "TAMPERED — a prova local não corresponde ao hash registrado";
  }
  if (v.integrity === "UNKNOWN") {
    return "INTEGRIDADE DESCONHECIDA — a base não registrou hash para comparar";
  }
  return "EVIDENCE_INTACT_HERE — prova local íntegra, NÃO reexecutada";
}
