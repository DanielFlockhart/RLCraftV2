import { spawn } from "node:child_process";
import { createRequire } from "node:module";
import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
const root = fileURLToPath(new URL("../", import.meta.url));
dotenv.config({ path: resolve(root, ".env"), quiet: true });
const port = Number(process.env.DASHBOARD_PORT ?? 3000);
if (!Number.isInteger(port) || port < 1024 || port > 65535)
  throw new Error("DASHBOARD_PORT must be 1024–65535");
const require = createRequire(resolve(root, "apps/dashboard/package.json"));
const child = spawn(
  process.execPath,
  [
    require.resolve("next/dist/bin/next"),
    process.argv[2] === "start" ? "start" : "dev",
    "--hostname",
    process.env.DASHBOARD_HOST ?? "127.0.0.1",
    "--port",
    String(port),
  ],
  { cwd: resolve(root, "apps/dashboard"), stdio: "inherit", windowsHide: true },
);
process.on("SIGINT", () => child.kill("SIGINT"));
process.on("SIGTERM", () => child.kill("SIGTERM"));
child.on("error", (err) => {
  console.error(err.message);
  process.exitCode = 1;
});
child.on("exit", (code) => {
  process.exitCode = code ?? 0;
});
