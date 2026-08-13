export const SCRIPT_URL = "https://script.google.com/macros/s/AKfycbwsGv4sz5ljPtdq347Y8zKaDP9FCLKAKKUNCPY5tarhAiAYz8RZdrC_nltVTeT0WWIXjA/exec";

// ---------------------------------------------------------------------------
// การย้ายจาก Google Apps Script ไป SQL Server (เครื่อง 203.154.185.48)
// action ที่อยู่ในลิสต์นี้จะถูกส่งไปที่ /api/schedule (ต่อ MS SQL ตรง) แทน Apps Script
// ที่เหลือยังวิ่งไปชีทเหมือนเดิม — ย้ายทีละกลุ่มได้โดยไม่ต้องแก้หน้าเว็บสักหน้า
// รูปแบบ request/response เหมือนกันทั้งสองทาง หน้าเว็บจึงไม่รู้ว่าข้อมูลมาจากไหน
//
// ยังไม่ย้าย getBranches: อีก 7 หน้าที่ไม่เกี่ยวกับตารางงานใช้อยู่ (และบางหน้าอ่าน outletId ด้วย)
// รอย้ายพร้อมกลุ่มของหน้านั้นๆ จะได้ทดสอบพร้อมกัน — /api/schedule รองรับ action นี้ไว้แล้ว
// ---------------------------------------------------------------------------
const SQL_ENDPOINT = '/api/schedule';
const SQL_ACTIONS = new Set([
  'getScheduleEmployees',
  'getBranchStats',
  'getDailySales',
  'getHistoryData',
  'saveTimesheet',
  'updateOTApprovalBulk',
  'updateWorkStation',
]);

export const isSqlBackedAction = (action) => SQL_ACTIONS.has(action);

// ---------------------------------------------------------------------------
// ทำไมถึงชอบขึ้น "ติดต่อเซิร์ฟเวอร์ไม่ได้"
// 1) Google Apps Script จำกัดจำนวน execution ที่วิ่งพร้อมกันต่อบัญชี ถ้าหลายสาขายิงพร้อมกัน
//    (หน้าเดียวยิง 2-5 request รวด) จะโดนคิว/โดนปฏิเสธ แล้วตอบกลับเป็น "หน้า HTML" ไม่ใช่ JSON
//    -> response.json() พัง -> เด้ง error ทั้งที่เน็ตปกติ
// 2) GAS ต้องเปิดสเปรดชีตทั้งไฟล์ทุกครั้ง บางครั้งช้าเกิน 30-60 วิ ถ้าไม่มี timeout จะค้างยาว
// 3) เน็ตสาขา/มือถือหลุดชั่ววินาที = fetch เด้งทันทีโดยไม่ลองใหม่
// ตัวช่วยด้านล่างจึงมี: timeout, ลองใหม่อัตโนมัติ (เฉพาะคำสั่งอ่าน), จำกัดจำนวนที่ยิงพร้อมกัน
// และแยกให้ชัดว่า "ต่อเซิร์ฟเวอร์ไม่ได้" กับ "เซิร์ฟเวอร์ตอบว่าทำไม่ได้" คนละเรื่องกัน
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 30000;      // GAS เปิดสเปรดชีตใหญ่ๆ ช้าได้ แต่ไม่ควรค้างเกินนี้ต่อหนึ่งครั้ง
const DEADLINE_MS = 70000;     // เวลารวมทั้งหมดรวมการลองใหม่ — เกินนี้ยอมแพ้ ไม่ปล่อยให้ผู้ใช้รอลอยๆ
const MIN_ATTEMPT_MS = 8000;   // เหลือเวลาน้อยกว่านี้ก็ไม่ต้องลองใหม่แล้ว ยิงไปก็ไม่ทันอยู่ดี
const MAX_CONCURRENT = 3;      // ยิงพร้อมกันเกินนี้ GAS จะเริ่มปฏิเสธ
const RETRY_DELAYS = [800, 2500, 5000]; // ms — หน่วงเพิ่มขึ้นเรื่อยๆ กันซ้ำเติมตอนเซิร์ฟเวอร์แน่น

// คำสั่งที่เป็นการ "อ่าน" อย่างเดียว ลองใหม่ได้โดยไม่เกิดข้อมูลซ้ำ
// (คำสั่งบันทึก/ส่งใบเบิก จะไม่ลองใหม่ เพราะ request อาจถึงเซิร์ฟเวอร์แล้วแต่ตอบกลับไม่ทัน)
const READ_ONLY_ACTION = /^(get|list|load|fetch|search|check|login)/i;

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

export class ApiError extends Error {
  // kind: 'network' = ติดต่อ/อ่านคำตอบไม่ได้ (ลองใหม่ได้), 'server' = เซิร์ฟเวอร์ตอบว่าทำไม่สำเร็จ
  constructor(message, kind, cause) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.cause = cause;
  }
}

// ข้อความ error ที่เอาไปโชว์ผู้ใช้ได้เลย — ใช้แทนการ hardcode "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ"
// ซึ่งเดิมกลบข้อความจริงจากเซิร์ฟเวอร์จนหาสาเหตุไม่เจอ
export const errMessage = (err, fallback = 'เกิดข้อผิดพลาด กรุณาลองใหม่อีกครั้ง') => {
  if (!err) return fallback;
  if (err.name === 'AbortError') return 'ยกเลิกการเชื่อมต่อแล้ว';
  return err.message || fallback;
};

// --- ตัวจำกัดจำนวน request ที่วิ่งพร้อมกัน ---
let active = 0;
const waiting = [];
const pump = () => {
  while (active < MAX_CONCURRENT && waiting.length) {
    active++;
    waiting.shift()();
  }
};
const acquire = () => new Promise((resolve) => { waiting.push(resolve); pump(); });
const release = () => { active--; pump(); };

const requestOnce = async (action, payload, timeoutMs) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const toSql = SQL_ACTIONS.has(action);

  let response;
  try {
    response = await fetch(toSql ? SQL_ENDPOINT : SCRIPT_URL, {
      method: 'POST',
      // Apps Script: ไม่ใส่ Content-Type ตั้งใจ ให้เป็น text/plain เบราว์เซอร์จะได้ไม่ยิง preflight (GAS ไม่รองรับ)
      // /api/schedule: เป็น origin เดียวกัน ไม่มี preflight อยู่แล้ว จึงส่ง JSON ตรงๆ ให้ Vercel parse body ให้เลย
      headers: toSql ? { 'Content-Type': 'application/json' } : undefined,
      body: JSON.stringify({ action, ...payload }),
      redirect: 'follow', // GAS ตอบ 302 ไป script.googleusercontent.com เสมอ
      signal: controller.signal,
    });
  } catch (err) {
    if (controller.signal.aborted) {
      throw new ApiError('เซิร์ฟเวอร์ตอบกลับช้าเกินไป (หมดเวลารอ) กรุณาลองใหม่อีกครั้ง', 'network', err);
    }
    throw new ApiError('ติดต่อเซิร์ฟเวอร์ไม่ได้ กรุณาตรวจสอบสัญญาณอินเทอร์เน็ตแล้วลองใหม่', 'network', err);
  } finally {
    clearTimeout(timer);
  }

  // อ่านเป็น text ก่อน เพราะเวลา GAS ล่ม/ติดลิมิต มันตอบเป็นหน้า HTML ไม่ใช่ JSON
  let text;
  try {
    text = await response.text();
  } catch (err) {
    throw new ApiError('อ่านข้อมูลจากเซิร์ฟเวอร์ไม่สำเร็จ (การเชื่อมต่อหลุดกลางคัน)', 'network', err);
  }

  let result;
  try {
    result = JSON.parse(text);
  } catch {
    result = null;
  }

  if (!result || typeof result !== 'object') {
    if (response.status === 429 || /too many|quota|exceeded|overloaded/i.test(text)) {
      throw new ApiError('มีการเรียกใช้งานพร้อมกันมากเกินไป ระบบจะลองใหม่ให้อัตโนมัติ', 'network');
    }
    throw new ApiError(`เซิร์ฟเวอร์ตอบกลับไม่ถูกต้อง (HTTP ${response.status}) — Google Apps Script อาจล่มหรือถูกจำกัดชั่วคราว`, 'network');
  }

  if (!response.ok) {
    throw new ApiError(
      result.message || `เซิร์ฟเวอร์ตอบกลับผิดพลาด (HTTP ${response.status})`,
      response.status >= 500 ? 'network' : 'server',
    );
  }

  if (result.status !== 'success') {
    throw new ApiError(result.message || 'เกิดข้อผิดพลาดจากเซิร์ฟเวอร์', 'server');
  }

  return result;
};

/**
 * เรียก Google Apps Script
 * @param {string} action ชื่อคำสั่ง
 * @param {object} payload ข้อมูลที่ส่งไปด้วย
 * @param {{ retries?: number, timeoutMs?: number }} [options]
 *        retries — จำนวนครั้งที่ลองใหม่ (ค่าเริ่มต้น: คำสั่งอ่าน = 3, คำสั่งบันทึก = 0)
 */
export const apiCall = async (action, payload, options = {}) => {
  if (SCRIPT_URL === "YOUR_GOOGLE_APPS_SCRIPT_WEB_APP_URL" || SCRIPT_URL === "") {
    throw new ApiError("กรุณาตั้งค่า SCRIPT_URL ในไฟล์ src/services/api.js ก่อนใช้งาน", 'server');
  }

  const timeoutMs = options.timeoutMs ?? TIMEOUT_MS;
  const retries = options.retries ?? (READ_ONLY_ACTION.test(action) ? RETRY_DELAYS.length : 0);

  await acquire();
  const deadline = Date.now() + (options.deadlineMs ?? DEADLINE_MS);
  try {
    for (let attempt = 0; ; attempt++) {
      try {
        // ตัด timeout ของรอบนี้ไม่ให้ล้ำ deadline รวม — เดิมทุกรอบใช้ 30 วิเต็มโดยไม่สนเวลาที่ใช้ไปแล้ว
        // ทำให้ 3 รอบรวมกันเป็น ~93 วิ ทั้งที่ตั้ง deadline ไว้ 70 วิ (ผู้ใช้นั่งรอค้างเกินจริงเกือบครึ่งนาที)
        const remaining = deadline - Date.now();
        return await requestOnce(action, payload, Math.min(timeoutMs, remaining));
      } catch (err) {
        // เซิร์ฟเวอร์ตอบมาแล้วว่าทำไม่ได้ (เช่น รหัสผ่านผิด, ไม่พบข้อมูล) — ลองใหม่ก็ได้ผลเดิม
        const delay = RETRY_DELAYS[Math.min(attempt, RETRY_DELAYS.length - 1)];
        // เผื่อเวลาให้รอบใหม่ได้ยิงจริงอย่างน้อย MIN_ATTEMPT_MS ไม่งั้นเป็นการยิงซ้ำใส่ GAS ที่แน่นอยู่แล้วฟรีๆ
        // (การ abort ฝั่งเบราว์เซอร์ไม่ได้หยุด GAS ที่กำลังรัน ยิงซ้ำ = งานค้างซ้อนกันในบัญชีเดียว)
        if (err.kind === 'server' || attempt >= retries || Date.now() + delay + MIN_ATTEMPT_MS >= deadline) {
          console.error(`API Error [${action}]`, err);
          throw err;
        }
        await sleep(delay);
      }
    }
  } finally {
    release();
  }
};
