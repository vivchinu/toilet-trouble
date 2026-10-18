import { defineConfig } from 'vite';
import basicSsl from '@vitejs/plugin-basic-ssl';

// `npm run dev` serves plain http://localhost (fine for desktop mode; localhost is a secure context).
// `npm run dev:quest` adds a self-signed HTTPS cert and exposes the server on the LAN,
// because WebXR requires a secure context when the headset loads the page over the network.
export default defineConfig(({ mode, command }) => ({
  // Relative asset paths in the build so it works from any sub-path (e.g. GitHub Pages /toilet-trouble/).
  base: command === 'build' ? './' : '/',
  plugins: mode === 'https' ? [basicSsl()] : [],
  server: { port: 5173 },
  // Keep module paths as written (avoids path rewriting on virtualised Windows folders).
  resolve: { preserveSymlinks: true },
  build: { chunkSizeWarningLimit: 800 },
}));
