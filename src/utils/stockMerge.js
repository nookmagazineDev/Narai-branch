// ผสมข้อมูลใหม่จากเซิร์ฟเวอร์ลงตารางนับสต๊อกที่ผู้ใช้กำลังกรอกอยู่
// ---------------------------------------------------------------------------
// สองเครื่องนับสาขาเดียวกันพร้อมกันเป็นเรื่องปกติของหน้านี้ แต่ละเครื่องจึงต้องเห็น
// "ยอดนับล่าสุด" ที่อีกเครื่องเพิ่งบันทึก โดยยอดที่ตัวเองกำลังกรอกค้างไว้ต้องไม่หาย
//
// กติกา
//   - ฟิลด์ที่มาจากเซิร์ฟเวอร์ (ยอดนับล่าสุด/ยอดยกมา/ใบเบิกล่าสุด/ชื่อ/ราคา/หมวด) ใช้ของใหม่เสมอ
//   - remaining / requested ที่ผู้ใช้พิมพ์ ใช้ของเดิมเสมอ ไม่ว่าเซิร์ฟเวอร์จะว่าอะไร
//   - ค่าที่ loadData คำนวณไว้จาก endpoint อื่น (ยอดเดือนก่อน/ค่าตั้งเบิก) คงของเดิม รอบนี้ไม่ได้ดึงมา
//   - เรียงลำดับตามที่เซิร์ฟเวอร์ส่งมา สินค้าที่เพิ่ง "เพิ่ม/ถอด" ออกจากทะเบียนจึงตามไปด้วย
//
// แยกออกมาจาก StockList.jsx เพราะเป็นหัวใจของเรื่อง "ข้อมูลสองเครื่องต้องตรงกัน" — ต้องเทสต์ได้
// ---------------------------------------------------------------------------

/** แถวนั้นถูกบันทึกโดยคนอื่นไประหว่างที่เราเปิดค้างอยู่ไหม */
const movedOn = (fresh, old) =>
  String(fresh.lastStockDate || '') !== String(old.lastStockDate || '') ||
  String(fresh.lastStock ?? '') !== String(old.lastStock ?? '');

/**
 * @param prev       แถวที่อยู่บนหน้าจอตอนนี้ (มียอดที่ผู้ใช้กรอกค้างไว้)
 * @param fresh      รายการสินค้าชุดใหม่จาก getStockItems
 * @param incomingMap สินค้ารอเข้า (คีย์ = รหัสที่ตัด 0 นำหน้าแล้ว)
 * @param prevMonthOf ฟังก์ชันคิดยอดเดือนก่อนจากประวัติ ใช้เฉพาะสินค้าที่เพิ่งโผล่มาใหม่
 * @returns { items, changed } changed = จำนวนแถวที่ค่าจากเซิร์ฟเวอร์ขยับ
 */
export function mergeStockItems(prev, fresh, incomingMap = {}, prevMonthOf = () => null) {
  const byId = new Map((prev || []).map((p) => [String(p.productId), p]));
  let changed = 0;

  const items = (fresh || []).map((row) => {
    const nid = String(row.productId).replace(/^0+/, '');
    const incoming = incomingMap[nid];
    const base = {
      ...row,
      incomingQty: incoming ? incoming.qty : undefined,
      incomingDate: incoming ? incoming.deldate : '',
      incomingOrderNo: incoming ? incoming.orderNo : '',
    };

    const old = byId.get(String(row.productId));
    if (!old) {
      // สินค้าที่เพิ่งถูกเพิ่มเข้าทะเบียนระหว่างวัน — ยังไม่มีอะไรให้เก็บรักษา
      const pm = prevMonthOf(row.stockHistory);
      return {
        ...base,
        remaining: '',
        requested: '',
        prevMonthQty: pm ? pm.qty : undefined,
        prevMonthDate: pm ? pm.date : '',
      };
    }

    const moved = movedOn(row, old);
    if (moved) changed++;
    const typedHere = String(old.remaining ?? '') !== '';

    return {
      ...base,
      remaining: old.remaining,
      requested: old.requested,
      prevMonthQty: old.prevMonthQty,
      prevMonthDate: old.prevMonthDate,
      prevMonthFromClosing: old.prevMonthFromClosing,
      avgPerHead: old.avgPerHead,
      calcMode: old.calcMode,
      parQty: old.parQty,
      calcCovers: old.calcCovers,
      // เตือนเฉพาะแถวที่เรากรอกค้างไว้แล้วมีคนอื่นบันทึกทับ แถวที่ยังไม่ได้กรอกไม่ต้องรบกวน
      conflict: (moved && typedHere)
        ? { qty: row.lastStock, by: row.lastStockCounter || '', at: row.lastStockDate || '' }
        : old.conflict,
    };
  });

  return { items, changed };
}
