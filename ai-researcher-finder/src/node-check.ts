/** Imported first by every entry point: a clear message instead of a cryptic crash on old Node versions. */
const [major, minor] = process.versions.node.split(".").map(Number);
if (major < 22 || (major === 22 && minor < 13)) {
  console.error(`This tool needs Node 22.13 or newer (you have ${process.versions.node}). Download it from https://nodejs.org`);
  process.exit(1);
}
export {};
