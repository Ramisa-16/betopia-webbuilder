/// <reference types="vitest" />
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'
import path from 'path'

export default defineConfig({
  plugins: [react(), tailwindcss()],
  resolve: {
    alias: { '@': path.resolve(__dirname, './src') },
  },
  clearScreen: false,
  server: {
    port: 1420,
    strictPort: true,
    watch: { ignored: ['**/src-tauri/**'] },
  },
  envPrefix: ['VITE_', 'TAURI_ENV_*'],
  build: {
    target: 'chrome105',
    minify: !process.env.TAURI_ENV_DEBUG ? 'esbuild' : false,
    sourcemap: !!process.env.TAURI_ENV_DEBUG,
    chunkSizeWarningLimit: 600,
    rollupOptions: {
      output: {
        manualChunks(id) {
          // Vendor splits
          if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) return 'react-vendor'
          if (id.includes('@uiw/react-codemirror') || id.includes('@codemirror/') || id.includes('@lezer/')) return 'codemirror'
          if (id.includes('node_modules/react-markdown') || id.includes('node_modules/remark') || id.includes('node_modules/rehype') || id.includes('node_modules/highlight.js')) return 'markdown'
          if (id.includes('node_modules/zustand')) return 'zustand'

          // Module splits
          if (id.includes('src/modules/chat/')) return 'module-chat'
          if (id.includes('src/modules/editor/')) return 'module-editor'
          if (id.includes('src/modules/explorer/')) return 'module-explorer'
          if (id.includes('src/modules/preview/')) return 'module-preview'
          if (id.includes('src/modules/settings/')) return 'module-settings'
          if (id.includes('src/modules/workspace/')) return 'module-workspace'
          if (id.includes('src/store/')) return 'stores'
          if (id.includes('src/lib/')) return 'lib'
        },
      },
    },
  },
  worker: {
    format: 'es',
  },
  test: {
    globals: true,
    environment: 'jsdom',
    setupFiles: ['./src/test-setup.ts'],
    alias: { '@/': new URL('./src/', import.meta.url).pathname },
  },
})
