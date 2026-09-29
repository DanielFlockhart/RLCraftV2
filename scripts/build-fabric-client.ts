import { resolve } from "node:path";
import { fileURLToPath } from "node:url";
import { config, root } from "../apps/control/src/config.js";
import { fabricRoot } from "../packages/runtime/src/fabric.js";
import { fabricToolchain, run } from "./fabric-toolchain.js";

export async function buildFabricClient(
  directory = fabricRoot(config.dataDir),
) {
  const tools = await fabricToolchain(directory);
  await run(
    tools.java,
    [
      "-classpath",
      resolve(tools.gradleDir, "lib/gradle-launcher-8.7.jar"),
      "org.gradle.launcher.GradleMain",
      "--no-daemon",
      "--max-workers=2",
      "-g",
      resolve(directory, "gradle-cache"),
      "-p",
      resolve(root, "clients/fabric-agent"),
      `-PrlcraftBuildDir=${resolve(directory, "build")}`,
      "build",
    ],
    root,
    { JAVA_HOME: tools.javaHome },
  );
  return {
    ...tools,
    jar: resolve(directory, "build/libs/rlcraft-fabric-agent-0.1.0.jar"),
  };
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildFabricClient();
