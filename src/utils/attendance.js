// ตัวช่วยสรุปข้อมูลสแกนเข้า-ออก — ใช้ร่วมกันระหว่างหน้า "สแกนเข้า-ออก" กับ modal ในหน้ารายชื่อพนักงาน
//
// "เข้า/ออก" คิดจากเวลาสแกนแรกและสแกนสุดท้ายของวัน ไม่ได้อิง punch_state
// เพราะการตั้งค่าปุ่มเข้า/ออกของเครื่องสแกนแต่ละตัวไม่เหมือนกัน (ข้อมูลจริงมีทั้งค่า 0 และ 2 ปนกัน)

/** "2026-08-06 09:05:12" -> "09:05" */
export const hhmm = (t) => String(t || '').slice(11, 16);

/** ผลต่างเป็นชั่วโมง จาก "YYYY-MM-DD HH:MM:SS" (เวลาท้องถิ่นทั้งคู่ ลบกันตรงๆ ได้) */
export function hoursBetween(a, b) {
  if (!a || !b || a === b) return null;
  const d1 = new Date(String(a).replace(' ', 'T'));
  const d2 = new Date(String(b).replace(' ', 'T'));
  if (isNaN(d1) || isNaN(d2)) return null;
  return (d2 - d1) / 3600000;
}

/**
 * รวมรายการสแกนดิบเป็นรายวัน — พนักงาน 1 คน x 1 วัน = 1 แถว
 * คืน [{ date, empCode, name, first, breakOut, breakIn, last, count, hours, breakHours, netHours }]
 * เรียงวันที่ล่าสุดก่อน
 *
 * ลำดับการสแกนปกติของสาขาคือ 4 รอบ: เข้างาน -> ออกเบรค -> เข้าเบรค -> ออกงาน
 * จึงอ่านจาก "ลำดับ" ของเวลาในวันนั้น ไม่ได้อ่านจาก punch_state
 * เพราะการตั้งค่าปุ่มของเครื่องสแกนแต่ละตัวไม่เหมือนกัน (ข้อมูลจริงมีทั้งค่า 0/1/2 ปนกัน)
 *
 * จำนวนครั้งที่สแกนไม่ครบ 4 ก็ยังอ่านได้เท่าที่มี:
 *   1 ครั้ง = มีแต่เวลาเข้า (ยังไม่ออก หรือลืมสแกน)
 *   2 ครั้ง = เข้า-ออก ไม่ได้แยกเบรค
 *   3 ครั้ง = มีออกเบรค แต่ขาดเข้าเบรค (ลืมสแกนตอนกลับ)
 *
 * สแกนที่ห่างจากครั้งก่อนไม่ถึง SCAN_MERGE_MIN นาทีนับเป็นครั้งเดียว (เก็บเวลาแรกไว้)
 * กันกรณีกดเครื่องซ้ำ หรือสแกนรวดหลายครั้ง ซึ่งจะทำให้ลำดับเข้า/ออกเบรคเลื่อนผิดทั้งแถว
 * จำนวนครั้งก่อนรวมอยู่ใน rawCount (แท็บ "ทุกครั้งที่สแกน" ยังเห็นครบทุกครั้ง)
 */
export const SCAN_MERGE_MIN = 10;

function mergeCloseScans(sorted) {
  const out = [];
  for (const t of sorted) {
    const prev = out[out.length - 1];
    const gap = prev ? hoursBetween(prev, t) : null;
    if (prev && (prev === t || (gap != null && gap * 60 < SCAN_MERGE_MIN))) continue;
    out.push(t);
  }
  return out;
}

export function summarizeDaily(rows) {
  const m = {};
  for (const r of rows || []) {
    const k = `${r.date}|${r.empCode}`;
    if (!m[k]) m[k] = { date: r.date, empCode: r.empCode, name: r.name, times: [] };
    if (!m[k].name && r.name) m[k].name = r.name;
    m[k].times.push(r.time);
  }
  return Object.values(m)
    .map((e) => {
      const ts = mergeCloseScans(e.times.slice().sort());
      const n = ts.length;
      const first = ts[0];
      const last = n > 1 ? ts[n - 1] : null;
      const breakOut = n >= 3 ? ts[1] : null;
      const breakIn = n >= 4 ? ts[2] : null;
      const hours = hoursBetween(first, last);
      const breakHours = hoursBetween(breakOut, breakIn);
      return {
        ...e,
        first,
        breakOut,
        breakIn,
        last,
        count: n,
        rawCount: e.times.length,
        hours,
        breakHours,
        // ชั่วโมงทำงานจริงหลังหักเวลาพัก (ถ้าไม่มีข้อมูลพักก็เท่ากับชั่วโมงรวม)
        netHours: hours != null && breakHours != null ? hours - breakHours : hours,
      };
    })
    .sort((a, b) => (b.date + b.empCode).localeCompare(a.date + a.empCode));
}

// ---------------------------------------------------------------------------
// เทียบกับตารางงานที่สาขาลงไว้ (hr_timesheet ผ่าน action getHistoryData)
//
// หน้าสแกนเข้า-ออกจะได้เห็นสองฝั่งคู่กัน: เวลาที่ "วางแผนไว้" กับเวลาที่ "สแกนจริง"
// แล้วสรุปส่วนต่างให้เลยว่าเข้าสาย/เข้าเบรคสาย/ออกก่อนเวลากี่นาที
// ---------------------------------------------------------------------------

/** 'HH:mm' -> จำนวนนาทีนับจากเที่ยงคืน (รองรับ '24:00' ที่ระบบเดิมใช้ได้จริง) */
export function minutesOfDay(t) {
  const m = String(t || '').match(/^(\d{1,2}):(\d{2})$/);
  if (!m) return null;
  return Number(m[1]) * 60 + Number(m[2]);
}

/** ระยะเบรคที่อนุญาตเป็นนาที จากข้อความในตารางงาน ('ไม่เบรค' / '1 ชม.') */
export function breakMinutes(text) {
  const s = String(text || '').trim();
  if (!s) return null;
  if (s.includes('ไม่เบรค')) return 0;
  const n = parseFloat(s);
  return Number.isFinite(n) ? Math.round(n * 60) : null;
}

/* ชื่อจากเครื่องสแกน (ZKBio9) กับจากตารางงานมักใส่คำนำหน้าไม่เหมือนกัน
   ใช้เป็นทางสำรองตอนรหัสไม่ตรงกันเท่านั้น รหัสยังเป็นตัวหลักเสมอ */
const normName = (s) =>
  String(s || '')
    .replace(/^(นาย|นางสาว|น\.ส\.|นาง|ว่าที่ร\.ต\.|ดร\.|mr\.?|mrs\.?|miss|ms\.?)\s*/i, '')
    .replace(/\s+/g, '')
    .toLowerCase();

/** แถวตารางงานหนึ่งแถว -> เวลาที่วางแผนไว้ (ข้อความ 'HH:mm' ตามที่สาขากรอก) */
export function planOf(record) {
  if (!record) return null;
  const range = String(record.breakTimeRange || '').split('-');
  return {
    in: record.checkIn || '',
    out: record.checkOut || '',
    breakOut: range[0] || '',
    breakIn: range[1] || '',
    breakAllowed: breakMinutes(record.breakTime),
    status: record.status || '',
    otHours: parseFloat(record.ot || '0') || 0,
    otApprover: record.otApprover || '',
    hourlyLeave: parseFloat(record.hourlyLeave || '0') || 0,
    empType: String(record.empType || '').trim(),
    expected: expectedToWork(record),
  };
}

/** วันนั้นพนักงานต้องมาทำงาน (มีเวลาเข้า-ออก และไม่ได้ลงว่าหยุด/ลา) */
export function expectedToWork(record) {
  if (!record || record.otherNote === 'ล้างข้อมูล') return false;
  if (String(record.status || '').trim() === 'หยุด') return false;
  if (String(record.leaveNote || '').trim() || String(record.unpaidLeave || '').trim()) return false;
  return Boolean(record.checkIn && record.checkOut);
}

/** ต่างกันกี่นาที คืน null ถ้าข้อมูลไม่พอ และคืน 0 เมื่อไม่สาย (ไม่คืนค่าติดลบ) */
function lateBy(actual, planned) {
  const a = minutesOfDay(actual);
  const p = minutesOfDay(planned);
  if (a == null || p == null) return null;
  return Math.max(0, Math.round(a - p));
}

/**
 * รวมสรุปรายวัน (จากการสแกน) เข้ากับตารางงานที่สาขาลงไว้
 *
 * จับคู่ด้วยรหัสพนักงานก่อนเสมอ ถ้าไม่เจอค่อยลองจับด้วยชื่อในวันเดียวกัน
 * (เครื่องสแกนกับตารางงานเป็นคนละระบบ บางสาขารหัสจึงไม่ตรงกัน)
 *
 * เพิ่มให้แต่ละแถว:
 *   plan      เวลาที่วางแผนไว้ (null = วันนั้นไม่มีในตารางงาน)
 *   lateIn        เข้างานสายกี่นาที
 *   lateBreakIn   กลับจากเบรคสายกี่นาที
 *   earlyOut      ออกก่อนเวลากี่นาที
 */
export function attachSchedule(daily, scheduleRows) {
  const byCode = new Map();
  const byName = new Map();
  for (const r of scheduleRows || []) {
    if (r.otherNote === 'ล้างข้อมูล') continue;
    const date = String(r.workDate || '').slice(0, 10);
    if (!date) continue;
    if (r.hrCode) byCode.set(`${date}|${String(r.hrCode).trim()}`, r);
    const n = normName(r.name);
    if (n) byName.set(`${date}|${n}`, r);
  }

  return (daily || []).map((d) => {
    const rec =
      byCode.get(`${d.date}|${String(d.empCode).trim()}`) ||
      byName.get(`${d.date}|${normName(d.name)}`) ||
      null;
    const plan = planOf(rec);
    if (!plan) return { ...d, plan: null, lateIn: null, lateBreakIn: null, earlyOut: null, shortMin: null };

    // กลับจากเบรคสาย: เทียบกับเวลาสิ้นสุดเบรคที่ลงไว้ ถ้าไม่ได้ลงช่วงเวลาไว้
    // ก็เทียบกับ "ออกเบรคจริง + ระยะเบรคที่อนุญาต" แทน จะได้ยังวัดได้
    let lateBreakIn = lateBy(hhmm(d.breakIn), plan.breakIn);
    if (lateBreakIn == null && plan.breakAllowed != null && d.breakOut && d.breakIn) {
      const out = minutesOfDay(hhmm(d.breakOut));
      const back = minutesOfDay(hhmm(d.breakIn));
      if (out != null && back != null) lateBreakIn = Math.max(0, Math.round(back - out - plan.breakAllowed));
    }

    const lateIn = lateBy(hhmm(d.first), plan.in);
    // ออกก่อนเวลา = กลับด้านของการสาย (เวลาที่ลงไว้ - เวลาที่สแกนออกจริง)
    const earlyOut = lateBy(plan.out, d.last ? hhmm(d.last) : '');
    // ชั่วโมงที่ขาดทั้งวัน = สาย + เบรคเกิน + ออกก่อน หักลาเป็นชั่วโมงที่ลงไว้แล้ว
    // วันที่สแกนไม่ครบคิดไม่ได้ (ไม่รู้ว่าออกกี่โมง) จึงเป็น null
    const shortMin = d.first && d.last && (lateIn != null || earlyOut != null)
      ? Math.max(0, (lateIn || 0) + (lateBreakIn || 0) + (earlyOut || 0) - Math.round(plan.hourlyLeave * 60))
      : null;

    return { ...d, plan, lateIn, lateBreakIn, earlyOut, shortMin };
  });
}

// ---------------------------------------------------------------------------
// แจ้งเตือนสแกนไม่ครบ / ชั่วโมงขาด
// ---------------------------------------------------------------------------

/** ขาดรวมเกินกี่นาทีต่อวันถึงแจ้งเตือน */
export const SHORT_ALERT_MIN = 15;

/**
 * คนที่มีตารางงานวันนั้นแต่ไม่มีการสแกนเลย -> แถวว่างแบบเดียวกับ summarizeDaily (count = 0)
 * จับคู่แบบเดียวกับ attachSchedule: รหัสก่อน ไม่เจอค่อยลองชื่อ
 */
export function missingFromSchedule(daily, scheduleRows) {
  const seenCode = new Set();
  const seenName = new Set();
  for (const d of daily || []) {
    seenCode.add(`${d.date}|${String(d.empCode).trim()}`);
    const n = normName(d.name);
    if (n) seenName.add(`${d.date}|${n}`);
  }
  const out = [];
  const added = new Set();
  for (const r of scheduleRows || []) {
    if (!expectedToWork(r)) continue;
    const date = String(r.workDate || '').slice(0, 10);
    const code = String(r.hrCode || '').trim();
    const n = normName(r.name);
    if (!date || (!code && !n)) continue;
    if ((code && seenCode.has(`${date}|${code}`)) || (n && seenName.has(`${date}|${n}`))) continue;
    const key = `${date}|${code || n}`;
    if (added.has(key)) continue;
    added.add(key);
    out.push({
      date, empCode: code || r.name, name: r.name || '', times: [],
      first: null, breakOut: null, breakIn: null, last: null,
      count: 0, rawCount: 0, hours: null, breakHours: null, netHours: null,
    });
  }
  return out;
}

/**
 * ใช้เวลาที่สาขากด "แก้ไข" ไว้แทนเวลาสแกนในช่องที่กรอก (ช่องที่เว้นว่างยังใช้เวลาสแกนจริง)
 * fixes = [{ workDate, empCode, timeIn, breakOut, breakIn, timeOut, reason, note, savedBy, savedAt }]
 */
export function applyFixes(daily, fixes) {
  const byKey = new Map((fixes || []).map((f) => [`${f.workDate}|${String(f.empCode).trim()}`, f]));
  if (byKey.size === 0) return daily;
  return (daily || []).map((d) => {
    const fix = byKey.get(`${d.date}|${String(d.empCode).trim()}`);
    if (!fix) return d;
    const at = (t, orig) => (t ? `${d.date} ${t}:00` : orig);
    const first = at(fix.timeIn, d.first);
    const breakOut = at(fix.breakOut, d.breakOut);
    const breakIn = at(fix.breakIn, d.breakIn);
    const last = at(fix.timeOut, d.last);
    const hours = hoursBetween(first, last);
    const breakHours = hoursBetween(breakOut, breakIn);
    return {
      ...d, fix, first, breakOut, breakIn, last, hours, breakHours,
      netHours: hours != null && breakHours != null ? hours - breakHours : hours,
    };
  });
}

/**
 * สถานะของแถวหนึ่ง (หลัง attachSchedule แล้ว)
 *   level: 'crit' | 'warn' | 'info' | 'ok' | 'fixed' | 'pending'
 * วันนี้ (และหลังจากนี้) ยังไม่ตรวจ — แจ้งเตือนเฉพาะเมื่อวานย้อนไป
 */
export function scanIssue(d, today) {
  if (d.date >= today) return { code: 'pending', level: 'pending', label: 'วันนี้ ยังไม่ตรวจ' };
  if (d.fix) return { code: 'fixed', level: 'fixed', label: 'แก้ไขแล้ว' };
  if (!d.first) return { code: 'none', level: 'crit', label: 'ไม่สแกนทั้งวัน' };
  if (!d.last) return { code: 'noOut', level: 'crit', label: 'ขาดออกงาน' };
  const expected = Boolean(d.plan?.expected);
  if (d.breakOut && !d.breakIn) return { code: 'noBreakIn', level: 'warn', label: 'ขาดเข้าเบรค' };
  if (expected && !d.breakOut && (d.plan.breakAllowed || 0) > 0) {
    return { code: 'noBreak', level: 'warn', label: 'ไม่ได้สแกนเบรค' };
  }
  if (expected && d.shortMin != null && d.shortMin > SHORT_ALERT_MIN) {
    return { code: 'short', level: 'warn', label: `ทำงานขาด ${d.shortMin} นาที` };
  }
  if (!d.plan) return { code: 'noPlan', level: 'info', label: 'ไม่มีในตารางงาน' };
  return { code: 'ok', level: 'ok', label: 'ครบ' };
}

/**
 * ประเภทพนักงาน (F/T, P/T, DAY9 ...) ของแต่ละแถว
 * ใช้ค่าในตารางงานของวันนั้นก่อน (ประเภท ณ วันนั้น) ไม่มีค่อยดูจากรายชื่อพนักงานปัจจุบัน
 * จับคู่รายชื่อด้วยรหัสก่อน ไม่เจอค่อยลองชื่อ แบบเดียวกับ attachSchedule
 */
export function empTypeLookup(employees) {
  const byCode = new Map();
  const byName = new Map();
  for (const e of employees || []) {
    const t = String(e.empType || e.type || '').trim();
    if (!t) continue;
    if (e.hrCode) byCode.set(String(e.hrCode).trim(), t);
    const n = normName(e.name || e.fullName);
    if (n) byName.set(n, t);
  }
  return (d) => d.plan?.empType || byCode.get(String(d.empCode).trim()) || byName.get(normName(d.name)) || '';
}

/** แถวนี้ต้องแจ้งเตือนไหม (ระดับด่วน/เตือน) */
export const isAlertIssue = (issue) => issue?.level === 'crit' || issue?.level === 'warn';

/**
 * สรุปรายวันพร้อมสถานะแจ้งเตือน — ใช้ร่วมกันระหว่างหน้าสแกนเข้า-ออกกับกระดิ่งแจ้งเตือน
 * scans = รายการสแกนดิบ, schedule = getHistoryData, fixes = getScanFixes, today = 'YYYY-MM-DD'
 * เรียงวันที่ล่าสุดก่อน แล้วตามชื่อ
 */
export function buildDailyReport(scans, schedule, fixes, today) {
  const scanned = summarizeDaily(scans);
  const all = [...scanned, ...missingFromSchedule(scanned, schedule)];
  return attachSchedule(applyFixes(all, fixes), schedule)
    .map((d) => ({ ...d, issue: scanIssue(d, today) }))
    .sort((a, b) => b.date.localeCompare(a.date) ||
      String(a.name || a.empCode).localeCompare(String(b.name || b.empCode), 'th'));
}

/** รายละเอียดสั้น ๆ ของแถวที่ถูกเตือน (ใช้ในกระดิ่ง) */
export function issueDetail(d) {
  const t = (v) => (v ? hhmm(v) : '');
  switch (d.issue?.code) {
    case 'none': return d.plan ? `ตารางงาน ${d.plan.in}–${d.plan.out}` : '';
    case 'noOut': return `เข้า ${t(d.first)} · ไม่มีสแกนออก`;
    case 'noBreakIn': return `ออกเบรค ${t(d.breakOut)} · ไม่มีสแกนกลับ`;
    case 'noBreak': return `สแกน ${t(d.first)} – ${t(d.last)} · ตารางมีเบรค`;
    case 'short': {
      const parts = [];
      if (d.lateIn) parts.push(`สาย ${d.lateIn}`);
      if (d.lateBreakIn) parts.push(`เบรคเกิน ${d.lateBreakIn}`);
      if (d.earlyOut) parts.push(`ออกก่อน ${d.earlyOut}`);
      return parts.length ? `${parts.join(' · ')} นาที` : '';
    }
    default: return '';
  }
}

/** ชื่อกรณีสำหรับชิปกรองบนแบนเนอร์ (เรียงตามความด่วน) */
export const ISSUE_TYPES = [
  { code: 'none', level: 'crit', label: 'ไม่สแกนทั้งวัน' },
  { code: 'noOut', level: 'crit', label: 'ขาดออกงาน' },
  { code: 'noBreakIn', level: 'warn', label: 'ขาดเข้าเบรค' },
  { code: 'noBreak', level: 'warn', label: 'ไม่ได้สแกนเบรค' },
  { code: 'short', level: 'warn', label: 'สแกนครบแต่ชั่วโมงขาด' },
];
