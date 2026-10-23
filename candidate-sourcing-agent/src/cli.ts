/** Commands: source | rescore | contacts | watch-example | forget. Setup and replay have their own entry points. */

import "./node-check.js";
import { runWatchExample } from "../examples/watch-role.js";
import { runContacts } from "./contacts.js";
import { runForget } from "./forget.js";
import { runRescore, runSource } from "./source.js";

const HELP = `Commands:
  npm run setup                                   check your Crustdata key and what it can use, write .env
  npm run source -- --role "..." --dry-run        what it understood and the cost; spends nothing
  npm run source -- --role "..."                  a ranked shortlist for the role; run again for the next batch
  npm run rescore                                 score the saved candidates again (after changing src/score.ts), free
  npm run contacts -- --top 25                    personal emails for the top 25 (needs contact access)
  npm run watch-example -- --slack <webhook URL>  the Crustdata watcher request for new matches every week (sends nothing)
  npm run forget -- <profile URL>                 remove one person from every role's files
  npm run replay -- fixtures/ml-engineer.json     the whole run offline, from saved responses
All flags: npm run source -- --help`;

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "source": return runSource(args);
    case "rescore": return runRescore(args);
    case "contacts": return runContacts(args);
    case "watch-example": return runWatchExample(args);
    case "forget": return runForget(args);
    case undefined: case "help": case "--help": case "-h":
      console.log(HELP);
      return;
    default:
      console.error(`Unknown command "${command}".\n${HELP}`);
      process.exitCode = 1;
  }
}

main().catch(err => {
  console.error(err instanceof Error ? err.message : String(err));
  process.exit(1);
});
