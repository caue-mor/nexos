/**
 * `nexos info --json` — envelope de identidade do build.
 *
 * `buildInfoPath` é um seam só de teste (ver `InfoOptions`): aponta o
 * comando para um artefato de fixture em vez do `dist/build-info.json` real
 * do pacote, para que a asserção compare contra um valor CONHECIDO e
 * literal — não contra o estado do repo real no momento em que o teste
 * roda.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import fs from "fs-extra";
import os from "node:os";
import path from "node:path";
import { info } from "../src/commands/info.js";
import { VERSION } from "../src/lib/constants.js";

const TMP = fs.realpathSync(os.tmpdir());
let ws: string;

function captureStdout(): { text: () => string; restore: () => void } {
  let out = "";
  const spy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: unknown) => {
    out += typeof chunk === "string" ? chunk : String(chunk);
    return true;
  });
  return { text: () => out, restore: () => spy.mockRestore() };
}

beforeEach(async () => {
  ws = await fs.mkdtemp(path.join(TMP, "info-cmd-"));
});
afterEach(async () => {
  vi.restoreAllMocks();
  await fs.remove(ws);
});

describe("nexos info --json", () => {
  it("emite JSON válido contendo version, commit, buildTime, dirty — valores CONHECIDOS da fixture", async () => {
    const KNOWN_COMMIT = "f9b85561d7eb769f1bc5bf310dbfb92990139f1c";
    const artifact = path.join(ws, "build-info.json");
    await fs.writeJson(artifact, {
      commit: KNOWN_COMMIT,
      commitShort: "f9b8556",
      branch: "main",
      buildTime: "2026-08-20T22:30:12.345Z",
      dirty: false,
      source: "repo",
    });

    const cap = captureStdout();
    await info({ json: true, buildInfoPath: artifact });
    cap.restore();

    const parsed = JSON.parse(cap.text());
    expect(parsed).toEqual({
      version: VERSION,
      commit: KNOWN_COMMIT,
      commitShort: "f9b8556",
      branch: "main",
      buildTime: "2026-08-20T22:30:12.345Z",
      dirty: false,
      source: "repo",
    });
  });

  it("caminho git-indisponível (artefato ausente) produz unknown, nunca lança", async () => {
    const cap = captureStdout();
    await info({ json: true, buildInfoPath: path.join(ws, "nao-existe.json") });
    cap.restore();

    const parsed = JSON.parse(cap.text());
    expect(parsed.commit).toBe("unknown");
    expect(parsed.dirty).toBe(false);
    expect(parsed.version).toBe(VERSION);
  });

  it("modo --json não imprime nada além do JSON (sem decoração @clack/prompts)", async () => {
    const cap = captureStdout();
    await info({ json: true, buildInfoPath: path.join(ws, "nao-existe.json") });
    cap.restore();

    expect(() => JSON.parse(cap.text())).not.toThrow();
  });
});
