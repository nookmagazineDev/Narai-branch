// ร่างการนับสต๊อกที่เก็บไว้ในเครื่อง — กันยอดที่กรอกค้างไว้หายตอนรีเฟรช/ปิดแท็บ
// ---------------------------------------------------------------------------
// หน้านับสต๊อกเก็บยอดที่พิมพ์ไว้ใน state ของ React ล้วน ๆ ยังไม่ได้ส่งขึ้นเซิร์ฟเวอร์จนกว่าจะกดบันทึก
// ระหว่างนั้นถ้าเผลอรีเฟรช ปิดแท็บ หรือเครื่องหลับ ยอดที่นับมาทั้งชั้นหายหมด ต้องเดินนับใหม่
// (สาขาหนึ่งมีสินค้า 200-300 ตัว และมักนับกันข้ามชั่วโมง)
//
// เก็บเฉพาะสิ่งที่ผู้ใช้พิมพ์เอง (ยอดคงเหลือ/ยอดขอเบิก + ชื่อคนนับ/ผู้เบิก/วันที่รับของ)
// ไม่เก็บข้อมูลที่มาจากเซิร์ฟเวอร์ เพราะของพวกนั้นต้องเป็นของใหม่เสมอตอนเปิดหน้า
//
// แยกร่างตามสาขา — เครื่องเดียวสลับสาขาไปมาได้โดยร่างไม่ปนกัน
// ---------------------------------------------------------------------------

const PREFIX = 'stock_count_draft_v1';
const MAX_AGE_MS = 24 * 60 * 60 * 1000;   // ร่างข้ามวันไม่มีความหมายแล้ว (ยอดนับเป็นของวันนั้น)

const keyOf = (branch) => `${PREFIX}:${String(branch || '').toLowerCase()}`;

/** อ่านร่างของสาขานั้น ไม่มี/หมดอายุ/เสีย คืน null */
export const loadStockDraft = (branch) => {
  if (!branch) return null;
  try {
    const raw = localStorage.getItem(keyOf(branch));
    if (!raw) return null;
    const d = JSON.parse(raw);
    if (!d || typeof d !== 'object' || !d.values || typeof d.values !== 'object') return null;
    // ร่างเก่าข้ามวันทิ้งไปเลย ไม่งั้นยอดเมื่อวานจะโผล่มาให้กดบันทึกทับของวันนี้
    if (d.savedAt && Date.now() - new Date(d.savedAt).getTime() > MAX_AGE_MS) {
      clearStockDraft(branch);
      return null;
    }
    return {
      branch: d.branch || '',
      values: d.values,                       // { productId: { remaining, requested } }
      counterName: d.counterName || '',
      requesterName: d.requesterName || '',
      requestDate: d.requestDate || '',
      savedAt: d.savedAt || '',
    };
  } catch {
    // ร่างเสียหาย (ถูกแก้มือ/เวอร์ชันเก่า) — ทิ้งดีกว่าทำหน้าพัง
    return null;
  }
};

/**
 * เก็บร่าง — values ว่างทั้งก้อน = ลบร่างทิ้ง
 * เรียกได้บ่อยเท่าที่ต้องการ (เขียน localStorage ไม่กี่สิบ KB ต่อครั้ง)
 */
export const saveStockDraft = (branch, { values, counterName, requesterName, requestDate }) => {
  if (!branch) return;
  const clean = {};
  for (const [id, v] of Object.entries(values || {})) {
    const remaining = v?.remaining ?? '';
    const requested = v?.requested ?? '';
    if (String(remaining) === '' && String(requested) === '') continue;
    clean[id] = { remaining: String(remaining), requested: String(requested) };
  }
  try {
    if (Object.keys(clean).length === 0) {
      localStorage.removeItem(keyOf(branch));
      return;
    }
    localStorage.setItem(keyOf(branch), JSON.stringify({
      branch, values: clean, counterName: counterName || '', requesterName: requesterName || '',
      requestDate: requestDate || '', savedAt: new Date().toISOString(),
    }));
  } catch (err) {
    // localStorage เต็มหรือถูกปิด — ห้ามทำให้นับสต๊อกต่อไม่ได้
    console.warn('เก็บร่างนับสต๊อกลงเครื่องไม่สำเร็จ:', err?.message || err);
  }
};

/** บันทึกขึ้นเซิร์ฟเวอร์สำเร็จแล้ว — ลบร่างทิ้ง */
export const clearStockDraft = (branch) => {
  if (!branch) return;
  try {
    localStorage.removeItem(keyOf(branch));
  } catch {
    // ลบไม่ได้ก็ไม่เป็นไร รอบหน้าถูกเขียนทับอยู่ดี
  }
};

/** จำนวนช่องที่ค้างอยู่ในร่าง — ใช้บอกผู้ใช้ว่ากู้คืนมากี่รายการ */
export const countDraftValues = (draft) => Object.keys(draft?.values || {}).length;
