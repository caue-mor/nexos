/**
 * STORE AUTHORITY BOUNDARY V1 — Frente A: TamperScanner (I2, ver
 * `tamper-scanner.ts`).
 *
 *   POST-ADMISSION TAMPER != CORRUPTION AT WRITE TIME
 *
 * TETO EXPLÍCITO reproduzido aqui como contrafactual: fecha contra
 * `cat > arquivo.yaml` sobre um record JÁ commitado sem recommitar, e contra
 * `rm` desse mesmo record (`DELETED`); NÃO fecha contra um atacante que também
 * commita a adulteração OU a deleção (ver os testes "adulteração COMMITADA não
 * é detectada" e "deleção COMMITADA não é detectada").
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import { execFileSync } from "node:child_process";
import { initializeCapsule } from "../src/lib/capsule/initializer.js";
import { publishCanonical } from "../src/lib/capsule/store.js";
import { forProject } from "../src/lib/capsule/paths.js";
import { scanForPostAdmissionTamper } from "../src/lib/capsule/tamper-scanner.js";
import { makeGotcha } from "./capsule-fixtures.js";
import type { CapsuleRecord } from "../src/lib/capsule/schemas.js";

const TMP_BASE = fs.realpathSync(os.tmpdir());
let ws: string, root: string, projectId: string;

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP_BASE, "tamper-"));
  root = path.join(ws, "proj");
  await fs.ensureDir(root);
  execFileSync("git", ["init", "-q"], { cwd: root });
  execFileSync("git", ["config", "user.email", "t@t.com"], { cwd: root });
  execFileSync("git", ["config", "user.name", "t"], { cwd: root });
  projectId = (await initializeCapsule(root, { projectName: "proj" })).projectId;
});
afterEach(async () => {
  await fs.remove(ws);
});

function commitAll(message: string): void {
  execFileSync("git", ["add", "-A"], { cwd: root });
  execFileSync("git", ["commit", "-q", "-m", message], { cwd: root });
}

const withProject = (r: CapsuleRecord): CapsuleRecord => ({ ...r, project_id: projectId }) as CapsuleRecord;

describe("scanForPostAdmissionTamper · aplicabilidade", () => {
  it("root fora de work tree git → applicable: false, nunca finge medir", async () => {
    const semGit = path.join(ws, "sem-git");
    await fs.ensureDir(semGit);
    const r = await scanForPostAdmissionTamper(semGit);
    expect(r.applicable).toBe(false);
  });

  it("work tree git sem nenhum commit ainda → applicable: false (sem HEAD, sem witness)", async () => {
    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(false);
  });
});

describe("scanForPostAdmissionTamper · aceite: POST-WRITE TAMPER detected", () => {
  it("record intacto desde o commit → MATCH, zero findings", async () => {
    await publishCanonical(root, withProject(makeGotcha()));
    commitAll("initial");

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toEqual([]);
    expect(r.filesChecked).toBeGreaterThan(0);
  });

  it("cat > arquivo.yaml sobre um record JÁ commitado, SEM recommitar → TAMPERED", async () => {
    const rec = withProject(makeGotcha());
    await publishCanonical(root, rec);
    commitAll("initial");

    // Simula `cat > .nexos/records/knowledge/<id>.yaml` — escrita direta,
    // sem passar por publishCanonical, sem novo commit.
    const filePath = forProject(root).recordPath("KnowledgeRecord", rec.id);
    await fs.writeFile(filePath, "schema_version: 1\ntampered: true\n");

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.state).toBe("TAMPERED");
    expect(r.findings[0]!.filePath).toBe(filePath);
  });

  it("record nunca commitado (untracked, recém publishCanonical) → NOT_COMMITTED, não é TAMPERED", async () => {
    await publishCanonical(root, withProject(makeGotcha()));
    // nenhum commit — só o manifest/gitignore do init foram commitados no beforeEach? Não: beforeEach não commita nada.
    execFileSync("git", ["add", "-A"], { cwd: root });
    execFileSync("git", ["commit", "-q", "-m", "manifest only"], { cwd: root });
    // o record acima foi escrito ANTES deste commit inicial — já está no HEAD, então
    // este teste prova o caso realmente untracked publicando um SEGUNDO record depois.
    const depois = withProject(makeGotcha({ content: { title: "outro", rule: "regra" } }));
    await publishCanonical(root, depois);

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toEqual([]);
  });

  /**
   * O FALSO POSITIVO QUE DECIDE `warn` × `fail` NO DOCTOR.
   *
   *   STAGED != COMMITTED — e sem "antes" no witness não há adulteração.
   *
   * O fluxo normal de uma sessão é "record nasce, é usado, é commitado depois",
   * e entre nascer e commitar ele passa por `git add`. Se o scanner acusasse
   * um record staged-mas-não-commitado, o check tocaria em TODA sessão de
   * trabalho — e alarme que toca sempre é alarme desligado. É por isso que o
   * scanner filtra por `M` e não aceita `A`.
   */
  it("record `git add`-ado e ainda NÃO commitado não é adulteração — não há bytes anteriores", async () => {
    await publishCanonical(root, withProject(makeGotcha()));
    commitAll("initial");

    const novo = withProject(makeGotcha({ content: { title: "nascido agora", rule: "regra" } }));
    await publishCanonical(root, novo);
    execFileSync("git", ["add", "-A"], { cwd: root });

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toEqual([]);
  });

  /**
   * O outro lado do mesmo filtro: `git add` da PRÓPRIA adulteração não a
   * esconde. `git diff HEAD` compara HEAD contra a working tree qualquer que
   * seja o estado do índice — só o COMMIT move o witness (teto acima).
   */
  it("adulteração `git add`-ada mas não commitada continua TAMPERED — staging não é witness", async () => {
    const rec = withProject(makeGotcha());
    await publishCanonical(root, rec);
    commitAll("initial");

    const filePath = forProject(root).recordPath("KnowledgeRecord", rec.id);
    await fs.writeFile(filePath, "schema_version: 1\ntampered: true\n");
    execFileSync("git", ["add", "-A"], { cwd: root });

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.filePath).toBe(filePath);
  });

  /**
   * O VETOR MAIS BARATO DOS QUATRO.
   *
   *   ABSENT FROM DISK != ABSENT FROM HISTORY
   *
   * O permission gate classifica TEXTO de comando, e `rm .nexos/records/x.yaml`
   * sai como `read` (knw_01M15NHGDQMWH8KSDSGN65JSH3). Medido antes deste teste:
   * `rm` de record commitado deixava `git status` com ` D <path>` e o scanner
   * respondendo `filesChecked: 420 | findings: 0` — porque a lista de trabalho
   * saía do `readdir`, isto é, DO PRÓPRIO ALVO. Arquivo apagado não aparece na
   * lista que ele mesmo alimenta.
   */
  it("`rm` de record JÁ commitado → DELETED, nomeando o arquivo", async () => {
    const rec = withProject(makeGotcha());
    await publishCanonical(root, rec);
    commitAll("initial");

    const filePath = forProject(root).recordPath("KnowledgeRecord", rec.id);
    await fs.remove(filePath);

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.state).toBe("DELETED");
    expect(r.findings[0]!.filePath).toBe(filePath);
    expect(r.findings[0]!.family).toBe("KnowledgeRecord");
  });

  /**
   * `DELETED` e `TAMPERED` no MESMO relatório, cada um com seu rótulo. Colapsar
   * os dois num "divergindo de HEAD" mandaria o operador procurar um diff que
   * não existe para o que foi destruído.
   */
  it("adulterado e apagado convivem sem se colapsar num rótulo só", async () => {
    const vitima = withProject(makeGotcha());
    const reescrito = withProject(makeGotcha({ content: { title: "outro", rule: "regra" } }));
    await publishCanonical(root, vitima);
    await publishCanonical(root, reescrito);
    commitAll("initial");

    const pathVitima = forProject(root).recordPath("KnowledgeRecord", vitima.id);
    const pathReescrito = forProject(root).recordPath("KnowledgeRecord", reescrito.id);
    await fs.remove(pathVitima);
    await fs.writeFile(pathReescrito, "schema_version: 1\ntampered: true\n");

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    const porPath = new Map(r.findings.map((f) => [f.filePath, f.state]));
    expect(porPath.get(pathVitima)).toBe("DELETED");
    expect(porPath.get(pathReescrito)).toBe("TAMPERED");
    expect(r.findings).toHaveLength(2);
  });

  /**
   * `git rm` sem commit é a mesma deleção com o índice já atualizado — e o
   * witness continua sendo HEAD, não o índice.
   */
  it("`git rm` (deleção STAGED, não commitada) também é DELETED", async () => {
    const rec = withProject(makeGotcha());
    await publishCanonical(root, rec);
    commitAll("initial");

    const filePath = forProject(root).recordPath("KnowledgeRecord", rec.id);
    execFileSync("git", ["rm", "-q", "--", path.relative(root, filePath)], { cwd: root });

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toHaveLength(1);
    expect(r.findings[0]!.state).toBe("DELETED");
  });

  /**
   * O teto de `D` é o MESMO teto de `M`: quem commita a destruição move o
   * witness. Declarado, não escondido.
   */
  it("deleção COMMITADA não é detectada — mesmo teto do atacante que commita", async () => {
    const rec = withProject(makeGotcha());
    await publishCanonical(root, rec);
    commitAll("initial");

    await fs.remove(forProject(root).recordPath("KnowledgeRecord", rec.id));
    commitAll("attacker also commits the deletion");

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toEqual([]);
  });

  /**
   * A REGRA DA SOBRA SÓ É SÃ SE AS DUAS LISTAS COBREM O MESMO CONJUNTO.
   *
   * Sobra do `git diff` = apagado. Um `.md` modificado dentro da pasta da
   * família aparece no diff e o `readdir` (que filtra `.yaml`) nunca o visita —
   * viraria `DELETED` de um arquivo que está ali, inteiro. Por isso o parse
   * filtra por `.yaml` + pasta de família conhecida.
   */
  it("arquivo não-YAML modificado dentro da pasta da família não vira DELETED fantasma", async () => {
    await publishCanonical(root, withProject(makeGotcha()));
    const intruso = path.join(forProject(root).familyDir("KnowledgeRecord"), "NOTAS.md");
    await fs.writeFile(intruso, "antes\n");
    commitAll("initial");

    await fs.writeFile(intruso, "depois\n");

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    expect(r.findings).toEqual([]);
  });

  it("adulteração COMMITADA não é detectada — teto declarado, não segurança teatral", async () => {
    const rec = withProject(makeGotcha());
    await publishCanonical(root, rec);
    commitAll("initial");

    const filePath = forProject(root).recordPath("KnowledgeRecord", rec.id);
    await fs.writeFile(filePath, "schema_version: 1\ntampered: true\n");
    commitAll("attacker also commits the tamper");

    const r = await scanForPostAdmissionTamper(root);
    expect(r.applicable).toBe(true);
    if (!r.applicable) return;
    /**
     * HEAD agora REFLETE os bytes adulterados — não há divergência a medir.
     * Isto é o teto documentado no cabeçalho do módulo, provado em teste:
     * reescrever E commitar engana este detector. Fechar isso exigiria
     * comparar toda a história do path, fora do orçamento desta fatia.
     */
    expect(r.findings).toEqual([]);
  });
});
