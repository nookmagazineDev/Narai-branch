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

// เปิดทีละกลุ่ม ไม่เปิดรวดเดียว เพราะบาง action มีหน้าอื่นใช้ร่วมด้วย
//
// รอบแรกเคยเปิด getScheduleEmployees ทั้งที่ hr_employee ยังว่าง ผลคือ
// "หน้านับสต๊อก/ขอเบิก" ที่ใช้ action เดียวกันดึงรายชื่อผู้เบิก-ผู้นับ กลายเป็นดรอปดาวน์ว่าง
// ใช้งานไม่ได้ทั้งหน้า — ก่อนเปิดตัวไหนต้องไล่ดูก่อนว่ามีหน้าไหนเรียกบ้าง
//
// สถานะข้อมูลตอนเปิดกลุ่มนี้: พนักงาน 356 คน, กะ 2,412 แถว (ย้อนหลัง 1 เดือน),
// กะที่หาเจ้าของไม่เจอ 6 แถว (0.25%)
const SQL_ACTIONS = new Set([
  // กลุ่มที่ 1 — กระทบเฉพาะหน้าลงตารางงานกับหน้าประวัติ ไม่มีหน้าอื่นเรียก
  'getHistoryData',        // ScheduleWeekly, ScheduleHistory
  'saveTimesheet',         // ScheduleWeekly
  'updateOTApprovalBulk',  // ScheduleHistory
  'updateWorkStation',     // ยังไม่มีหน้าไหนเรียก
  'getBranchStats',        // ScheduleWeekly (การ์ดเป้าขาย)
  'getDailySales',         // ScheduleHistory (การ์ดยอดขาย)

  // กลุ่มที่ 2 — อ่านจาก SQL เพื่อความเร็ว แต่ยังเช็คของใหม่จากชีทเงียบๆ ข้างหลัง
  // ห้ามเรียก action นี้ด้วย apiCall() ตรงๆ ให้ใช้ fetchScheduleEmployees() แทน
  // เพราะมันจัดการ fallback ตอน SQL ว่าง และการซิงก์กลับให้ครบ
  'getScheduleEmployees',  // ScheduleWeekly + StockList (หน้านับสต๊อก) ใช้ร่วมกัน

  // กลุ่มที่ 3 — เมนูสต๊อก (นับสต๊อก/ขอเบิก, รวมสต๊อกทุกสาขา, ปิดยอดสิ้นเดือน, ของเสีย)
  //
  // ทั้งชุดต้องสลับพร้อมกัน เพราะอ่านกับเขียนอ้างข้อมูลก้อนเดียวกัน — ถ้าเปิดแค่ฝั่งอ่าน
  // สาขานับเสร็จกดบันทึกแล้วหน้าจะยังโชว์ยอดเก่า เหมือนบันทึกไม่ติด
  //
  // การ์ดมูลค่าสต๊อกบนหน้า Dashboard (/api/stockcount) ย้ายมาอ่าน SQL พร้อมกันแล้ว
  // ส่วนที่ยังอยู่บนชีทคือหน้ารับของกับสถานะใบเบิก เพราะเป็นชีทที่ทีมสโตร์กรอกเอง
  'getStockItems',              // StockList
  'getStockTotal',              // StockTotalList
  'saveStock',                  // StockList — บันทึกการนับ + ใบเบิก + ยอดยกมา
  'updateStorageCategory',      // StockList
  'saveAvgPerHead',             // StockList
  'saveBranchPercentagesBulk',  // StockList
  'getClosingItems',            // MonthEndClosing
  'getMonthEndClosing',         // MonthEndClosing
  'saveMonthEndClosing',        // MonthEndClosing
  'saveWaste',                  // Waste

  // กลุ่มที่ 4 — หน้าล็อกอิน (ผู้ใช้ย้ายจากชีท User ไปตาราง hr_user)
  // ห้ามเรียกด้วย apiCall() ตรงๆ ให้ใช้ loginUser() แทน เพราะมันมีทางถอยเมื่อ office-server ล่ม
  'login',                      // Login
]);

// ---------------------------------------------------------------------------
// รายชื่อพนักงาน: Google Sheet เป็นตัวหลัก SQL คัดลอกตามให้อัตโนมัติ
//
// เพิ่มพนักงาน / ให้ลาออก / แก้ค่าแรง ยังทำที่เดิมทุกอย่าง (หน้ารายชื่อพนักงาน -> ชีท)
// แล้วทุกครั้งที่หน้าไหนดึงรายชื่อพนักงาน ผลลัพธ์จะถูกส่งไปเก็บใน hr_employee ด้วย
// ฝั่ง SQL จะปรับตามให้เอง: คนใหม่ -> เพิ่ม, คนที่หายไปจากรายชื่อ -> ตั้งเป็นลาออก
//
// ข้อดีที่สำคัญกว่าความสะดวก: SQL จะได้ "รหัสพนักงานชุดเดียวกับที่หน้าเว็บใช้" เป๊ะ
// ไม่ต้องเดาว่ารหัสในชีท HR (0808001) กับในตารางงาน (740808001) ตัวไหนถูก
// ซึ่งเป็นปัญหาที่ทำให้ตอนย้ายข้อมูลครั้งแรกกะ 72% หาเจ้าของไม่เจอ
//
// ยิงแบบไม่รอผล ถ้าคัดลอกไม่สำเร็จก็ไม่กระทบผู้ใช้ (ชีทเป็นตัวหลักอยู่แล้ว)
// ---------------------------------------------------------------------------
const MIRROR_TO_SQL = new Set(['getScheduleEmployees']);

const mirrorToSql = (action, payload, result) => {
  if (!Array.isArray(result?.data) || result.data.length === 0) return;
  const branch = String(payload?.branch || '').trim();
  if (!branch) return;

  fetch(SQL_ENDPOINT, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({
      action: 'syncEmployees',
      branch,
      employees: result.data,
      _user: sessionUser(),
    }),
    keepalive: true, // ให้ยิงจบแม้ผู้ใช้เปลี่ยนหน้าไปแล้ว
  })
    .then((res) => res.json())
    .then((res) => {
      if (res?.status === 'success') {
        const d = res.data || {};
        if (d.added || d.resigned) {
          console.info(`ซิงก์พนักงานสาขา ${branch} -> SQL: เพิ่ม/อัปเดต ${d.upserted ?? 0}, ตั้งเป็นลาออก ${d.resigned ?? 0}`);
        }
      } else {
        console.warn(`ซิงก์พนักงานสาขา ${branch} ไม่สำเร็จ:`, res?.message);
      }
    })
    .catch((err) => console.warn(`ซิงก์พนักงานสาขา ${branch} ไม่สำเร็จ:`, err?.message || err));
};

/** ลายนิ้วมือของรายชื่อ ใช้เทียบว่าชีทเปลี่ยนไปจากที่เก็บใน SQL หรือยัง */
const rosterSignature = (list) =>
  (list || [])
    .map((e) => `${e.hrCode}|${e.name}|${e.position || ''}|${e.type || e.empType || ''}|${e.dailyWage || 0}`)
    .sort()
    .join('~');

/**
 * ดึงรายชื่อพนักงานของสาขา — เร็วจาก SQL แต่ยังตามการแก้ในชีททัน
 *
 * ปัญหาที่ต้องแก้พร้อมกันสองข้อ
 *   1) Apps Script ช้า (เปิดสเปรดชีตทั้งไฟล์ทุกครั้ง) เปิดหน้าลงตารางแล้วรอนาน
 *   2) ถ้าอ่านจาก SQL เฉยๆ การแก้ในชีท (เพิ่มคน/ให้ลาออก/แก้ค่าแรง) จะไม่มีทางเข้า SQL
 *      เพราะตัวซิงก์เดิมทำงานตอนที่หน้าเว็บไปอ่านชีท
 *
 * จึงทำเป็นสองจังหวะ
 *   จังหวะแรก  — อ่านจาก SQL คืนให้หน้าเว็บใช้ทันที (เร็ว)
 *   จังหวะสอง — เช็คชีทเงียบๆ ข้างหลัง ซิงก์เข้า SQL ให้ และถ้ารายชื่อต่างจากเดิม
 *                จะเรียก onRefresh ให้หน้าเว็บอัปเดตตัวเองในการเปิดครั้งนั้นเลย
 *
 * ถ้า SQL ยังไม่มีข้อมูลของสาขานั้น (สาขาใหม่ / ซิงก์ยังไม่ถึง) จะรอผลจากชีทแทน
 * ไม่ปล่อยให้หน้าเว็บขึ้นรายชื่อว่างเปล่า — เคสนี้เคยทำหน้านับสต๊อกใช้งานไม่ได้ทั้งหน้า
 *
 * @param {string} branch
 * @param {{ onRefresh?: (employees: any[]) => void }} [options]
 */
export const fetchScheduleEmployees = async (branch, { onRefresh } = {}) => {
  const b = String(branch || '').trim();
  if (!b) return { status: 'success', data: [] };

  let sqlRes = null;
  try {
    sqlRes = await apiCall('getScheduleEmployees', { branch: b }, { via: 'sql' });
  } catch (err) {
    console.warn('อ่านรายชื่อพนักงานจาก SQL ไม่สำเร็จ จะใช้ชีทแทน:', err?.message || err);
  }

  const fromSql = Array.isArray(sqlRes?.data) ? sqlRes.data : [];

  // SQL ไม่มีข้อมูล -> ต้องได้จากชีทก่อนคืนค่า (mirror จะซิงก์เข้า SQL ให้เอง)
  if (fromSql.length === 0) {
    return await apiCall('getScheduleEmployees', { branch: b }, { via: 'sheet' });
  }

  // มีข้อมูลแล้ว — คืนทันที แล้วค่อยเช็คของใหม่จากชีทข้างหลัง
  // ไม่ลองใหม่ (retries: 0) เพราะเป็นงานเบื้องหลัง ถ้าพลาดรอบนี้ครั้งหน้าก็เช็คใหม่
  apiCall('getScheduleEmployees', { branch: b }, { via: 'sheet', retries: 0 })
    .then((sheetRes) => {
      const fresh = Array.isArray(sheetRes?.data) ? sheetRes.data : [];
      if (fresh.length === 0) return;
      if (rosterSignature(fresh) === rosterSignature(fromSql)) return;
      console.info(`รายชื่อพนักงานสาขา ${b} ในชีทเปลี่ยนไปจากใน SQL — อัปเดตให้แล้ว`);
      if (typeof onRefresh === 'function') onRefresh(fresh);
    })
    .catch((err) => console.warn(`เช็ครายชื่อพนักงานสาขา ${b} จากชีทไม่สำเร็จ:`, err?.message || err));

  return sqlRes;
};

/**
 * office-server เวอร์ชันเก่าที่ยังไม่มี action 'login' ตอบ 400 พร้อมข้อความนี้
 *
 * 400 ปกติแปลว่า "เซิร์ฟเวอร์ตอบชัดแล้วว่าทำไม่ได้" ซึ่งไม่ควรถามชีทซ้ำ
 * แต่กรณีนี้คนละเรื่อง — มันแปลว่าเครื่องที่ออฟฟิศยังไม่ได้อัปเดตโค้ด ไม่ใช่ว่ารหัสผิด
 * ถ้าไม่แยกออก การ deploy หน้าเว็บก่อนอัปเดตเครื่องออฟฟิศจะทำให้ทุกสาขาล็อกอินไม่ได้พร้อมกัน
 * แยกไว้แล้วจึง deploy สองฝั่งลำดับไหนก่อนก็ได้
 */
const isUnknownAction = (err) => /ไม่รู้จักคำสั่ง/.test(err?.message || '');

/**
 * เข้าสู่ระบบ — ตรวจกับตาราง hr_user ใน SQL เป็นหลัก
 *
 * ห้ามเรียก apiCall('login') ตรงๆ ให้ใช้ฟังก์ชันนี้เสมอ เพราะมีทางถอยที่หน้าเว็บต้องมี
 *
 * ทำไมต้องมีทางถอย: ทุก action อื่นถ้า office-server ล่มก็แค่หน้านั้นใช้ไม่ได้
 * แต่ถ้า "ล็อกอิน" ล่มด้วยคือเข้าระบบไม่ได้เลยสักหน้า รวมถึงหน้าที่ยังวิ่งไปชีทและยังทำงานได้ปกติ
 * (หน้ารายชื่อพนักงาน หน้ารับของ หน้าใบเบิก) จึงต้องยอมเสียเวลาอีกรอบเพื่อไม่ให้เกิดกรณีนั้น
 *
 * แยกให้ชัดว่าล้มเพราะอะไร
 *   kind 'server' = SQL ตอบชัดว่ารหัสไม่ถูก/บัญชีถูกปิด -> จบตรงนี้ ไม่ต้องถามชีทซ้ำ
 *                   (ฝั่ง office-server ถามชีทให้แล้วก่อนจะตอบแบบนี้ — ดู login() ใน schedule.js)
 *   kind 'network' = ต่อ office-server ไม่ได้/ตอบ 5xx -> ยังไม่รู้ว่ารหัสถูกไหม ไปถามชีทเอง
 */
export const loginUser = async (username, password) => {
  try {
    return await apiCall('login', { username, password }, { via: 'sql', retries: 1 });
  } catch (err) {
    if (err.kind === 'server' && !isUnknownAction(err)) throw err;
    console.warn('ล็อกอินผ่าน SQL ไม่สำเร็จ จะลองผ่านชีทแทน:', err?.message || err);
    return await apiCall('login', { username, password }, { via: 'sheet' });
  }
};

export const isSqlBackedAction = (action) => SQL_ACTIONS.has(action);

// ---------------------------------------------------------------------------
// ผู้ใช้ที่ล็อกอินไว้ตั้งแต่แรก — ฝั่ง SQL ไม่มีการล็อกอินซ้อนอีกชั้น
// login ทำครั้งเดียวที่หน้าเข้าสู่ระบบ (loginUser() ด้านล่าง) แล้วเก็บ user ไว้ที่
// localStorage 'hr_user' (ดู src/contexts/AuthContext.jsx) ทุกคำสั่งที่วิ่งไป SQL
// จะแนบ user คนนี้ไปด้วยอัตโนมัติ เพื่อใช้เป็น "คนที่กดบันทึก" และใช้จำกัดสาขาฝั่งเซิร์ฟเวอร์
// หน้าเว็บจึงไม่ต้องส่งเอง
// ---------------------------------------------------------------------------
const sessionUser = () => {
  try {
    const raw = localStorage.getItem('hr_user');
    if (!raw) return null;
    const u = JSON.parse(raw);
    if (!u || !u.username) return null;
    return { username: String(u.username), branch: String(u.branch || ''), name: String(u.name || '') };
  } catch {
    return null; // localStorage อ่านไม่ได้/ข้อมูลเสีย — ปล่อยให้เซิร์ฟเวอร์ปฏิเสธเอง
  }
};

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

const requestOnce = async (action, payload, timeoutMs, via) => {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  // via บังคับเส้นทางได้ ('sql' หรือ 'sheet') ไม่ใส่ = ตัดสินจาก SQL_ACTIONS ตามปกติ
  // จำเป็นเพราะ fetchScheduleEmployees() ต้องอ่านทั้งสองทางในคำสั่งเดียวกัน
  const toSql = via ? via === 'sql' : SQL_ACTIONS.has(action);

  let response;
  try {
    response = await fetch(toSql ? SQL_ENDPOINT : SCRIPT_URL, {
      method: 'POST',
      // Apps Script: ไม่ใส่ Content-Type ตั้งใจ ให้เป็น text/plain เบราว์เซอร์จะได้ไม่ยิง preflight (GAS ไม่รองรับ)
      // /api/schedule: เป็น origin เดียวกัน ไม่มี preflight อยู่แล้ว จึงส่ง JSON ตรงๆ ให้ Vercel parse body ให้เลย
      headers: toSql ? { 'Content-Type': 'application/json' } : undefined,
      // _user = คนที่ล็อกอินไว้ตั้งแต่แรก แนบไปให้ฝั่ง SQL เอง จะได้ไม่ต้องล็อกอินซ้อนอีกชั้น
      body: JSON.stringify(toSql ? { action, ...payload, _user: sessionUser() } : { action, ...payload }),
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
        const result = await requestOnce(action, payload, Math.min(timeoutMs, remaining), options.via);
        // คัดลอกรายชื่อพนักงานไปเก็บใน SQL ด้วย — ไม่รอผล ไม่ให้กระทบเวลาโหลดหน้า
        // ซิงก์เข้า SQL เมื่อคำขอนี้ไปหยิบมาจากชีทจริงๆ เท่านั้น
        // (ถ้าอ่านมาจาก SQL อยู่แล้วก็ไม่มีอะไรต้องซิงก์)
        const cameFromSheet = options.via ? options.via === 'sheet' : !SQL_ACTIONS.has(action);
        if (MIRROR_TO_SQL.has(action) && cameFromSheet) mirrorToSql(action, payload, result);
        return result;
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
