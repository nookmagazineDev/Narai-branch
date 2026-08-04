// pool MySQL ที่ใช้ร่วมกันของ api/*.js (ต่อไปที่ inventory.dyndns.tv)
// วางไว้นอกโฟลเดอร์ api/ เพราะทุกไฟล์ใน api/ จะถูกนับเป็น Serverless Function (ลิมิต 12 ฟังก์ชัน)
//
// ทำไมถึงชอบขึ้น "ติดต่อเซิร์ฟเวอร์ไม่ได้" เป็นครั้งคราว:
// Vercel จะ "แช่แข็ง" ฟังก์ชันไว้ระหว่างที่ไม่มีคนเรียก แต่ pool ที่ค้างอยู่ใน memory ยังถือ socket เดิม
// พอถูกปลุกอีกที socket นั้นมักถูก router/NAT ฝั่งปลายทางตัดทิ้งไปแล้ว -> ใช้ครั้งถัดไปได้ ECONNRESET
// (อาการคือ "เข้าครั้งแรกพัง กดซ้ำอีกทีติด") จึงต้องปิด connection ที่ว่างทิ้งเร็วๆ + เปิด TCP keepalive
// และลองใหม่หนึ่งครั้งเมื่อเจอ error ระดับการเชื่อมต่อ

import mysql from 'mysql2/promise';

let pool;

export function getPool() {
  if (!pool) {
    pool = mysql.createPool({
      host: process.env.MYSQL_HOST || 'inventory.dyndns.tv',
      port: Number(process.env.MYSQL_PORT) || 3306,
      user: process.env.MYSQL_USER || 'root',
      password: process.env.MYSQL_PASSWORD || '',
      database: process.env.MYSQL_DATABASE || 'myfbdata',
      waitForConnections: true,
      connectionLimit: 5,
      connectTimeout: 15000,
      // กัน socket ค้างตายระหว่างที่ฟังก์ชันถูกแช่แข็ง
      enableKeepAlive: true,
      keepAliveInitialDelay: 10000,
      maxIdle: 2,
      idleTimeout: 30000,
    });
  }
  return pool;
}

// error ที่แปลว่า "การเชื่อมต่อเดิมใช้ไม่ได้แล้ว" — ลองใหม่ด้วย connection ใหม่มักผ่าน
const RECOVERABLE = new Set([
  'PROTOCOL_CONNECTION_LOST',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
  'ER_CLIENT_INTERACTION_TIMEOUT',
]);

const isRecoverable = (err) =>
  RECOVERABLE.has(err?.code) || /closed state|connection is in closed/i.test(err?.message || '');

/**
 * query สำหรับการ "อ่าน" — ลองใหม่หนึ่งครั้งถ้า connection เก่าตายไปแล้ว
 * ห้ามใช้กับ INSERT/UPDATE เพราะอาจเขียนซ้ำ (คำสั่งอาจถึงเซิร์ฟเวอร์แล้วแต่ตอบกลับไม่ทัน)
 */
export async function queryRead(sql, params) {
  try {
    const [rows] = await getPool().query(sql, params);
    return rows;
  } catch (err) {
    if (!isRecoverable(err)) throw err;
    console.warn('MySQL: connection เก่าใช้ไม่ได้ กำลังลองใหม่ —', err.code || err.message);
    const [rows] = await getPool().query(sql, params);
    return rows;
  }
}

/** แปลง error ของ MySQL เป็นข้อความไทยที่บอกสาเหตุได้จริง แทนข้อความดิบภาษาอังกฤษ */
export function describeDbError(err) {
  const code = err?.code || '';
  if (code === 'ENOTFOUND' || code === 'EAI_AGAIN') {
    return 'หาที่อยู่เซิร์ฟเวอร์ฐานข้อมูลไม่เจอ (dyndns อาจยังไม่อัปเดต IP ใหม่)';
  }
  if (code === 'ECONNREFUSED' || code === 'EHOSTUNREACH') {
    return 'เซิร์ฟเวอร์ฐานข้อมูลไม่รับการเชื่อมต่อ — เครื่องที่ออฟฟิศอาจปิดอยู่';
  }
  if (code === 'ETIMEDOUT' || code === 'PROTOCOL_SEQUENCE_TIMEOUT') {
    return 'เชื่อมต่อฐานข้อมูลไม่ทันเวลา (เน็ตที่ออฟฟิศช้า) กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'ECONNRESET' || code === 'PROTOCOL_CONNECTION_LOST' || code === 'EPIPE') {
    return 'การเชื่อมต่อฐานข้อมูลหลุดกลางคัน กรุณาลองใหม่อีกครั้ง';
  }
  if (code === 'ER_ACCESS_DENIED_ERROR') {
    return 'เข้าฐานข้อมูลไม่ได้ (ชื่อผู้ใช้/รหัสผ่านไม่ถูกต้อง)';
  }
  return err?.message || 'เกิดข้อผิดพลาดกับฐานข้อมูล';
}

/** ตอบ error กลับเป็น JSON เสมอ ฝั่งเว็บจะได้โชว์สาเหตุจริง */
export function replyDbError(res, error, context) {
  console.error(`${context} error:`, error);
  const connectionIssue = /ENOTFOUND|EAI_AGAIN|ECONNREFUSED|EHOSTUNREACH|ETIMEDOUT|ECONNRESET|PROTOCOL_CONNECTION_LOST|EPIPE/.test(error?.code || '');
  return res.status(connectionIssue ? 503 : 500).json({
    status: 'error',
    message: describeDbError(error),
  });
}
