/* global __BUILD_ID__ */
import { branchCodes } from '../utils/branchAlias';

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

/* ───────────── จับเครื่องที่ยังถือไฟล์ชุดเก่าค้างอยู่ ─────────────
   หน้าเว็บเลือกว่าจะยิงไป SQL หรือ Apps Script จาก SQL_ACTIONS ซึ่งถูก "ฝังอยู่ในไฟล์ JavaScript
   ที่เบราว์เซอร์โหลดไป" ไม่ใช่ค่าที่ถามเซิร์ฟเวอร์ตอนใช้งาน เครื่องที่แคชไฟล์ชุดเก่าไว้ (หรือเปิดจาก
   bookmark ของ deployment เก่า) จึงยังยิงไป Apps Script แล้วอ่าน-เขียนชีทต่อไปได้เงียบ ๆ
   เคสจริง: สาขา CRM นับสต๊อกวันที่ 20/09/2026 ลงชีท ส่วนแอดมินดู SQL เห็นแค่ 17/09 ไม่มีอะไรฟ้อง

   /api/schedule ตอบ header x-app-build = รุ่นที่ deploy อยู่จริง เทียบกับรุ่นที่ฝังมากับไฟล์นี้
   ต่างกันเมื่อไหร่ = ไฟล์ชุดนี้เก่าแล้ว ต้องบอกผู้ใช้ให้โหลดใหม่ ไม่ปล่อยให้ทำงานต่อแบบไม่รู้ตัว */
const BUILD_ID = typeof __BUILD_ID__ === 'string' ? __BUILD_ID__ : 'dev';
let staleBuild = false;

/** ไฟล์ที่เบราว์เซอร์ถืออยู่เก่ากว่าที่ deploy อยู่จริงหรือยัง */
export const isStaleBuild = () => staleBuild;

function checkBuild(response) {
  // 'dev' = รันในเครื่องนักพัฒนา (ยังไม่มีรหัสรุ่นจริง) ไม่ต้องเทียบ
  if (staleBuild || BUILD_ID === 'dev') return;
  let served;
  try {
    served = response.headers.get('x-app-build') || '';
  } catch {
    return;   // บางเบราว์เซอร์/โหมดอ่าน header ไม่ได้ ไม่ใช่เรื่องที่ต้องทำให้คำขอล้ม
  }
  if (!served || served === 'dev' || served === BUILD_ID) return;
  staleBuild = true;
  console.warn(`หน้าเว็บนี้เป็นไฟล์รุ่น ${BUILD_ID.slice(0, 7)} แต่เซิร์ฟเวอร์ให้บริการรุ่น ${served.slice(0, 7)} แล้ว`);
  try {
    window.dispatchEvent(new CustomEvent('app-stale-build', { detail: { loaded: BUILD_ID, served } }));
  } catch {
    // ไม่มี window (เทส/SSR) — แค่ตั้งธงไว้ก็พอ
  }
}

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
  'getScheduleLocks',      // ScheduleWeekly (วันที่ออฟฟิศล็อกตารางไว้)
  'getBranchStats',        // ScheduleWeekly (การ์ดเป้าขาย)
  'getDailySales',         // ScheduleHistory (การ์ดยอดขาย)

  // กลุ่มที่ 2 — อ่านจาก SQL เพื่อความเร็ว แต่ยังเช็คของใหม่จากชีทเงียบๆ ข้างหลัง
  // ห้ามเรียก action นี้ด้วย apiCall() ตรงๆ ให้ใช้ fetchEmployees() แทน
  // เพราะมันจัดการ fallback ตอน SQL ว่าง การรวมรหัสสาขาพี่น้อง และการซิงก์กลับให้ครบ
  //
  // getEmployees (หน้ารายชื่อพนักงาน) ไม่ได้อยู่ในลิสต์นี้ทั้งที่อ่าน SQL เหมือนกัน
  // เพราะ fetchEmployees() สั่งเส้นทางเองด้วย via: 'sql' / 'sheet' ทีละครั้ง
  // ถ้าใส่ไว้ที่นี่ด้วย การอ่านชีทเพื่อเช็คของใหม่จะถูกส่งไป SQL แทน กลายเป็นไม่เคยเช็คชีทเลย
  'getScheduleEmployees',  // ScheduleWeekly + StockList (หน้านับสต๊อก) ใช้ร่วมกัน

  // กลุ่มที่ 3 — เมนูสต๊อก (นับสต๊อก/ขอเบิก, รวมสต๊อกทุกสาขา, ปิดยอดสิ้นเดือน, ของเสีย)
  //
  // ทั้งชุดต้องสลับพร้อมกัน เพราะอ่านกับเขียนอ้างข้อมูลก้อนเดียวกัน — ถ้าเปิดแค่ฝั่งอ่าน
  // สาขานับเสร็จกดบันทึกแล้วหน้าจะยังโชว์ยอดเก่า เหมือนบันทึกไม่ติด
  //
  // การ์ดมูลค่าสต๊อกบนหน้า Dashboard (/api/stockcount) ย้ายมาอ่าน SQL พร้อมกันแล้ว
  // ส่วนที่ยังอยู่บนชีทคือหน้ารับของกับสถานะใบเบิก เพราะเป็นชีทที่ทีมสโตร์กรอกเอง
  'getStockItems',              // StockList
  'stockPulse',                 // StockList — เช็คเบา ๆ ว่ามีเครื่องอื่นบันทึกอะไรใหม่ไหม
  'getStockTotal',              // StockTotalList
  'saveStock',                  // StockList — บันทึกการนับ + ใบเบิก + ยอดยกมา
  'updateStorageCategory',      // StockList
  'saveAvgPerHead',             // StockList
  'saveBranchPercentagesBulk',  // StockList
  'getClosingItems',            // MonthEndClosing
  'getMonthEndClosing',         // MonthEndClosing
  'saveMonthEndClosing',        // MonthEndClosing
  'saveWaste',                  // Waste

  // กลุ่มที่ 3.01 — กรอกรายจ่าย (ต้นทุนจาก Supplier) ย้ายจากชีท "ต้นทุนจากsup" (ดู office-server/supcost.js)
  // อ่านกับเขียนต้องสลับพร้อมกัน ไม่งั้นบันทึกลง SQL แล้วโหลดกลับจากชีท เหมือนบันทึกไม่ติด
  'getSupCost',                 // ExpenseEntry
  'saveSupCost',                // ExpenseEntry

  // กลุ่มที่ 3.05 — ยูนิฟอร์มพนักงาน (ปุ่มรูปเสื้อในหน้ารายชื่อพนักงาน)
  //
  // ทั้งชุดเป็นของใหม่ ไม่เคยมีใน Apps Script จึงไม่มีทางถอยไปชีท — เครื่องที่ถือไฟล์เก่า
  // จะไม่มีปุ่มนี้ให้กดอยู่แล้ว
  // สาขาส่งคำขอ -> ออฟฟิศ (naraipizzeria) อนุมัติและออกใบเบิก -> สาขากดได้รับของ (ดู office-server/uniform.js)
  'getUniformItems',
  'getUniformSummary',
  'getEmployeeUniform',
  'submitUniformRequest',
  'receiveUniformRequest',

  // กลุ่มที่ 3.06 — หน้าสแกนเข้า-ออก: แก้เวลาสแกนที่ขาด/ผิด (ปุ่ม "แก้ไข" ในตารางสรุปรายวัน)
  // ของใหม่ทั้งชุด ไม่เคยมีใน Apps Script — ดู office-server/attendance.js
  'getScanFixes',
  'saveScanFix',
  'deleteScanFix',

  // กลุ่มที่ 3.07 — หน้ารายชื่อพนักงาน: สัญชาติ (ไทย/ต่างชาติ) + เอกสารพนักงานต่างชาติและวันหมดอายุ
  // ของใหม่ทั้งชุด ไม่เคยมีใน Apps Script — ดู office-server/employee-doc.js
  'getEmployeeDocs',
  'saveEmployeeDoc',
  'linkEmployeeDoc',
  'deleteEmployeeDoc',
  'importEmployeeDocs',

  // กลุ่มที่ 3.1 — หน้ารับสินค้า
  //
  // ต้องสลับพร้อมกับที่แอป storefct สลับ STORE_SOURCE=sql เพราะทั้งสองฝั่งอ้างข้อมูลก้อนเดียวกัน:
  // getGoodsToReceive อ่านสิ่งที่โกดังจัดไว้ (dbo.store_fulfillment ที่ storefct เขียน) ส่วนอีกสอง
  // ตัวเขียน dbo.store_receiving ที่ storefct อ่านไปแสดงและกดอนุมัติ
  // ถ้าสลับข้างเดียว สาขาจะไม่เห็นใบที่โกดังเพิ่งจัด หรือโกดังจะไม่เห็นว่าสาขารับแล้ว
  //
  // uploadReceivePhotos ไม่ได้อยู่ในลิสต์นี้โดยตั้งใจ — รูปยังขึ้น Google Drive ผ่าน Apps Script
  // เพราะ SQL Server เขียน Drive ไม่ได้
  'getGoodsToReceive',          // ReceiveGoods
  'saveGoodsReceived',          // ReceiveGoods
  'confirmReceivedItem',        // ReceiveGoods

  // กลุ่มที่ 3.08 — พนักงาน: ย้ายจาก Google Sheet มา SQL ทั้งหมด (ดู office-server/employee-hr.js)
  // ห้ามถอยไปชีท — ชีทไม่ได้เป็นตัวหลักแล้ว เขียนลงชีทเท่ากับข้อมูลหาย
  'getNextHrCode',             // AddEmployee
  'addEmployee',               // AddEmployee
  'resignEmployee',            // EmployeeList
  'updateEmployeeLoga',        // EmployeeList
  'uploadEmployeePhoto',       // EmployeeList

  // กลุ่มที่ 4 — หน้าล็อกอิน (ผู้ใช้ย้ายจากชีท User ไปตาราง hr_user)
  // ห้ามเรียกด้วย apiCall() ตรงๆ ให้ใช้ loginUser() แทน เพราะมันมีทางถอยเมื่อ office-server ล่ม
  'login',                      // Login
]);

// ---------------------------------------------------------------------------
// รายชื่อพนักงาน: SQL (hr_employee) เป็นตัวหลัก
//
// เดิม Google Sheet เป็นตัวหลักแล้ว SQL คัดลอกตาม (อ่านชีทเบื้องหลังแล้วซิงก์เข้า SQL ทุกครั้งที่เปิดหน้า)
// ตอนนี้ เพิ่มพนักงาน / แจ้งลาออก / LOGA / รูป เขียน SQL ตรง (office-server/employee-hr.js)
// จึงเลิกอ่านชีทและเลิกคัดลอก — ชีทที่ไม่มีใครอัปเดตแล้วจะไปเขียนทับข้อมูลใหม่ใน SQL
// ---------------------------------------------------------------------------

const BKK_DATE = new Intl.DateTimeFormat('en-CA', {
  timeZone: 'Asia/Bangkok', year: 'numeric', month: '2-digit', day: '2-digit',
});

/**
 * วันที่จากชีท -> 'YYYY-MM-DD' ให้อยู่รูปเดียวกับที่ SQL ส่งมา
 *
 * Apps Script ส่งวันที่มาเป็น ISO เต็ม ซึ่งเป็นเที่ยงคืนเวลาไทย = 17:00 UTC ของ "วันก่อนหน้า"
 * ตัด 10 ตัวแรกตรงๆ วันเริ่มงานจะถอยหลังไป 1 วันทุกคน จึงต้องแปลงตามเวลาไทย
 * อ่านไม่ออกก็คืนค่าเดิม (ชีทเก่าบางแถวกรอกเป็นข้อความ) ไม่ทิ้งข้อมูลของผู้ใช้
 */
const normalizeDate = (v) => {
  if (!v) return '';
  const t = String(v).trim();
  if (/^\d{4}-\d{2}-\d{2}$/.test(t)) return t;
  const d = new Date(t);
  return Number.isNaN(d.getTime()) ? t : BKK_DATE.format(d);
};

/**
 * ลิงก์รูปพนักงาน — รูปที่อัปหลังย้ายมา SQL เก็บบนเครื่องออฟฟิศเป็น 'file:photos/xxx.jpg'
 * เปิดผ่าน /api/schedule?file=... (Vercel ส่งต่อไป office-server) ส่วนรูปเก่าบน Google Drive เป็นลิงก์ตรงตามเดิม
 */
const photoHref = (v) => {
  const s = String(v ?? '').trim();
  return s.startsWith('file:') ? `${SQL_ENDPOINT}?file=${encodeURIComponent(s.slice(5))}` : s;
};

/**
 * ปรับรูปข้อมูลพนักงานให้เป็นชุดเดียวกันไม่ว่ามาจากทางไหน
 *
 * ชีทสองคำสั่งเรียกฟิลด์ชื่อไม่เหมือนกัน (getEmployees ให้ fullName, getScheduleEmployees ให้ name)
 * และแต่ละทางรู้ข้อมูลคนละส่วน หน้าเว็บจึงเคยต้องจำว่า "หน้านี้ต้องอ่านฟิลด์ชื่อไหน"
 * ตรงนี้เติมให้ครบทั้งสองชื่อและใส่ค่าว่างให้ฟิลด์ที่ทางนั้นไม่มี หน้าเว็บจะได้ไม่ต้องรู้ที่มา
 */
const normalizeEmployee = (e) => {
  const name = String(e?.name ?? e?.fullName ?? '').trim();
  // ทุกสาขาที่คนนี้สังกัด — ชีทส่งมาเป็นข้อความช่องเดียว ('SUM, IPR') ส่วน SQL ส่งมาเป็นอาเรย์แล้ว
  // คนทั่วไปได้รหัสเดียว หน้าเว็บจึงเช็ค "คนของสองร้าน" ด้วย branches.length > 1 ได้ที่เดียวจบ
  const branches = branchCodes(
    Array.isArray(e?.branches) ? e.branches.join(',') : (e?.branches ?? e?.branch)
  );
  return {
    ...e,
    hrCode: String(e?.hrCode ?? '').trim(),
    name,
    fullName: name,
    branch: e?.branch ?? '',
    branches,
    type: e?.type ?? e?.empType ?? '',
    empType: e?.empType ?? e?.type ?? '',
    position: e?.position ?? '',
    status: e?.status ?? '',
    dailyWage: e?.dailyWage ?? '',
    startDate: normalizeDate(e?.startDate),
    loga: e?.loga ?? '',
    newCode: e?.newCode ?? '',
    photoUrl: photoHref(e?.photoUrl),
  };
};

/**
 * ดึงรายชื่อพนักงานของสาขา — ทุกหน้าใช้ตัวนี้ตัวเดียว (อ่าน SQL อย่างเดียว)
 *
 * @param {string} branch
 * @param {object} [options]
 * @param {boolean} [options.includeResigned] เอาคนที่ลาออกแล้วมาด้วย (หน้ารายชื่อพนักงาน)
 * fresh / onRefresh ยังรับไว้ให้หน้าที่ส่งมาไม่พัง แต่ไม่มีผลแล้ว — ไม่มีชีทให้เช็คของใหม่อีก
 */
export const fetchEmployees = async (branch, { includeResigned = false } = {}) => {
  const b = String(branch || '').trim();
  if (!b) return { status: 'success', data: [] };
  const res = await apiCall('getEmployees', { branch: b, includeResigned }, { via: 'sql' });
  if (res?.status !== 'success') return res;
  return { status: 'success', data: (Array.isArray(res.data) ? res.data : []).map(normalizeEmployee) };
};


/** ชื่อเดิมของ fetchEmployees() — หน้าลงตารางงานกับหน้านับสต๊อกยังเรียกชื่อนี้อยู่ */
export const fetchScheduleEmployees = (branch, options) => fetchEmployees(branch, options);

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
  // code = รหัสที่เซิร์ฟเวอร์ส่งมา (เช่น 'SCHEDULE_LOCKED') · status = HTTP status · body = คำตอบทั้งก้อน
  constructor(message, kind, cause, extra = {}) {
    super(message);
    this.name = 'ApiError';
    this.kind = kind;
    this.cause = cause;
    this.code = extra.code || '';
    this.status = extra.status || 0;
    this.body = extra.body || null;
  }
}

// ข้อความ error ที่เอาไปโชว์ผู้ใช้ได้เลย — ใช้แทนการ hardcode "เชื่อมต่อเซิร์ฟเวอร์ไม่สำเร็จ"
// ซึ่งเดิมกลบข้อความจริงจากเซิร์ฟเวอร์จนหาสาเหตุไม่เจอ
/** เซิร์ฟเวอร์ปฏิเสธเพราะวันนั้นออฟฟิศล็อกตารางงานไว้แล้ว (HTTP 423) — ลองส่งซ้ำก็ไม่ผ่าน */
export const isScheduleLocked = (err) => err?.code === 'SCHEDULE_LOCKED' || err?.status === 423;

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

  if (toSql) checkBuild(response);

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
      undefined,
      { code: result.code, status: response.status, body: result },
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
