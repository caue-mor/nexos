// H3 (rodada 2) — entrypoint real, rodado como processo de verdade sob
// `nexos-budget.sh` real. Ver `tests/hook-budget-h3.test.ts`.
import { claudeUserPromptSubmit } from "../../src/host/claude/user-prompt-submit.js";

await claudeUserPromptSubmit();
