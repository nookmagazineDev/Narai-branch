#!/usr/bin/env node
/**
 * สร้างค่า password_hash สำหรับเพิ่ม/แก้ผู้ใช้เว็บใน dbo.hr_user ด้วยมือ
 *
 * ใช้ตอนต้องเพิ่มผู้ใช้ใหม่ที่ยังไม่มีในชีท หรือรีเซ็ตรหัสให้สาขาที่ลืมรหัส
 * (ผู้ใช้ที่มีอยู่ในชีทแล้วไม่ต้องใช้สคริปต์นี้ — ระบบคัดลอกเข้ามาให้เองตอนล็อกอินครั้งแรก)
 *
 * วิธีใช้ (ที่เครื่องออฟฟิศ ในโฟลเดอร์ office-server)
 *   node scripts/hash-password.mjs "รหัสที่ต้องการ"
 *
 * แล้วเอาค่าที่ได้ไปวางในคำสั่ง SQL ที่สคริปต์พิมพ์ให้
 *
 * ทำไมต้องมีสคริปต์นี้: คอลัมน์ password_hash รับข้อความล้วนได้อยู่ (ระบบจะเข้ารหัสทับให้
 * ตอนคนนั้นล็อกอินครั้งถัดไป) แต่ระหว่างนั้นรหัสจริงจะนอนอยู่ในตารางแบบอ่านได้
 * ถ้าใส่ค่าที่เข้ารหัสแล้วตั้งแต่แรก ก็ไม่มีช่วงเวลานั้นเลย
 */

import { hashPassword } from '../hr-password.js';

const plain = process.argv[2];

if (!plain) {
  console.error('ใส่รหัสผ่านมาด้วย เช่น:  node scripts/hash-password.mjs "รหัสที่ต้องการ"');
  process.exit(1);
}
if (plain.length < 6) {
  console.error('รหัสผ่านสั้นเกินไป ควรยาวอย่างน้อย 6 ตัว');
  process.exit(1);
}

const hash = await hashPassword(plain);

console.log('');
console.log('password_hash:');
console.log(hash);
console.log('');
console.log('เพิ่มผู้ใช้ใหม่ (แก้ username / สาขา / outlet id ให้ตรงก่อนรัน):');
console.log('');
console.log('  USE narai_hr;');
console.log('  MERGE dbo.hr_user WITH (HOLDLOCK) AS t');
console.log("  USING (SELECT N'ชื่อผู้ใช้' AS username) AS s ON t.username = s.username");
console.log(`  WHEN MATCHED THEN UPDATE SET password_hash = N'${hash}', updated_at = SYSDATETIME()`);
console.log('  WHEN NOT MATCHED THEN');
console.log('       INSERT (username, password_hash, branch, outlet_id)');
console.log(`       VALUES (N'ชื่อผู้ใช้', N'${hash}', N'รหัสสาขา', N'outlet id');`);
console.log('');
