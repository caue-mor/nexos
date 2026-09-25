// H3 (rodada 2) — entrypoint real, rodado como processo de verdade sob
// `nexos-budget.sh` real. Ver `tests/hook-budget-h3.test.ts`.
import { claudeMemoryRecall } from "../../src/host/claude/memory-recall.js";

await claudeMemoryRecall();
