import { resolve } from 'node:path';
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
    rollupOptions: {
      /* MULTI-PAGE. Without this Vite builds index.html and nothing else — any
         other .html works under `npm run dev` and then silently vanishes from
         dist/, which is what was happening to lab.html.

         Both entries stay at the ROOT on purpose. base is './', so a page in a
         sub-folder would resolve the splat against its own directory —
         /bluedio/splat/... instead of /splat/... — and 404. A prettier URL is
         not worth a broken one.

         lab.html is deliberately NOT listed: it is a work-in-progress scratch
         page, and listing it here would publish it. Add it when it is ready. */
      input: {
        index: resolve(__dirname, 'index.html'),
        bluedio: resolve(__dirname, 'bluedio.html'),
      },
    },
  },
  server: {
    host: true, // expose on the LAN so you can test on the iPhone via Tailscale
  },
});
