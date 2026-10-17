// `npm test`: start the harness server once, run each test/*.test.mjs (one
// process per file, one file at a time) against it, then drop the test
// database. `npm test -- 07` runs only the files whose name contains "07".
import { run } from "node:test";
import { spec } from "node:test/reporters";
import { finished } from "node:stream/promises";
import fs from "node:fs";
import path from "node:path";
import { start, stop } from "./harness.mjs";

const dir = import.meta.dirname;
const only = process.argv[2];
const files = fs
  .readdirSync(dir)
  .filter((f) => f.endsWith(".test.mjs") && (!only || f.includes(only)))
  .map((f) => path.join(dir, f));

await start();
let failed = false;
try {
  const stream = run({ files, concurrency: 1 });
  stream.on("test:fail", () => (failed = true));
  const report = stream.compose(spec);
  report.pipe(process.stdout);
  await finished(report);
} finally {
  await stop();
}
process.exit(failed ? 1 : 0);
