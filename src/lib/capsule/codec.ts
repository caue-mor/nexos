/**
 * C2.2.5a — codec canônico.
 *
 * ADR-045: CANONICAL SERIALIZATION IS A STORE RESPONSIBILITY.
 * O producer NÃO controla os bytes. Duas entradas logicamente equivalentes, com
 * formatação ou ordem de chaves diferentes, produzem bytes IDÊNTICOS.
 *
 * Sem isso, dois writers geram diff espúrio no mesmo conteúdo e a mergeability
 * morre — que é o motivo de record-per-file existir.
 */
import { parse, stringify } from "yaml";

/** Opções que tornam a saída determinística. Nenhuma é negociável pelo producer. */
const CANONICAL_STRINGIFY = {
  version: "1.2" as const,
  sortMapEntries: true,
  /** 0 = sem quebra automática; largura de linha não pode depender do conteúdo. */
  lineWidth: 0,
  indent: 2,
  /** Sem anchors/aliases: um mesmo objeto referenciado 2× vira 2 nós literais. */
  aliasDuplicateObjects: false,
  /** Aspas duplas sempre que preciso citar — uma política, não duas. */
  singleQuote: false,
  nullStr: "null",
};

const CANONICAL_PARSE = {
  version: "1.2" as const,
  /** Rejeita chave duplicada em vez de silenciosamente manter a última. */
  uniqueKeys: true,
};

export class CanonicalCodecError extends Error {
  constructor(message: string, readonly cause?: unknown) {
    super(message);
    this.name = "CanonicalCodecError";
  }
}

/**
 * Serializa na forma canônica. Sempre termina com exatamente um `\n`.
 * Line endings são LF — nunca CRLF, mesmo em Windows: o arquivo é conteúdo
 * versionado, não texto de plataforma.
 */
export function serializeCanonical(value: unknown): string {
  let out: string;
  try {
    out = stringify(value, CANONICAL_STRINGIFY);
  } catch (error) {
    throw new CanonicalCodecError("falha ao serializar em YAML canônico", error);
  }
  return normalizeTrailingNewline(out.replace(/\r\n/g, "\n"));
}

export function parseCanonical(text: string): unknown {
  try {
    return parse(text, CANONICAL_PARSE);
  } catch (error) {
    const reason = error instanceof Error ? error.message : "erro desconhecido";
    throw new CanonicalCodecError(`YAML inválido: ${reason}`, error);
  }
}

function normalizeTrailingNewline(text: string): string {
  return `${text.replace(/\n+$/, "")}\n`;
}

/**
 * Prova de idempotência do codec: serializar o que já é canônico não muda nada.
 * Usado pelos testes e pela verificação de integridade estrutural.
 *
 * `options.parsed` — 03e (perf de `scanIntegrity`, medido no checkpoint
 * `chk_01M2EE9N5EEET94B5PFPHBGTDN`): `loadCanonicalRecord` já chama
 * `parseCanonical(raw)` para validar o schema ANTES de checar a forma
 * canônica — sem este parâmetro, `isCanonicalForm` reparseava o MESMO texto
 * de novo, um segundo custo de parse por arquivo pago em toda leitura de
 * capsule (CPU profile: 691ms dos 1182ms de `loadCanonicalRecord`, em 1434
 * arquivos). A presença de `options` (não o VALOR de `options.parsed`) é o
 * sinal de "já parseado" — nunca `undefined` como segundo argumento
 * ambíguo entre "não tenho o valor" e "o valor parseado é `undefined`"
 * (documento YAML vazio parseia para `undefined` e é uma forma válida de
 * chamar isto sem reparsear). Chamadores que só têm o texto (`presence/
 * prompt.ts`, `presence/verify.ts`) continuam chamando com um argumento só —
 * comportamento e assinatura idênticos para eles.
 */
export function isCanonicalForm(text: string, options?: { readonly parsed: unknown }): boolean {
  try {
    const value = options ? options.parsed : parseCanonical(text);
    return serializeCanonical(value) === text;
  } catch {
    return false;
  }
}
