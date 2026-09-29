/** Runnable transport example. This is a simulator, not a Minecraft client. */
import { createInterface } from "node:readline";
import { SimulatorEnvironment } from "../../packages/agents/src/backends/simulator.ts";
const lines = createInterface({ input: process.stdin, crlfDelay: Infinity });
let environment;
for await (const line of lines) {
  const request = JSON.parse(line);
  try {
    if (request.protocol !== 1) throw new Error("Expected protocol 1");
    let result = null;
    const { method, params } = request;
    if (method === "connect") {
      environment = new SimulatorEnvironment(params.inputs);
      await environment.connect();
    } else if (!environment) throw new Error("Connect first");
    else if (method === "observe") result = environment.observe(params.tick);
    else if (method === "apply") await environment.apply(params.action);
    else if (method === "reset") await environment.reset(params.setup);
    else if (method === "close") await environment.close();
    else throw new Error(`Unsupported method: ${method}`);
    process.stdout.write(
      JSON.stringify({ protocol: 1, id: request.id, result }) + "\n",
    );
    if (method === "close") break;
  } catch (error) {
    process.stdout.write(
      JSON.stringify({ protocol: 1, id: request.id, error: error.message }) +
        "\n",
    );
  }
}
