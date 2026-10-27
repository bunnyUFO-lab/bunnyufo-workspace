import { defineConfig, type Plugin } from 'vite'
import react from '@vitejs/plugin-react'
import path from 'path'
import { readdirSync, readFileSync, statSync } from 'node:fs'
// @ts-expect-error: plain ESM helper without type declarations
import workspaceFiles from './scripts/vite-workspace.mjs'

// Excalidraw fetches its fonts from esm.sh unless window.EXCALIDRAW_ASSET_PATH says otherwise
// (set in DrawingSection). The build copies them next to the app so a private site makes no CDN
// call and drawing works offline. Xiaolai (CJK, 13 MB) is left out; workspace content is English.
function excalidrawFonts(): Plugin {
  const fonts = path.resolve(import.meta.dirname, 'node_modules/@excalidraw/excalidraw/dist/prod/fonts')
  const walk = (dir: string): string[] => readdirSync(dir).flatMap(name => {
    const full = path.join(dir, name)
    return statSync(full).isDirectory() ? (name === 'Xiaolai' ? [] : walk(full)) : [full]
  })
  return {
    name: 'excalidraw-fonts',
    apply: 'build',
    // Excalidraw lists its fonts as [our copy, esm.sh] and the browser asks esm.sh for all of them as
    // soon as the editor mounts, so a private site would call a CDN on every drawing. Drop the second
    // address. The build fails if a new Excalidraw words this differently, rather than quietly calling out again.
    transform: {
      filter: { id: /@excalidraw\/excalidraw\/dist\/prod\/.*\.js$/ },
      handler(code) {
        const fallback = /return (\w+)\.push\(new URL\(\w+,\w+\.ASSETS_FALLBACK_URL\)\),\w+(?=\})/
        if (!code.includes('ASSETS_FALLBACK_URL')) return null
        if (!fallback.test(code)) this.error('Excalidraw no longer builds its font list the way vite.config.ts expects; update excalidrawFonts().')
        return code.replace(fallback, 'return $1')
      },
    },
    generateBundle() {
      for (const file of walk(fonts)) {
        this.emitFile({ type: 'asset', fileName: `assets/excalidraw/fonts/${path.relative(fonts, file).split(path.sep).join('/')}`, source: readFileSync(file) })
      }
    },
  }
}

// The phone app's two files live in public/ (publicDir is not copied, so the UI build is only what
// Vite emits): the worker must answer at /sw.js and the manifest at /manifest.webmanifest.
function sitePublicFiles(): Plugin {
  return {
    name: 'site-public-files',
    apply: 'build',
    generateBundle() {
      for (const file of ['sw.js', 'manifest.webmanifest']) {
        this.emitFile({ type: 'asset', fileName: file, source: readFileSync(path.resolve(import.meta.dirname, 'public', file)) })
      }
    },
  }
}

// A site API to proxy to, when one is running locally: the deployed one listens on 8099.
const siteApi = process.env.BUW_SITE_API || 'http://127.0.0.1:8099'

export default defineConfig({
  // /workspace/* comes from the active workspace (see scripts/vite-workspace.mjs).
  plugins: [react(), excalidrawFonts(), sitePublicFiles(), workspaceFiles({ appRepo: import.meta.dirname })],
  server: {
    port: 3009,
    open: true,
    fs: {
      allow: ['.'],
    },
    // The site's write API (site/api), when one is running locally: the preview then offers the
    // pin and archive controls exactly as a published site with the API does. Nothing is
    // proxied if it is not running — the probe fails and the preview stays read-only.
    proxy: {
      '/api': { target: siteApi, changeOrigin: true },
      // The site list too: on a published site the web server writes it, and the preview has
      // none of its own, so a local API can stand in for both.
      '/sites.json': { target: siteApi, changeOrigin: true },
      // And the sections themselves: with a local API pointed at the cards bucket, the preview
      // shows exactly what the published site does.
      '/w': { target: siteApi, changeOrigin: true },
    },
  },
  publicDir: 'public',
  build: {
    // Cards are served by the dev-server plugin and never belong in dist; brand assets
    // under public/ are copied by the Dockerfile, so publicDir stays out of dist.
    copyPublicDir: false,
  },
  resolve: {
    alias: {
      '@': path.resolve(import.meta.dirname, 'src'),
    },
  },
})
