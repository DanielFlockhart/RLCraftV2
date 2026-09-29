import { resolve } from "node:path";
import { mkdir, readdir } from "node:fs/promises";
import { spawn } from "node:child_process";
import {
  exists,
  readJson,
  downloadFile,
  extractZip,
} from "../packages/runtime/src/downloads.js";

export async function fabricToolchain(directory: string) {
  const tools = resolve(directory, "toolchain");
  await mkdir(tools, { recursive: true });
  const javaDir = resolve(tools, "java17");
  let homes = await readdir(javaDir).catch(() => [] as string[]);
  if (!homes.length) {
    const os =
      process.platform === "win32"
        ? "windows"
        : process.platform === "linux"
          ? "linux"
          : "mac";
    const arch = process.arch === "arm64" ? "aarch64" : "x64";
    const releases = await readJson(
      `https://api.adoptium.net/v3/assets/latest/17/hotspot?architecture=${arch}&image_type=jdk&os=${os}&vendor=eclipse`,
    );
    const archive = releases[0]?.binary?.package;
    if (!archive) throw new Error("No Java 17 JDK for this host");
    const file = resolve(tools, archive.name);
    console.log("Preparing isolated Java 17 build/runtime toolchain…");
    await downloadFile(archive.link, file, archive.checksum, "sha256");
    await mkdir(javaDir, { recursive: true });
    if (archive.name.endsWith(".zip")) await extractZip(file, javaDir);
    else await run("tar", ["-xzf", file, "-C", javaDir], tools);
    homes = await readdir(javaDir);
  }
  const javaHome = resolve(
    javaDir,
    homes[0],
    ...(process.platform === "darwin" ? ["Contents", "Home"] : []),
  );
  const java = resolve(
    javaHome,
    "bin",
    process.platform === "win32" ? "java.exe" : "java",
  );
  if (!(await exists(java))) throw new Error("Prepared Java 17 is incomplete");
  const gradleDir = resolve(tools, "gradle-8.7");
  if (!(await exists(resolve(gradleDir, "lib", "gradle-launcher-8.7.jar")))) {
    console.log("Preparing isolated Gradle 8.7…");
    const url = "https://services.gradle.org/distributions/gradle-8.7-bin.zip";
    const response = await fetch(url + ".sha256");
    if (!response.ok) throw new Error("Cannot verify Gradle distribution");
    const file = resolve(tools, "gradle-8.7-bin.zip");
    await downloadFile(url, file, (await response.text()).trim(), "sha256");
    await extractZip(file, tools);
  }
  return { java, javaHome, gradleDir };
}
export async function run(
  command: string,
  args: string[],
  cwd: string,
  env?: NodeJS.ProcessEnv,
) {
  await new Promise<void>((yes, no) => {
    const child = spawn(command, args, {
      cwd,
      env: { ...process.env, ...env },
      stdio: "inherit",
      windowsHide: true,
      shell: false,
    });
    child.once("error", no);
    child.once("close", (code) =>
      code === 0 ? yes() : no(new Error(`Build process exited ${code}`)),
    );
  });
}
