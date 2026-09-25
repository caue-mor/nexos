import pc from "picocolors";

/**
 * P1.3i — `showWelcome`/`showNextSteps`/`LOGO`/`SEPARATOR` removidos: o
 * banner e o "next steps" antigos pertenciam ao wizard interativo do
 * instalador (Greenfield/Brownfield, stack preset), que não existe mais
 * (nexos://decision/p1-3i-install-environment-boundary). `TAGLINE` continua
 * porque `tests/install-surface-contract.test.ts` a lê como fonte de
 * verdade da descrição de produto exibida ao usuário.
 */
export const TAGLINE = pc.dim("  Project Intelligence OS — durable project memory for Claude Code");
