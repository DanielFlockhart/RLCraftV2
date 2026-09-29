import { test } from "node:test";
import assert from "node:assert/strict";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { resolve } from "node:path";
import {
  controlConnection,
  explicitToken,
  storagePaths,
} from "../packages/runtime/src/settings.js";

test("remote dashboards use a mounted secret without a shared database or local token", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rlcraft-remote-"));
  try {
    const token = "a".repeat(64);
    const secret = resolve(root, "secret");
    writeFileSync(secret, token + "\n");
    assert.deepEqual(
      controlConnection(
        {
          CONTROL_URL: "https://runtime.example:4100",
          CONTROL_TOKEN_FILE: secret,
        },
        root,
      ),
      { origin: "https://runtime.example:4100", token },
    );
    assert.throws(
      () => controlConnection({ CONTROL_URL: "https://runtime.example" }, root),
      /requires CONTROL_TOKEN/,
    );
    assert.throws(
      () =>
        controlConnection(
          { CONTROL_URL: "http://runtime.example", CONTROL_TOKEN: token },
          root,
        ),
      /requires HTTPS/,
    );
    assert.deepEqual(
      controlConnection(
        {
          CONTROL_URL: "http://control:4100",
          CONTROL_TOKEN: token,
          CONTROL_ALLOW_INSECURE_HTTP: "true",
        },
        root,
      ),
      { origin: "http://control:4100", token },
    );
    for (const url of [
      "https://user:pass@runtime.example",
      "https://runtime.example/path",
      "https://runtime.example?token=secret",
      "file:///tmp/control",
    ]) {
      assert.throws(
        () =>
          controlConnection({ CONTROL_URL: url, CONTROL_TOKEN: token }, root),
        /HTTP\(S\) origin/,
      );
    }
    assert.throws(
      () => explicitToken({ CONTROL_TOKEN: "short" }),
      /at least 32/,
    );
    assert.throws(
      () => explicitToken({ CONTROL_TOKEN: "a".repeat(32) + " b" }),
      /non-whitespace/,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test("local credentials and storage paths do not depend on the launching working directory", () => {
  const root = mkdtempSync(resolve(tmpdir(), "rlcraft-paths-"));
  try {
    const paths = storagePaths({}, root);
    assert.equal(paths.serverDir, resolve(root, "runtime/server"));
    assert.equal(paths.artifactDir, resolve(root, "data/runs"));
    const relocated = storagePaths(
      {
        DATA_DIR: "state",
        ARTIFACT_DIR: "checkpoints",
        SERVER_DIR: "minecraft",
      },
      root,
    );
    assert.equal(relocated.artifactDir, resolve(root, "checkpoints"));
    assert.equal(
      storagePaths({ DATA_DIR: "state" }, root).artifactDir,
      resolve(root, "state/runs"),
    );
    mkdirSync(paths.dataDir, { recursive: true });
    const token = "b".repeat(64);
    writeFileSync(resolve(paths.dataDir, "control-token"), token);
    assert.deepEqual(controlConnection({}, root), {
      origin: "http://127.0.0.1:4100",
      token,
    });
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
