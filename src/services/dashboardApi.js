// บริการดึงข้อมูลแดชบอร์ดสาขา (ยอดขาย/ต้นทุน/กำไร/บิล/ลูกค้า/ยอดขายรายวัน)
// เรียกผ่าน /api/dashboard (Vercel) ซึ่ง proxy ไปที่ office-server ที่มี cache รายวันอยู่แล้ว

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
  const res = await fetch(`/api/dashboard?${params.toString()}`, { signal });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== 'success') {
    throw new Error((json && json.message) || `ดึงข้อมูลไม่สำเร็จ (${res.status})`);
  }
  return json; // { status, branch, outletId, data:{...} }
}

// ดึงรายการบิลทั้งหมด (ตารางรายการขาย) ของสาขาในช่วงเวลา
export async function fetchBills({ branch, outletId, startDate, endDate, signal }) {
  const params = new URLSearchParams({ startDate, endDate });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  const res = await fetch(`/api/bills?${params.toString()}`, { signal });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== 'success') {
    throw new Error((json && json.message) || `ดึงรายการบิลไม่สำเร็จ (${res.status})`);
  }
  return json; // { status, branch, outletId, count, data:[...] }
}

// ดึงใบเบิก (TRF/RCV) ของสาขาในช่วงเวลา — ใช้คิดต้นทุนจริงจากใบเบิกในตารางสรุปกำไร/ขาดทุน
export async function fetchWithdrawals({ branch, outletId, startDate, endDate, signal }) {
  const params = new URLSearchParams({ startDate, endDate });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  const res = await fetch(`/api/withdrawals?${params.toString()}`, { signal });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== 'success') {
    throw new Error((json && json.message) || `ดึงใบเบิกไม่สำเร็จ (${res.status})`);
  }
  return json; // { status, data:[ { invNo, docNo, docDate, docType, items:[{itemCode,itemName,qty,unit,unitPrice,amount}] } ] }
}

// ดึงยอดคงเหลือสต๊อกล่าสุด (จากชีท "ข้อมูลนับสตอค") — เลือกวันนับล่าสุดที่ <= endDate ของสาขานั้น
// พร้อมรายจ่ายจาก Supplier (ชีท "ต้นทุนจากsup") ในช่วง [startDate, endDate]
export async function fetchStockCount({ branch, startDate, endDate, signal }) {
  const params = new URLSearchParams();
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (startDate) params.set('start', startDate);
  if (endDate) params.set('end', endDate);
  const res = await fetch(`/api/stockcount?${params.toString()}`, { signal });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== 'success') {
    throw new Error((json && json.message) || `ดึงข้อมูลสต๊อกไม่สำเร็จ (${res.status})`);
  }
  return json; // { status, branch, current:{...}, previous:{...}, supCost:{total,count,items} }
}

// ดึงรายละเอียดรายการในบิลเดียว (line items)
export async function fetchBillDetail({ branch, outletId, date, checkID, signal }) {
  const params = new URLSearchParams({ date, checkID: String(checkID) });
  if (branch) params.set('branch', String(branch).toLowerCase());
  if (outletId) params.set('outletId', String(outletId));
  const res = await fetch(`/api/billdetail?${params.toString()}`, { signal });
  const json = await res.json().catch(() => null);
  if (!res.ok || !json || json.status !== 'success') {
    throw new Error((json && json.message) || `ดึงรายละเอียดบิลไม่สำเร็จ (${res.status})`);
  }
  return json; // { status, ..., data:[...] }
}
