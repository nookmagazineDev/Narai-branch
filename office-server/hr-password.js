// รหัสผ่านของผู้ใช้เว็บ — เข้ารหัสก่อนเก็บ ไม่เก็บรหัสจริงลงฐานข้อมูล
//
// ชีท User เดิมเก็บรหัสเป็นข้อความล้วน ใครเปิดชีทได้ก็อ่านรหัสของทุกสาขาได้ทันที
// ตอนย้ายมา SQL จึงไม่คัดลอกรหัสมาตรงๆ แต่เก็บเป็นค่าที่ย้อนกลับไม่ได้ (scrypt)
// ถ้าวันหนึ่งข้อมูลในตารางหลุดออกไป คนที่ได้ไปก็ยังเอาไปล็อกอินไม่ได้
//
// ทำไมเป็น scrypt: มากับ Node อยู่แล้ว (ไม่ต้องเพิ่ม dependency ให้เครื่องที่ออฟฟิศ)
// และถูกออกแบบมาให้ "เดารหัสทีละล้านครั้ง" ทำได้ช้า ต่างจาก SHA-256 ที่เร็วเกินไปสำหรับงานนี้
//
// รูปแบบที่เก็บ:  scrypt$<N>$<r>$<p>$<salt base64>$<hash base64>
// เก็บพารามิเตอร์ไว้ในสตริงด้วย เพราะถ้าวันหน้าปรับค่าให้แน่นขึ้น รหัสเก่าต้องยังตรวจได้อยู่

import { scrypt, randomBytes, timingSafeEqual } from 'node:crypto';
import { promisify } from 'node:util';

const scryptAsync = promisify(scrypt);

/* ค่าที่ใช้กับรหัสที่สร้างใหม่ — ~50-100ms ต่อครั้งบนเครื่องออฟฟิศ
   ช้าพอที่การไล่เดารหัสจะไม่คุ้ม แต่ผู้ใช้จริงกดล็อกอินครั้งเดียวจึงไม่รู้สึก */
const N = 16384;
const R = 8;
const P = 1;
const KEYLEN = 32;
const SALT_BYTES = 16;

const PREFIX = 'scrypt$';

/** ค่านี้เป็นรหัสที่เข้ารหัสไว้แล้วหรือยัง (ที่ไม่ใช่ = ข้อความล้วนที่ยังไม่ได้แปลง) */
export function isHashed(stored) {
  return typeof stored === 'string' && stored.startsWith(PREFIX);
}

/** แปลงรหัสเป็นค่าที่เก็บลงคอลัมน์ password_hash ได้ */
export async function hashPassword(plain) {
  const salt = randomBytes(SALT_BYTES);
  const key = await scryptAsync(String(plain), salt, KEYLEN, { N, r: R, p: P });
  return `${PREFIX}${N}$${R}$${P}$${salt.toString('base64')}$${key.toString('base64')}`;
}

/**
 * ตรวจรหัสที่ผู้ใช้กรอกกับค่าที่เก็บไว้
 *
 * รองรับค่าที่เป็นข้อความล้วนด้วย เพื่อให้แอดมินเพิ่ม/แก้ผู้ใช้จาก SSMS ได้โดยตรง
 * (UPDATE hr_user SET password_hash = N'รหัสใหม่') แล้วระบบจะแปลงเป็นค่าที่เข้ารหัสให้เอง
 * ในการล็อกอินครั้งถัดไป — ดู needsRehash ที่คืนกลับไป
 *
 * @returns {Promise<{ok: boolean, needsRehash: boolean}>}
 */
export async function verifyPassword(plain, stored) {
  const input = String(plain ?? '');
  const saved = String(stored ?? '');
  if (!input || !saved) return { ok: false, needsRehash: false };

  if (!isHashed(saved)) {
    // ข้อความล้วน — เทียบแบบเวลาคงที่เหมือนกัน แล้วบอกให้ผู้เรียกไปเข้ารหัสทับให้
    const a = Buffer.from(input);
    const b = Buffer.from(saved);
    const ok = a.length === b.length && timingSafeEqual(a, b);
    return { ok, needsRehash: ok };
  }

  const parts = saved.slice(PREFIX.length).split('$');
  if (parts.length !== 5) return { ok: false, needsRehash: false }; // ค่าเสีย = เข้าไม่ได้ ไม่ใช่เข้าได้ทุกคน
  const [n, r, p, saltB64, hashB64] = parts;
  const cost = { N: Number(n), r: Number(r), p: Number(p) };
  if (!Number.isInteger(cost.N) || !Number.isInteger(cost.r) || !Number.isInteger(cost.p)) {
    return { ok: false, needsRehash: false };
  }

  const expected = Buffer.from(hashB64, 'base64');
  const actual = await scryptAsync(input, Buffer.from(saltB64, 'base64'), expected.length, cost);
  const ok = expected.length === actual.length && timingSafeEqual(expected, actual);

  // เข้าได้แต่ค่าความแน่นเก่ากว่าที่ใช้อยู่ตอนนี้ -> เข้ารหัสใหม่ให้ตอนล็อกอินสำเร็จ
  const stale = cost.N !== N || cost.r !== R || cost.p !== P;
  return { ok, needsRehash: ok && stale };
}
