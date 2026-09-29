import { writeFile, mkdir } from "node:fs/promises";
import { resolve } from "node:path";
import { format, resolveConfig } from "prettier";
import { config } from "../apps/control/src/config.js";
import { protocolCatalog } from "../packages/agents/src/inputs/catalog.js";
import { exportInputReadme } from "./export-input-readme.js";
const catalog = protocolCatalog(config.MC_VERSION);
const output = resolve(process.argv[2] ?? "docs/agent-inputs.catalog.json");
await mkdir(resolve(output, ".."), { recursive: true });
await writeFile(
  output,
  await format(JSON.stringify(catalog), {
    ...(await resolveConfig(output)),
    parser: "json",
  }),
);
console.log(`Exported ${output}`);
await exportInputReadme(catalog);
