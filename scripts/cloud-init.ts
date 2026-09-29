import { mkdir, writeFile, access } from "node:fs/promises";
import { randomBytes } from "node:crypto";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("../", import.meta.url));
const state = resolve(root, "deploy/cloud.state");
for (const name of ["data", "artifacts", "server"])
  await mkdir(resolve(state, name), { recursive: true });
const secret = resolve(state, "control-token");
try {
  await writeFile(secret, randomBytes(32).toString("hex") + "\n", {
    flag: "wx",
    mode: 0o600,
  });
} catch (error) {
  if ((error as NodeJS.ErrnoException).code !== "EEXIST") throw error;
  await access(secret);
}
console.log(
  `Prepared ${state}; existing state and credentials preserved.\nSee docs/cloud.md for container preparation and migration. No services started.`,
);
