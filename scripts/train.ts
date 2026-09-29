import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import dotenv from "dotenv";
import { controlConnection } from "../packages/runtime/src/settings.js";
const root = fileURLToPath(new URL("../", import.meta.url));
dotenv.config({ path: resolve(root, ".env"), quiet: true });
const stage = process.argv[2] ?? "movement";
const mode = process.argv.includes("--simulator") ? "simulator" : "minecraft";
const component = process.argv.includes("--environment")
  ? "environment"
  : process.argv.includes("--evaluation")
    ? "evaluation"
    : "pipeline";
const body = {
  stage,
  mode,
  component,
  agents: Number(process.env.AGENTS ?? 4),
  episodes: Number(process.env.EPISODES ?? 10),
  ticksPerEpisode: Number(process.env.TICKS ?? 100),
  tickMs: Number(process.env.TICK_MS ?? 100),
  seed: Number(process.env.SEED ?? 42),
};
try {
  const { origin, token } = controlConnection(process.env, root);
  const response = await fetch(`${origin}/runs`, {
    method: "POST",
    headers: {
      authorization: `Bearer ${token}`,
      "content-type": "application/json",
    },
    body: JSON.stringify(body),
    redirect: "error",
    signal: AbortSignal.timeout(15000),
  });
  const run = await response.json();
  if (!response.ok) throw new Error(run.error);
  console.log(JSON.stringify(run, null, 2));
} catch (err) {
  console.error(
    `Could not submit run: ${(err as Error).message}. Start the control service first.`,
  );
  process.exitCode = 1;
}
