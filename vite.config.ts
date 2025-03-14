import { reactRouter } from "@react-router/dev/vite";
import { cloudflareDevProxy } from "@react-router/dev/vite/cloudflare";
import tailwindcss from "@tailwindcss/vite";
import { defineConfig } from "vite";
import tsconfigPaths from "vite-tsconfig-paths";

export default defineConfig(({ isSsrBuild }) => ({
  build: {
    rollupOptions: isSsrBuild
      ? {
          input: "./workers/app.ts",
          // We need to include the virtual module in the build for Cloudflare Workers
        }
      : undefined,
  },
  server: {
    allowedHosts: [
      '.gitpod.io', // Allow all hosts from gitpod.io
    ],
    // Add proxy configuration to forward API requests to the Cloudflare Worker
    proxy: {
      '/api': {
        target: 'http://localhost:8787', // Cloudflare Worker's default port
        changeOrigin: true,
        secure: false,
      },
    },
  },
  plugins: [
    cloudflareDevProxy({
      getLoadContext({ context }) {
        return { cloudflare: context.cloudflare };
      },
    }),
    tailwindcss(),
    reactRouter(),
    tsconfigPaths(),
  ],
}));
