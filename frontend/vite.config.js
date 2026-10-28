import { defineConfig } from 'vite'
import vue from '@vitejs/plugin-vue'
import path from 'path'

const backendTarget = 'http://127.0.0.1:5001'

export default defineConfig({
  plugins: [vue()],
  resolve: {
    alias: {
      '@': path.resolve(__dirname, 'src'),
      'three': path.resolve(__dirname, 'node_modules/three/build/three.module.js')
    }
  },
  server: {
    port: 5000,
    strictPort: true,
    host: '0.0.0.0',
    proxy: {
      '/api': {
        target: backendTarget,
        changeOrigin: true
      }
    }
  },
  build: {
    target: 'es2015',
    chunkSizeWarningLimit: 700,
    rollupOptions: {
      output: {
        manualChunks(id) {
          if (!id.includes('node_modules')) return undefined
          if (id.includes('echarts')) return 'echarts-vendor'
          if (id.includes('element-plus') || id.includes('@element-plus')) return 'element-plus-vendor'
          if (id.includes('vue') || id.includes('pinia') || id.includes('vue-router')) return 'vue-core-vendor'
          if (id.includes('axios') || id.includes('dayjs')) return 'http-utils-vendor'
          return 'vendor'
        }
      }
    }
  },
  esbuild: {
    target: 'es2015'
  }
})
