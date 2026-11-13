/** Whether a file is the program being run, or a module imported by another file (a script, a test runner). */

import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";

export function isEntryPoint(metaUrl: string, argv1 = process.argv[1]): boolean {
  if (!argv1) return false;
  try { return metaUrl === pathToFileURL(realpathSync(argv1)).href; } catch { return false; }
}
