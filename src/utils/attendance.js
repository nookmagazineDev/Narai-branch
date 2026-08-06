// ตัวช่วยสรุปข้อมูลสแกนเข้า-ออก — ใช้ร่วมกันระหว่างหน้า "สแกนเข้า-ออก" กับ modal ในหน้ารายชื่อพนักงาน
//
// "เข้า/ออก" คิดจากเวลาสแกนแรกและสแกนสุดท้ายของวัน ไม่ได้อิง punch_state
// เพราะการตั้งค่าปุ่มเข้า/ออกของเครื่องสแกนแต่ละตัวไม่เหมือนกัน (ข้อมูลจริงมีทั้งค่า 0 และ 2 ปนกัน)

/** "2026-08-06 09:05:12" -> "09:05" */
export const hhmm = (t) => String(t || '').slice(11, 16);

/** ผลต่างเป็นชั่วโมง จาก "YYYY-MM-DD HH:MM:SS" (เวลาท้องถิ่นทั้งคู่ ลบกันตรงๆ ได้) */
export function hoursBetween(a, b) {
  if (!a || !b || a === b) return null;
  const d1 = new Date(String(a).replace(' ', 'T'));
  const d2 = new Date(String(b).replace(' ', 'T'));
  if (isNaN(d1) || isNaN(d2)) return null;
  return (d2 - d1) / 3600000;
}

/**
 * รวมรายการสแกนดิบเป็นรายวัน — พนักงาน 1 คน x 1 วัน = 1 แถว
 * คืน [{ date, empCode, name, first, last, count, hours }] เรียงวันที่ล่าสุดก่อน
 * count = 1 แปลว่าสแกนครั้งเดียว (ยังไม่ได้สแกนออก หรือลืมสแกน) — last จะเท่ากับ first
 */
export function summarizeDaily(rows) {
  const m = {};
  for (const r of rows || []) {
    const k = `${r.date}|${r.empCode}`;
    if (!m[k]) m[k] = { date: r.date, empCode: r.empCode, name: r.name, times: [] };
    if (!m[k].name && r.name) m[k].name = r.name;
    m[k].times.push(r.time);
  }
  return Object.values(m)
    .map((e) => {
      const ts = e.times.slice().sort();
      const first = ts[0];
      const last = ts[ts.length - 1];
      return { ...e, first, last, count: ts.length, hours: hoursBetween(first, last) };
    })
    .sort((a, b) => (b.date + b.empCode).localeCompare(a.date + a.empCode));
}
