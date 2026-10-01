import { fileURLToPath } from "node:url";
import { resolve } from "node:path";
import { mkdirSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { randomBytes } from "node:crypto";
import dotenv from "dotenv";
import { z } from "zod";
import {
  explicitToken,
  isLoopback,
  storagePaths,
} from "../../../packages/runtime/src/settings.js";
export const root = fileURLToPath(new URL("../../../", import.meta.url));
dotenv.config({ path: resolve(root, ".env"), quiet: true });
const env = z
  .object({
    CONTROL_HOST: z.string().min(1).default("127.0.0.1"),
    CONTROL_PORT: z.coerce.number().int().min(1024).max(65535).default(4100),
    MAX_CONCURRENT_RUNS: z.coerce.number().int().min(1).max(8).default(2),
    MAX_AGENTS: z.coerce.number().int().min(1).max(128).default(64),
    MAX_RENDER_CLIENTS: z.coerce.number().int().min(1).max(128).default(2),
    MC_HOST: z.string().default("127.0.0.1"),
    MC_BIND_HOST: z.string().default("127.0.0.1"),
    MC_PORT: z.coerce.number().int().min(1).max(65535).default(25565),
    MC_MAX_PLAYERS: z.coerce.number().int().min(100).max(100000).default(100),
    MC_VERSION: z.string().default("1.18.1"),
    MC_AUTH: z.enum(["offline", "microsoft"]).default("offline"),
    MC_AGENT_BACKEND: z
      .string()
      .regex(/^[a-z][a-z0-9_-]{0,63}$/)
      .default("mineflayer"),
    AGENT_BACKENDS_FILE: z.string().min(1).optional(),
    ARCHIVE_PROVIDER: z.enum(["local", "firebase"]).default("local"),
    FIREBASE_PROJECT_ID: z
      .string()
      .regex(/^[a-z][a-z0-9-]{4,61}[a-z0-9]$/)
      .optional(),
    FIREBASE_STORAGE_BUCKET: z
      .string()
      .regex(/^[a-z0-9][a-z0-9._-]+[a-z0-9]$/)
      .optional(),
    FIREBASE_ARCHIVE_PREFIX: z
      .string()
      .regex(/^[A-Za-z][A-Za-z0-9_-]{0,63}$/)
      .default("rlcraftRuntimes"),
    JAVA_PATH: z.string().default("java"),
    PYTHON_PATH: z
      .string()
      .min(1)
      .default(process.platform === "win32" ? "python" : "python3"),
    MC_MIN_MEMORY: z
      .string()
      .regex(/^\d+[MG]$/i)
      .default("1G"),
    MC_MAX_MEMORY: z
      .string()
      .regex(/^\d+[MG]$/i)
      .default("4G"),
  })
  .parse(process.env);
export const config = {
  ...env,
  ...storagePaths(process.env, root),
};
if (
  config.ARCHIVE_PROVIDER === "firebase" &&
  (!config.FIREBASE_PROJECT_ID || !config.FIREBASE_STORAGE_BUCKET)
)
  throw new Error(
    "Firebase archiving requires FIREBASE_PROJECT_ID and FIREBASE_STORAGE_BUCKET. Keep ARCHIVE_PROVIDER=local until configured.",
  );
const suppliedToken = explicitToken(process.env);
if (!isLoopback(config.CONTROL_HOST) && !suppliedToken)
  throw new Error(
    "A non-loopback CONTROL_HOST requires CONTROL_TOKEN or CONTROL_TOKEN_FILE",
  );
mkdirSync(config.dataDir, { recursive: true });
const tokenPath = resolve(config.dataDir, "control-token");
if (!suppliedToken && !existsSync(tokenPath))
  writeFileSync(tokenPath, randomBytes(32).toString("hex"), { mode: 0o600 });
export const token = suppliedToken ?? readFileSync(tokenPath, "utf8").trim();
if (token.length < 32 || /\s/.test(token))
  throw new Error("Invalid control token");
