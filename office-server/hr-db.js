// การเชื่อมต่อฐานข้อมูล HR (SQL Server narai_hr บนเครื่องเดียวกันนี้ ผ่าน localhost:1433)
//
// แยกออกมาจาก schedule.js ตอนเริ่มย้ายหน้านับสต๊อกไป SQL เพราะ stock.js ต้องใช้ตัวเชื่อมต่อตัวเดียวกัน
// ถ้าให้ stock.js import จาก schedule.js แล้ว schedule.js import ACTIONS ของสต๊อกกลับมา จะกลายเป็น
// วงกลม ซึ่งพังแบบเงียบๆ ได้เวลามีคนสลับลำดับ import — แยกมาไว้ที่นี่แล้วทั้งสองฝั่งชี้มาทางเดียว
//
// ตั้งค่าใน .env: HR_DB_USER, HR_DB_PASSWORD (และ HR_DB_HOST/HR_DB_NAME/HR_DB_PORT/HR_DB_INSTANCE ถ้าไม่ใช้ค่าเริ่มต้น)
import sql from 'mssql';

export { sql };

/* ---------------------------- การเชื่อมต่อฐานข้อมูล ----------------------------
   ใช้แพตเทิร์นเดียวกับ ZK_DB ใน server.js — ต่อ localhost จึงไม่ต้องเข้ารหัส
   และไม่ต้องมีลูกเล่นกัน socket ตายแบบฝั่ง Vercel (ที่นี่ไม่มีการแช่แข็งฟังก์ชัน) */
/* อ่าน env ตอนเรียกใช้ ไม่ใช่ตอนโหลดไฟล์ — ไม่งั้นจะขึ้นกับว่า dotenv ถูกโหลดก่อนไฟล์นี้หรือยัง
   ซึ่งเป็นเรื่องที่พังเงียบๆ ได้ง่ายเวลามีคนสลับลำดับ import ใน server.js */
function dbConfig() {
  return {
    server: process.env.HR_DB_HOST || 'localhost',
    database: process.env.HR_DB_NAME || 'narai_hr',
    user: process.env.HR_DB_USER || '',
    password: process.env.HR_DB_PASSWORD || '',
    options: {
      encrypt: false,
      trustServerCertificate: true,
      enableArithAbort: true,
      ...(process.env.HR_DB_INSTANCE ? { instanceName: process.env.HR_DB_INSTANCE } : {}),
    },
    port: Number(process.env.HR_DB_PORT) || 1433,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    requestTimeout: 30000,
    connectionTimeout: 15000,
  };
}

let hrPool = null;

export function isConfigured() {
  return Boolean(process.env.HR_DB_USER && process.env.HR_DB_PASSWORD);
}

export async function getPool() {
  if (hrPool && hrPool.connected) return hrPool;
  hrPool = await new sql.ConnectionPool(dbConfig()).connect();
  hrPool.on('error', () => { hrPool = null; }); // ต่อหลุดแล้วให้สร้างใหม่รอบหน้า
  return hrPool;
}

function bind(request, params) {
  for (const [name, value] of Object.entries(params || {})) {
    // รูปแบบ { type, value } ใช้เมื่อต้องระบุชนิดเอง (เช่น sql.Date, sql.Decimal)
    if (value && typeof value === 'object' && !(value instanceof Date) && 'type' in value) {
      request.input(name, value.type, value.value);
    } else {
      request.input(name, value);
    }
  }
  return request;
}

export async function queryRead(text, params) {
  const pool = await getPool();
  const r = await bind(pool.request(), params).query(text);
  return r.recordset || [];
}

/**
 * รันหลายคำสั่งใน transaction เดียว — ใช้ตอนบันทึกตารางทั้งสัปดาห์
 * บันทึกทั้งสัปดาห์แล้วพลาดกลางคันจะไม่เหลือข้อมูลครึ่งๆ
 */
export async function withTransaction(fn) {
  const pool = await getPool();
  const tx = new sql.Transaction(pool);
  let begun = false;
  try {
    await tx.begin();
    begun = true;
    const run = (text, params) => bind(new sql.Request(tx), params).query(text);
    const result = await fn(run);
    await tx.commit();
    return result;
  } catch (err) {
    if (begun) {
      try {
        await tx.rollback();
      } catch {
        // ถ้า transaction ตายไปพร้อม connection แล้ว rollback ก็ไม่มีอะไรให้ย้อน
      }
    }
    if (/connection is closed|not connected/i.test(err?.message || '')) hrPool = null;
    throw err;
  }
}

/** แปลง error ของ SQL Server เป็นข้อความไทยที่บอกสาเหตุได้จริง แทนข้อความดิบภาษาอังกฤษ */
export function describeDbError(err) {
  const code = err?.code || '';
  const msg = err?.message || '';
  if (code === 'ELOGIN') {
    return 'เข้าฐานข้อมูล HR ไม่ได้ (ชื่อผู้ใช้/รหัสผ่านใน .env ไม่ถูกต้อง หรือยังไม่ได้เปิด SQL Server Authentication)';
  }
  if (code === 'ESOCKET' || code === 'ECONNCLOSED' || code === 'ECONNRESET') {
    return 'การเชื่อมต่อฐานข้อมูล HR หลุดกลางคัน กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'ETIMEOUT') {
    return 'ฐานข้อมูล HR ไม่ตอบในเวลาที่กำหนด (คำสั่งหนัก หรือตารางถูกล็อกอยู่) กรุณาลองใหม่อีกครั้ง';
  }
  if (/Invalid object name/i.test(msg)) {
    return 'ยังไม่ได้สร้างตารางในฐานข้อมูล HR (รัน docs/schema-hr.sql ก่อน)';
  }
  if (/Cannot open database/i.test(msg)) {
    return 'เปิดฐานข้อมูล HR ไม่ได้ — ตรวจชื่อฐานข้อมูล (HR_DB_NAME) และสิทธิ์ของผู้ใช้';
  }
  return msg || 'เกิดข้อผิดพลาดกับฐานข้อมูล HR';
}
