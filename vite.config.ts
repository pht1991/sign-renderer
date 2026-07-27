import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'

export default defineConfig({
  // GitHub Pages 部署在 /仓库名/ 子路径下，使用相对路径保证资源可加载
  base: './',
  plugins: [react()],
  server: {
    port: 5173,
    host: true,
  },
})
