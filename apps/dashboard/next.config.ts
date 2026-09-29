import type { NextConfig } from "next";
import { resolve } from "node:path";
import dotenv from "dotenv";
dotenv.config({ path: resolve(process.cwd(), "../../.env"), quiet: true });
const config: NextConfig = {
  turbopack: { root: resolve(process.cwd(), "../..") },
  devIndicators: false,
};
export default config;
