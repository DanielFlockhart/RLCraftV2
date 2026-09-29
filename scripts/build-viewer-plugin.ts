import { spawnSync } from "node:child_process";
import { mkdirSync, readdirSync, copyFileSync, existsSync } from "node:fs";
import { resolve, join, delimiter } from "node:path";
import { fileURLToPath } from "node:url";
import { config, root } from "../apps/control/src/config.js";
import { writeFile } from "node:fs/promises";
import { createHash } from "node:crypto";

function run(executable: string, args: string[], cwd: string) {
  const result = spawnSync(executable, args, {
    cwd,
    stdio: "inherit",
    windowsHide: true,
  });
  if (result.error)
    throw new Error(
      `Cannot run ${executable}. A JDK 17 or newer is needed to build the viewer plugin. Set JAVAC_PATH/JAR_PATH if needed. ${result.error.message}`,
    );
  if (result.status !== 0)
    throw new Error(`${executable} exited with code ${result.status}`);
}
function files(directory: string): string[] {
  return readdirSync(directory, { withFileTypes: true }).flatMap((entry) =>
    entry.isDirectory()
      ? files(join(directory, entry.name))
      : [join(directory, entry.name)],
  );
}
export async function buildViewerPlugin() {
  const serverJar = resolve(config.serverDir, "server.jar");
  if (!existsSync(serverJar))
    throw new Error("Prepare the Minecraft server jar first.");
  const buildDir = resolve(root, "runtime/viewer-plugin-build");
  const deps = resolve(buildDir, "dependencies");
  const classes = resolve(buildDir, "classes");
  mkdirSync(deps, { recursive: true });
  mkdirSync(classes, { recursive: true });
  const jar = process.env.JAR_PATH ?? "jar";
  const javac = process.env.JAVAC_PATH ?? "javac";
  // Compile against the exact API and dependencies bundled by this Paper build.
  run(jar, ["xf", serverJar, "META-INF/libraries"], deps);
  const annotations = resolve(deps, "annotations-24.1.0.jar");
  if (!existsSync(annotations)) {
    const url =
      "https://repo.maven.apache.org/maven2/org/jetbrains/annotations/24.1.0/annotations-24.1.0.jar";
    const [artifact, checksum] = await Promise.all([
      fetch(url),
      fetch(url + ".sha1"),
    ]);
    if (!artifact.ok || !checksum.ok)
      throw new Error(
        "Could not download the compile-time JetBrains annotations dependency.",
      );
    const bytes = Buffer.from(await artifact.arrayBuffer());
    if (
      createHash("sha1").update(bytes).digest("hex") !==
      (await checksum.text()).trim()
    )
      throw new Error("Annotations jar checksum mismatch.");
    await writeFile(annotations, bytes);
  }
  const guava = resolve(deps, "guava-31.0.1-jre.jar");
  if (!existsSync(guava)) {
    const installed = resolve(
      config.serverDir,
      "libraries/com/google/guava/guava/31.0.1-jre/guava-31.0.1-jre.jar",
    );
    if (existsSync(installed)) copyFileSync(installed, guava);
    else {
      const url =
        "https://repo.maven.apache.org/maven2/com/google/guava/guava/31.0.1-jre/guava-31.0.1-jre.jar";
      const [artifact, checksum] = await Promise.all([
        fetch(url),
        fetch(url + ".sha1"),
      ]);
      if (!artifact.ok || !checksum.ok)
        throw new Error(
          "Could not download the compile-time Guava dependency.",
        );
      const bytes = Buffer.from(await artifact.arrayBuffer());
      if (
        createHash("sha1").update(bytes).digest("hex") !==
        (await checksum.text()).trim()
      )
        throw new Error("Guava jar checksum mismatch.");
      await writeFile(guava, bytes);
    }
  }
  const libraries = files(deps).filter((path) => path.endsWith(".jar"));
  if (!libraries.some((path) => path.includes("paper-api")))
    throw new Error(
      "This server jar does not bundle a Paper API. Viewer Guard currently targets Paper 1.18.1.",
    );
  const source = resolve(root, "plugins/viewer-guard/src");
  run(
    javac,
    [
      "--release",
      "17",
      "-encoding",
      "UTF-8",
      "-classpath",
      libraries.join(delimiter),
      "-d",
      classes,
      ...files(source).filter((path) => path.endsWith(".java")),
    ],
    root,
  );
  for (const name of ["plugin.yml", "config.yml"])
    copyFileSync(
      resolve(root, "plugins/viewer-guard/resources", name),
      resolve(classes, name),
    );
  const pluginDir = resolve(config.serverDir, "plugins");
  mkdirSync(pluginDir, { recursive: true });
  const output = resolve(buildDir, "RLCraftViewerGuard.jar");
  run(jar, ["--create", "--file", output, "-C", classes, "."], root);
  copyFileSync(output, resolve(pluginDir, "RLCraftViewerGuard.jar"));
  console.log(
    "Installed RLCraftViewerGuard. Restart Minecraft to load it; ChilledVibe becomes a protected admin spectator.",
  );
  return output;
}
if (
  process.argv[1] &&
  resolve(process.argv[1]) === fileURLToPath(import.meta.url)
)
  await buildViewerPlugin();
