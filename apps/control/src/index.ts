import { createApp } from "./app.js";
import { config } from "./config.js";
const { app } = createApp();
let closing = false;
async function close() {
  if (closing) return;
  closing = true;
  await app.close();
}
process.on("SIGINT", () => void close());
process.on("SIGTERM", () => void close());
try {
  await app.listen({ port: config.CONTROL_PORT, host: config.CONTROL_HOST });
} catch (err) {
  app.log.error(err);
  await close();
  process.exitCode = 1;
}
