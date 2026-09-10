import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";
import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

const __dirname = path.dirname(fileURLToPath(import.meta.url));

// run_frontend.sh --host (LAN/phone testing) writes a self-signed cert here
// via ensure_dev_cert.sh and sets VITE_DEV_HTTPS=1. HTTPS is required for
// navigator.mediaDevices.getUserMedia (mic button) to work in phone
// browsers, which — unlike desktop — don't treat plain HTTP as a secure
// context even when it's only reachable on the LAN.
const certFile = path.resolve(__dirname, "../certs/ca/dev-cert.pem");
const keyFile = path.resolve(__dirname, "../certs/ca/dev-key.pem");
const https =
  process.env.VITE_DEV_HTTPS === "1" &&
  fs.existsSync(certFile) &&
  fs.existsSync(keyFile)
    ? { cert: fs.readFileSync(certFile), key: fs.readFileSync(keyFile) }
    : undefined;

// Proxy the backend's routes through Vite's own origin so a phone only ever
// talks to one (HTTPS) origin. Without this, config.js's BACKEND_URL would
// have to point at a separate http://<lan-ip>:8001 origin, which browsers
// block as mixed content once the page itself is HTTPS — the backend stays
// plain HTTP since it's now only ever reached from this same machine.
const BACKEND_TARGET = "http://localhost:8001";
const proxy = {
  "/auth": BACKEND_TARGET,
  "/presets": BACKEND_TARGET,
  "/launcher": BACKEND_TARGET,
  "/huri-modules": BACKEND_TARGET,
  "/ws": { target: BACKEND_TARGET.replace(/^http/, "ws"), ws: true },
};

export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    https,
    proxy,
  },
});
