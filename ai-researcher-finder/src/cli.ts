/** Commands: find | map | rescore | watch-example | forget. Setup and replay have their own entry points. */

import "./node-check.js";
import { runWatchExample } from "../examples/watch-people.js";
import { runFind, runRescore } from "./find.js";
import { runForget } from "./forget.js";

const HELP = `Commands:
  npm run setup                                       check your Crustdata key and what it can use, write .env
  npm run find -- --labs frontier --dry-run           the plan and the most it can cost; spends nothing
  npm run find -- --role "..." --labs frontier        find, score and team-map AI researchers and ML engineers
  npm run find -- --from seeds.csv                    start from Scholar, GitHub or profile URLs and paper titles
  npm run map -- --lab anthropic.com                  every research and ML person at one lab, by team
  npm run rescore                                     score again after changing rubric.json or config/teams.json, free
  npm run watch-example -- --email you@example.com    the Crustdata watcher request for job moves (sends nothing)
  npm run forget -- <person id or profile URL>        remove a person from every folder; later runs skip them
  npm run replay -- fixtures/example-labs.json        the whole run offline, from saved responses
All flags: npm run find -- --help`;

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "find": return runFind(args, "find");
    case "map": return runFind(args, "map");
    case "rescore": return runRescore(args);
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
