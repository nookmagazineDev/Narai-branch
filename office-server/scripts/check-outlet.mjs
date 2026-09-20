#!/usr/bin/env node
/**
 * ตรวจว่า "เลข outlet ของแต่ละสาขา" ในทุกแหล่งตรงกันไหม
 *
 * ระบบนี้ถือเลข outlet ไว้ 3 ที่ และแต่ละที่มีคนละคนดูแล:
 *   1. dbo.hr_branch.outlet_id   — ทะเบียนสาขา (ผู้ใช้สิทธิ์ all เลือกจากดรอปดาวน์นี้)
 *   2. dbo.hr_user.outlet_id     — ติดตัวผู้ใช้ตอน login (สาขาใช้เลขนี้)
 *   3. lib/branchOutlet.js       — ตารางในโค้ดฝั่ง Vercel (api/* ใช้ตอนไม่มี outletId ส่งมา)
 *
 * ไม่ตรงกันเมื่อไหร่ แอดมินกับสาขาจะเห็นยอดรับเข้า/ใบเบิก/สินค้ารอเข้าคนละชุด โดยไม่มีอะไรฟ้อง
 * (เคสจริง: HPS เคยเป็น 109 ในโค้ด 4 ไฟล์ ทั้งที่เลขจริงคือ 902 — ข้อมูลที่โชว์เป็นของร้านอื่น)
 *
 * วิธีใช้ (รันจากโฟลเดอร์ office-server บนเครื่องที่ออฟฟิศ):
 *   node scripts/check-outlet.mjs
 *
 * อ่านอย่างเดียว ไม่เขียนอะไรทั้งนั้น — ออก exit code 1 ถ้าเจอที่ไม่ตรง (เอาไปใส่ CI ได้)
 */

import { config } from 'dotenv';
import path from 'node:path';
import process from 'node:process';
import { fileURLToPath } from 'node:url';

const here = path.dirname(fileURLToPath(import.meta.url));
config({ path: path.join(here, '..', '.env') });

// hr_branch / hr_user อยู่ฐาน HR (narai_hr) — ไม่ใช่ InventoryNarai ของหน้านับสต๊อก
// (InventoryNarai มีตารางชื่อเดียวกันค้างอยู่จากตอนย้ายระบบ แต่คนละสคีมาและไม่ใช่ตัวที่ระบบใช้)
const { hrDb, isConfigured, describeDbError } = await import('../hr-db.js');
const { OUTLET_BY_BRANCH, branchSiblings } = await import('../../lib/branchOutlet.js');

const HR_DB = process.env.HR_DB_NAME || 'narai_hr';

if (!isConfigured()) {
  console.error('ยังไม่ได้ตั้งค่า HR_DB_USER / HR_DB_PASSWORD ใน office-server/.env');
  process.exit(2);
}

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const line = () => console.log('─'.repeat(78));

try {
  // ตารางรุ่นเก่าบางเครื่องยังไม่มีคอลัมน์ is_active — ถอยไปอ่านแบบไม่มีคอลัมน์นั้นแทนที่จะล้มทั้งสคริปต์
  const readBranches = async () => {
    try {
      return await hrDb.queryRead('SELECT branch, branch_name, outlet_id, is_active FROM dbo.hr_branch ORDER BY branch');
    } catch (err) {
      if (!/Invalid column name/i.test(err?.message || '')) throw err;
      console.log('  (ตารางนี้ยังไม่มีคอลัมน์ is_active — ถือว่าทุกสาขาเปิดใช้งาน)');
      const rows = await hrDb.queryRead('SELECT branch, branch_name, outlet_id FROM dbo.hr_branch ORDER BY branch');
      return rows.map((r) => ({ ...r, is_active: true }));
    }
  };

  console.log(`อ่านจากฐาน ${HR_DB} (dbo.hr_branch / dbo.hr_user)`);
  console.log('');
  const [branches, users] = await Promise.all([
    readBranches(),
    hrDb.queryRead('SELECT username, branch, outlet_id FROM dbo.hr_user ORDER BY branch, username'),
  ]);

  const problems = [];
  const registry = new Map(branches.map((b) => [str(b.branch).toLowerCase(), b]));

  console.log('ทะเบียนสาขา (dbo.hr_branch) เทียบกับตารางในโค้ด (lib/branchOutlet.js)');
  line();
  for (const b of branches) {
    const code = str(b.branch).toLowerCase();
    const inDb = str(b.outlet_id);
    const inCode = OUTLET_BY_BRANCH[code] || '';
    const same = inDb === inCode;
    if (!inDb) {
      console.log(`  ${code.padEnd(6)} ทะเบียนไม่ได้ใส่ outlet_id (โค้ดมี ${inCode || '-'})`);
      if (inCode) problems.push(`${code}: ทะเบียนว่าง แต่โค้ดมี ${inCode}`);
      continue;
    }
    if (!inCode) {
      console.log(`  ${code.padEnd(6)} ${inDb.padEnd(5)} ← โค้ดยังไม่รู้จักรหัสนี้`);
      if (b.is_active) problems.push(`${code}: มีในทะเบียน (${inDb}) แต่ lib/branchOutlet.js ไม่มี`);
      continue;
    }
    console.log(`  ${code.padEnd(6)} ทะเบียน ${inDb.padEnd(5)} · โค้ด ${inCode.padEnd(5)} ${same ? 'ตรงกัน' : '❌ ไม่ตรงกัน'}`);
    if (!same) problems.push(`${code}: ทะเบียน ${inDb} แต่โค้ด ${inCode}`);
  }

  // รหัสพี่น้องต้องชี้ไป outlet เดียวกัน ไม่งั้น zjp กับ sjp จะกลายเป็นคนละร้าน
  console.log('');
  console.log('รหัสพี่น้อง (ร้านเดียวกันหลายรหัส)');
  line();
  const seen = new Set();
  for (const code of Object.keys(OUTLET_BY_BRANCH)) {
    const group = branchSiblings(code);
    if (group.length < 2 || seen.has(group.join('|'))) continue;
    seen.add(group.join('|'));
    const ids = group.map((c) => OUTLET_BY_BRANCH[c] || '-');
    const same = new Set(ids).size === 1;
    console.log(`  ${group.join(' / ')} → ${ids.join(' / ')} ${same ? 'ตรงกัน' : '❌ ไม่ตรงกัน'}`);
    if (!same) problems.push(`${group.join('/')}: รหัสพี่น้องชี้คนละ outlet (${ids.join('/')})`);
  }

  console.log('');
  console.log('ผู้ใช้ (dbo.hr_user) เทียบกับทะเบียนสาขา');
  line();
  let userProblems = 0;
  for (const u of users) {
    const code = str(u.branch).toLowerCase();
    if (!code || code === 'all') continue;   // 'all' ไม่ใช่สาขาจริง
    const reg = registry.get(code) || registry.get(branchSiblings(code).find((c) => registry.has(c)));
    const inUser = str(u.outlet_id);
    const inReg = str(reg?.outlet_id);
    if (!reg) {
      console.log(`  ${String(u.username).padEnd(16)} สาขา ${code} ← ไม่มีในทะเบียนสาขา`);
      problems.push(`ผู้ใช้ ${u.username}: สาขา ${code} ไม่มีในทะเบียน`);
      userProblems++;
      continue;
    }
    if (inReg && inUser !== inReg) {
      console.log(`  ${String(u.username).padEnd(16)} สาขา ${code.padEnd(5)} hr_user ${inUser || '(ว่าง)'} · ทะเบียน ${inReg} ❌`);
      problems.push(`ผู้ใช้ ${u.username}: hr_user=${inUser || 'ว่าง'} แต่ทะเบียน=${inReg}`);
      userProblems++;
    }
  }
  if (userProblems === 0) console.log('  ตรงกันทุกคน');

  console.log('');
  line();
  if (problems.length === 0) {
    console.log('✅ ทุกแหล่งตรงกัน');
    process.exit(0);
  }
  console.log(`❌ เจอ ${problems.length} จุดที่ไม่ตรงกัน`);
  for (const p of problems) console.log(`   · ${p}`);
  console.log('');
  console.log('แก้ที่ไหน: ทะเบียนสาขา (dbo.hr_branch) คือแหล่งจริง — แก้ที่นั่นก่อน');
  console.log('แล้วอัปเดต lib/branchOutlet.js ให้ตรง ส่วน hr_user.outlet_id ตอน login จะถูก');
  console.log('ทับด้วยค่าจากทะเบียนให้เองอยู่แล้ว (ดู payloadWithRegistryOutlet ใน schedule.js)');
  process.exit(1);
} catch (err) {
  console.error('ตรวจไม่สำเร็จ:', describeDbError ? describeDbError(err) : err.message);
  process.exit(2);
}
