// pool MS SQL Server สำหรับข้อมูล HR (ตารางงาน/พนักงาน) — เครื่อง 203.154.185.48
// วางไว้นอกโฟลเดอร์ api/ เพราะทุกไฟล์ใน api/ ถูกนับเป็น Serverless Function (ลิมิต 12 ฟังก์ชัน)
//
// ข้อควรระวังแบบเดียวกับ lib/mysql.js:
// Vercel "แช่แข็ง" ฟังก์ชันไว้ระหว่างที่ไม่มีคนเรียก แต่ pool ที่ค้างใน memory ยังถือ socket เดิม
// พอถูกปลุกอีกที socket มักถูก router/NAT ฝั่งปลายทางตัดทิ้งไปแล้ว -> ใช้ครั้งถัดไปได้ ESOCKET/ECONNCLOSED
// (อาการคือ "เข้าครั้งแรกพัง กดซ้ำอีกทีติด") จึงต้องทิ้ง pool แล้วต่อใหม่เมื่อเจอ error ระดับการเชื่อมต่อ
//
// env ที่ต้องตั้งบน Vercel:
//   HR_DB_HOST (ค่าเริ่มต้น 203.154.185.48), HR_DB_PORT (1433), HR_DB_NAME (narai_hr),
//   HR_DB_USER, HR_DB_PASSWORD, HR_DB_INSTANCE (ใส่เมื่อเป็น named instance), HR_DB_ENCRYPT=1 (ถ้าเปิด TLS)

import sql from 'mssql';

let poolPromise = null;

function buildConfig() {
  const cfg = {
    server: process.env.HR_DB_HOST || '203.154.185.48',
    port: Number(process.env.HR_DB_PORT) || 1433,
    user: process.env.HR_DB_USER,
    password: process.env.HR_DB_PASSWORD,
    database: process.env.HR_DB_NAME || 'narai_hr',
    connectionTimeout: 15000,
    // ต้องต่ำกว่า 30 วิที่ฝั่งหน้าเว็บตั้งไว้ (TIMEOUT_MS ใน src/services/api.js)
    // ไม่งั้นหน้าเว็บยกเลิกไปก่อน ผู้ใช้จะเห็นแค่ error เน็ตกลางๆ ไม่เห็นสาเหตุจริง
    requestTimeout: 25000,
    pool: { max: 4, min: 0, idleTimeoutMillis: 30000 },
    options: {
      // on-prem ส่วนใหญ่ไม่ได้ติดใบรับรองจริง — ตั้ง HR_DB_ENCRYPT=1 เมื่อเปิด TLS ที่ SQL Server แล้ว
      encrypt: String(process.env.HR_DB_ENCRYPT || '') === '1',
      trustServerCertificate: true,
      enableArithAbort: true,
    },
  };
  // named instance (เช่น SQLEXPRESS) จะคุยผ่าน SQL Browser พอร์ต 1434 แทนพอร์ตตรง
  if (process.env.HR_DB_INSTANCE) {
    cfg.options.instanceName = process.env.HR_DB_INSTANCE;
    delete cfg.port;
  }
  return cfg;
}

export function isConfigured() {
  return Boolean(process.env.HR_DB_USER && process.env.HR_DB_PASSWORD);
}

export async function getPool() {
  if (!poolPromise) {
    poolPromise = new sql.ConnectionPool(buildConfig()).connect().catch((err) => {
      poolPromise = null; // ต่อไม่ติด อย่าจำ promise ที่พังไว้ ครั้งหน้าจะได้ลองใหม่จริงๆ
      throw err;
    });
  }
  const pool = await poolPromise;
  if (!pool.connected && !pool.connecting) {
    poolPromise = null;
    return getPool();
  }
  return pool;
}

async function resetPool() {
  const p = poolPromise;
  poolPromise = null;
  try {
    const pool = await p;
    await pool?.close();
  } catch {
    // pool พังอยู่แล้ว ปิดไม่ได้ก็ไม่เป็นไร
  }
}

/**
 * ปิด pool ให้เรียบร้อย — ใช้กับสคริปต์ที่รันแล้วจบ (เช่น scripts/migrate-schedule.mjs)
 * ถ้าไม่ปิดแล้วไปเรียก process.exit() ทิ้ง Node บน Windows จะโวยว่า
 * "Assertion failed: !(handle->flags & UV_HANDLE_CLOSING)" เพราะยังมี socket ค้างอยู่
 * (ฝั่ง Vercel ไม่ต้องเรียก ปล่อยให้ pool อยู่ข้ามการเรียกจะเร็วกว่า)
 */
export async function closePool() {
  await resetPool();
}

// error ที่แปลว่า "การเชื่อมต่อเดิมใช้ไม่ได้แล้ว" — ต่อใหม่แล้วลองอีกครั้งมักผ่าน
const RECOVERABLE = new Set(['ESOCKET', 'ECONNCLOSED', 'ENOCONN', 'ETIMEOUT', 'ECONNRESET', 'EPIPE']);
const isRecoverable = (err) =>
  RECOVERABLE.has(err?.code) || /connection is closed|not connected/i.test(err?.message || '');

/** ตัดรอถ้าเกินเวลา — ใช้กับ ping ที่ไม่ควรปล่อยให้ค้างยาวเท่า requestTimeout */
function withDeadline(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEOUT' })), ms);
  });
  // Promise.race ผูก handler ให้ promise แล้ว ถ้ามันพังทีหลังก็ไม่เป็น unhandled rejection
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const PING_TIMEOUT_MS = 5000;

/**
 * pool สำหรับการ "เขียน" — เคาะ SELECT 1 ก่อนเสมอ ถ้าไม่ตอบใน 5 วิ ให้ทิ้งแล้วต่อใหม่
 *
 * ทำไมต้องเคาะ: Vercel แช่แข็งฟังก์ชันไว้ระหว่างที่ไม่มีคนเรียก แต่ pool ยังถือ socket เดิม
 * ระหว่างนั้น NAT/ไฟร์วอลล์ฝั่งปลายทางตัด socket ทิ้งแบบเงียบๆ (ไม่ส่ง RST กลับมา)
 * ฝั่งเราจึงไม่รู้ว่าตายแล้ว — tedious ยังบอกว่า connected อยู่ พอเขียนจริงแพ็กเก็ตหายไปเฉยๆ
 * แล้วรอจนครบ requestTimeout ค่อยโผล่มาเป็น ETIMEOUT ("เชื่อมต่อไม่ทันเวลา")
 *
 * อาการที่ผู้ใช้เจอ: เปิดหน้าตารางแล้วกรอกอยู่หลายนาที (ฟังก์ชันถูกแช่แข็งช่วงนี้)
 * พอกดบันทึกก็ค้างแล้วขึ้นว่าเชื่อมต่อไม่ทันเวลา ทั้งที่ฐานข้อมูลปกติดี
 * และเดิมฝั่งเขียนไม่เคย resetPool() ให้เลย socket ที่ตายจึงค้างในพูลตลอด
 * -> กดบันทึกซ้ำอีกกี่ครั้งก็พังเหมือนเดิม จนกว่า Vercel จะรีไซเคิลฟังก์ชันทิ้ง
 *
 * ค่าเคาะเสียเวลาเพิ่มแค่หนึ่งรอบ (~0.2 วิ) แลกกับการไม่ต้องรอ 30 วิแล้วพัง
 */
async function poolForWrite() {
  const pool = await getPool();
  try {
    await withDeadline(pool.request().query('SELECT 1'), PING_TIMEOUT_MS, 'ฐานข้อมูล HR ไม่ตอบการเคาะ');
    return pool;
  } catch (err) {
    console.warn('MSSQL: connection ในพูลใช้ไม่ได้ (เคาะไม่ผ่าน) กำลังต่อใหม่ —', err.code || err.message);
    await resetPool();
    return getPool();
  }
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

/**
 * query สำหรับการ "อ่าน" — ต่อใหม่แล้วลองอีกหนึ่งครั้งถ้า connection เก่าตายไปแล้ว
 * ห้ามใช้กับ INSERT/UPDATE/DELETE เพราะอาจเขียนซ้ำ (คำสั่งอาจถึงเซิร์ฟเวอร์แล้วแต่ตอบกลับไม่ทัน)
 */
export async function queryRead(text, params) {
  try {
    const pool = await getPool();
    const r = await bind(pool.request(), params).query(text);
    return r.recordset || [];
  } catch (err) {
    if (!isRecoverable(err)) throw err;
    console.warn('MSSQL: connection เก่าใช้ไม่ได้ กำลังต่อใหม่ —', err.code || err.message);
    await resetPool();
    const pool = await getPool();
    const r = await bind(pool.request(), params).query(text);
    return r.recordset || [];
  }
}

/** query สำหรับการ "เขียน" — ไม่ลองคำสั่งใหม่ให้อัตโนมัติ (อาจเขียนซ้ำ) แต่ล้างพูลที่ตายให้ */
export async function queryWrite(text, params) {
  const pool = await poolForWrite();
  try {
    return await bind(pool.request(), params).query(text);
  } catch (err) {
    // ถ้าพังระดับการเชื่อมต่อ ต้องทิ้ง socket นั้น ไม่ให้ค้างในพูลไปพังครั้งต่อไปด้วย
    if (isRecoverable(err)) await resetPool();
    throw err;
  }
}

/**
 * รันหลายคำสั่งใน transaction เดียว — ใช้ตอนบันทึกตารางทั้งสัปดาห์
 * fn จะได้ตัวช่วย run(text, params) ที่ผูกอยู่กับ transaction นั้น
 *
 * เชื่อมต่อผ่าน poolForWrite() (เคาะก่อนใช้) และถ้ายังพังระดับการเชื่อมต่อ
 * "ก่อนจะสั่ง commit" จะต่อใหม่แล้วลองทั้ง transaction อีกหนึ่งครั้ง
 * ปลอดภัยเพราะยังไม่ commit = ฝั่งเซิร์ฟเวอร์ไม่มีอะไรค้าง
 *
 * แต่ถ้าพัง "ตอนกำลัง commit" จะไม่ลองใหม่ เพราะแยกไม่ออกว่า
 * commit ผ่านแล้วแต่คำตอบหายกลางทาง หรือไม่ผ่านจริง — ปล่อยให้ผู้ใช้กดเอง
 * (คำสั่งที่ใช้เป็น MERGE/DELETE ตามคีย์ กดซ้ำแล้วผลเหมือนเดิม ไม่เกิดข้อมูลซ้ำ)
 */
export async function withTransaction(fn) {
  for (let attempt = 1; ; attempt++) {
    const pool = await poolForWrite();
    const tx = new sql.Transaction(pool);
    let begun = false;
    let committing = false;
    try {
      await tx.begin();
      begun = true;
      const run = (text, params) => bind(new sql.Request(tx), params).query(text);
      const result = await fn(run);
      committing = true;
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
      if (!isRecoverable(err)) throw err;

      // socket นี้ใช้ต่อไม่ได้แล้ว ต้องทิ้ง ไม่งั้นค้างในพูลไปพังครั้งต่อไปด้วย
      await resetPool();
      if (attempt > 1 || committing) throw err;
      console.warn('MSSQL: transaction ล้มเพราะการเชื่อมต่อ กำลังต่อใหม่แล้วลองอีกครั้ง —', err.code || err.message);
    }
  }
}

/** แปลง error ของ SQL Server เป็นข้อความไทยที่บอกสาเหตุได้จริง แทนข้อความดิบภาษาอังกฤษ */
export function describeDbError(err) {
  const code = err?.code || '';
  const msg = err?.message || '';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'หาที่อยู่เซิร์ฟเวอร์ฐานข้อมูล HR ไม่เจอ';
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
    return 'เซิร์ฟเวอร์ฐานข้อมูล HR ไม่รับการเชื่อมต่อ — เครื่องอาจปิดอยู่ หรือพอร์ต 1433 ยังไม่เปิดออกเน็ต';
  }
  if (code === 'ETIMEOUT' || code === 'ETIMEOUT_CONNECT') {
    // แยกให้ชัดว่า "ต่อไม่ติดเลย" (ไฟร์วอลล์/พอร์ต) กับ "ต่อติดแล้วแต่คำสั่งไม่เสร็จ" (คำสั่งช้า/ตารางถูกล็อก)
    // เพราะสองอันนี้ต้องไปแก้ที่ต่างที่กัน แต่ tedious ใช้รหัส ETIMEOUT ตัวเดียวกันทั้งคู่
    if (err?.name === 'ConnectionError') {
      return 'ต่อเข้าฐานข้อมูล HR ไม่ติดในเวลาที่กำหนด — พอร์ต 1433 อาจถูกไฟร์วอลล์บล็อก หรือเครื่องปลายทางไม่ตอบ';
    }
    return 'ฐานข้อมูล HR รับคำสั่งแล้วแต่ทำไม่เสร็จในเวลาที่กำหนด (คำสั่งหนัก หรือตารางถูกล็อกอยู่) กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'ESOCKET' || code === 'ECONNCLOSED' || code === 'ECONNRESET' || code === 'EPIPE') {
    return 'การเชื่อมต่อฐานข้อมูล HR หลุดกลางคัน กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'ELOGIN') {
    return 'เข้าฐานข้อมูล HR ไม่ได้ (ชื่อผู้ใช้/รหัสผ่านไม่ถูกต้อง หรือยังไม่ได้เปิด SQL Server Authentication)';
  }
  if (/Invalid object name/i.test(msg)) {
    return 'ยังไม่ได้สร้างตารางในฐานข้อมูล HR (รัน docs/schema-hr.sql ก่อน)';
  }
  if (/Cannot open database/i.test(msg)) {
    return 'เปิดฐานข้อมูล HR ไม่ได้ — ตรวจชื่อฐานข้อมูล (HR_DB_NAME) และสิทธิ์ของผู้ใช้';
  }
  return msg || 'เกิดข้อผิดพลาดกับฐานข้อมูล HR';
}

/** ตอบ error กลับเป็น JSON เสมอ ฝั่งเว็บจะได้โชว์สาเหตุจริง */
export function replyDbError(res, error, context) {
  console.error(`${context} error:`, error);
  const connectionIssue =
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ETIMEOUT|ESOCKET|ECONNCLOSED|ECONNRESET|EPIPE/.test(error?.code || '');
  return res.status(connectionIssue ? 503 : 500).json({
    status: 'error',
    message: describeDbError(error),
  });
}

export { sql };
