import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import './index.css'
import App from './App.jsx'

// ถ้าเว็บ deploy เวอร์ชันใหม่ทับพอดีตอนผู้ใช้เปิดหน้าเว็บค้างไว้ ไฟล์ chunk เดิมที่ browser
// อ้างถึงจะหายไป ทำให้กดนำทางแล้วโหลดไม่ขึ้น — รีเฟรชหน้าอัตโนมัติแทนที่จะค้างเงียบๆ
window.addEventListener('vite:preloadError', () => {
  window.location.reload();
});

createRoot(document.getElementById('root')).render(
  <StrictMode>
    <App />
  </StrictMode>,
)
