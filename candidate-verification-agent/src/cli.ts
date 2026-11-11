/** Commands: verify | test-slack | forget | purge. Setup and replay have their own entry points. */

import "./node-check.js";
import { runForget, runPurge } from "./forget.js";
import { runTestSlack, runVerify } from "./verify.js";

const HELP = `Commands:
  npm run setup                               check your Crustdata key and what it can use, write .env
  npm run verify -- candidates.csv --dry-run  what would be checked and what it costs; spends nothing
  npm run verify -- candidates.csv            check everyone; writes out/<list>/verified.csv and report.md
  npm run verify -- candidates.csv --quick    the 1-credit quick screen only
  npm run test-slack                          send a test message to your Slack webhook
  npm run forget -- <profile URL or email>    remove one person from every output file
  npm run purge -- --older-than 90            delete lists and results older than 90 days
  npm run replay -- fixtures/mixed-list.json  a whole run offline, from saved responses
All options: npm run verify -- --help`;

const [command, ...args] = process.argv.slice(2);

async function main() {
  switch (command) {
    case "verify": return runVerify(args);
    case "test-slack": return runTestSlack();
    case "forget": return runForget(args);
    case "purge": return runPurge(args);
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
