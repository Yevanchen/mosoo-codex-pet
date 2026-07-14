import { rm } from "node:fs/promises";
import { resolve } from "node:path";

const appRoot = resolve(import.meta.dir, "..");
const source = resolve(appRoot, "skill/hatch-pet-mosoo");
const output = resolve(appRoot, "hatch-pet-mosoo.skill");

await rm(output, { force: true });
await rm(resolve(source, "scripts/__pycache__"), { force: true, recursive: true });
const process = Bun.spawn(["zip", "-qr", output, "."], {
  cwd: source,
  stderr: "inherit",
  stdout: "inherit",
});
const exitCode = await process.exited;
if (exitCode !== 0) throw new Error(`zip exited with code ${exitCode}`);
console.log(output);
