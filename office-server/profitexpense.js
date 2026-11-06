// ค่าใช้จ่ายอื่น ๆ ในตาราง "สรุปกำไร / ขาดทุน" (src/components/ProfitSummary.jsx)
// ตาราง dbo.profit_expense (ดู sql/profitexp-001-table.sql) — หนึ่งแถวต่อ (เดือน + สาขา + รายการ)
//
// เดิมช่องพวกนี้อยู่แค่ใน state ของหน้าเว็บ รีเฟรช/ออกจากเมนูแล้วหายหมด
//
// กติกา
//   - ทุกสาขากรอก/แก้ของสาขาตัวเองได้ ออฟฟิศ (สิทธิ์ all) แก้ได้ทุกสาขา (ด่านเดียวกับ branchFor)
//   - เก็บใต้รหัสหลักของกลุ่มสาขา (zjp/sjp -> zjp) จึงเห็นชุดเดียวกันไม่ว่าล็อกอินด้วยรหัสไหน
//   - บันทึกส่งมาเฉพาะรายการที่จะเปลี่ยน: ตัวเลข = ตั้งค่า · ว่าง/null = ลบรายการนั้นของเดือนนั้น

import { sql, stockDb } from './hr-db.js';
import { branchFor, branchGroup } from './hr-session.js';

const { queryRead, withTransaction } = stockDb;

/** รายการที่เก็บได้ — ต้องตรงกับ EXPENSES + member/delivery ใน ProfitSummary.jsx */
export const PROFIT_EXPENSE_KEYS = [
  'petty', 'rent', 'water', 'power', 'ice', 'phone', 'gas', 'insurance',
  'member', 'delivery',
];
const KEY_SET = new Set(PROFIT_EXPENSE_KEYS);

const str = (v) => (v === null || v === undefined ? '' : String(v).trim());
const badRequest = (msg) => Object.assign(new Error(msg), { badRequest: true });
const isMonth = (v) => /^\d{4}-(0[1-9]|1[0-2])$/.test(str(v));

const two = (n) => String(n).padStart(2, '0');
function localStamp(d = new Date()) {
  return `${d.getFullYear()}-${two(d.getMonth() + 1)}-${two(d.getDate())} ` +
    `${two(d.getHours())}:${two(d.getMinutes())}:${two(d.getSeconds())}`;
}

/** รหัสที่ใช้เก็บ: ผ่านด่านสิทธิ์ก่อน แล้วยุบรหัสพี่น้องเป็นรหัสหลักของกลุ่ม */
export function storageBranch(code) {
  return branchGroup(code)[0] || '';
}
function branchOf(body, session) {
  const b = storageBranch(branchFor(session, body.branch));
  if (!b || b === 'all') throw badRequest('ระบุสาขา');
  return b;
}

/** ตัวเลขเงินจากหน้าเว็บ — ว่าง/null = ลบ (คืน null) · อ่านไม่ได้ = undefined */
function parseAmount(v) {
  if (v === null || v === undefined) return null;
  const s = String(v).replace(/,/g, '').trim();
  if (s === '') return null;
  const n = Number(s);
  return Number.isFinite(n) ? Math.round(n * 100) / 100 : undefined;
}

async function readMonths(branch, from, to) {
  const rows = await queryRead(
    `SELECT exp_month, item_key, amount, source,
            CONVERT(NVARCHAR(19), COALESCE(updated_at, created_at), 120) AS changed_at,
            COALESCE(updated_by, created_by) AS changed_by
       FROM dbo.profit_expense
      WHERE branch = @branch AND exp_month BETWEEN @from AND @to
      ORDER BY exp_month`,
    {
      branch: { type: sql.NVarChar(50), value: branch },
      from: { type: sql.Char(7), value: from },
      to: { type: sql.Char(7), value: to },
    }
  );
  const months = {};
  for (const r of rows) {
    const m = str(r.exp_month);
    const slot = months[m] || (months[m] = { values: {}, updatedAt: '', updatedBy: '' });
    slot.values[str(r.item_key)] = Number(r.amount) || 0;
    const at = str(r.changed_at);
    if (at > slot.updatedAt) {
      slot.updatedAt = at;
      slot.updatedBy = r.source === 'sheet' && !r.changed_by ? 'Google Sheet' : str(r.changed_by);
    }
  }
  return months;
}

/**
 * ค่าที่บันทึกไว้ของสาขาในช่วงเดือน — body: { branch, from:'YYYY-MM', to:'YYYY-MM' }
 * คืน { branch, months: { 'YYYY-MM': { values:{petty: 1200, ...}, updatedAt, updatedBy } } }
 */
async function getProfitExpenses(body, session) {
  const branch = branchOf(body, session);
  const from = isMonth(body.from) ? str(body.from) : str(body.month);
  const to = isMonth(body.to) ? str(body.to) : from;
  if (!isMonth(from) || !isMonth(to)) throw badRequest('ระบุเดือน (YYYY-MM)');
  return { branch, months: await readMonths(branch, from <= to ? from : to, from <= to ? to : from) };
}

/**
 * บันทึกค่าของ (สาขา + เดือน) — body: { branch, month:'YYYY-MM', values:{ key: ตัวเลข | '' | null }, recorder }
 * ส่งมาเฉพาะรายการที่จะเปลี่ยนก็ได้ รายการที่ไม่ได้ส่งมาคงค่าเดิม
 */
async function saveProfitExpenses(body, session) {
  const branch = branchOf(body, session);
  const month = str(body.month);
  if (!isMonth(month)) throw badRequest('ระบุเดือน (YYYY-MM)');
  const values = body.values && typeof body.values === 'object' ? body.values : {};
  const recorder = str(session?.username) || str(body.recorder) || 'Unknown';

  const sets = [], clears = [];
  for (const [key, raw] of Object.entries(values)) {
    if (!KEY_SET.has(key)) continue;
    const amt = parseAmount(raw);
    if (amt === undefined) throw badRequest(`จำนวนเงินของ "${key}" ไม่ถูกต้อง`);
    if (amt === null) clears.push(key);
    else if (amt < 0) throw badRequest('จำนวนเงินติดลบไม่ได้');
    else sets.push({ key, amt });
  }
  if (sets.length === 0 && clears.length === 0) throw badRequest('ไม่มีรายการที่จะบันทึก');

  const now = localStamp();
  await withTransaction(async (run) => {
    for (const s of sets) {
      // UPDLOCK + HOLDLOCK กันสองเครื่องกดบันทึกเดือนเดียวกันพร้อมกันแล้วชน unique key
      await run(
        `UPDATE dbo.profit_expense WITH (UPDLOCK, HOLDLOCK)
            SET amount = @amount, updated_at = CONVERT(DATETIME2(0), @now, 120), updated_by = @who
          WHERE exp_month = @month AND branch = @branch AND item_key = @key;
         IF @@ROWCOUNT = 0
           INSERT INTO dbo.profit_expense (exp_month, branch, item_key, amount, created_at, created_by, source)
           VALUES (@month, @branch, @key, @amount, CONVERT(DATETIME2(0), @now, 120), @who, N'web');`,
        {
          month: { type: sql.Char(7), value: month },
          branch: { type: sql.NVarChar(50), value: branch },
          key: { type: sql.NVarChar(30), value: s.key },
          amount: { type: sql.Decimal(18, 2), value: s.amt },
          now: { type: sql.NVarChar(19), value: now },
          who: { type: sql.NVarChar(255), value: recorder },
        }
      );
    }
    for (const key of clears) {
      await run(
        `DELETE FROM dbo.profit_expense WHERE exp_month = @month AND branch = @branch AND item_key = @key;`,
        {
          month: { type: sql.Char(7), value: month },
          branch: { type: sql.NVarChar(50), value: branch },
          key: { type: sql.NVarChar(30), value: key },
        }
      );
    }
  });

  const months = await readMonths(branch, month, month);
  return {
    message: `บันทึกค่าใช้จ่ายเดือน ${month} แล้ว`,
    branch,
    month,
    saved: months[month] || { values: {}, updatedAt: '', updatedBy: '' },
  };
}

export const PROFIT_EXPENSE_ACTIONS = {
  getProfitExpenses,
  saveProfitExpenses,
};
