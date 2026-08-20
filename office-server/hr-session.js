// ผู้ใช้ที่ล็อกอินไว้ + การจำกัดสาขา — ใช้ร่วมกันระหว่าง schedule.js กับ stock.js
//
// แยกออกมาเพื่อให้กติกาสาขามีที่มาที่เดียว ถ้าปล่อยให้แต่ละไฟล์เขียนเอง
// วันหนึ่งจะแก้ที่หนึ่งแล้วลืมอีกที่ ซึ่งเป็นกติกาเรื่องสิทธิ์ ไม่ควรมีสองฉบับ

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());

/* ---------------------------- ผู้ใช้ที่ล็อกอินไว้ ----------------------------
   ไม่มีการล็อกอินซ้อนอีกชั้นที่นี่ — ใช้ user เดิมที่ล็อกอินเข้าระบบมาตั้งแต่แรก
   ฝั่งเว็บแนบมาให้ในฟิลด์ _user อัตโนมัติทุกคำสั่ง (ดู src/services/api.js)

   ข้อจำกัดที่ต้องรู้: _user มาจาก localStorage ของเบราว์เซอร์ ผู้ใช้แก้เองได้
   จึงกันได้แค่การกดผิดสาขาโดยไม่ตั้งใจ ไม่ใช่การกันคนที่ตั้งใจปลอม
   ถ้าต้องการกันจริงต้องให้ตอน login ออก token ที่เซ็นชื่อไว้แล้วตรวจที่นี่
   (ตอนนี้ Apps Script เดิมก็เชื่อสาขาที่ฝั่งเว็บส่งมาแบบเดียวกัน)
------------------------------------------------------------------------- */
export function sessionOf(body) {
  const u = body && typeof body._user === 'object' ? body._user : null;
  const username = str(u?.username);
  if (!username) return null;
  const branch = str(u?.branch);
  return { username, branch, isAll: branch.toLowerCase() === 'all' };
}

/**
 * สาขาที่คำสั่งนี้ทำงานด้วยได้จริง
 * user สิทธิ์ all เลือกสาขาไหนก็ได้ นอกนั้นถูกล็อกไว้ที่สาขาตัวเองเสมอ
 * (หน้าเว็บล็อกไว้อยู่แล้ว ตรงนี้กันซ้ำอีกชั้นเผื่อเรียก API ตรงๆ)
 */
export function branchFor(session, requested) {
  const want = str(requested);
  if (!session) return want;
  if (session.isAll) return want;
  if (want && want.toLowerCase() !== session.branch.toLowerCase()) {
    throw Object.assign(new Error(`ไม่มีสิทธิ์ดูข้อมูลของสาขา ${want}`), { forbidden: true });
  }
  return session.branch;
}
