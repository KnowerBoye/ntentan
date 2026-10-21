import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// Dev server runs on 5173; it talks to the api-live server (default :8080)
// over Socket.IO + HTTP. The server URL is configurable in the UI, so no proxy
// is required, but HTTPS is NOT needed for localhost mic/camera access.
export default defineConfig({
  plugins: [react()],
  server: { port: 5173, host: true },
});
