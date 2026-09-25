/**
 * ESCAPE POR SYMLINK DE DIRETÓRIO INTERMEDIÁRIO.
 *
 *   PATH DENTRO DA RAIZ != ESCRITA DENTRO DA RAIZ
 *
 * MEDIDO e registrado em `knw_01M33F7WSDD6SMSYGQQBA93NPH`: `applyAssetOp`
 * monta `destFile` com `path.join` e chama `ensureDir` + `fs.copy` sem olhar
 * os SEGMENTOS do caminho. Se `~/.claude/skills` (ou `agents`/`rules`/`hooks`)
 * for symlink para fora, o kernel resolve o link e o arquivo é gravado no
 * alvo externo — o path parece estar sob `~/.claude` e a escrita não está.
 *
 * A assimetria é a parte que engana, e foi medida: symlink de ARQUIVO não é
 * seguido (o `fs.copy` remove o link e a vítima fica intacta); symlink de
 * DIRETÓRIO é. Um teste que só cobrisse arquivo passaria com o buraco aberto.
 *
 * `dec_01M33FNYGV67GBE1N289EBR72R` fixa o padrão: segmento a segmento, como o
 * ECC faz — nunca a checagem LÉXICA do AIOX, que compara strings de prefixo e
 * é cega a link, porque `/a/b/../c` e um symlink resolvem no kernel, não no
 * comparador de strings.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import fs from "fs-extra";
import path from "node:path";
import os from "node:os";
import ts from "typescript";
import { assertNoSymlinkTraversal } from "../src/lib/installer.js";

let lab: string;
let raiz: string;
let externo: string;

beforeEach(async () => {
  lab = await fs.mkdtemp(path.join(fs.realpathSync(os.tmpdir()), "symlink-escape-"));
  raiz = path.join(lab, "claude");
  externo = path.join(lab, "fora");
  await fs.ensureDir(raiz);
  await fs.ensureDir(externo);
});

afterEach(async () => {
  await fs.remove(lab);
});

describe("assertNoSymlinkTraversal — segmento a segmento, nunca léxico", () => {
  it("recusa quando um diretório INTERMEDIÁRIO do destino é symlink para fora", async () => {
    const skills = path.join(raiz, "skills");
    await fs.ensureSymlink(externo, skills, "dir");

    await expect(
      assertNoSymlinkTraversal(raiz, path.join(skills, "alguma-skill", "SKILL.md"))
    ).rejects.toThrow(/symlink/i);
  });

  it("recusa mesmo quando o symlink está no MEIO do caminho, não no primeiro segmento", async () => {
    const skills = path.join(raiz, "skills");
    await fs.ensureDir(skills);
    await fs.ensureSymlink(externo, path.join(skills, "pacote"), "dir");

    await expect(
      assertNoSymlinkTraversal(raiz, path.join(skills, "pacote", "SKILL.md"))
    ).rejects.toThrow(/symlink/i);
  });

  it("aceita caminho normal, sem symlink em segmento nenhum", async () => {
    const destino = path.join(raiz, "skills", "normal", "SKILL.md");
    await fs.ensureDir(path.dirname(destino));
    await expect(assertNoSymlinkTraversal(raiz, destino)).resolves.toBeUndefined();
  });

  it("aceita segmento que ainda NÃO existe — instalar cria diretório novo", async () => {
    const destino = path.join(raiz, "skills", "ainda-nao-existe", "SKILL.md");
    await expect(assertNoSymlinkTraversal(raiz, destino)).resolves.toBeUndefined();
  });

  it("recusa destino fora da raiz por travessia léxica — o caso que o ECC também cobre", async () => {
    await expect(
      assertNoSymlinkTraversal(raiz, path.join(raiz, "..", "fora", "SKILL.md"))
    ).rejects.toThrow(/fora da raiz|outside/i);
  });

  /**
   * A VÍTIMA é o que prova o escape: sem a guarda, um arquivo aparece em
   * `externo/`. Com ela, o diretório externo continua vazio.
   */
  it("com a guarda, nada é escrito no diretório externo", async () => {
    const skills = path.join(raiz, "skills");
    await fs.ensureSymlink(externo, skills, "dir");

    await expect(
      assertNoSymlinkTraversal(raiz, path.join(skills, "vitima.md"))
    ).rejects.toThrow();

    expect(await fs.readdir(externo)).toEqual([]);
  });
});

/**
 * A GUARDA É CHAMADA PELO CAMINHO DE ESCRITA — prova ESTRUTURAL, e assumida
 * como tal.
 *
 *   FUNCTION TESTED != FUNCTION CALLED BY THE COMMAND
 *
 * A primeira versão deste bloco era vácua: chamava `assertNoSymlinkTraversal`
 * de novo e dizia testar o wiring. MEDIDO por mutação — removendo a chamada de
 * `applyAssetOp`, os 8 testes continuavam verdes. Guarda que o comando não
 * invoca não protege nada, e o teste que "cobre" isso mente.
 *
 * O caso behavioral (rodar `applyInstallPlan` contra uma raiz de laboratório)
 * não é alcançável sem seam: `INSTALL_TARGETS` deriva de `os.homedir()` em
 * constante de módulo, e trocar `homedir` por mock não reavalia a constante já
 * carregada — tentado e medido. As opções eram um seam de produto só para
 * teste, ou esta prova estrutural. Escolhi a estrutural, e o teto está aqui
 * escrito: ela prova a CHAMADA no AST, não o efeito em runtime.
 *
 *   PROVA ESTRUTURAL != PROVA COMPORTAMENTAL
 *
 * Ainda assim ela mata a mutação que os 8 casos anteriores deixavam passar,
 * que era o buraco real.
 */
describe("wiring — applyAssetOp chama a guarda antes de tocar o disco", () => {
  it("a chamada existe, e vem ANTES de ensureDir/copy/remove", async () => {
    const caminho = path.resolve(__dirname, "../src/lib/installer.ts");
    const fonte = ts.createSourceFile(caminho, fs.readFileSync(caminho, "utf-8"), ts.ScriptTarget.ESNext, true);

    let corpo: ts.FunctionDeclaration | undefined;
    const acha = (no: ts.Node): void => {
      if (ts.isFunctionDeclaration(no) && no.name?.text === "applyAssetOp") corpo = no;
      ts.forEachChild(no, acha);
    };
    acha(fonte);
    expect(corpo, "applyAssetOp sumiu ou mudou de forma — o wiring precisa ser reconferido").toBeDefined();

    const chamadas: string[] = [];
    const anda = (no: ts.Node): void => {
      if (ts.isCallExpression(no)) {
        const alvo = no.expression;
        const nome = ts.isIdentifier(alvo)
          ? alvo.text
          : ts.isPropertyAccessExpression(alvo)
            ? `${alvo.expression.getText()}.${alvo.name.text}`
            : "";
        if (nome) chamadas.push(nome);
      }
      ts.forEachChild(no, anda);
    };
    if (corpo) anda(corpo);

    const iGuarda = chamadas.indexOf("assertNoSymlinkTraversal");
    expect(iGuarda, "applyAssetOp não chama assertNoSymlinkTraversal — o escape volta").toBeGreaterThanOrEqual(0);

    /** Depois da guarda não pode haver nada que já tenha tocado o disco antes dela. */
    const tocamDisco = ["fs.ensureDir", "fs.copy", "fs.remove"];
    const antes = chamadas.slice(0, iGuarda).filter((c) => tocamDisco.includes(c));
    expect(antes, "há escrita em disco ANTES da guarda — ensureDir materializa o caminho pelo link").toEqual([]);
  });
});
