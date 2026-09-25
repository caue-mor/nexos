export const SECRET_PATTERNS: ReadonlyArray<{ readonly name: string; readonly pattern: RegExp }>;
export function redact(text: string): string;
export const REDACTION_KILL_SWITCH_ENV: string;
export const REDACTION_KILL_SWITCH_TOKEN: string;
export const KNOWN_PLACEHOLDERS: ReadonlyArray<string>;
export function isKnownPlaceholder(value: string): boolean;
