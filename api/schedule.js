// ตารางงาน (ลงตารางสัปดาห์ / ประวัติ / อนุมัติ OT) — ตัวส่งต่อไปยัง office-server ที่ออฟฟิศ
//
// ไฟล์นี้ "ไม่ต่อฐานข้อมูลเอง" อีกต่อไป เพราะไฟร์วอลล์ของออฟฟิศเปิดพอร์ต 1433 ให้เฉพาะ IP ในไทย
// แต่ฟังก์ชันบน Vercel วิ่งมาจากต่างประเทศ จึงต่อไม่ติดและกดบันทึกตารางไม่ได้มาตลอด
// (ดูที่มาใน src/utils/scheduleDrafts.js ที่ทำระบบเก็บร่างไว้กันข้อมูลหายระหว่างรอแก้เรื่องนี้)
//
// เส้นทางใหม่เดินอ้อมผ่านทางที่เปิดอยู่แล้วและใช้งานได้ทุกวัน (หน้ายอดขาย/สต๊อกใช้ทางนี้อยู่)
//
//   เบราว์เซอร์ -> /api/schedule (ไฟล์นี้) -> office-server :8787/schedule -> SQL Server (localhost)
//
// ตรรกะ SQL ทั้งหมดย้ายไปอยู่ที่ office-server/schedule.js แล้ว ที่นี่เหลือแค่ส่ง body ต่อ
// และส่งคำตอบกลับตามเดิมทุกตัวอักษร หน้าเว็บจึงไม่ต้องแก้อะไรเลย (ดู SQL_ACTIONS ใน src/services/api.js)

import { USAGE_API_BASE, fetchUpstream, applyCors, replyUpstreamError } from '../lib/upstream.js';

/* action ที่แค่อ่าน — ยิงซ้ำได้ปลอดภัยเมื่อ office-server ตอบ 5xx หรือเน็ตสะดุด
   ที่เหลือคือคำสั่งเขียน ห้ามลองใหม่ให้อัตโนมัติ เพราะคำสั่งอาจถึงปลายทางแล้วแต่คำตอบหายกลางทาง
   (ตัวตารางเขียนทับตามคีย์อยู่แล้ว แต่ hr_timesheet_log เป็นแบบต่อท้าย จะได้ประวัติซ้ำ) */
const READ_ONLY = new Set([
  'ping',
  'getBranches',
  'getBranchList',
  'getScheduleEmployees',
  'getBranchStats',
  'getDailySales',
  'getHistoryData',
]);

export default async function handler(req, res) {
  if (applyCors(req, res)) return;
  if (req.method !== 'POST') {
    return res.status(405).json({ status: 'error', message: 'รองรับเฉพาะ POST' });
  }

  // body อาจมาเป็นข้อความล้วนถ้า Content-Type ไม่ใช่ application/json
  let body = req.body;
  if (typeof body === 'string') {
    try {
      body = JSON.parse(body);
    } catch {
      return res.status(400).json({ status: 'error', message: 'รูปแบบข้อมูลที่ส่งมาไม่ถูกต้อง' });
    }
  }
  body = body || {};
  const action = String(body.action || '').trim();

  // ฝั่งหน้าเว็บรอสูงสุด 30 วิต่อหนึ่งครั้ง (TIMEOUT_MS ใน src/services/api.js)
  // ตรงนี้จึงต้องยอมแพ้ก่อนหน้านั้น ไม่งั้นผู้ใช้เห็นแค่ error เน็ตกลางๆ ไม่เห็นสาเหตุจริง
  const opts = READ_ONLY.has(action)
    ? { timeoutMs: 12000, retries: 1, deadlineMs: 26000 }
    : { timeoutMs: 25000, retries: 0 };

  const headers = { 'Content-Type': 'application/json' };
  if (process.env.USAGE_API_TOKEN) headers['x-api-token'] = process.env.USAGE_API_TOKEN;

  try {
    const r = await fetchUpstream(`${USAGE_API_BASE}/schedule`, {
      ...opts,
      method: 'POST',
      headers,
      body: JSON.stringify(body),
    });

    // ส่งต่อคำตอบของ office-server ทั้งรหัสสถานะและเนื้อความ
    // (401 เซสชันหมดอายุ / 403 ไม่มีสิทธิ์สาขา / 400 ข้อมูลไม่ครบ / 503 ยังไม่ได้ตั้งค่า .env)
    // ฝั่งเว็บจะได้เห็นข้อความจริงเหมือนตอนที่ยังต่อฐานข้อมูลตรงๆ
    const payload = await r.json().catch(() => null);
    if (!payload) {
      return res.status(502).json({
        status: 'error',
        message: `เซิร์ฟเวอร์ที่ออฟฟิศตอบกลับมาไม่ใช่ JSON (HTTP ${r.status})`,
      });
    }
    return res.status(r.status).json(payload);
  } catch (error) {
    return replyUpstreamError(res, error, `schedule:${action}`);
  }
}
