/**
 * Example AskUserHandler using Node readline.
 * Wire it via: new Agent({ provider, model, askUser })
 */

import readline from "node:readline/promises";
import type { AskUserHandler } from "@skawld/agent-sdk/tools";

export const askUser: AskUserHandler = async (req, signal) => {
  const rl = readline.createInterface({ input: process.stdin, output: process.stdout });
  signal.addEventListener("abort", () => rl.close(), { once: true });
  try {
    const answers: Array<{ selected: string[] }> = [];
    for (const q of req.questions) {
      console.log(`\n[${q.header}] ${q.question}`);
      q.options.forEach((o, i) =>
        console.log(`  ${i + 1}. ${o.label}${o.description ? ` — ${o.description}` : ""}`));
      const raw = await rl.question("Pick number(s) or type an answer (empty to decline all): ");
      if (raw.trim() === "") return { declined: true };
      const picks = raw.split(",").map(s => s.trim()).map(s => {
        const n = Number(s);
        return Number.isInteger(n) && q.options[n - 1] ? q.options[n - 1]!.label : s;
      });
      answers.push({ selected: q.multi_select ? picks : [picks[0]!] });
    }
    return { answers };
  } finally {
    rl.close();
  }
};
