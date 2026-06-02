import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Two build targets share the same source:
//   - `npm run build`    → relative-path bundle for Capacitor (file:// in iOS/Android webview).
//   - `npm run build:pwa` → absolute-path bundle for nginx at ems.wellnessextract.com/m/
// Pick via VITE_BASE env var.
export default defineConfig({
  plugins: [react()],
  base: process.env.VITE_BASE ?? "./",
  build: {
    outDir: "dist",
    sourcemap: true,
  },
  server: {
    host: true,                       // makes vite dev reachable from a phone on the same Wi-Fi
    port: 5173,
  },
});
