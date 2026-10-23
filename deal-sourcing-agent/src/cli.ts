/** Commands: setup | source | memo | replay. Every failure ends in a plain next step, never a stack trace. */

import { CrustdataError, fmtCredits, spend } from "./crustdata.js";

const HELP = `Commands:
  npm run setup                                   save your Crustdata key (and an optional AI key) in .env, checked live
  npm run source -- --thesis "..."                scored pipeline, founders and a memo per company in out/
  npm run memo -- <domain>                        re-render one memo from saved data (free); --ai adds the analysis
  npm run replay -- fixtures/<case>.json          the whole pipeline on a saved sample, offline, no key`;

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "setup": return (await import("./setup.js")).runSetup();
    case "source":
      if (args.includes("--help") || args.includes("-h")) {
        const { FLAGS, SWITCHES, USAGE } = await import("./thesis.js");
        console.log(`${USAGE}\nFlags: ${[...Object.keys(FLAGS), "out", ...SWITCHES].map(f => "--" + f).join(" ")}\nEach flag is explained in the README (Reference, Flags).`);
        return;
      }
      return (await import("./source.js")).runSource(args);
    case "memo": return (await import("./commands.js")).runMemo(args);
    case "replay": return (await import("./commands.js")).runReplay(args);
    case undefined: case "help": case "--help": case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${command}".\n${HELP}`);
      process.exitCode = 1;
  }
}

/** What to do next, for the errors people actually hit. */
export function explain(err: unknown): string {
  if (err instanceof CrustdataError) {
    if (err.status === 401) return "Crustdata did not accept your API key (401). Run npm run setup, or check CRUSTDATA_API_KEY in .env.";
    if (err.outOfCredits) return "Your Crustdata account is out of credits. Add credits at https://app.crustdata.com and run the same command again: the steps already paid for were saved and are not run again.";
    if (err.status === 403) return `Your Crustdata plan does not include this (${err.path || "403"}): ${err.message}. Ask Crustdata to enable it.`;
    if (err.status === 429) return "Crustdata rate limit (429) even after waiting. Wait a minute and run again.";
    if (err.status === 0 || err.status >= 500) return `${err.message}. Check your connection or wait a minute, then run the same command again: everything already paid for was saved and is not paid again.`;
  }
  return err instanceof Error ? err.message : String(err);
}

main()
  .then(() => { if (spend.credits > 0 && command !== "source") console.log(`credits used: ${fmtCredits(spend.credits)}`); })
  .catch(err => {
    console.error(explain(err));
    if (spend.credits > 0) console.error(`credits used before the error: ${fmtCredits(spend.credits)}`);
    process.exit(1);
  });
