import { defineConfig } from 'vite';

// GitHub Pages serves a *project* site from https://<user>.github.io/<repo>/,
// so the app must know it lives in a sub-folder. Using a relative base ('./')
// makes every built asset URL relative to index.html, which works whether the
// site is served from the domain root, a /<repo>/ sub-path, or a custom domain.
// Override with `VITE_BASE=/my-repo/ npm run build` if you ever need an absolute base.
export default defineConfig({
  base: process.env.VITE_BASE ?? './',
  build: {
    // esnext lets us use top-level await (we await the graphics device on boot).
    target: 'esnext',
    // Never inline the splat/wasm files as base64 — they must stay as fetched assets.
    assetsInlineLimit: 0,
  },
  server: {
    host: true, // expose on the LAN so you can test on the iPhone via Tailscale
  },
});
