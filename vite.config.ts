import { loadEnvFile } from "node:process";
import fs from "node:fs";

try {
  loadEnvFile();
} catch (e) {
  console.log(e);
}

export default {
  build: {
    outDir: "build",
    // sourcemap: true,
    rolldownOptions: {
      onwarn(warning: { code?: string }, warn: (w: unknown) => void) {
        // Mantine marks its modules "use client" (for React Server Components); harmless in a client-only app
        if (warning.code === "MODULE_LEVEL_DIRECTIVE") {
          return;
        }
        warn(warning);
      },
    },
  },
  // Module workers (subtitle auto-sync) can code-split, so the AC-3 decoder only loads for Dolby audio
  worker: { format: "es" },
  server: {
    https:
      process.env.SSL_CRT_FILE && process.env.SSL_KEY_FILE
        ? {
            key: fs.readFileSync(process.env.SSL_KEY_FILE),
            cert: fs.readFileSync(process.env.SSL_CRT_FILE),
          }
        : null,
    allowedHosts: true,
  },
  test: {
    projects: [
      {
        extends: true,
        test: {
          name: "server",
          include: ["server/**/*.test.ts"],
          environment: "node",
        },
      },
      {
        extends: true,
        test: {
          name: "client",
          include: ["src/**/*.test.{ts,tsx}"],
          environment: "happy-dom",
          environmentOptions: {
            happyDOM: {
              // Scripts such as the YouTube iframe API aren't loaded in tests; don't log an error for each
              settings: { handleDisabledFileLoadingAsSuccess: true },
            },
          },
        },
      },
    ],
  },
};
