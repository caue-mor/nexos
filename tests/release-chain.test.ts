/**
 * O que o repositório produz é o que o Claude Code usa?
 *
 *   PRODUZIDO != ENTREGUE
 *
 * São quatro instalações independentes e nada as sincroniza: SOURCE (commit do
 * worktree), BUILD (commit carimbado no dist local), RUNTIME (o dist que o
 * binário do PATH executa — é ELE que roda nos hooks) e ASSETS (o que
 * `nexos install` projetou em ~/.claude).
 *
 * MEDIDO em 2026-09-18, depois de 28 commits no dia:
 *   SOURCE  4e186383
 *   BUILD   4e186383
 *   RUNTIME 07203616   <- 58 commits atrás
 *   ASSETS  6.5.1 contra pacote 6.5.2
 * Das 6 entregas do dia, 5 não existiam no runtime que o host executa. O aviso
 * de runtime velho, construído justamente para detectar isso, estava na versão
 * não instalada.
 */
import { describe, it, expect } from "vitest";
import path from "node:path";
import { execFileSync } from "node:child_process";
import { elosQuebrados, type ReleaseLink } from "../src/lib/host/release-chain.js";

const link = (elo: ReleaseLink["elo"], valor: string | null, bate: boolean | null): ReleaseLink => ({
  elo,
  valor,
  bateComSource: bate,
  detalhe: "",
});

describe("elosQuebrados", () => {
  it("cadeia íntegra não reporta nada", () => {
    expect(
      elosQuebrados([
        link("SOURCE", "abc", true),
        link("BUILD", "abc", true),
        link("RUNTIME", "abc", true),
        link("ASSETS", "6.5.2", true),
      ])
    ).toEqual([]);
  });

  it("reporta o elo divergente — o caso real desta máquina", () => {
    const quebrados = elosQuebrados([
      link("SOURCE", "4e186383", true),
      link("BUILD", "4e186383", true),
      link("RUNTIME", "07203616", false),
      link("ASSETS", "6.5.1", false),
    ]);
    expect(quebrados.map((l) => l.elo)).toEqual(["RUNTIME", "ASSETS"]);
  });

  /**
   * NEGATIVE CONTROL, e é o que distingue este detector de um otimista:
   * `null` significa NÃO SABIDO — binário ausente do PATH, dist sem
   * build-info, marcador ilegível. Não sabido nunca pode virar "bate", porque
   * o silêncio passaria por cadeia íntegra.
   */
  it("NEGATIVE CONTROL: elo não observado não conta como quebrado NEM como íntegro", () => {
    const chain = [link("SOURCE", "abc", true), link("RUNTIME", null, null)];
    expect(elosQuebrados(chain)).toEqual([]);
    // e o valor null continua visível para quem renderiza — ausência é reportada, não escondida
    expect(chain[1]?.valor).toBeNull();
    expect(chain[1]?.bateComSource).toBeNull();
  });
});

/**
 * COMMIT MOVIDO != ARTEFATO MUDADO.
 *
 * `knw_01M34MTER8982VX9QXTYSNMZ06`: `SOURCE` é `git rev-parse HEAD` e o Store
 * (`.nexos/`) NÃO é empacotado — `package.json.files` é
 * `[dist, bin, assets, agent.yaml, console]`. Então todo `nexos state --set`
 * move `SOURCE` sem mudar um byte que chegue ao runtime, e a cadeia acusa
 * drift que não existe no artefato. O protocolo EXIGE escrever estado ao
 * fechar sessão, então o indicador quebra sozinho, sempre.
 *
 * MEDIDO neste repo: `HEAD` em `7e018b30` (commit só de `.nexos/map`) contra
 * `fd566acb` como último commit a tocar algo empacotável. Dois commits de
 * distância, zero diferença no que é entregue — e quatro ciclos de rebuild
 * gastos nesta sessão para "fechar" um número que já estava certo.
 *
 * Indicador que acusa drift inexistente treina a ignorá-lo, que é exatamente
 * o que ele existe para evitar.
 *
 * A correção fica na COMPARAÇÃO, não no carimbo: `build-info.commit` continua
 * dizendo a verdade sobre de onde o build saiu. O que muda é a pergunta —
 * de "os hashes são iguais?" para "algo que chega ao runtime mudou entre
 * eles?".
 */
describe("mesmaSuperficieEmpacotada — diferença de commit não é diferença de artefato", () => {
  /**
   * LABORATÓRIO, nunca o histórico vivo.
   *
   * A primeira versão destes casos escolhia dois commits do repo real com
   * `git log -1 -- <pathspec>` e assumia que diferiam só em `.nexos`. MEDIDO:
   * falhou na suíte porque entre os dois escolhidos também mudaram `src/`,
   * `tests/` e `docs/` — a função respondeu certo, a premissa do teste é que
   * era falsa. Teste ancorado em histórico vivo mede o histórico, e quebra
   * sozinho a cada commit.
   *
   *   HISTÓRICO REAL != CENÁRIO CONTROLADO
   */
  const laboratorio = async (
    montar: (g: (...a: string[]) => string, lab: string) => Promise<void>
  ): Promise<{ lab: string; g: (...a: string[]) => string }> => {
    const fs2 = (await import("fs-extra")).default;
    const os2 = await import("node:os");
    const lab = await fs2.mkdtemp(path.join(fs2.realpathSync(os2.tmpdir()), "rc-"));
    const g = (...a: string[]): string =>
      execFileSync("git", ["-C", lab, ...a], { encoding: "utf-8" }).trim();
    g("init", "-q");
    g("config", "user.email", "t@t");
    g("config", "user.name", "t");
    await montar(g, lab);
    return { lab, g };
  };

  it("dois commits que diferem só em .nexos contam como a MESMA superfície", async () => {
    const fs2 = (await import("fs-extra")).default;
    const { mesmaSuperficieEmpacotada } = await import("../src/lib/host/release-chain.js");
    const { lab, g } = await laboratorio(async (g2, dir) => {
      await fs2.ensureDir(path.join(dir, "src"));
      await fs2.writeFile(path.join(dir, "src", "x.ts"), "export const x = 1;\n");
      g2("add", "-A");
      g2("commit", "-q", "-m", "A");
      await fs2.ensureDir(path.join(dir, ".nexos", "records"));
      await fs2.writeFile(path.join(dir, ".nexos", "records", "y.yaml"), "id: y\n");
      g2("add", "-A");
      g2("commit", "-q", "-m", "B");
    });
    try {
      const [b, a] = g("log", "-2", "--format=%h").split("\n");
      expect(await mesmaSuperficieEmpacotada(lab, a ?? "", b ?? "")).toBe(true);
    } finally {
      await fs2.remove(lab);
    }
  });

  it("commits que diferem em src/ contam como superfícies DIFERENTES", async () => {
    const fs2 = (await import("fs-extra")).default;
    const { mesmaSuperficieEmpacotada } = await import("../src/lib/host/release-chain.js");
    const { lab, g } = await laboratorio(async (g2, dir) => {
      await fs2.ensureDir(path.join(dir, "src"));
      await fs2.writeFile(path.join(dir, "src", "x.ts"), "export const x = 1;\n");
      g2("add", "-A");
      g2("commit", "-q", "-m", "A");
      await fs2.writeFile(path.join(dir, "src", "x.ts"), "export const x = 2;\n");
      g2("add", "-A");
      g2("commit", "-q", "-m", "B");
    });
    try {
      const [b, a] = g("log", "-2", "--format=%h").split("\n");
      expect(
        await mesmaSuperficieEmpacotada(lab, a ?? "", b ?? ""),
        "drift real passando como mesma superfície"
      ).toBe(false);
    } finally {
      await fs2.remove(lab);
    }
  });

  it("commit desconhecido não vira 'igual' — não sabido nunca é igual", async () => {
    const { mesmaSuperficieEmpacotada } = await import("../src/lib/host/release-chain.js");
    expect(await mesmaSuperficieEmpacotada(path.resolve(__dirname, ".."), "0000000", "1111111")).toBe(false);
  });
});

describe("inspectReleaseChain usa a comparação por superfície — prova comportamental", () => {
  it("commit só de .nexos depois do build não quebra o elo BUILD", async () => {
    const fs2 = (await import("fs-extra")).default;
    const os2 = await import("node:os");
    const { inspectReleaseChain } = await import("../src/lib/host/release-chain.js");

    const lab = await fs2.mkdtemp(path.join(fs2.realpathSync(os2.tmpdir()), "rc-wiring-"));
    try {
      const g = (...args: string[]): string =>
        execFileSync("git", ["-C", lab, ...args], { encoding: "utf-8" }).trim();
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      await fs2.writeJson(path.join(lab, "package.json"), { name: "nexos-cli" });

      await fs2.ensureDir(path.join(lab, "src"));
      await fs2.writeFile(path.join(lab, "src", "x.ts"), "export const x = 1;\n");
      g("add", "-A");
      g("commit", "-q", "-m", "A: superfície empacotada");
      const commitA = g("rev-parse", "HEAD");

      await fs2.ensureDir(path.join(lab, ".nexos", "records"));
      await fs2.writeFile(path.join(lab, ".nexos", "records", "y.yaml"), "id: y\n");
      g("add", "-A");
      g("commit", "-q", "-m", "B: só Store");
      const commitB = g("rev-parse", "HEAD");

      expect(commitA, "os dois commits precisam ser distintos para o caso existir").not.toBe(commitB);

      /** O build saiu de A; o HEAD já é B. */
      await fs2.ensureDir(path.join(lab, "dist"));
      await fs2.writeJson(path.join(lab, "dist", "build-info.json"), { commit: commitA });

      const chain = await inspectReleaseChain(lab);
      const build = chain.find((l) => l.elo === "BUILD");

      expect(build?.valor).toBe(commitA.slice(0, 8));
      expect(
        build?.bateComSource,
        "BUILD acusou drift, mas entre A e B só mudou .nexos — nada que chegue ao runtime"
      ).toBe(true);
    } finally {
      await fs2.remove(lab);
    }
  });

  it("commit que toca src/ depois do build QUEBRA o elo — o detector não ficou cego", async () => {
    const fs2 = (await import("fs-extra")).default;
    const os2 = await import("node:os");
    const { inspectReleaseChain } = await import("../src/lib/host/release-chain.js");

    const lab = await fs2.mkdtemp(path.join(fs2.realpathSync(os2.tmpdir()), "rc-drift-"));
    try {
      const g = (...args: string[]): string =>
        execFileSync("git", ["-C", lab, ...args], { encoding: "utf-8" }).trim();
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      await fs2.writeJson(path.join(lab, "package.json"), { name: "nexos-cli" });

      await fs2.ensureDir(path.join(lab, "src"));
      await fs2.writeFile(path.join(lab, "src", "x.ts"), "export const x = 1;\n");
      g("add", "-A");
      g("commit", "-q", "-m", "A");
      const commitA = g("rev-parse", "HEAD");

      await fs2.writeFile(path.join(lab, "src", "x.ts"), "export const x = 2;\n");
      g("add", "-A");
      g("commit", "-q", "-m", "B: mexe em src");

      await fs2.ensureDir(path.join(lab, "dist"));
      await fs2.writeJson(path.join(lab, "dist", "build-info.json"), { commit: commitA });

      const chain = await inspectReleaseChain(lab);
      expect(
        chain.find((l) => l.elo === "BUILD")?.bateComSource,
        "src/ mudou depois do build e o elo não quebrou — drift real passando"
      ).toBe(false);
    } finally {
      await fs2.remove(lab);
    }
  });
});

/**
 * PROJETO DO USUÁRIO != FONTE DO RUNTIME. MEDIDO 2026-09-23 em `~/Fintech`:
 * `RUNTIME e02c8af1 ✗` — commit do runtime contra o HEAD de um histórico sem
 * relação. Fora do repositório do NexOS não há SOURCE, e nada pode acusar quebra.
 */
describe("inspectReleaseChain fora do repositório do NexOS", () => {
  it("SOURCE e BUILD ficam null e nenhum elo quebra, mesmo com HEAD e dist próprios", async () => {
    const fs2 = (await import("fs-extra")).default;
    const os2 = await import("node:os");
    const { inspectReleaseChain } = await import("../src/lib/host/release-chain.js");
    const lab = await fs2.mkdtemp(path.join(fs2.realpathSync(os2.tmpdir()), "rc-alheio-"));
    try {
      const g = (...args: string[]): string =>
        execFileSync("git", ["-C", lab, ...args], { encoding: "utf-8" }).trim();
      g("init", "-q");
      g("config", "user.email", "t@t");
      g("config", "user.name", "t");
      await fs2.writeJson(path.join(lab, "package.json"), { name: "app-do-usuario" });
      g("add", "-A");
      g("commit", "-q", "-m", "A");
      await fs2.ensureDir(path.join(lab, "dist"));
      await fs2.writeJson(path.join(lab, "dist", "build-info.json"), { commit: "0000000000" });

      const chain = await inspectReleaseChain(lab);
      expect(chain.find((l) => l.elo === "SOURCE")?.valor).toBeNull();
      expect(chain.find((l) => l.elo === "BUILD")?.valor).toBeNull();
      expect(chain.find((l) => l.elo === "RUNTIME")?.bateComSource).toBeNull();
      expect(elosQuebrados(chain).filter((l) => l.elo !== "ASSETS")).toEqual([]);
    } finally {
      await fs2.remove(lab);
    }
  });
});
