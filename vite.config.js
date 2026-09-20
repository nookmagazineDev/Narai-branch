/* global process */
import { defineConfig } from 'vite'
import react from '@vitejs/plugin-react'
import tailwindcss from '@tailwindcss/vite'

// https://vite.dev/config/
export default defineConfig({
  // รหัสรุ่นของไฟล์ชุดนี้ — ฝังตอน build แล้วเอาไปเทียบกับรุ่นที่เซิร์ฟเวอร์กำลังให้บริการ
  // (ดู src/services/api.js) เพื่อจับเครื่องที่ยังถือไฟล์ชุดเก่าค้างในแคช ซึ่งเคยทำให้สาขา
  // บันทึกสต๊อกลงชีทเก่าทั้งที่ระบบย้ายไป SQL แล้ว โดยไม่มีอะไรฟ้องเลย
  define: {
    __BUILD_ID__: JSON.stringify(process.env.VERCEL_GIT_COMMIT_SHA || 'dev'),
  },
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
