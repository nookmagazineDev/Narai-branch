// กระดิ่งแจ้งเตือนมุมขวาบน — รวมรายการ "สแกนไม่ครบ / ชั่วโมงขาด" ของ 7 วันล่าสุด (ถึงเมื่อวาน)
//
// ใช้กฎชุดเดียวกับหน้าสแกนเข้า-ออก (buildDailyReport ใน utils/attendance.js) ตัวเลขจึงตรงกันเสมอ
// ดึงข้อมูล 3 ก้อนต่อสาขาเหมือนหน้านั้น: สแกน (ZKBio9) + ตารางงาน + เวลาที่สาขาแก้ไขไว้
//
// สาขาเห็นเฉพาะสาขาตัวเอง แอดมิน (all) เห็นทุกสาขา — ดึงทีละ 3 สาขาพร้อมกัน
// ผลเก็บไว้ใน sessionStorage 15 นาที กดเปลี่ยนหน้าไปมาจะไม่ยิงซ้ำ
import { apiCall } from './api';
import { fetchAttendance } from './dashboardApi';
import { buildDailyReport, isAlertIssue, issueDetail } from '../utils/attendance';

export const ALERT_DAYS = 7;
export const ALERT_CACHE_MS = 15 * 60 * 1000;
/** หน้าสแกนยิง event นี้หลังบันทึก/ยกเลิกการแก้ไข ให้กระดิ่งโหลดใหม่ทันที */
export const SCAN_ALERTS_CHANGED = 'scan-alerts-changed';

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };

/** สาขาที่มีตารางงานอย่างน้อยเท่านี้คนในวันเดียว แต่ไม่มีสแกนเลยสักคน = น่าจะเป็นเครื่องสแกนไม่ส่งข้อมูล */
const DEVICE_MIN_PEOPLE = 3;

/** รายการแจ้งเตือนของสาขาเดียว */
async function branchAlerts(branch, startDate, endDate, today) {
  const [res, sched, fixRes] = await Promise.all([
    fetchAttendance({ branch, startDate, endDate }),
    apiCall('getHistoryData', { branch, startDate, endDate }).catch(() => null),
    apiCall('getScanFixes', { branch, startDate, endDate }).catch(() => null),
  ]);
  if (res?.status !== 'success') throw new Error(res?.message || 'ดึงประวัติสแกนไม่สำเร็จ');
  const scans = res.data || [];
  const report = buildDailyReport(scans, Array.isArray(sched?.data) ? sched.data : [], Array.isArray(fixRes?.data) ? fixRes.data : [], today);

  // ทั้งสาขาไม่มีสแกนเลยในวันนั้น -> รวมเป็นรายการเดียว แทนการขึ้นว่าทุกคน "ไม่สแกนทั้งวัน"
  const scanDates = new Set(scans.map((r) => r.date));
  const items = [];
  const deviceDays = new Map();
  for (const d of report) {
    if (!isAlertIssue(d.issue)) continue;
    if (d.issue.code === 'none' && !scanDates.has(d.date)) {
      deviceDays.set(d.date, (deviceDays.get(d.date) || 0) + 1);
      continue;
    }
    items.push({
      key: `${branch}|${d.date}|${d.empCode}|${d.issue.code}`,
      branch, date: d.date, empCode: d.empCode, name: d.name || d.empCode,
      code: d.issue.code, level: d.issue.level, label: d.issue.label, detail: issueDetail(d),
    });
  }
  for (const [date, n] of deviceDays) {
    if (n < DEVICE_MIN_PEOPLE) {
      // คนน้อย อาจเป็นการขาดจริง — ยังขึ้นเป็นรายคนตามปกติ
      for (const d of report.filter((x) => x.date === date && x.issue.code === 'none')) {
        items.push({
          key: `${branch}|${date}|${d.empCode}|none`, branch, date, empCode: d.empCode, name: d.name || d.empCode,
          code: 'none', level: 'crit', label: d.issue.label, detail: issueDetail(d),
        });
      }
      continue;
    }
    items.push({
      key: `${branch}|${date}|*|device`, branch, date, empCode: '', name: `ทั้งสาขา ${n} คน`,
      code: 'device', level: 'crit', label: 'ไม่มีการสแกนทั้งสาขา', detail: 'เครื่องสแกนอาจไม่ส่งข้อมูล — ตรวจเครื่อง/อินเทอร์เน็ตของสาขา',
    });
  }
  return items;
}

/** รหัสสาขาทั้งหมด (สำหรับแอดมิน) — กติกาเดียวกับตัวเลือกสาขาในหน้าสแกนเข้า-ออก */
async function allBranches() {
  const res = await apiCall('getBranches');
  if (res?.status !== 'success' || !Array.isArray(res.data)) return [];
  return [...new Set(res.data.map((b) => String(b.name || '').toLowerCase().trim())
    .filter((n) => n && n !== 'all' && n !== 'ชื่อสาขา'))];
}

/**
 * โหลดรายการแจ้งเตือน { items, failed: [สาขาที่ดึงไม่ได้], at }
 * user.branch = 'all' -> ทุกสาขา, นอกนั้นสาขาตัวเอง
 */
export async function loadScanAlerts(user, { force = false } = {}) {
  const userBranch = String(user?.branch || '').trim();
  if (!userBranch) return { items: [], failed: [], at: Date.now() };
  const isAdmin = userBranch.toLowerCase() === 'all';
  const cacheKey = `scan_alerts_v1|${user?.username || ''}|${userBranch}`;

  if (!force) {
    try {
      const cached = JSON.parse(sessionStorage.getItem(cacheKey) || 'null');
      if (cached && Date.now() - cached.at < ALERT_CACHE_MS) return cached;
    } catch { /* แคชเสียก็โหลดใหม่ */ }
  }

  const now = new Date();
  const today = fmtDate(now);
  const startDate = fmtDate(addDays(now, -ALERT_DAYS));
  const endDate = fmtDate(addDays(now, -1));

  const branches = isAdmin ? await allBranches() : [userBranch];
  const items = [];
  const failed = [];
  const CONC = 3;
  for (let i = 0; i < branches.length; i += CONC) {
    const slice = branches.slice(i, i + CONC);
    const out = await Promise.all(slice.map((b) =>
      branchAlerts(b, startDate, endDate, today).catch(() => { failed.push(b); return []; })));
    out.forEach((list) => items.push(...list));
  }

  const rank = { crit: 0, warn: 1 };
  items.sort((a, b) => b.date.localeCompare(a.date) || rank[a.level] - rank[b.level] || a.branch.localeCompare(b.branch));
  const result = { items, failed, at: Date.now() };
  try { sessionStorage.setItem(cacheKey, JSON.stringify(result)); } catch { /* เต็มก็ไม่เป็นไร */ }
  return result;
}

/* ---------- รายการที่เปิดดูแล้ว (เก็บในเครื่อง) ---------- */
const SEEN_KEY = 'scan_alerts_seen';
const SEEN_MAX = 3000;

export function getSeen() {
  try { return new Set(JSON.parse(localStorage.getItem(SEEN_KEY) || '[]')); } catch { return new Set(); }
}

export function markSeen(keys) {
  const seen = getSeen();
  for (const k of keys) seen.add(k);
  try { localStorage.setItem(SEEN_KEY, JSON.stringify([...seen].slice(-SEEN_MAX))); } catch { /* ไม่เป็นไร */ }
  return seen;
}
