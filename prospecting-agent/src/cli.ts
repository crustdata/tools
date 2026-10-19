/** Commands: find | watch-example */

import { fmtCredits, spend } from "./crustdata.js";
import { runFind } from "./find.js";
import { runWatchExample } from "../examples/watch-accounts.js";

const HELP = 'Commands:\n  npm run find -- --icp "..."   accounts.csv and people.csv for your ICP\n  npm run watch-example         the Crustdata watcher request for that shortlist (sends nothing)';
const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "find": return runFind(args);
    case "watch-example": return runWatchExample(args);
    case undefined: case "help": case "--help":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${command}".\n${HELP}`);
      process.exitCode = 1;
  }
}

main()
  .then(() => { if (spend.credits > 0 && command !== "find") console.log(`credits used: ${fmtCredits(spend.credits)}`); })
  .catch(err => { console.error(err instanceof Error ? err.message : err); process.exit(1); });
