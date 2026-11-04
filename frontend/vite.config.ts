import { defineConfig } from "vite";
import react from "@vitejs/plugin-react";

// El navegador solo habla con /api (mismo origen); Vite lo reenvía al backend.
// Así no hay CORS y la clave de Gemini nunca pasa por el frontend.
export default defineConfig({
  plugins: [react()],
  server: {
    port: 5173,
    proxy: { "/api": { target: process.env.VITE_API_TARGET || "https://autostudio-marto-2.onrender.com/", changeOrigin: true } },
  },
});
