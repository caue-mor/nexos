/**
 * STORE AUTHORITY BOUNDARY V1 — Frente A: TamperScanner.
 *
 *   POST-ADMISSION TAMPER != CORRUPTION AT WRITE TIME
 *
 * I0/I1 (`integrity.ts`) catcham um record MAL FORMADO. Isto cata um record
 * BEM FORMADO cujos bytes mudaram DEPOIS de já terem sido commitados —
 * `lifecycle: immutable` prometido pelo schema, verificado aqui contra um
 * witness que sobrevive ao processo do agente: o histórico git.
 *
 * Deliberadamente um arquivo À PARTE de `integrity.ts`, não uma chamada
 * dentro de `scanIntegrity()`. `integrity.ts` documenta a própria garantia
 * como "C2.2 garante I0 + I1 sem consultar git (ADR-044)... I2 (completude
 * histórica) exige witness sobrevivente e está fora desta fase" — isto É a
 * fase I2. Misturar os dois faria toda leitura I0/I1 (hoje sem I/O de
 * processo externo, síncrona por natureza) passar a depender de `git`
 * instalado e do repo ter HEAD — uma degradação que ninguém pediu para as
 * outras duas.
 *
 * Mesmo padrão de `git-boundary.ts`: `GitRunner` injetável, git ausente ou
 * fora de work tree é INAPLICÁVEL (não é "sem tamper"), nunca finge medir o
 * que não mediu.
 *
 * TETO EXPLÍCITO — leia antes de confiar neste módulo:
 *
 *   FECHA        bytes em disco divergindo do que HEAD guarda para um record
 *                JÁ commitado — o caso comum de `cat > .nexos/records/....yaml`
 *                sobre um record existente, sem passar por `git commit` depois.
 *   FECHA        record commitado que SUMIU do disco (`rm`, `git rm` sem
 *                commit) — `DELETED`, não `TAMPERED`. Este era o furo mais
 *                barato de todos: o permission gate classifica TEXTO de
 *                comando, e `rm .nexos/records/x.yaml` sai como `read`
 *                (knw_01M15NHGDQMWH8KSDSGN65JSH3), enquanto a lista de
 *                trabalho deste scanner vinha do `readdir` — isto é, DO
 *                PRÓPRIO ALVO. Arquivo apagado some da lista e some do
 *                relatório: `ABSENT FROM DISK != ABSENT FROM HISTORY`. Quem
 *                responde "o que deveria existir" é o witness, não o disco.
 *   NÃO FECHA    um atacante que TAMBÉM commita a adulteração OU a deleção (o
 *                HEAD passaria a refletir os bytes forjados / a ausência) —
 *                mesmo limite que `codex-delivery-broker.ts` já documenta para
 *                a evidência de delivery: mesmo uid, mesmo repositório local,
 *                sem broker.
 *   NÃO FECHA    reescrita de histórico (`commit --amend`, `rebase`,
 *                `filter-branch`) — exigiria comparar TODA a história do
 *                path, não só HEAD; fora do orçamento desta fatia.
 *   NÃO SE APLICA a um record NUNCA commitado (staged ou untracked) — sem
 *                bytes anteriores no witness não há "antes" para comparar, e
 *                apagá-lo antes do primeiro commit também não é deleção
 *                detectável: não havia nada a perder.
 *                Isso não é `TAMPERED`; ver `classifyAdmission`
 *                (`integrity.ts`) para a pergunta ortogonal "este record foi
 *                admitido pelo escritor canônico?".
 *
 * Uma linha dizendo o que isto detecta e o que não impede vale mais que um
 * mecanismo que finge fechar a fronteira inteira.
 */
import path from "node:path";
import { readdir } from "node:fs/promises";
import { forProject, CANONICAL_FAMILIES } from "./paths.js";
import type { RecordFamily } from "./ids.js";
import { type GitRunner, type GitOutcome, systemGitRunner } from "./git-boundary.js";

/**
 * Diretório ausente é família ainda não usada — silenciosamente `[]`, mesma
 * leitura de `listYaml` (`integrity.ts`) para ENOENT. Qualquer OUTRA falha
 * de `readdir` também vira `[]`: `TamperScanner` é best-effort e read-only
 * (mesma doutrina de `collectGit`/`describeHostSurfaces` em `boot.ts`) — não
 * é a autoridade de integridade estrutural, que já é `scanIntegrity()`.
 */
async function listYamlBestEffort(dir: string): Promise<readonly string[]> {
  try {
    return (await readdir(dir)).filter((f) => f.endsWith(".yaml")).sort();
  } catch {
    return [];
  }
}

export type TamperState = "MATCH" | "TAMPERED" | "NOT_COMMITTED" | "DELETED";

export interface TamperFinding {
  readonly family: RecordFamily;
  readonly filePath: string;
  /**
   * `TAMPERED` = bytes mudaram. `DELETED` = o arquivo sumiu do disco. Um
   * `state` só, e não dois arrays, porque quem consome quer a lista de
   * violações do Store — mas os dois NUNCA se colapsam num rótulo genérico:
   * "adulterado" manda ler o diff, "apagado" manda restaurar do witness.
   */
  readonly state: Extract<TamperState, "TAMPERED" | "DELETED">;
  readonly detail: string;
}

export type TamperReport =
  | {
      readonly applicable: false;
      /** Git ausente, ou root fora de work tree, ou HEAD sem commit ainda. */
      readonly reason: string;
      readonly findings: readonly [];
    }
  | {
      readonly applicable: true;
      /**
       * YAML encontrados NO DISCO. Não é "records verificados": um record
       * apagado não está aqui e mesmo assim vira finding — a contagem de disco
       * nunca foi a medida da cobertura.
       */
      readonly filesChecked: number;
      /** Só violação entra — `MATCH`/`NOT_COMMITTED` não são anomalia. */
      readonly findings: readonly TamperFinding[];
    };

/**
 * UM spawn de git para TODOS os records — não um por record.
 *
 *   WITNESS PER FILE != WITNESS PER SCAN
 *
 * A primeira versão resolvia o witness com `git show HEAD:<path>` por record.
 * Medido no Store real deste repositório (421 records): **103.049 ms** — 20x o
 * `nexos doctor` inteiro, que roda em 5,3 s. Foi exatamente esse custo que
 * manteve a função sem chamador desde que nasceu (o nó 20 do grafo registrava
 * "39,5s para 415 records ... não é lentidão aceitável num `nexos doctor`", e
 * GOTCHA-S20 já tinha ensinado que varredura preventiva que sai de 3 s para
 * 374 s é varredura que alguém desliga).
 *
 * `git diff HEAD` faz a MESMA comparação — bytes da working tree contra os
 * bytes em HEAD — porém dentro do git e com o stat cache do índice: **47 ms**
 * para os mesmos 421. O witness não mudou; mudou quem itera.
 *
 * `--diff-filter=MD` NÃO é otimização, é o contrato do módulo escrito em argv:
 *
 *   M   existia em HEAD e os bytes divergem   → `TAMPERED`
 *   D   existia em HEAD e sumiu do disco      → `DELETED`
 *   A   no índice mas nunca commitado         → NÃO SE APLICA (não há "antes")
 *
 * Aceitar `D` não reabre o falso positivo de `A`: são letras disjuntas, e é `A`
 * — não `D` — que "nasce, é usado, é commitado depois" produz em toda sessão.
 * Sem o filtro, todo record recém-`git add`-ado viraria finding, que é como um
 * alarme vira alarme desligado.
 *
 * `D` custa ZERO spawn adicional: mesma chamada, mesma travessia do índice.
 *
 * O filtro por `.yaml` dentro de um dos `dirs` NÃO é decoração: os paths que
 * sobram sem correspondência no disco viram `DELETED`, então qualquer entrada
 * que o `readdir` não visitaria por outro motivo (um `.md` largado na pasta da
 * família, um YAML dentro de subpasta) seria acusada de deleção sem ter sido
 * apagada. A regra de sobra só é sã se as duas listas cobrirem o MESMO
 * conjunto.
 *
 * `--relative` faz o git emitir paths relativos ao `-C rootPath`, casando com
 * o `path.relative(rootPath, ...)` do laço abaixo, em vez de relativos ao topo
 * do repositório — a versão anterior assumia silenciosamente que os dois
 * coincidem. `-z` remove a citação de paths com caracteres incomuns.
 *
 * `null` = git respondeu de forma inesperada. NUNCA vira "zero tamper":
 * `CANNOT OBSERVE != DOES NOT EXIST`.
 */
async function pathsDivergingFromHead(
  runner: GitRunner,
  rootPath: string,
  familyByRelDir: ReadonlyMap<string, RecordFamily>
): Promise<Set<string> | null> {
  const pathspecs = [...familyByRelDir.keys()].map((relDir) => relDir.split(path.sep).join("/"));
  const result: GitOutcome = await runner.run([
    "-C",
    rootPath,
    "diff",
    "HEAD",
    "--name-only",
    "--diff-filter=MD",
    "-z",
    "--relative",
    "--",
    ...pathspecs,
  ]);
  if (!result.ok || result.code !== 0) return null;
  return new Set(
    result.stdout
      .split("\0")
      .filter((entry) => entry.length > 0)
      .map((entry) => entry.split("/").join(path.sep))
      .filter((rel) => rel.endsWith(".yaml") && familyByRelDir.has(path.dirname(rel)))
  );
}

export async function scanForPostAdmissionTamper(
  rootPath: string,
  runner: GitRunner = systemGitRunner()
): Promise<TamperReport> {
  const inside = await runner.run(["-C", rootPath, "rev-parse", "--is-inside-work-tree"]);
  if (!inside.ok || inside.code !== 0 || inside.stdout.trim() !== "true") {
    return { applicable: false, reason: "não é uma work tree git, ou git indisponível", findings: [] };
  }
  const head = await runner.run(["-C", rootPath, "rev-parse", "--verify", "HEAD"]);
  if (!head.ok || head.code !== 0) {
    return { applicable: false, reason: "repositório sem HEAD (nenhum commit ainda)", findings: [] };
  }

  const p = forProject(rootPath);
  const familyByRelDir = new Map<string, RecordFamily>(
    CANONICAL_FAMILIES.map((family) => [path.relative(rootPath, p.familyDir(family)), family])
  );
  const diverging = await pathsDivergingFromHead(runner, rootPath, familyByRelDir);
  if (diverging === null) {
    return {
      applicable: false,
      reason: "git diff HEAD falhou — ausência de medição não é ausência de adulteração",
      findings: [],
    };
  }

  const findings: TamperFinding[] = [];
  let filesChecked = 0;

  for (const family of CANONICAL_FAMILIES) {
    const dir = p.familyDir(family);
    const files = await listYamlBestEffort(dir);

    for (const file of files) {
      const filePath = path.join(dir, file);
      const relPath = path.relative(rootPath, filePath);
      filesChecked++;

      // `delete` em vez de `has`: o que NÃO for consumido pelo disco é
      // exatamente o que o witness conhece e o disco não tem mais.
      if (!diverging.delete(relPath)) continue;

      findings.push({
        family,
        filePath,
        state: "TAMPERED",
        detail:
          `bytes em disco divergem do commit em HEAD para "${relPath}" — record ` +
          `lifecycle:immutable não deveria mudar depois de commitado. NÃO commitado desde ` +
          `a mudança (senão o HEAD já refletiria os bytes atuais) — ver teto do módulo para o ` +
          `que isto NÃO cobre.`,
      });
    }
  }

  /**
   * A SOBRA É O ACHADO.
   *
   *   WORK LIST FROM THE TARGET != WORK LIST FROM THE WITNESS
   *
   * O laço acima itera o disco, e disco não tem opinião sobre o que foi
   * apagado. Estes paths o git viu em HEAD e o `readdir` não encontrou — a
   * única lista em que um arquivo destruído ainda aparece.
   */
  for (const relPath of [...diverging].sort()) {
    const family = familyByRelDir.get(path.dirname(relPath));
    if (family === undefined) continue;
    findings.push({
      family,
      filePath: path.join(rootPath, relPath),
      state: "DELETED",
      detail:
        `"${relPath}" existe em HEAD e NÃO existe no disco — record canônico ` +
        `destruído sem passar por supersede/correção. Deleção não deixa bytes para ` +
        `comparar: quem acusa é o witness, e restaurar é \`git checkout HEAD -- <path>\`.`,
    });
  }

  return { applicable: true, filesChecked, findings };
}
