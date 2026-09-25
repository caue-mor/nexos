/**
 * SUBPROCESSO SEM TERMINAL CONTROLADOR — o construto que os testes do gate de
 * `nexos memory --promote` afirmam medir.
 *
 *   STDIO EM PIPE != AUSÊNCIA DE TERMINAL CONTROLADOR
 *
 * MEDIDO nesta sessão, mesmo commit e mesmos testes, dois hosts:
 *
 *   Bash tool sandboxada   /dev/tty -> ENXIO    4 arquivos, 55 testes, 6s, verde
 *   terminal do dono       /dev/tty -> abre     `--promote` imprime "[y/N]" e a
 *                                               suíte congela esperando alguém digitar
 *
 * `spawnSync(..., { encoding })` põe stdin/stdout/stderr em pipe e NÃO tira o
 * terminal controlador: quem o define é a SESSÃO, não o stdio. O teste que
 * dependia disso media o host, não o produto — passava sandboxado e travava no
 * terminal, que é a definição de teste não determinístico.
 *
 * O único mecanismo POSIX que tira o terminal controlador sem alocar um pty é
 * `setsid()`: o líder de sessão nasce sem terminal e `open("/dev/tty")` devolve
 * ENXIO. Node expõe isso como `spawn(..., { detached: true })` — MEDIDO aqui:
 * com `detached` o filho lidera o próprio grupo (`kill(-pid, 0)` encontra o
 * grupo); sem `detached`, ESRCH.
 *
 * `provarAusenciaDeTerminalControlador` NÃO confia nessa medição: roda um probe
 * pelo MESMO caminho de spawn e devolve o que o FILHO mediu. Se algum host
 * entregar um terminal apesar do `detached`, o teste falha dizendo isso — e o
 * alarme abaixo garante que ele falhe em vez de congelar.
 *
 *   CONSTRUTO AFIRMADO != CONSTRUTO PROVADO
 */
import { spawn } from "node:child_process";

export interface SaidaSubprocesso {
  readonly status: number | null;
  readonly stdout: string;
  readonly stderr: string;
  /** `stdout + stderr` — é o que as asserções de mensagem leem. */
  readonly saida: string;
}

/**
 * Folga larga para o carregamento do tsx; o que importa é ser FINITO — e ser
 * MENOR que o `testTimeout` do vitest (30_000 em `vitest.config.ts`).
 *
 *   ALARME QUE EMPATA COM O RUNNER != ALARME
 *
 * Empatados, o vitest pode matar o worker primeiro; aí este `setTimeout` morre
 * junto e o filho `detached` fica órfão VIVO — justamente porque `detached` é
 * o que o desacopla do pai. Só aconteceria com o construto quebrado, mas a
 * margem é grátis.
 */
export const LIMITE_SUBPROCESSO_MS = 20_000;

export interface OpcoesSubprocesso {
  readonly cwd: string;
  readonly env: NodeJS.ProcessEnv;
}

/**
 * Roda `node <args>` num processo que NÃO tem terminal controlador. Rejeita, em
 * vez de esperar para sempre, se o processo passar do limite — um prompt preso
 * vira falha com mensagem, nunca uma suíte congelada.
 */
export function spawnSemTerminalControlador(
  args: readonly string[],
  opcoes: OpcoesSubprocesso
): Promise<SaidaSubprocesso> {
  return new Promise<SaidaSubprocesso>((resolve, reject) => {
    const filho = spawn(process.execPath, [...args], {
      cwd: opcoes.cwd,
      env: { ...opcoes.env },
      /** `setsid()`: nova sessão, sem terminal controlador. É o construto. */
      detached: true,
      /** stdin fechado: nem o pipe sugere que existe alguém do outro lado. */
      stdio: ["ignore", "pipe", "pipe"],
    });

    let stdout = "";
    let stderr = "";
    filho.stdout?.on("data", (chunk: Buffer | string) => (stdout += chunk.toString()));
    filho.stderr?.on("data", (chunk: Buffer | string) => (stderr += chunk.toString()));

    const alarme = setTimeout(() => {
      /** Mata o GRUPO: filho preso em `readSync` não morre com o pai. */
      const pid = filho.pid;
      if (pid !== undefined) {
        try {
          process.kill(-pid, "SIGKILL");
        } catch {
          /* já saiu — nada a matar */
        }
      }
      reject(
        new Error(
          `subprocesso passou de ${LIMITE_SUBPROCESSO_MS}ms. Se travou num prompt, o construto ` +
            `"sem terminal controlador" quebrou neste host. Saída até aqui: ${stdout}${stderr}`
        )
      );
    }, LIMITE_SUBPROCESSO_MS);

    filho.on("error", (erro) => {
      clearTimeout(alarme);
      reject(erro);
    });
    filho.on("close", (status) => {
      clearTimeout(alarme);
      resolve({ status, stdout, stderr, saida: `${stdout}${stderr}` });
    });
  });
}

/**
 * `import()` em vez de `require`/`import` estático porque `node -e` não tem
 * modo de módulo garantido entre versões, e `import()` funciona nos dois.
 */
const PROBE_DEV_TTY = [
  'import("node:fs").then((fs) => {',
  '  try { fs.closeSync(fs.openSync("/dev/tty", "r+")); process.stdout.write("COM_TERMINAL"); }',
  '  catch (e) { process.stdout.write("SEM_TERMINAL:" + e.code); }',
  "});",
].join("\n");

/**
 * Mede, pelo MESMO caminho de spawn usado pelos testes, se o filho enxerga um
 * terminal controlador. Devolve `SEM_TERMINAL:<code>` ou `COM_TERMINAL`.
 */
export async function provarAusenciaDeTerminalControlador(cwd: string): Promise<string> {
  const r = await spawnSemTerminalControlador(["-e", PROBE_DEV_TTY], {
    cwd,
    env: { PATH: process.env.PATH ?? "" },
  });
  return r.saida.trim();
}
