import { spawn, type ChildProcess } from "node:child_process";
import { fileURLToPath } from "node:url";
import type { Run } from "@rlcraft/core";
import { config, root } from "./config.js";

/** Current execution boundary: workers remain colocated with the control runtime. */
export interface RunExecutor {
  launch(run: Run): ChildProcess;
}

export class LocalProcessExecutor implements RunExecutor {
  launch(run: Run) {
    return spawn(
      process.execPath,
      [
        "--import",
        "tsx",
        fileURLToPath(new URL("./worker.ts", import.meta.url)),
      ],
      {
        cwd: root,
        env: {
          ...process.env,
          DATA_DIR: config.dataDir,
          ARTIFACT_DIR: config.artifactDir,
          SERVER_DIR: config.serverDir,
          RUN_PAYLOAD: JSON.stringify(run),
        },
        stdio: ["ignore", "pipe", "pipe", "ipc"],
        windowsHide: true,
      },
    );
  }
}
