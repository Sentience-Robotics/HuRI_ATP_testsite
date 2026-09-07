// Origin the SPA talks to for /auth/* and the /ws websocket.
//
// Priority:
//   1. VITE_BACKEND_URL — explicit build-time override (cross-origin frontend).
//   2. Same origin — a deployed single-origin build where the backend serves
//      this SPA (https://app.huri.pommier.dev), so /auth/login and /ws are here.
//   3. http://localhost:8000 — local dev, where Vite (:5173) and the backend
//      (:8000) are different origins.
export const BACKEND_URL =
  import.meta.env.VITE_BACKEND_URL ||
  (typeof window !== "undefined" &&
  window.location.hostname !== "localhost" &&
  window.location.hostname !== "127.0.0.1"
    ? window.location.origin
    : "http://localhost:8000");
