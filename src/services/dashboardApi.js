// บริการดึงข้อมูลแดชบอร์ดสาขา (ยอดขาย/ต้นทุน/กำไร/บิล/ลูกค้า/ยอดขายรายวัน)
// เรียกผ่าน /api/dashboard (Vercel) ซึ่ง proxy ไปที่ office-server ที่มี cache รายวันอยู่แล้ว

// ---- ตัวเรียก /api/* ที่ทน error ชั่วคราว ----
// เส้นทางคือ เบราว์เซอร์ -> Vercel -> office-server ที่ออฟฟิศ (ผ่าน dyndns พอร์ต 8787)
// มีจุดหลุดได้หลายที่ (เน็ตสาขา, เน็ตออฟฟิศ, cold start ของ Vercel, ช่วงที่ office-server อุ่น cache)
// เดิมเจอ error ปุ๊บเด้งทันที เลยชอบขึ้น "ติดต่อเซิร์ฟเวอร์ไม่ได้" ทั้งที่รอแป๊บเดียวก็ได้
// GET ทั้งหมดเป็นการอ่านอย่างเดียว จึงลองใหม่ได้ปลอดภัย
const TIMEOUT_MS = 30000;   // ต่อการยิงหนึ่งครั้ง
const DEADLINE_MS = 60000;  // เวลารวมทั้งหมดรวมการลองใหม่ — เกินนี้ยอมแพ้ ไม่ปล่อยให้ผู้ใช้รอลอยๆ
const RETRY_DELAYS = [700, 1800, 4000];

// endpoint หนัก (ยอดขายรายเมนู/รายการบิล/แดชบอร์ด): office-server ต้องคำนวณข้ามหลายวัน
// วันที่ยังไม่อยู่ในแคชต้องดึงจาก POS สด ฝั่ง Vercel รอได้ถึง ~60 วิ (maxDuration)
// ถ้าเบราว์เซอร์ตัดที่ 30 วิ จะยกเลิกทั้งที่เซิร์ฟเวอร์กำลังจะตอบ — รายการเลยไม่ขึ้นทั้งที่รออีกนิดก็ได้
// ต่อรอบจึงต้องรอนานกว่าเพดานของ Vercel และเผื่อเวลารวมให้ลองใหม่ได้อีกรอบ
// (การลองใหม่ไม่เริ่มจากศูนย์ — office-server แคชรายวันที่คำนวณเสร็จแล้วไว้ รอบถัดไปจึงเร็วขึ้นเรื่อยๆ)
const HEAVY_OPTS = { timeoutMs: 65000, deadlineMs: 130000 };

const sleep = (ms) => new Promise((r) => setTimeout(r, ms));

// รวม signal ของผู้เรียก (ยกเลิกตอน component unmount) เข้ากับ timeout ภายใน
function withTimeout(outerSignal, timeoutMs) {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  const onAbort = () => controller.abort();
  if (outerSignal) {
    if (outerSignal.aborted) controller.abort();
    else outerSignal.addEventListener('abort', onAbort, { once: true });
  }
  const cleanup = () => {
    clearTimeout(timer);
    if (outerSignal) outerSignal.removeEventListener('abort', onAbort);
  };
  return { signal: controller.signal, cleanup };
}

async function getJson(url, { signal, label, timeoutMs = TIMEOUT_MS, deadlineMs = DEADLINE_MS }) {
  let lastError;
  const deadline = Date.now() + deadlineMs;
  for (let attempt = 0; attempt <= RETRY_DELAYS.length; attempt++) {
    if (signal?.aborted) throw new DOMException('Aborted', 'AbortError');
    const { signal: reqSignal, cleanup } = withTimeout(signal, timeoutMs);
    try {
      const res = await fetch(url, { signal: reqSignal });
      const text = await res.text();
      let json = null;
      try { json = JSON.parse(text); } catch { json = null; }

      if (res.ok && json && json.status === 'success') return json;

      // 502/503/504 = ต่อ office-server ไม่ได้/ไม่ทัน, 5xx อื่น = ฝั่ง Vercel เอง — ลองใหม่ได้
      if (res.status >= 500 || !json) {
        lastError = new Error((json && json.message) || `${label}ไม่สำเร็จ (${res.status})`);
      } else {
        // 4xx พร้อมข้อความจากเซิร์ฟเวอร์ = ส่งพารามิเตอร์ผิด ลองใหม่ก็ได้ผลเดิม
        throw new Error(json.message || `${label}ไม่สำเร็จ (${res.status})`);
      }
    } catch (err) {
      // ผู้เรียกสั่งยกเลิกเอง (เปลี่ยนหน้า/เปลี่ยนช่วงวันที่) — ไม่ใช่ error ที่ต้องลองใหม่
      if (signal?.aborted) throw err;
      if (err.name === 'AbortError') {
        lastError = new Error(`${label}ไม่สำเร็จ (เซิร์ฟเวอร์ตอบช้าเกินไป)`);
      } else if (err instanceof TypeError) {
        lastError = new Error(`${label}ไม่สำเร็จ (เชื่อมต่อเครือข่ายไม่ได้)`);
      } else {
        throw err; // error ที่ระบุสาเหตุชัดแล้วจากด้านบน
      }
    } finally {
      cleanup();
    }

    if (attempt >= RETRY_DELAYS.length) break;
    if (Date.now() + RETRY_DELAYS[attempt] >= deadline) break;
    await sleep(RETRY_DELAYS[attempt]);
  }
  throw lastError;
}

/**
 * เรียก /api/* แบบไม่โยน error — คืน { status:'error', message } เมื่อพลาด
 * ใช้กับจุดที่โหลดไม่ได้ก็ให้หน้าทำงานต่อได้ (จะได้ไม่พังทั้งหน้าเพราะ endpoint เดียว)
 */
export async function tryGetJson(url, label = 'ดึงข้อมูล', opts = {}) {
  try {
    return await getJson(url, { label, ...opts });
  } catch (err) {
    if (err.name === 'AbortError') throw err;
    return { status: 'error', message: err.message || `${label}ไม่สำเร็จ` };
  }
}

// ---- ตัวช่วยเรื่องวันที่ (ใช้เวลาท้องถิ่น) ----
const pad = (n) => String(n).padStart(2, '0');
export const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

// สร้างช่วงวันที่ของแต่ละพรีเซ็ตจาก "วันนี้"
export function presetRange(preset, today = new Date()) {
  const t = new Date(today.getFullYear(), today.getMonth(), today.getDate());
  switch (preset) {
    case 'thisMonth': {
      const start = new Date(t.getFullYear(), t.getMonth(), 1);
      return { startDate: fmtDate(start), endDate: fmtDate(t) };
    }
    case 'lastMonth': {
      const start = new Date(t.getFullYear(), t.getMonth() - 1, 1);
      const end = new Date(t.getFullYear(), t.getMonth(), 0); // วันสุดท้ายของเดือนที่แล้ว
      return { startDate: fmtDate(start), endDate: fmtDate(end) };
    }
    case 'lastWeek': {
      // สัปดาห์ที่แล้ว: จันทร์–อาทิตย์ ของสัปดาห์ก่อนหน้า
      const dow = (t.getDay() + 6) % 7; // 0 = จันทร์
      const thisMon = new Date(t); thisMon.setDate(t.getDate() - dow);
      const lastMon = new Date(thisMon); lastMon.setDate(thisMon.getDate() - 7);
      const lastSun = new Date(lastMon); lastSun.setDate(lastMon.getDate() + 6);
      return { startDate: fmtDate(lastMon), endDate: fmtDate(lastSun) };
    }
    case 'yesterday': {
      const y = new Date(t); y.setDate(t.getDate() - 1);
      return { startDate: fmtDate(y), endDate: fmtDate(y) };
    }
    default:
      return presetRange('thisMonth', today);
  }
}

export const PRESETS = [
  { key: 'thisMonth', label: 'เดือนนี้' },
  { key: 'lastMonth', label: 'เดือนที่แล้ว' },
  { key: 'lastWeek', label: 'สัปดาห์ที่แล้ว' },
  { key: 'yesterday', label: 'เมื่อวาน' },
  { key: 'custom', label: 'กำหนดเอง' },
];

// ดึงข้อมูลแดชบอร์ดของสาขาเดียว
export async function fetchDashboard({ branch, outletId, startDate, endDate, signal }) {
  const params = new URLSearchParams({ startDate, endDate });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  return getJson(`/api/dashboard?${params.toString()}`, { signal, label: 'ดึงข้อมูล', ...HEAVY_OPTS });
  // { status, branch, outletId, data:{...} }
}

// ดึงยอดขายรายเมนู รวม+รายวัน (หน้า "ค้นหารายการขาย") — โหมด itemsales=1 ของ /api/dashboard
export async function fetchItemSales({ branch, outletId, startDate, endDate, signal }) {
  const params = new URLSearchParams({ startDate, endDate, itemsales: '1' });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  return getJson(`/api/dashboard?${params.toString()}`, { signal, label: 'ดึงรายการขาย', ...HEAVY_OPTS });
  // { status, branch, outletId, count, data:[{itemCode,name,qty,amt,daily}] }
}

// ดึงรายการบิลทั้งหมด (ตารางรายการขาย) ของสาขาในช่วงเวลา
export async function fetchBills({ branch, outletId, startDate, endDate, signal }) {
  const params = new URLSearchParams({ startDate, endDate });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  return getJson(`/api/bills?${params.toString()}`, { signal, label: 'ดึงรายการบิล', ...HEAVY_OPTS });
  // { status, branch, outletId, count, data:[...] }
}

// ดึงใบเบิก (TRF/RCV) ของสาขาในช่วงเวลา — ใช้คิดต้นทุนจริงจากใบเบิกในตารางสรุปกำไร/ขาดทุน
export async function fetchWithdrawals({ branch, outletId, startDate, endDate, signal }) {
  const params = new URLSearchParams({ startDate, endDate });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  return getJson(`/api/withdrawals?${params.toString()}`, { signal, label: 'ดึงใบเบิก' });
  // { status, data:[ { invNo, docNo, docDate, docType, items:[{itemCode,itemName,qty,unit,unitPrice,amount}] } ] }
}

// ดึงยอดคงเหลือสต๊อกล่าสุด (จากชีท "ข้อมูลนับสตอค") — เลือกวันนับล่าสุดที่ <= endDate ของสาขานั้น
// พร้อมรายจ่ายจาก Supplier (ชีท "ต้นทุนจากsup") ในช่วง [startDate, endDate]
export async function fetchStockCount({ branch, startDate, endDate, signal }) {
  const params = new URLSearchParams();
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (startDate) params.set('start', startDate);
  if (endDate) params.set('end', endDate);
  return getJson(`/api/stockcount?${params.toString()}`, { signal, label: 'ดึงข้อมูลสต๊อก' });
  // { status, branch, current:{...}, previous:{...}, supCost:{total,count,items} }
}

// ดึงรายละเอียดรายการในบิลเดียว (line items)
export async function fetchBillDetail({ branch, outletId, date, checkID, signal }) {
  const params = new URLSearchParams({ date, checkID: String(checkID) });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  return getJson(`/api/billdetail?${params.toString()}`, { signal, label: 'ดึงรายละเอียดบิล' });
  // { status, ..., data:[...] }
}
