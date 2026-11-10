import { defineConfig } from 'vitest/config';
import { VitePWA } from 'vite-plugin-pwa';

export default defineConfig({
  base: './',
  worker: { format: 'es' },
  build: { target: 'es2020', chunkSizeWarningLimit: 1500 },
  plugins: [
    // Installable, fully offline web app (the native shells ship the same build through Capacitor).
    VitePWA({
      registerType: 'autoUpdate',
      injectRegister: null, // registered manually: never inside the native apps
      includeAssets: ['icon.svg', 'apple-touch-icon.png'],
      workbox: { globPatterns: ['**/*.{js,css,html,svg,png,woff2}'], maximumFileSizeToCacheInBytes: 5_000_000 },
      manifest: {
        name: 'EPOCH — The Living World',
        short_name: 'EPOCH',
        description: 'Un monde 3D vivant où des civilisations naissent et écrivent leur histoire.',
        lang: 'fr',
        display: 'fullscreen',
        display_override: ['fullscreen', 'standalone'],
        orientation: 'landscape',
        background_color: '#07080a',
        theme_color: '#07080a',
        start_url: './',
        scope: './',
        categories: ['games', 'simulation'],
        icons: [
          { src: 'icon-192.png', sizes: '192x192', type: 'image/png' },
          { src: 'icon-512.png', sizes: '512x512', type: 'image/png' },
          { src: 'icon-maskable-512.png', sizes: '512x512', type: 'image/png', purpose: 'maskable' },
        ],
      },
    }),
  ],
  test: { environment: 'node', include: ['tests/**/*.test.ts'], testTimeout: 60000 },
});
