import { readFileSync } from "node:fs";
import { resolve } from "node:path";

type Environment = Record<string, string | undefined>;

export function isLoopback(host: string) {
  return ["127.0.0.1", "localhost", "::1", "[::1]"].includes(host);
}

/** Node-only settings. Credentials never belong in NEXT_PUBLIC_* variables. */
export function explicitToken(env: Environment) {
  const value =
    env.CONTROL_TOKEN ??
    (env.CONTROL_TOKEN_FILE
      ? readFileSync(env.CONTROL_TOKEN_FILE, "utf8")
      : undefined);
  if (value === undefined) return undefined;
  const token = value.trim();
  if (token.length < 32 || /\s/.test(token))
    throw new Error(
      "The control token must contain at least 32 non-whitespace characters",
    );
  return token;
}

export function storagePaths(env: Environment, root: string) {
  const dataDir = resolve(root, env.DATA_DIR ?? "data");
  return {
    dataDir,
    serverDir: resolve(root, env.SERVER_DIR ?? "runtime/server"),
    artifactDir: resolve(root, env.ARTIFACT_DIR ?? resolve(dataDir, "runs")),
  };
}

export function controlConnection(env: Environment, root: string) {
  const url = new URL(
    env.CONTROL_URL ?? `http://127.0.0.1:${env.CONTROL_PORT ?? 4100}`,
  );
  if (
    !["http:", "https:"].includes(url.protocol) ||
    url.username ||
    url.password ||
    url.search ||
    url.hash ||
    url.pathname !== "/"
  )
    throw new Error(
      "CONTROL_URL must be an HTTP(S) origin without credentials or a path",
    );
  const local = isLoopback(url.hostname);
  if (
    !local &&
    url.protocol !== "https:" &&
    env.CONTROL_ALLOW_INSECURE_HTTP !== "true"
  )
    throw new Error(
      "Remote CONTROL_URL requires HTTPS; private container networks may explicitly allow HTTP",
    );
  let token = explicitToken(env);
  if (!token && !local)
    throw new Error(
      "Remote control requires CONTROL_TOKEN or CONTROL_TOKEN_FILE",
    );
  token ??= readFileSync(
    resolve(storagePaths(env, root).dataDir, "control-token"),
    "utf8",
  ).trim();
  if (token.length < 32 || /\s/.test(token))
    throw new Error("Invalid control token");
  return { origin: url.origin, token };
}
