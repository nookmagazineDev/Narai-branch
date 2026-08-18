// pool MySQL สำหรับข้อมูล HR (ตารางงาน/พนักงาน) — ฐานข้อมูล narai_hr ที่ inventory.dyndns.tv
//
// มาแทน lib/mssql.js ที่เลิกใช้แล้ว: ข้อมูล HR ย้ายจาก MS SQL Server มาอยู่บนเครื่อง MySQL
// ตัวเดียวกับที่ระบบสต๊อก (myfbdata) ใช้อยู่ จะได้ดูแลเครื่องเดียว เปิดพอร์ตเดียว
// (ดู docs/schema-hr-mysql.sql และ scripts/mssql-to-mysql.mjs)
//
// แยก pool จาก lib/mysql.js เพราะคนละฐานข้อมูลกัน (narai_hr กับ myfbdata)
// และฝั่ง HR ต้องใช้ transaction ซึ่ง lib/mysql.js ไม่มี
// วางไว้นอกโฟลเดอร์ api/ เพราะทุกไฟล์ใน api/ ถูกนับเป็น Serverless Function (ลิมิต 12 ฟังก์ชัน)
//
// env ที่ต้องตั้งบน Vercel:
//   HR_DB_HOST (ค่าเริ่มต้น inventory.dyndns.tv), HR_DB_PORT (3306), HR_DB_NAME (narai_hr),
//   HR_DB_USER, HR_DB_PASSWORD — ถ้าไม่ตั้งสองตัวหลัง จะถอยไปใช้ MYSQL_USER/MYSQL_PASSWORD
//   ที่ตั้งไว้ให้ myfbdata อยู่แล้ว (เครื่องเดียวกัน user เดียวกันมักใช้ได้เลย)
//
// ข้อควรระวังแบบเดียวกับ lib/mysql.js:
// Vercel "แช่แข็ง" ฟังก์ชันไว้ระหว่างที่ไม่มีคนเรียก แต่ pool ที่ค้างใน memory ยังถือ socket เดิม
// พอถูกปลุกอีกที socket มักถูก router/NAT ฝั่งปลายทางตัดทิ้งไปแล้ว -> ใช้ครั้งถัดไปได้ ECONNRESET
// (อาการคือ "เข้าครั้งแรกพัง กดซ้ำอีกทีติด") จึงต้องปิด connection ที่ว่างทิ้งเร็วๆ + เปิด keepalive
// และเคาะก่อนใช้ทุกครั้งที่จะเขียน

import mysql from 'mysql2/promise';

let pool;

/** พอร์ตของ MySQL — กัน HR_DB_PORT=1433 ที่ค้างมาจากตอนใช้ SQL Server ทำให้ต่อไม่ติดแบบงงๆ */
function resolvePort() {
  const port = Number(process.env.HR_DB_PORT) || Number(process.env.MYSQL_PORT) || 3306;
  if (port === 1433) {
    console.warn('HR_DB_PORT ยังเป็น 1433 (พอร์ตของ SQL Server) — ใช้ 3306 แทน ควรแก้ค่าบน Vercel');
    return 3306;
  }
  return port;
}

const dbUser = () => process.env.HR_DB_USER || process.env.MYSQL_USER || '';
const dbPassword = () => process.env.HR_DB_PASSWORD || process.env.MYSQL_PASSWORD || '';
const dbHost = () => process.env.HR_DB_HOST || process.env.MYSQL_HOST || 'inventory.dyndns.tv';
const dbName = () => process.env.HR_DB_NAME || 'narai_hr';

/**
 * ปลายทางที่กำลังจะต่อ — เอาไว้แนบท้าย error ตอนต่อไม่ติด
 * ไม่มี user/password อยู่ในนี้ ปลอดภัยพอที่จะส่งกลับไปแสดงบนหน้าเว็บ
 */
export function describeTarget() {
  return `${dbHost()}:${resolvePort()}/${dbName()}`;
}

export function isConfigured() {
  return Boolean(dbUser() && dbPassword());
}

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: dbHost(),
      port: resolvePort(),
      user: dbUser(),
      password: dbPassword(),
      database: dbName(),
      charset: 'utf8mb4',
      waitForConnections: true,
      connectionLimit: 4,
      connectTimeout: 15000,
      // กัน socket ค้างตายระหว่างที่ฟังก์ชันถูกแช่แข็ง
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      maxIdle: 2,
      idleTimeout: 30000,
      // DECIMAL เป็นตัวเลขจริง ไม่ใช่ข้อความ — ฝั่งเว็บอ่านค่าแรง/OT เป็นตัวเลขมาตลอด
      // ถ้าปล่อยเป็นข้อความ '0.00' หน้าเว็บจะโชว์ '0.00' แทน '0'
      decimalNumbers: true,
      // วันที่/เวลาเป็นข้อความตามที่เก็บไว้ ไม่ให้ไปแปลง timezone ตามเครื่องที่รัน
      // (Vercel รันที่ UTC แต่ข้อมูลเป็นเวลาไทย ถ้าแปลงจะเลื่อนไป 7 ชั่วโมง)
      dateStrings: true,
      // ให้ affectedRows นับ "แถวที่ตรงเงื่อนไข" ไม่ใช่ "แถวที่ค่าเปลี่ยนจริง"
      // เพื่อให้จำนวนที่ตอบกลับเหมือนตอนใช้ SQL Server (ติ๊กอนุมัติ OT ซ้ำค่าเดิมต้องนับว่าสำเร็จ)
      flags: ['+FOUND_ROWS'],
    });
  }
  return pool;
}

async function resetPool() {
  const p = pool;
  pool = undefined;
  try {
    await p?.end();
  } catch {
    // pool พังอยู่แล้ว ปิดไม่ได้ก็ไม่เป็นไร
  }
}

/**
 * ปิด pool ให้เรียบร้อย — ใช้กับสคริปต์ที่รันแล้วจบ (เช่น scripts/migrate-schedule.mjs)
 * ถ้าไม่ปิด Node จะค้างไม่ยอมจบเพราะยังมี socket เปิดอยู่
 * (ฝั่ง Vercel ไม่ต้องเรียก ปล่อยให้ pool อยู่ข้ามการเรียกจะเร็วกว่า)
 */
export async function closePool() {
  await resetPool();
}

// error ที่แปลว่า "การเชื่อมต่อเดิมใช้ไม่ได้แล้ว" — ต่อใหม่แล้วลองอีกครั้งมักผ่าน
const RECOVERABLE = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ER_CLIENT_INTERACTION_TIMEOUT',
]);
const isRecoverable = (err) =>
  RECOVERABLE.has(err?.code) || /closed state|connection is in closed/i.test(err?.message || '');

/** ตัดรอถ้าเกินเวลา — ใช้กับ ping ที่ไม่ควรปล่อยให้ค้างยาว */
function withDeadline(promise, ms, message) {
  let timer;
  const guard = new Promise((_, reject) => {
    timer = setTimeout(() => reject(Object.assign(new Error(message), { code: 'ETIMEDOUT' })), ms);
  });
  return Promise.race([promise, guard]).finally(() => clearTimeout(timer));
}

const PING_TIMEOUT_MS = 5000;

/**
 * connection สำหรับการ "เขียน" — เคาะก่อนเสมอ ถ้าไม่ตอบใน 5 วิ ให้ทิ้งพูลแล้วต่อใหม่
 *
 * ทำไมต้องเคาะ: Vercel แช่แข็งฟังก์ชันไว้ระหว่างที่ไม่มีคนเรียก แต่พูลยังถือ socket เดิม
 * ระหว่างนั้น NAT/ไฟร์วอลล์ฝั่งปลายทางตัด socket ทิ้งแบบเงียบๆ (ไม่ส่ง RST กลับมา)
 * ฝั่งเราจึงไม่รู้ว่าตายแล้ว พอเขียนจริงแพ็กเก็ตหายไปเฉยๆ แล้วค้างจนหมดเวลา
 *
 * อาการที่ผู้ใช้เจอ: เปิดหน้าตารางแล้วกรอกอยู่หลายนาที พอกดบันทึกก็ค้างแล้วขึ้นว่า
 * เชื่อมต่อไม่ทันเวลา ทั้งที่ฐานข้อมูลปกติดี — เคาะก่อนเสียเวลาเพิ่มแค่รอบเดียว (~0.2 วิ)
 */
/** คืน connection เข้าพูล — ถ้าพูลถูกทิ้งไปแล้ว (resetPool) การคืนจะพัง ซึ่งไม่เป็นไร */
function release(conn) {
  try {
    conn.release();
  } catch {
    // พูลถูกปิดไปแล้ว connection นี้ก็ถูกปิดตามไปด้วย ไม่มีอะไรต้องคืน
  }
}

async function connectionForWrite() {
  let conn = await getPool().getConnection();
  try {
    await withDeadline(conn.ping(), PING_TIMEOUT_MS, 'ฐานข้อมูล HR ไม่ตอบการเคาะ');
    return conn;
  } catch (err) {
    console.warn('MySQL(HR): connection ในพูลใช้ไม่ได้ (เคาะไม่ผ่าน) กำลังต่อใหม่ —', err.code || err.message);
    try {
      conn.destroy();
    } catch {
      // connection ตายอยู่แล้ว
    }
    await resetPool();
    conn = await getPool().getConnection();
    return conn;
  }
}

/**
 * query สำหรับการ "อ่าน" — ต่อใหม่แล้วลองอีกหนึ่งครั้งถ้า connection เก่าตายไปแล้ว
 * ห้ามใช้กับ INSERT/UPDATE/DELETE เพราะอาจเขียนซ้ำ (คำสั่งอาจถึงเซิร์ฟเวอร์แล้วแต่ตอบกลับไม่ทัน)
 *
 * ใช้ query() ไม่ใช่ execute() เพราะต้องพึ่งการแตกพารามิเตอร์เป็นชุด
 * (INSERT ... VALUES ? และ IN (?)) ซึ่ง prepared statement ทำให้ไม่ได้
 */
export async function queryRead(text, params) {
  try {
    const [rows] = await getPool().query(text, params);
    return rows;
  } catch (err) {
    if (!isRecoverable(err)) throw err;
    console.warn('MySQL(HR): connection เก่าใช้ไม่ได้ กำลังต่อใหม่ —', err.code || err.message);
    await resetPool();
    const [rows] = await getPool().query(text, params);
    return rows;
  }
}

/** query สำหรับการ "เขียน" — ไม่ลองคำสั่งใหม่ให้อัตโนมัติ (อาจเขียนซ้ำ) แต่ล้างพูลที่ตายให้ */
export async function queryWrite(text, params) {
  const conn = await connectionForWrite();
  try {
    const [result] = await conn.query(text, params);
    return result;
  } catch (err) {
    if (isRecoverable(err)) await resetPool();
    throw err;
  } finally {
    release(conn);
  }
}

/**
 * รันหลายคำสั่งใน transaction เดียว — ใช้ตอนบันทึกตารางทั้งสัปดาห์
 * fn จะได้ตัวช่วย run(text, params) ที่ผูกอยู่กับ connection นั้น
 * run() คืนค่าเดียวกับ mysql2: SELECT ได้อาร์เรย์ของแถว, INSERT/UPDATE ได้ header ที่มี affectedRows
 *
 * ถ้าพังระดับการเชื่อมต่อ "ก่อนจะสั่ง commit" จะต่อใหม่แล้วลองทั้ง transaction อีกหนึ่งครั้ง
 * ปลอดภัยเพราะยังไม่ commit = ฝั่งเซิร์ฟเวอร์ไม่มีอะไรค้าง
 *
 * แต่ถ้าพัง "ตอนกำลัง commit" จะไม่ลองใหม่ เพราะแยกไม่ออกว่า commit ผ่านแล้วแต่คำตอบหาย
 * หรือไม่ผ่านจริง — ปล่อยให้ผู้ใช้กดเอง (คำสั่งที่ใช้เขียนทับตามคีย์ กดซ้ำแล้วผลเหมือนเดิม)
 */
export async function withTransaction(fn) {
  for (let attempt = 1; ; attempt++) {
    const conn = await connectionForWrite();
    let begun = false;
    let committing = false;
    try {
      await conn.beginTransaction();
      begun = true;
      const run = async (text, params) => {
        const [result] = await conn.query(text, params);
        return result;
      };
      const result = await fn(run);
      committing = true;
      await conn.commit();
      return result;
    } catch (err) {
      if (begun) {
        try {
          await conn.rollback();
        } catch {
          // ถ้า connection ตายไปแล้ว rollback ก็ไม่มีอะไรให้ย้อน (เซิร์ฟเวอร์ย้อนให้เองตอน socket ขาด)
        }
      }
      if (!isRecoverable(err)) throw err;

      // socket นี้ใช้ต่อไม่ได้แล้ว ต้องทิ้ง ไม่งั้นค้างในพูลไปพังครั้งต่อไปด้วย
      await resetPool();
      if (attempt > 1 || committing) throw err;
      console.warn('MySQL(HR): transaction ล้มเพราะการเชื่อมต่อ กำลังต่อใหม่แล้วลองอีกครั้ง —', err.code || err.message);
    } finally {
      release(conn);
    }
  }
}

/** แปลง error ของ MySQL เป็นข้อความไทยที่บอกสาเหตุได้จริง แทนข้อความดิบภาษาอังกฤษ */
export function describeDbError(err) {
  const code = err?.code || '';
  const msg = err?.message || '';

  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'หาที่อยู่เซิร์ฟเวอร์ฐานข้อมูล HR ไม่เจอ (dyndns อาจยังไม่อัปเดต IP ใหม่)';
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
    return 'เซิร์ฟเวอร์ฐานข้อมูล HR ไม่รับการเชื่อมต่อ — เครื่องที่ออฟฟิศอาจปิดอยู่ หรือพอร์ต 3306 ยังไม่เปิด';
  }
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT' || code === 'ER_CLIENT_INTERACTION_TIMEOUT') {
    return 'เชื่อมต่อฐานข้อมูล HR ไม่ทันเวลา (เน็ตที่ออฟฟิศช้า หรือไฟร์วอลล์บล็อก) กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'ECONNRESET' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'EPIPE') {
    return 'การเชื่อมต่อฐานข้อมูล HR หลุดกลางคัน กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'ER_ACCESS_DENIED_ERROR' || code === 'ER_NOT_SUPPORTED_AUTH_MODE') {
    return 'เข้าฐานข้อมูล HR ไม่ได้ (ชื่อผู้ใช้/รหัสผ่านไม่ถูกต้อง หรือ user นี้ต่อจากภายนอกไม่ได้)';
  }
  if (code === 'ER_BAD_DB_ERROR') {
    return 'ยังไม่มีฐานข้อมูล HR บนเครื่องนี้ (รัน docs/schema-hr-mysql.sql ก่อน)';
  }
  if (code === 'ER_NO_SUCH_TABLE') {
    return 'ยังไม่ได้สร้างตารางในฐานข้อมูล HR (รัน docs/schema-hr-mysql.sql ก่อน)';
  }
  return msg || 'เกิดข้อผิดพลาดกับฐานข้อมูล HR';
}

/** ตอบ error กลับเป็น JSON เสมอ ฝั่งเว็บจะได้โชว์สาเหตุจริง */
export function replyDbError(res, error, context) {
  console.error(`${context} error:`, error);
  const connectionIssue =
    /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|PROTOCOL_CONNECTION_LOST|EPIPE/.test(error?.code || '');
  const message = connectionIssue
    ? `${describeDbError(error)} [ปลายทาง: ${describeTarget()}]`
    : describeDbError(error);
  return res.status(connectionIssue ? 503 : 500).json({ status: 'error', message });
}
