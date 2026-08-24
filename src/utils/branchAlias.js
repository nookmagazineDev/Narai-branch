// สาขาที่มีรหัสสองแบบแต่เป็นร้านเดียวกัน — ฉบับฝั่งเว็บ
//
// ตัวอย่างที่มีจริง: เว็บล็อกอินด้วย zjp แต่ชีท DATA / POS / เครื่องสแกนนิ้วเขียนว่า SJP
// (ทั้งคู่คือ outlet 7) ผลคือล็อกอิน zjp แล้วรายชื่อพนักงานขึ้นไม่ครบ เพราะพนักงาน
// ถูกบันทึกไว้ใต้รหัสอีกตัว ทั้งที่เป็นร้านเดียวกัน
//
// กติกาเดียวกับฝั่งเซิร์ฟเวอร์:
//   อ่าน  -> อ่านทุกรหัสในกลุ่ม (ข้อมูลเก่าที่ลงไว้ด้วยรหัสไหนก็เห็นหมด)
//   เขียน -> ใช้รหัสที่ล็อกอินมาตามเดิม ไม่แปลง (ไม่งั้นของเก่าจะกลายเป็นกำพร้า)
//
// ต้องตรงกับ BRANCH_ALIAS_GROUPS ใน office-server/hr-session.js เสมอ — คนละแอป
// คนละ bundle จึง import ข้ามกันไม่ได้ เพิ่มคู่ใหม่ต้องแก้ทั้งสองที่
const BRANCH_ALIAS_GROUPS = [
  ['zjp', 'sjp'],
];

/**
 * รหัสสาขาทั้งหมดที่ถือว่าเป็นร้านเดียวกันกับรหัสที่ให้มา (ตัวพิมพ์เล็ก)
 * รหัสที่ขอมาอยู่ตัวแรกเสมอ ผู้เรียกจึงถือว่าเป็น "ตัวหลัก" ได้
 * ไม่อยู่ในกลุ่มไหน = คืนตัวมันเองตัวเดียว
 */
export function branchGroup(code) {
  const b = String(code ?? '').trim().toLowerCase();
  if (!b) return [];
  const hit = BRANCH_ALIAS_GROUPS.find((g) => g.includes(b));
  return hit ? [b, ...hit.filter((c) => c !== b)] : [b];
}

/** สองรหัสนี้เป็นร้านเดียวกันไหม */
export function sameBranch(a, b) {
  const x = String(a ?? '').trim().toLowerCase();
  const y = String(b ?? '').trim().toLowerCase();
  if (!x || !y) return false;
  return x === y || branchGroup(x).includes(y);
}
