// สัญชาติ + เอกสารพนักงานต่างชาติ — ตรรกะที่หน้ารายชื่อพนักงานใช้ (ฝั่งเซิร์ฟเวอร์: office-server/employee-doc.js)
//
// ที่นี่มีสามเรื่อง: (1) คำนวณว่าเอกสารไหนใกล้หมด/หมดอายุ (2) จับคู่แถวเอกสารกับพนักงาน
// (3) อ่านไฟล์ Excel "DATA พนักงานต่างชาติ" ให้เป็นแถวที่เซิร์ฟเวอร์รับ

/** แจ้งเตือนล่วงหน้ากี่วันก่อนหมดอายุ */
export const DOC_WARN_DAYS = 120;
/** เหลือไม่เกินกี่วันถือว่าด่วน (สีส้ม) */
export const DOC_URGENT_DAYS = 30;

/** เอกสารที่มีวันหมดอายุ — key คือชื่อฟิลด์วันที่ของแถวเอกสาร */
export const DOC_TYPES = [
  { key: 'passportExpiry', label: 'หนังสือเดินทาง (Passport)', short: 'Passport' },
  { key: 'visaExpiry', label: 'วีซ่า (Visa)', short: 'วีซ่า' },
  { key: 'wpExpiry', label: 'ใบอนุญาตทำงาน (Work Permit)', short: 'ใบอนุญาตทำงาน' },
  { key: 'report90Date', label: 'รายงานตัว 90 วัน', short: 'รายงานตัว 90 วัน' },
  { key: 'pinkExpiry', label: 'บัตรประจำตัวคนต่างด้าว (บัตรชมพู)', short: 'บัตรชมพู' },
  { key: 'pkkExpiry', label: 'ปกค.', short: 'ปกค.' },
];

export const COUNTRIES = ['พม่า', 'ลาว', 'เขมร', 'เวียดนาม', 'ฟิลิปปินส์'];

/** แถวเอกสารเปล่าของพนักงานที่ยังไม่เคยบันทึก — ไม่มีแถว = คนไทย (ค่าเริ่มต้น) */
export const emptyDoc = (natType = 'thai') => ({
  docId: 0, hrCode: '', fullName: '', branch: '', natType,
  prefix: '', country: '', phone: '', email: '', ssoNo: '', bankAccount: '',
  passportNo: '', passportExpiry: '', visaExpiry: '', mou: '',
  wpIdNo: '', wpPermitNo: '', wpExpiry: '', report90Date: '',
  pinkNo: '', pinkExpiry: '', pkkExpiry: '', missingDocs: '',
});

const pad = (n) => String(n).padStart(2, '0');
const ymdOf = (y, m, d) => `${y}-${pad(m)}-${pad(d)}`;

/** วันนี้ตามเวลาเครื่อง (เที่ยงคืน) */
const today = () => { const t = new Date(); return new Date(t.getFullYear(), t.getMonth(), t.getDate()); };

/** 'YYYY-MM-DD' -> Date เที่ยงคืนเวลาเครื่อง (ไม่ผ่าน UTC วันจะได้ไม่เลื่อน) */
export const parseYmd = (s) => {
  const m = String(s || '').match(/^(\d{4})-(\d{2})-(\d{2})$/);
  return m ? new Date(Number(m[1]), Number(m[2]) - 1, Number(m[3])) : null;
};

/** เหลืออีกกี่วัน (ติดลบ = หมดอายุมาแล้ว) · ไม่มีวันที่ = null */
export const daysLeft = (ymd, now = today()) => {
  const d = parseYmd(ymd);
  return d ? Math.round((d - now) / 86400000) : null;
};

/** ระดับของจำนวนวันที่เหลือ: none ไม่มีข้อมูล · expired · urgent (≤30) · warn (≤120) · ok */
export const docLevel = (n) => (
  n === null || n === undefined ? 'none'
    : n < 0 ? 'expired'
      : n <= DOC_URGENT_DAYS ? 'urgent'
        : n <= DOC_WARN_DAYS ? 'warn' : 'ok'
);

export const docLevelText = (n) => (
  n === null || n === undefined ? 'ไม่มีข้อมูล'
    : n < 0 ? `หมดอายุแล้ว ${-n} วัน`
      : n === 0 ? 'หมดอายุวันนี้'
        : n <= DOC_WARN_DAYS ? `เหลือ ${n} วัน` : 'ปกติ'
);

/** 'YYYY-MM-DD' -> '13 ก.พ. 2570' */
export const formatDocDate = (ymd) => {
  const d = parseYmd(ymd);
  return d ? d.toLocaleDateString('th-TH', { year: 'numeric', month: 'short', day: 'numeric' }) : '-';
};

export const isForeign = (doc) => !!doc && doc.natType !== 'thai';

/** เอกสารของคนนี้ที่ต้องดำเนินการ (หมดแล้ว หรือเหลือไม่เกิน 120 วัน) เรียงจากด่วนสุด */
export const docIssues = (doc, now = today()) => {
  if (!isForeign(doc)) return [];
  return DOC_TYPES
    .map((t) => ({ ...t, date: doc[t.key], days: daysLeft(doc[t.key], now) }))
    .filter((x) => x.days !== null && x.days <= DOC_WARN_DAYS)
    .sort((a, b) => a.days - b.days);
};

/* ----------------------------- ชื่อ -----------------------------
   ต้องให้ผลตรงกับ normName() ใน office-server/employee-doc.js */
const NAME_PREFIX = /^(นางสาว|นาง|นาย|น\.?\s*ส\.?|ด\.?\s*ช\.?|ด\.?\s*ญ\.?|mrs|miss|mr|ms)[.\s]*/i;
export const normName = (v) => String(v ?? '').trim().replace(NAME_PREFIX, '').replace(/[\s.\-_/]+/g, '').toLowerCase();

/* ----------------------------- อ่านไฟล์ Excel -----------------------------
   รูปแบบไฟล์ "DATA พนักงานต่างชาติ": หัวตาราง 2 แถว แล้วตามด้วยข้อมูล คอลัมน์ตายตัว A..U
     A ลำดับ · B คำนำหน้า · C ชื่อ-สกุล · D โทร · E สัญชาติ · F สาขา
     G พาสปอร์ต Code · H พาสปอร์ตหมดอายุ · I วีซ่าหมดอายุ · J MOU
     K ใบอนุญาต เลขประจำตัว · L เลขที่ใบอนุญาต · M มติแรงงานหมดอายุ · N รายงานตัว 90 วัน
     O บัตรชมพู เลขที่ · P บัตรชมพูหมดอายุ · Q Email · R เลขประกันสังคม · S ปกค.หมดอายุ
     T เลขบัญชี · U ขาดเอกสาร */

const THAI_MONTHS = ['ม.ค', 'ก.พ', 'มี.ค', 'เม.ย', 'พ.ค', 'มิ.ย', 'ก.ค', 'ส.ค', 'ก.ย', 'ต.ค', 'พ.ย', 'ธ.ค'];
const EN_MONTHS = ['jan', 'feb', 'mar', 'apr', 'may', 'jun', 'jul', 'aug', 'sep', 'oct', 'nov', 'dec'];

/** ปีในไฟล์ปนกันทั้ง ค.ศ. (2027) และ พ.ศ. (2570) — เกิน 2400 ถือเป็น พ.ศ. */
const fixYear = (y) => (y > 2400 ? y - 543 : y < 100 ? y + 2000 : y);
const validYmd = (y, m, d) => {
  const yy = fixYear(y);
  const dt = new Date(yy, m - 1, d);
  if (yy < 1990 || yy > 2200 || dt.getMonth() !== m - 1 || dt.getDate() !== d) return null;
  return ymdOf(yy, m, d);
};

/**
 * ค่าในช่องวันที่ของ Excel -> { ymd, raw }
 *   ymd  = 'YYYY-MM-DD' (ค.ศ.) หรือ '' ถ้าช่องว่าง/อ่านไม่ออก
 *   raw  = ข้อความเดิม เมื่อมีค่าแต่อ่านเป็นวันที่ไม่ได้ (เอาไปใส่หมายเหตุ ไม่ทิ้งข้อมูล)
 * @param {(serial: number) => ({y:number,m:number,d:number}|null)} parseSerial XLSX.SSF.parse_date_code
 */
export const excelDate = (v, parseSerial) => {
  if (v === null || v === undefined || v === '') return { ymd: '', raw: '' };
  if (typeof v === 'number') {
    const p = parseSerial ? parseSerial(v) : null;
    const ymd = p ? validYmd(p.y, p.m, p.d) : null;
    return ymd ? { ymd, raw: '' } : { ymd: '', raw: String(v) };
  }
  if (v instanceof Date) {
    const ymd = validYmd(v.getFullYear(), v.getMonth() + 1, v.getDate());
    return ymd ? { ymd, raw: '' } : { ymd: '', raw: String(v) };
  }
  const s = String(v).trim();
  if (!s || s === '-') return { ymd: '', raw: '' };
  let m = s.match(/^(\d{4})[-/.](\d{1,2})[-/.](\d{1,2})/);
  if (m) {
    const ymd = validYmd(Number(m[1]), Number(m[2]), Number(m[3]));
    if (ymd) return { ymd, raw: '' };
  }
  m = s.match(/^(\d{1,2})[-/. ]+(\d{1,2})[-/. ]+(\d{2,4})$/);
  if (m) {
    const ymd = validYmd(Number(m[3]), Number(m[2]), Number(m[1]));
    if (ymd) return { ymd, raw: '' };
  }
  // '26-ม.ค-2026' / '26 ม.ค. 69' / '26-Jan-2026'
  m = s.match(/^(\d{1,2})[-/ ]+([^\d\s/-]+?)\.?[-/ ]+(\d{2,4})$/);
  if (m) {
    const name = m[2].replace(/\.$/, '').toLowerCase();
    let month = THAI_MONTHS.findIndex((t) => t === name || t.replace(/\./g, '') === name.replace(/\./g, '')) + 1;
    if (!month) month = EN_MONTHS.findIndex((t) => name.startsWith(t)) + 1;
    if (month) {
      const ymd = validYmd(Number(m[3]), month, Number(m[1]));
      if (ymd) return { ymd, raw: '' };
    }
  }
  return { ymd: '', raw: s };
};

const cell = (v) => {
  if (v === null || v === undefined) return '';
  const s = String(v).trim();
  return s === '-' ? '' : s;
};

/**
 * แถวดิบของชีท (array ของ array, รวมหัวตาราง) -> แถวที่ส่งให้ importEmployeeDocs
 * @returns {{ rows: object[], skipped: number, dateNotes: number }}
 */
export const parseForeignSheet = (aoa, parseSerial) => {
  const rows = [];
  let skipped = 0;
  let dateNotes = 0;
  for (const r of aoa || []) {
    const fullName = cell(r?.[2]).replace(/\s+/g, ' ');
    const branch = cell(r?.[5]).toLowerCase();
    // แถวหัวตาราง/แถวว่าง: ช่องลำดับไม่ใช่ตัวเลข หรือไม่มีชื่อ-สาขา
    if (!fullName || !branch || !/^\d+$/.test(cell(r?.[0]))) { if (fullName) skipped += 1; continue; }

    const notes = [];
    const date = (i, label) => {
      const { ymd, raw } = excelDate(r[i], parseSerial);
      if (raw) { notes.push(`${label}: ${raw}`); dateNotes += 1; }
      return ymd;
    };
    const row = {
      ...emptyDoc('foreign'),
      fullName,
      branch,
      prefix: cell(r[1]),
      phone: cell(r[3]),
      country: cell(r[4]),
      passportNo: cell(r[6]),
      passportExpiry: date(7, 'พาสปอร์ตหมดอายุ'),
      visaExpiry: date(8, 'วีซ่าหมดอายุ'),
      mou: cell(r[9]),
      wpIdNo: cell(r[10]),
      wpPermitNo: cell(r[11]),
      wpExpiry: date(12, 'ใบอนุญาตทำงานหมดอายุ'),
      report90Date: date(13, 'รายงานตัว 90 วัน'),
      pinkNo: cell(r[14]),
      pinkExpiry: date(15, 'บัตรชมพูหมดอายุ'),
      email: cell(r[16]),
      ssoNo: cell(r[17]),
      pkkExpiry: date(18, 'ปกค.หมดอายุ'),
      bankAccount: cell(r[19]),
    };
    row.missingDocs = [cell(r[20]), ...notes].filter(Boolean).join(' | ');
    rows.push(row);
  }
  return { rows, skipped, dateNotes };
};
