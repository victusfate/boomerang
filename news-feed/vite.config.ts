import { defineConfig } from 'vite';
import react from '@vitejs/plugin-react';
import { VitePWA } from 'vite-plugin-pwa';

/** GitHub project site path; no trailing slash so the canonical URL is …/boomerang not …/boomerang/ */
const base = process.env.GITHUB_PAGES === 'true' ? '/boomerang' : '/';

export default defineConfig({
  base,
  // Preview must use the same `base` as the build (set GITHUB_PAGES=true for gh-pages preview).
  preview: {
    open: base === '/boomerang' ? '/boomerang' : '/',
  },
  plugins: [
    react(),
    VitePWA({
      registerType: 'autoUpdate',
      includeAssets: ['favicon.svg', 'icon-192.png', 'icon-512.png'],
      manifest: {
        name: 'Boomerang News',
        short_name: 'News',
        description: 'Algorithmic news feed without ads',
        theme_color: '#111111',
        background_color: '#111111',
        display: 'standalone',
        orientation: 'portrait',
        start_url: base,
        scope: base,
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png', purpose: 'any maskable' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png', purpose: 'any maskable' },
        ],
      },
      workbox: {
        globPatterns: ['**/*.{js,css,html,svg,png}'],
        // RSS is fetched only via Cloudflare Worker (VITE_RSS_WORKER_URL); no RSS proxy caching.
      },
    }),
  ],
});
