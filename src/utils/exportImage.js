// เครื่องมือกลางสำหรับปุ่ม "บันทึกรูปภาพ" (แคปเจอร์ DOM เป็น PNG ด้วย html2canvas)
//
// html2canvas 1.4.1 รู้จักสีเฉพาะรูปแบบเดิม (hex / rgb() / hsl()) เจอฟังก์ชันสียุคใหม่เมื่อไร
// จะ throw ทันที ("Attempting to parse an unsupported color function")
// แต่ Tailwind v4 ใช้ oklch() เป็นค่าสีมาตรฐานของทุกคลาส (bg-blue-50, text-gray-500 ฯลฯ)
// และแปลงคลาสที่มีความโปร่งใส (bg-amber-50/60) เป็น color-mix() ผลคือตารางที่ตกแต่งด้วย
// Tailwind จะ export ไม่ได้เลยแม้แต่ช่องเดียว
//
// วิธีแก้: ก่อนแคปเจอร์ ให้ไล่อ่านสี "ที่เบราว์เซอร์คำนวณเสร็จแล้ว" ของทุก element ในเอกสาร
// สำเนาที่ html2canvas สร้างขึ้น แล้วเขียนทับเป็น rgb()/rgba() ที่ html2canvas อ่านออก
// สีที่ได้เป็นค่าเดียวกับที่ตาเห็นบนจอ เพราะให้ canvas ของเบราว์เซอร์เป็นคนแปลงให้
import html2canvas from 'html2canvas';

// พร็อพเพอร์ตี้ทุกตัวที่อาจมีฟังก์ชันสีฝังอยู่ (รวม shadow/gradient ที่สีอยู่กลางสตริง)
const COLOR_PROPS = [
  'color',
  'background-color',
  'background-image',
  'border-top-color',
  'border-right-color',
  'border-bottom-color',
  'border-left-color',
  'border-image-source',
  'outline-color',
  'text-decoration-color',
  'column-rule-color',
  'caret-color',
  'box-shadow',
  'text-shadow',
  'fill',
  'stroke',
];

// ตรวจแบบเร็วก่อนว่าค่านี้มีฟังก์ชันสียุคใหม่ไหม จะได้ไม่ต้องแปลงค่าที่ปกติดีอยู่แล้ว
const MODERN_COLOR_FN = /(^|[^\w-])(color-mix|oklch|oklab|lch|lab|hwb|color)\(/i;

// ขนาดสูงสุดที่เบราว์เซอร์ยอมให้ canvas เดียวกว้าง/สูงได้ ถ้าเกินจะได้ภาพเปล่า
const MAX_CANVAS_PX = 16384;

function findClosingParen(text, openIndex) {
  let depth = 0;
  for (let i = openIndex; i < text.length; i += 1) {
    if (text[i] === '(') depth += 1;
    else if (text[i] === ')') {
      depth -= 1;
      if (depth === 0) return i;
    }
  }
  return -1;
}

// ให้ canvas ของเบราว์เซอร์เป็นคนแปลงสี: ระบายสีนั้นลงบนพิกเซลเดียวแล้วอ่านค่ากลับมา
// เบราว์เซอร์ที่แสดงหน้าเว็บนี้ได้ย่อมแปลง oklch()/color-mix() ได้อยู่แล้ว ผลจึงตรงกับที่เห็นบนจอ
function createColorResolver() {
  const cache = new Map();
  let ctx = null;
  try {
    const canvas = document.createElement('canvas');
    canvas.width = 1;
    canvas.height = 1;
    ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (ctx) ctx.globalCompositeOperation = 'copy'; // ทับพิกเซลเดิมทั้งค่าสีและค่าความโปร่งใส
  } catch {
    ctx = null;
  }

  return (value) => {
    if (cache.has(value)) return cache.get(value);
    let result = null;
    if (ctx) {
      try {
        // ถ้า canvas อ่านค่าสีไม่ออก fillStyle จะค้างที่สีธง แล้วเราจะรู้ว่าแปลงไม่สำเร็จ
        const FLAG = '#ff00ff';
        ctx.fillStyle = FLAG;
        ctx.fillStyle = value;
        const parsed = ctx.fillStyle !== FLAG || /^#ff00ff$/i.test(value.trim());
        if (parsed) {
          ctx.fillRect(0, 0, 1, 1);
          const [r, g, b, a] = ctx.getImageData(0, 0, 1, 1).data;
          result = a >= 255
            ? `rgb(${r}, ${g}, ${b})`
            : `rgba(${r}, ${g}, ${b}, ${Number((a / 255).toFixed(3))})`;
        }
      } catch {
        result = null;
      }
    }
    cache.set(value, result);
    return result;
  };
}

// แทนที่เฉพาะช่วงที่เป็นฟังก์ชันสี ส่วนอื่นของค่า (ระยะเงา, ตำแหน่ง gradient) คงไว้เหมือนเดิม
function replaceModernColors(value, resolve) {
  const scanner = /(^|[^\w-])(color-mix|oklch|oklab|lch|lab|hwb|color)\(/gi;
  let out = '';
  let cursor = 0;
  let match = scanner.exec(value);
  while (match) {
    const fnStart = match.index + match[1].length;
    const openIndex = fnStart + match[2].length;
    const closeIndex = findClosingParen(value, openIndex);
    if (closeIndex === -1) break;
    const fnText = value.slice(fnStart, closeIndex + 1);
    out += value.slice(cursor, fnStart) + (resolve(fnText) || fnText);
    cursor = closeIndex + 1;
    scanner.lastIndex = cursor;
    match = scanner.exec(value);
  }
  return cursor === 0 ? value : out + value.slice(cursor);
}

function sanitizeElementColors(el, view, resolve) {
  const computed = view.getComputedStyle(el);
  COLOR_PROPS.forEach((prop) => {
    const value = computed.getPropertyValue(prop);
    if (!value || !MODERN_COLOR_FN.test(value)) return;
    const converted = replaceModernColors(value, resolve);
    if (converted !== value && !MODERN_COLOR_FN.test(converted)) {
      el.style.setProperty(prop, converted, 'important');
    }
  });
}

/**
 * แปลงสียุคใหม่ทั้งหมดใน root และลูกหลานให้เป็น rgb()/rgba() ที่ html2canvas อ่านออก
 * ใช้กับเอกสารสำเนาใน onclone เท่านั้น จะได้ไม่ไปยุ่งกับสไตล์ของหน้าจริง
 */
export function sanitizeModernColors(root) {
  if (!root) return;
  const view = root.ownerDocument?.defaultView;
  if (!view) return;
  const resolve = createColorResolver();
  sanitizeElementColors(root, view, resolve);
  root.querySelectorAll('*').forEach((el) => sanitizeElementColors(el, view, resolve));
}

/**
 * สร้างสำเนาของ element ไว้นอกจอ พร้อมหัวเรื่อง สำหรับเอาไปแคปเจอร์เป็นรูป
 * ข้อดีคือไม่ต้องไปยืด/ย่อของจริงให้หน้าจอกระตุก และได้เนื้อหาครบทุกแถวทุกคอลัมน์
 * ไม่ถูกตัดตามกรอบที่ผู้ใช้เลื่อนดูอยู่ ผู้เรียกต้องสั่ง remove() ทิ้งเองเมื่อแคปเจอร์เสร็จ
 */
export function buildOffscreenExportEl(sourceEl, { title = '', subtitle = '', minWidth = 0, padding = 20 } = {}) {
  const width = Math.max(sourceEl.scrollWidth, sourceEl.offsetWidth, minWidth, 1);

  const wrapper = document.createElement('div');
  wrapper.setAttribute('data-export-clone', 'true');
  wrapper.style.cssText = [
    'position:absolute', 'left:-100000px', 'top:0', 'z-index:-1',
    'box-sizing:content-box', `width:${width}px`, `padding:${padding}px`,
    'background:#ffffff', 'color:#111111', 'pointer-events:none',
  ].join(';');

  if (title) {
    const heading = document.createElement('div');
    heading.style.cssText = 'text-align:center;font-weight:700;font-size:20px;color:#1f2937;margin-bottom:4px;';
    heading.textContent = title;
    wrapper.appendChild(heading);
  }
  if (subtitle) {
    const sub = document.createElement('div');
    sub.style.cssText = 'text-align:center;font-size:13px;color:#6b7280;margin-bottom:14px;';
    sub.textContent = subtitle;
    wrapper.appendChild(sub);
  }

  const clone = sourceEl.cloneNode(true);
  clone.style.width = '100%';
  clone.style.maxHeight = 'none';
  clone.style.overflow = 'visible';
  wrapper.appendChild(clone);

  document.body.appendChild(wrapper);

  // ของจริงตรึงหัวตารางกับคอลัมน์ชื่อไว้ด้วย position:sticky ตอนเลื่อนดู
  // ในสำเนาไม่มีอะไรให้เลื่อนแล้ว ถ้าปล่อยไว้ html2canvas จะวาดซ้อนผิดตำแหน่ง
  [clone, ...clone.querySelectorAll('*')].forEach((el) => {
    const pos = window.getComputedStyle(el).position;
    if (pos === 'sticky' || pos === 'fixed') el.style.position = 'static';
  });

  return wrapper;
}

/**
 * แคปเจอร์ element เป็น canvas โดยลดอัตราขยายอัตโนมัติถ้าภาพใหญ่เกินที่เบราว์เซอร์รับไหว
 */
export async function captureElementToCanvas(el, { scale = 2, backgroundColor = '#ffffff' } = {}) {
  const width = Math.max(el.scrollWidth, el.offsetWidth) || 1;
  const height = Math.max(el.scrollHeight, el.offsetHeight) || 1;
  const maxScale = Math.min(MAX_CANVAS_PX / width, MAX_CANVAS_PX / height);
  const safeScale = Math.max(1, Math.min(scale, maxScale));

  return html2canvas(el, {
    backgroundColor,
    scale: safeScale,
    useCORS: true,
    logging: false,
    onclone: (clonedDoc, clonedEl) => {
      // พื้นหลังของ html/body ก็เป็น oklch เหมือนกัน และ html2canvas อ่านทุกครั้งไม่ว่าจะแคปเจอร์อะไร
      clonedDoc.documentElement.style.setProperty('background-color', backgroundColor, 'important');
      clonedDoc.body.style.setProperty('background-color', backgroundColor, 'important');
      clonedDoc.body.style.setProperty('color', '#111111', 'important');
      sanitizeModernColors(clonedEl || clonedDoc.body);
    },
  });
}

function canvasToPngBlob(canvas) {
  return new Promise((resolve, reject) => {
    if (typeof canvas.toBlob !== 'function') {
      try {
        const dataUrl = canvas.toDataURL('image/png');
        const binary = atob(dataUrl.split(',')[1]);
        const bytes = new Uint8Array(binary.length);
        for (let i = 0; i < binary.length; i += 1) bytes[i] = binary.charCodeAt(i);
        resolve(new Blob([bytes], { type: 'image/png' }));
      } catch (err) {
        reject(err);
      }
      return;
    }
    canvas.toBlob((blob) => {
      if (blob) resolve(blob);
      else reject(new Error('สร้างไฟล์ PNG ไม่สำเร็จ'));
    }, 'image/png');
  });
}

/** ตัดอักขระที่ใช้ตั้งชื่อไฟล์ไม่ได้ออก (ชื่อสาขาไทยใช้ได้ตามปกติ) */
export function safeFileName(name) {
  return String(name).replace(/[\\/:*?"<>|]+/g, '-').replace(/\s+/g, '_').slice(0, 150);
}

/** สั่งดาวน์โหลด canvas เป็นไฟล์ PNG */
export async function downloadCanvasAsPng(canvas, fileName) {
  const blob = await canvasToPngBlob(canvas);
  const url = URL.createObjectURL(blob);
  const link = document.createElement('a');
  link.href = url;
  link.download = fileName.endsWith('.png') ? fileName : `${fileName}.png`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  // ปล่อย URL ทีหลัง เพราะบางเบราว์เซอร์ยังอ่านไฟล์ไม่เสร็จตอน click() คืนค่า
  setTimeout(() => URL.revokeObjectURL(url), 60000);
}
