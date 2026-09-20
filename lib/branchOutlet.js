// ทะเบียนสาขา -> outlet ของ POS และชื่อฐานข้อมูลสาขา — ที่เดียวของฝั่ง api/*
// ---------------------------------------------------------------------------
// เดิมตารางนี้ถูกคัดลอกไว้ 5 ที่ (orderd, usage, withdrawals, insert_order, pending_orders)
// แล้วมันก็ไม่ตรงกันจริง ๆ:
//   - hps เคยเป็น 109 อยู่ 4 ไฟล์ ทั้งที่เลขจริงคือ 902 (แก้ไปแล้วในคอมมิต 2c84208)
//     แปลว่ายอด/ใบเบิก/ยอดใช้ของ HPS ที่หน้าพวกนั้นโชว์ เป็นของร้านอื่นมาตลอด
//   - zjp มีแค่ใน usage.js ไฟล์เดียว อีก 4 ไฟล์ไม่รู้จัก — สาขาที่ล็อกอินด้วย zjp จึงหาสาขา
//     ไม่เจอ ส่วนผู้ใช้สิทธิ์ all ที่เลือกจากดรอปดาวน์ (ได้ sjp) เจอปกติ → เห็นข้อมูลคนละชุด
//
// ตารางที่คัดลอกไว้หลายที่ไม่มีทางตรงกันเองได้ เพิ่ม/แก้สาขาใหม่จึงต้องทำที่ไฟล์นี้ที่เดียว
//
// แหล่งจริงระยะยาวคือ dbo.hr_branch (มีคนดูแล is_active/outlet_id อยู่แล้ว) แต่ api/* รันบน
// Vercel ซึ่งต่อ SQL ที่ออฟฟิศตรงไม่ได้ จึงยังต้องถือสำเนาไว้ที่นี่ — ถ้าวันหนึ่งย้ายมาถามผ่าน
// office-server ได้ ให้แทนที่ทั้งไฟล์นี้ด้วยการอ่านทะเบียนจริง
// ---------------------------------------------------------------------------

/** รหัสสาขาที่เป็นร้านเดียวกัน — ต้องตรงกับ BRANCH_ALIAS_GROUPS ใน office-server/hr-session.js */
const ALIAS_GROUPS = [
  ['zjp', 'sjp'],
];

/** รหัสสาขา (ตัวพิมพ์เล็ก) -> outlet ของ POS */
export const OUTLET_BY_BRANCH = {
  sjp: '7', zjp: '7', crm: '12', xcm: '19', slr: '37', sum: '51', sts: '55',
  xum: '59', scs: '61', smp: '63', xsb: '67', xhh: '72', hrs: '78', clk: '79',
  p90: '80', zbw: '400', zpt: '401', npt: '500', wrm: '501', wmt: '503',
  hps: '902', ipr: '904', zk3: '906', fct: '950',
};

/** outlet -> ชื่อต่อท้ายฐานข้อมูลสาขา (myfbdata<suffix>) */
export const DB_SUFFIX_BY_OUTLET = {
  7: 'zjp', 12: 'crm', 19: 'xcm', 37: 'slr', 51: 'sum', 55: 'sts', 59: 'xum',
  61: 'scs', 63: 'smp', 67: 'xsb', 72: 'xhh', 78: 'hrs', 79: 'clk', 80: 'p90',
  400: 'zbw', 401: 'zpt', 501: 'wrm', 902: 'hps', 906: 'zk3', 950: 'fct',
};

/** รหัสสาขาในเว็บ -> ชื่อฐานข้อมูลที่ POS ใช้จริง (ต่างกันอยู่ไม่กี่สาขา) */
export const DB_SUFFIX_BY_BRANCH = { sjp: 'zjp', zip: 'zjp' };

const norm = (b) => String(b ?? '').toLowerCase().trim();

/** รหัสทั้งหมดที่เป็นร้านเดียวกันกับรหัสนี้ (รวมตัวมันเอง) */
export const branchSiblings = (branch) => {
  const b = norm(branch);
  if (!b) return [];
  const hit = ALIAS_GROUPS.find((g) => g.includes(b));
  return hit ? [...hit] : [b];
};

/**
 * outlet ของสาขานั้น — ลองรหัสพี่น้องให้ด้วย ('zjp' กับ 'sjp' ต้องได้เลขเดียวกันเสมอ)
 * ไม่รู้จักรหัสนี้คืน '' ให้ผู้เรียกตัดสินใจเอง (บางหน้ามีทางถอยเป็นค่าที่ส่งมาใน query)
 */
export function outletIdOf(branch) {
  for (const code of branchSiblings(branch)) {
    if (OUTLET_BY_BRANCH[code]) return OUTLET_BY_BRANCH[code];
  }
  return '';
}

/** ชื่อฐานข้อมูลสาขาจาก outlet (หรือจากรหัสสาขาถ้า outlet ไม่รู้จัก) */
export function dbSuffixOf(outletId, branch) {
  const fromOutlet = DB_SUFFIX_BY_OUTLET[Number(outletId)];
  if (fromOutlet) return fromOutlet;
  const b = norm(branch);
  return DB_SUFFIX_BY_BRANCH[b] || b || '';
}
