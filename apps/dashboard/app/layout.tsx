import type { Metadata } from "next";
import "./globals.css";
export const metadata: Metadata = {
  title: "RLCraft V2 · Control Room",
  description:
    "Minecraft agent orchestration, training stages and performance monitoring.",
};
export default function Layout({ children }: { children: React.ReactNode }) {
  return (
    <html lang="en">
      <body>{children}</body>
    </html>
  );
}
