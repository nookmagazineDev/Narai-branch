// ร่างตารางงานที่เก็บไว้ในเครื่อง — กันข้อมูลหายตอนบันทึกขึ้นเซิร์ฟเวอร์ไม่ได้
// ---------------------------------------------------------------------------
// ที่มา: ฐานข้อมูล HR อยู่หลังไฟร์วอลล์ที่เปิดพอร์ต 1433 เฉพาะ IP ในไทย
// เว็บรันบน Vercel (ต่างประเทศ) จึงต่อไม่ได้ กดบันทึกแล้วขึ้น error
// ระหว่างที่ยังแก้เรื่องนั้นไม่เสร็จ ผู้ใช้ต้องลงตารางงานต่อได้โดยข้อมูลไม่หาย
//
// เก็บสองอย่างแยกกัน:
//   cells       - ช่องที่แก้แล้วยังไม่ได้กดบันทึก เอาไว้คืนหน้าจอตอนเปิดกลับมา
//   pendingLogs - แถวที่กดบันทึกแล้วแต่ส่งไม่สำเร็จ พร้อมส่งซ้ำได้ทันทีโดยไม่ต้องคำนวณใหม่
//
// แยกกันเพราะ pendingLogs สมบูรณ์ในตัวเอง (มีชื่อ ตำแหน่ง ค่าแรง คิดเสร็จแล้ว)
// จึงส่งซ้ำได้แม้ผู้ใช้เปลี่ยนไปสาขา/สัปดาห์อื่น ส่วน cells ต้องมีรายชื่อพนักงาน
// ของสัปดาห์นั้นประกอบถึงจะแปลงเป็น log ได้
// ---------------------------------------------------------------------------

const PREFIX = 'hr_schedule_draft_v1';

const keyOf = (branch, weekStart) => `${PREFIX}:${branch}:${weekStart}`;

const readRaw = (storageKey) => {
  try {
    const raw = localStorage.getItem(storageKey);
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object') return null;
    return {
      branch: d.branch || '',
      weekStart: d.weekStart || '',
      cells: d.cells && typeof d.cells === 'object' ? d.cells : {},
      pendingLogs: Array.isArray(d.pendingLogs) ? d.pendingLogs : [],
      updatedAt: d.updatedAt || '',
      lastError: d.lastError || '',
    };
  } catch {
    // ร่างเสียหาย (localStorage ถูกแก้มือ/เวอร์ชันเก่า) — ทิ้งไปดีกว่าทำหน้าพัง
    return null;
  }
};

const writeRaw = (storageKey, draft) => {
  const empty =
    Object.keys(draft.cells || {}).length === 0 && (draft.pendingLogs || []).length === 0;
  try {
    if (empty) localStorage.removeItem(storageKey);
    else localStorage.setItem(storageKey, JSON.stringify({ ...draft, updatedAt: new Date().toISOString() }));
  } catch (err) {
    // localStorage เต็มหรือถูกปิด — ไม่ควรทำให้กรอกตารางต่อไม่ได้
    console.warn('เก็บร่างตารางลงเครื่องไม่สำเร็จ:', err?.message || err);
  }
};

/** อ่านร่างของสาขา+สัปดาห์นั้น ไม่มีคืน null */
export const loadDraft = (branch, weekStart) => {
  if (!branch || !weekStart) return null;
  return readRaw(keyOf(branch, weekStart));
};

/**
 * เก็บช่องที่แก้ไว้ (เขียนทับของเดิม) โดยไม่แตะ pendingLogs ที่ค้างอยู่
 * ส่ง cells เป็นอ็อบเจกต์ว่างได้ = ไม่มีอะไรค้างแล้ว
 */
export const saveDraftCells = (branch, weekStart, cells) => {
  if (!branch || !weekStart) return;
  const storageKey = keyOf(branch, weekStart);
  const prev = readRaw(storageKey);
  writeRaw(storageKey, {
    branch,
    weekStart,
    cells: cells || {},
    pendingLogs: prev?.pendingLogs || [],
    lastError: prev?.lastError || '',
  });
};

/** กดบันทึกแล้วส่งไม่สำเร็จ — เก็บแถวที่คิดเสร็จแล้วไว้ส่งซ้ำ */
export const savePendingLogs = (branch, weekStart, logs, cells, lastError) => {
  if (!branch || !weekStart) return;
  writeRaw(keyOf(branch, weekStart), {
    branch,
    weekStart,
    cells: cells || {},
    pendingLogs: Array.isArray(logs) ? logs : [],
    lastError: lastError || '',
  });
};

/** ส่งขึ้นเซิร์ฟเวอร์สำเร็จแล้ว — ลบร่างทิ้งทั้งก้อน */
export const clearDraft = (branch, weekStart) => {
  if (!branch || !weekStart) return;
  try {
    localStorage.removeItem(keyOf(branch, weekStart));
  } catch {
    // ลบไม่ได้ก็ไม่เป็นไร รอบหน้าจะถูกเขียนทับอยู่ดี
  }
};

/** ร่างทั้งหมดที่ค้างอยู่ (ทุกสาขา ทุกสัปดาห์) เรียงจากเก่าไปใหม่ */
export const listDrafts = () => {
  const out = [];
  try {
    for (let i = 0; i < localStorage.length; i++) {
      const k = localStorage.key(i);
      if (!k || !k.startsWith(`${PREFIX}:`)) continue;
      const d = readRaw(k);
      if (d) out.push(d);
    }
  } catch {
    return [];
  }
  return out.sort((a, b) => String(a.updatedAt).localeCompare(String(b.updatedAt)));
};

/** จำนวนแถวที่กดบันทึกแล้วแต่ยังส่งไม่ขึ้น รวมทุกสาขา/สัปดาห์ */
export const countPendingLogs = () =>
  listDrafts().reduce((n, d) => n + (d.pendingLogs?.length || 0), 0);
