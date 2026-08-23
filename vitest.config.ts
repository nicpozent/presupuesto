import { defineConfig } from "vitest/config";

// Config aparte: vite.config.ts tiene root en src/client para la SPA, y los tests
// viven en src/ y tests/, en la raíz del proyecto.
export default defineConfig({
  test: {
    root: ".",
    include: ["src/**/*.test.ts", "tests/**/*.test.ts"],
    environment: "node",
  },
});
