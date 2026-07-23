import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  plugins: [react(), tailwindcss()],
  server: {
    host: true
  },
  build: {
    rollupOptions: {
      output: {
        // บังคับรวมทุกอย่างเป็นไฟล์เดียว กัน chunk ย่อยที่บาง library (เช่น jspdf) แยกออกไปโหลดทีหลัง
        // แบบ dynamic import — ถ้า deploy ใหม่ทับพอดีตอนผู้ใช้เปิดหน้าเว็บค้างไว้ ชื่อไฟล์ chunk เดิมจะหาย
        // ทำให้กดนำทางไปหน้าไหนที่ต้องใช้ chunk นั้นแล้วโหลดไม่ขึ้นจนกว่าจะรีเฟรช
        codeSplitting: false
      }
    }
  }
})
