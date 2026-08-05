// ตัวช่วยเรียก office-server (Narai Usage API ที่รันบนเครื่อง IT-Narai ผ่าน dyndns พอร์ต 8787)
// วางไว้นอกโฟลเดอร์ api/ เพราะทุกไฟล์ใน api/ จะถูกนับเป็น Serverless Function (ลิมิต 12 ฟังก์ชัน)
//
// ทำไมต้องมีไฟล์นี้: เดิม api/*.js เรียก fetch() เปล่าๆ ไม่มี timeout ไม่มี retry
//  - ถ้าเครื่องออฟฟิศปิด/เน็ตออฟฟิศหลุด/IP dyndns เพิ่งเปลี่ยน -> fetch ค้างจนฟังก์ชัน Vercel หมดเวลา
//    แล้วตอบกลับเป็นหน้า error ของ Vercel (ไม่ใช่ JSON) -> ฝั่งเว็บอ่านไม่ออก เด้ง "ติดต่อเซิร์ฟเวอร์ไม่ได้"
//  - ช่วง office-server เพิ่งรีสตาร์ท (กำลังอุ่น cache ~3-4 นาที) จะช้าเป็นพักๆ ลองใหม่ครั้งเดียวก็มักผ่าน
// ตั้ง env USAGE_API_BASE บน Vercel เพื่อทับค่าเริ่มต้นได้ (เช่นเวลาเปลี่ยน dyndns/พอร์ต)

export const USAGE_API_BASE = process.env.USAGE_API_BASE || 'http://storenarai.dyndns.tv:8787';

const DEFAULT_TIMEOUT_MS = 20000;
const DEFAULT_RETRIES = 1;
const RETRY_DELAY_MS = 1000;

// สำหรับ endpoint ที่ office-server ต้องคำนวณข้ามหลายวัน (itemsales / bills / dashboard):
// วันไหนยังไม่อยู่ในแคชรายวันต้องดึงจาก POS สด กินเวลาได้หลายสิบวินาที — timeout ดีฟอลต์ 20 วิ
// จะตัดการเชื่อมต่อทิ้งทั้งที่ office-server กำลังคำนวณใกล้เสร็จ ทำให้รายการยอดขายไม่ขึ้น
// จึงให้รอยาวใกล้เพดาน maxDuration 60 วิ ของฟังก์ชัน Vercel แทน (ดู vercel.json)
// retries เผื่อไว้สำหรับ error ที่ล้มเร็ว (เช่นต่อไม่ติดชั่ววินาที) — deadlineMs กันลองใหม่จนเกินเพดานรวม
export const HEAVY_UPSTREAM_OPTS = { timeoutMs: 50000, retries: 2, deadlineMs: 55000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class UpstreamError extends Error {
  constructor(message, cause) {
    super(message);
    this.name = 'UpstreamError';
    this.cause = cause;
  }
}

const describe = (err, timedOut) => {
  if (timedOut) {
    return 'เซิร์ฟเวอร์ที่ออฟฟิศไม่ตอบสนองภายในเวลาที่กำหนด — เครื่องอาจกำลังโหลดข้อมูลอยู่ หรือเน็ตที่ออฟฟิศช้า กรุณาลองใหม่อีกครั้ง';
  }
  const code = err?.cause?.code || err?.code || '';
  if (/ENOTFOUND|EAI_AGAIN/.test(code)) {
    return 'หาที่อยู่เซิร์ฟเวอร์ที่ออฟฟิศไม่เจอ (dyndns อาจยังไม่อัปเดต IP ใหม่)';
  }
  if (/ECONNREFUSED|ECONNRESET|EHOSTUNREACH|ETIMEDOUT/.test(code)) {
    return 'ติดต่อเซิร์ฟเวอร์ที่ออฟฟิศไม่ได้ — เครื่อง IT-Narai อาจปิดอยู่ หรือพอร์ต 8787 ไม่ได้เปิด';
  }
  return 'ติดต่อเซิร์ฟเวอร์ที่ออฟฟิศไม่ได้ กรุณาลองใหม่อีกครั้ง';
};

/**
 * fetch ไป office-server พร้อม timeout + ลองใหม่อัตโนมัติ
 * โยน UpstreamError ที่มีข้อความภาษาไทยบอกสาเหตุ เมื่อยังต่อไม่ได้หลังลองครบ
 * deadlineMs = เวลารวมทุกครั้งรวมกัน (กันการลองใหม่ลากยาวเกินเพดาน maxDuration ของฟังก์ชัน Vercel)
 */
export async function fetchUpstream(url, { timeoutMs = DEFAULT_TIMEOUT_MS, retries = DEFAULT_RETRIES, deadlineMs, ...init } = {}) {
  const deadline = deadlineMs ? Date.now() + deadlineMs : null;
  let lastError;
  for (let attempt = 0; attempt <= retries; attempt++) {
    const remaining = deadline ? deadline - Date.now() : Infinity;
    if (remaining < 1500) break; // เวลาที่เหลือน้อยเกินกว่าจะยิงอีกรอบให้ทันอยู่แล้ว
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), Math.min(timeoutMs, remaining));
    try {
      const res = await fetch(url, { ...init, signal: controller.signal });
      // 5xx ของ office-server = พลาดชั่วคราว (เช่นกำลังโหลดสูตร/cache อยู่) ลองใหม่ได้
      if (res.status >= 500 && attempt < retries) {
        lastError = new UpstreamError(`เซิร์ฟเวอร์ที่ออฟฟิศตอบผิดพลาด (HTTP ${res.status})`);
      } else {
        return res;
      }
    } catch (err) {
      lastError = new UpstreamError(describe(err, controller.signal.aborted), err);
    } finally {
      clearTimeout(timer);
    }
    if (attempt < retries) await sleep(RETRY_DELAY_MS);
  }
  throw lastError || new UpstreamError(describe(null, true));
}

/**
 * fetch ชีท Google (gviz) พร้อม timeout + ลองใหม่
 * Google เองก็มีจังหวะช้า/ตอบ 5xx เป็นครั้งคราว ถ้าไม่ลองใหม่จะกลายเป็น error เด้งใส่ผู้ใช้ทันที
 */
export async function fetchSheet(url, options = {}) {
  try {
    return await fetchUpstream(url, { timeoutMs: 15000, retries: 2, ...options });
  } catch (err) {
    throw new UpstreamError('อ่านข้อมูลจาก Google Sheet ไม่ได้ กรุณาลองใหม่อีกครั้ง', err);
  }
}

/** ตั้ง CORS header ชุดเดียวกับที่ api/*.js ใช้อยู่ คืน true ถ้าเป็น preflight (จบ request แล้ว) */
export function applyCors(req, res) {
  res.setHeader('Access-Control-Allow-Credentials', true);
  res.setHeader('Access-Control-Allow-Origin', '*');
  res.setHeader('Access-Control-Allow-Methods', 'GET,OPTIONS,PATCH,DELETE,POST,PUT');
  res.setHeader('Access-Control-Allow-Headers', 'X-CSRF-Token, X-Requested-With, Accept, Accept-Version, Content-Length, Content-MD5, Content-Type, Date, X-Api-Version');
  if (req.method === 'OPTIONS') {
    res.status(200).end();
    return true;
  }
  return false;
}

/** ตอบ error กลับไปเป็น JSON เสมอ — ฝั่งเว็บจะได้โชว์สาเหตุจริงแทน "ติดต่อเซิร์ฟเวอร์ไม่ได้" ลอยๆ */
export function replyUpstreamError(res, error, context) {
  console.error(`${context} error:`, error);
  const isUpstream = error instanceof UpstreamError;
  return res.status(isUpstream ? 503 : 500).json({
    status: 'error',
    message: isUpstream ? error.message : (error.message || 'เกิดข้อผิดพลาดที่ไม่ทราบสาเหตุ'),
  });
}
