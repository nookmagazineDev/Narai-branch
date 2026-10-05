// ประวัติสแกนเข้า-ออก — ข้อมูลจากเครื่องสแกนหน้า ZKBio9 (ผ่าน /api/dashboard?attendance=1)
// สาขาเห็นเฉพาะของตัวเอง แอดมิน (branch = all) เลือกสาขาได้
//
// ตารางสรุปรายวันวางคู่กันสองฝั่ง: เวลาที่สาขา "ลงตารางไว้" (hr_timesheet ผ่าน getHistoryData)
// กับเวลาที่ "สแกนจริง" แล้วสรุปส่วนต่างให้เลยว่าเข้าสาย/กลับจากเบรคสาย/ออกก่อนเวลากี่นาที
//
// "เข้า/ออก" คิดจากเวลาสแกนแรกและสแกนสุดท้ายของวัน ไม่ได้อิง punch_state
// เพราะการตั้งค่าปุ่มเข้า/ออกของแต่ละเครื่องไม่เหมือนกัน (แสดง punch_state ไว้ในตารางรายการดิบแทน)
//
// แจ้งเตือนสแกนไม่ครบ / ชั่วโมงขาด (แบนเนอร์เหนือตาราง + คอลัมน์สถานะ) — ตรวจเฉพาะเมื่อวานย้อนไป
// วันนี้ยังไม่นับ เพราะพนักงานอาจยังทำงานอยู่ กฎทั้งหมดอยู่ที่ scanIssue() ใน utils/attendance.js
// ปุ่ม "แก้ไข" ให้สาขา/แอดมินกรอกเวลาที่ถูกต้องพร้อมเหตุผล (ScanFixModal) แล้ววันนั้นจะไม่ถูกเตือนอีก
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Fingerprint, RefreshCw, Store, Search, CalendarDays, ListOrdered, AlertTriangle, CheckCircle2, Pencil } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { fetchAttendance } from '../services/dashboardApi';
import {
  hhmm, summarizeDaily, attachSchedule, missingFromSchedule, applyFixes, scanIssue,
  ISSUE_TYPES, SHORT_ALERT_MIN, SCAN_MERGE_MIN,
} from '../utils/attendance';
import ScanFixModal from '../components/ScanFixModal';

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const addDays = (d, n) => { const x = new Date(d); x.setDate(x.getDate() + n); return x; };
/** วันจันทร์ของสัปดาห์ที่วันนั้นอยู่ — สัปดาห์เริ่มวันจันทร์ให้ตรงกับหน้าลงตารางสัปดาห์ */
const mondayOf = (d) => addDays(d, -((d.getDay() + 6) % 7));

// ปุ่มเลือกช่วงวันที่สำเร็จรูป — คิดจาก "วันนี้" ตอนที่กดทุกครั้ง (เผื่อเปิดหน้าค้างข้ามวัน)
// "สัปดาห์นี้" จบที่วันนี้ ไม่ใช่วันอาทิตย์ เพราะวันข้างหน้ายังไม่มีใครสแกน
const RANGE_PRESETS = [
  { key: 'today', label: 'วันนี้', range: (t) => [t, t] },
  { key: 'yesterday', label: 'เมื่อวาน', range: (t) => [addDays(t, -1), addDays(t, -1)] },
  { key: 'thisWeek', label: 'สัปดาห์นี้', range: (t) => [mondayOf(t), t] },
  { key: 'lastWeek', label: 'สัปดาห์ที่แล้ว', range: (t) => [addDays(mondayOf(t), -7), addDays(mondayOf(t), -1)] },
];

const Dash = () => <span className="text-gray-300">—</span>;
const timeCell = (t, cls = '') => (t ? <span className={`font-mono ${cls}`}>{t}</span> : <Dash />);
/** จำนวนนาทีที่สาย — 0 = ตรงเวลา (เขียว), มากกว่านั้นเน้นแดง, null = เทียบไม่ได้ */
const lateCell = (v) => {
  if (v == null) return <Dash />;
  if (v <= 0) return <span className="font-mono text-emerald-600">0</span>;
  return <span className="font-mono font-semibold text-rose-600">{v}</span>;
};
const num2 = (v) => (v != null ? v.toFixed(2) : '-');

/** ช่องที่ควรมีแต่ไม่ได้สแกน */
const Missing = ({ warn }) => (
  <span className={`inline-block text-[11px] font-semibold px-1.5 rounded-md border border-dashed whitespace-nowrap ${
    warn ? 'text-amber-700 border-amber-400' : 'text-rose-700 border-rose-400'}`}>ไม่ได้สแกน</span>
);

/** สีของป้ายสถานะ / แถบซ้ายแถว ตามระดับ */
const ISSUE_PILL = {
  crit: 'bg-rose-100 text-rose-700',
  warn: 'bg-amber-100 text-amber-800',
  info: 'bg-gray-100 text-gray-500',
  ok: 'bg-emerald-50 text-emerald-700',
  fixed: 'bg-sky-100 text-sky-700',
  pending: 'bg-gray-50 text-gray-400',
};
const ISSUE_STRIPE = { crit: 'shadow-[inset_3px_0_0_#e11d48]', warn: 'shadow-[inset_3px_0_0_#d97706]' };
const isAlert = (i) => i.level === 'crit' || i.level === 'warn';

export default function Attendance() {
  const { user } = useAuth();
  const isAdmin = String(user?.branch || '').toLowerCase() === 'all';

  const [branchList, setBranchList] = useState([]);
  const [selBranch, setSelBranch] = useState('');
  const branch = isAdmin ? selBranch : (user?.branch || '');

  const today = fmtDate(new Date());
  const [startDate, setStartDate] = useState(today);
  const [endDate, setEndDate] = useState(today);
  const [loading, setLoading] = useState(false);
  const [rows, setRows] = useState(null);
  const [schedRows, setSchedRows] = useState([]); // ตารางงานที่สาขาลงไว้ ในช่วงวันเดียวกัน
  const [loadedRange, setLoadedRange] = useState('');
  const [loadedDates, setLoadedDates] = useState(null);
  const [search, setSearch] = useState('');
  const [dateFilter, setDateFilter] = useState(''); // '' = ทุกวันในช่วงที่โหลดมา
  const [view, setView] = useState('daily'); // 'daily' = สรุปรายวัน | 'raw' = รายการสแกนทั้งหมด
  const [fixes, setFixes] = useState([]); // เวลาที่สาขากดแก้ไขไว้ (dbo.attendance_scan_fix)
  const [issueFilter, setIssueFilter] = useState(''); // '' = ทั้งหมด | 'bad' = เฉพาะที่ต้องแก้ | รหัสกรณี
  const [editRow, setEditRow] = useState(null);
  const [loadedBranch, setLoadedBranch] = useState('');

  useEffect(() => {
    if (!isAdmin) return;
    apiCall('getBranches')
      .then((res) => {
        if (res?.status === 'success' && Array.isArray(res.data)) {
          const list = res.data.map((b) => String(b.name || '').toLowerCase().trim())
            .filter((n) => n && n !== 'all' && n !== 'ชื่อสาขา');
          setBranchList(list);
          setSelBranch((prev) => prev || list[0] || '');
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  const applyPreset = (preset) => {
    const [s, e] = preset.range(new Date());
    setStartDate(fmtDate(s));
    setEndDate(fmtDate(e));
  };

  const load = async () => {
    if (!branch) { toast.error('กรุณาเลือกสาขา'); return; }
    if (!startDate || !endDate) { toast.error('กรุณาเลือกช่วงวันที่'); return; }
    setLoading(true);
    try {
      // ตารางงานเป็นของเสริม ถ้าดึงไม่ได้ก็ยังต้องเห็นเวลาสแกนตามปกติ
      const [res, sched, fixRes] = await Promise.all([
        fetchAttendance({ branch, startDate, endDate }),
        apiCall('getHistoryData', { branch, startDate, endDate }).catch(() => null),
        apiCall('getScanFixes', { branch, startDate, endDate }).catch(() => null),
      ]);
      if (res?.status !== 'success') throw new Error(res?.message || 'ดึงข้อมูลไม่สำเร็จ');
      setRows(res.data || []);
      setDateFilter('');
      setIssueFilter('');
      setFixes(Array.isArray(fixRes?.data) ? fixRes.data : []);
      setLoadedBranch(branch);
      setSchedRows(Array.isArray(sched?.data) ? sched.data : []);
      if (!sched) toast('ดึงตารางงานมาเทียบไม่ได้ — แสดงเฉพาะเวลาสแกน', { icon: '⚠️' });
      setLoadedRange(startDate === endDate ? startDate : `${startDate} ถึง ${endDate}`);
      setLoadedDates({ startDate, endDate });
      toast.success(`พบการสแกน ${res.data?.length || 0} ครั้ง`);
    } catch (e) {
      toast.error(e.message || 'ดึงข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };

  const q = search.trim().toLowerCase();
  const matchSearch = (r) => !q || String(r.empCode).toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q);

  // รายการสแกนดิบ (แท็บ "ทุกครั้งที่สแกน")
  const filtered = useMemo(() => {
    let list = rows || [];
    if (dateFilter) list = list.filter((r) => r.date === dateFilter);
    return list.filter(matchSearch);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [rows, q, dateFilter]);

  // สรุปรายวันของทั้งช่วงที่โหลดมา: พนักงาน 1 คน x 1 วัน = 1 แถว (เข้า = สแกนแรก, ออก = สแกนสุดท้าย)
  // + คนที่มีตารางงานแต่ไม่ได้สแกนเลย -> ใช้เวลาที่สาขาแก้ไขไว้ -> เทียบตารางงาน -> สถานะแจ้งเตือน
  const allDaily = useMemo(() => {
    if (!rows) return [];
    const scanned = summarizeDaily(rows);
    const all = [...scanned, ...missingFromSchedule(scanned, schedRows)];
    return attachSchedule(applyFixes(all, fixes), schedRows)
      .map((d) => ({ ...d, issue: scanIssue(d, today) }))
      .sort((a, b) => b.date.localeCompare(a.date) || String(a.name || a.empCode).localeCompare(String(b.name || b.empCode), 'th'));
  }, [rows, schedRows, fixes, today]);

  // วันที่ในชุดที่โหลดมา (ล่าสุดก่อน) — ใช้เป็นตัวเลือกในหัวคอลัมน์วันที่
  const dateOptions = useMemo(() => [...new Set(allDaily.map((d) => d.date))].sort().reverse(), [allDaily]);

  // ตัวกรองในหัวคอลัมน์ — ช่วงที่มีวันเดียวไม่ต้องมีให้เลือก
  const dateFilterEl = dateOptions.length > 1 ? (
    <select value={dateFilter} onChange={(e) => setDateFilter(e.target.value)}
      className="mt-1 max-w-[132px] bg-white border border-gray-200 rounded-md px-1.5 py-0.5 text-[11px] font-normal text-gray-600 focus:ring-2 focus:ring-teal-500 outline-none cursor-pointer">
      <option value="">ทุกวัน ({dateOptions.length})</option>
      {dateOptions.map((d) => <option key={d} value={d}>{d}</option>)}
    </select>
  ) : null;

  // สรุปแจ้งเตือนของทั้งช่วง (ไม่ขึ้นกับช่องค้นหา) — นับเฉพาะเมื่อวานย้อนไป
  const alertSummary = useMemo(() => {
    const bad = allDaily.filter((d) => isAlert(d.issue));
    const byCode = {};
    for (const d of bad) byCode[d.issue.code] = (byCode[d.issue.code] || 0) + 1;
    return {
      total: bad.length,
      people: new Set(bad.map((d) => d.empCode)).size,
      byCode,
      fixed: allDaily.filter((d) => d.issue.level === 'fixed').length,
      checked: allDaily.some((d) => d.issue.level !== 'pending'),
    };
  }, [allDaily]);

  const daily = useMemo(() => allDaily.filter((d) =>
    (!dateFilter || d.date === dateFilter) &&
    matchSearch(d) &&
    (!issueFilter || (issueFilter === 'bad' ? isAlert(d.issue) : d.issue.code === issueFilter))
    // eslint-disable-next-line react-hooks/exhaustive-deps
  ), [allDaily, dateFilter, q, issueFilter]);

  /** หลังบันทึก/ยกเลิกการแก้ไข — โหลดเฉพาะรายการแก้ไขใหม่ ไม่ต้องดึงสแกนทั้งชุด */
  const reloadFixes = async () => {
    setEditRow(null);
    if (!loadedDates) return;
    const res = await apiCall('getScanFixes', { branch: loadedBranch, ...loadedDates }).catch(() => null);
    if (Array.isArray(res?.data)) setFixes(res.data);
  };

  const people = useMemo(() => new Set(daily.map((d) => d.empCode)).size, [daily]);

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-teal-100 text-teal-600 rounded-xl"><Fingerprint className="w-6 h-6" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">สแกนเข้า-ออก</h1>
            <p className="text-sm text-gray-500">เวลาสแกนหน้าจากเครื่องสแกนของสาขา • เข้า = สแกนแรกของวัน, ออก = สแกนสุดท้าย</p>
          </div>
        </div>
        {isAdmin ? (
          <div className="flex items-center gap-1.5 pl-3 pr-1 py-1 bg-purple-100 rounded-full">
            <Store className="w-4 h-4 text-purple-600 shrink-0" />
            <select value={selBranch} onChange={(e) => setSelBranch(e.target.value)}
              className="bg-transparent text-purple-800 text-sm font-medium pr-2 py-0.5 focus:outline-none cursor-pointer">
              {branchList.length === 0 && <option value="">กำลังโหลดสาขา…</option>}
              {branchList.map((b) => <option key={b} value={b}>{b}</option>)}
            </select>
          </div>
        ) : (
          <span className="px-3 py-1.5 bg-purple-100 text-purple-800 text-sm font-medium rounded-full">สาขา: {branch || '-'}</span>
        )}
      </div>

      {/* ตัวกรอง */}
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex flex-wrap items-center gap-2">
        <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-teal-500 outline-none" />
        <span className="text-gray-400">ถึง</span>
        <input type="date" value={endDate} min={startDate} max={today} onChange={(e) => setEndDate(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-teal-500 outline-none" />
        {RANGE_PRESETS.map((p) => {
          const [s, e] = p.range(new Date());
          const active = startDate === fmtDate(s) && endDate === fmtDate(e);
          return (
            <button key={p.key} onClick={() => applyPreset(p)}
              className={`px-3 py-2 rounded-xl text-sm border ${active
                ? 'border-teal-500 bg-teal-50 text-teal-700 font-medium'
                : 'border-gray-200 text-gray-600 hover:bg-gray-50'}`}>
              {p.label}
            </button>
          );
        })}
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {loading ? 'กำลังดึงข้อมูล…' : 'ดึงข้อมูล'}
        </button>
        {!loading && loadedRange && <span className="text-xs text-gray-400">ข้อมูล: {loadedRange}</span>}
      </div>

      {/* แจ้งเตือนสแกนไม่ครบ / ชั่วโมงขาด — กดชิปเพื่อกรองตาราง */}
      {rows !== null && alertSummary.checked && (alertSummary.total > 0 ? (
        <div role="alert" className="bg-white rounded-2xl shadow-sm border border-gray-100 border-l-4 border-l-rose-500 p-4 space-y-3">
          <div className="flex flex-wrap items-center justify-between gap-3">
            <div className="flex items-center gap-3">
              <div className="p-2 bg-rose-100 text-rose-600 rounded-xl"><AlertTriangle className="w-5 h-5" /></div>
              <div>
                <p className="font-semibold text-gray-800">สแกนไม่ครบ / เวลาไม่ตรง {alertSummary.total} รายการ ({alertSummary.people} คน)</p>
                <p className="text-xs text-gray-500">
                  เทียบกับตารางงานที่ลงไว้ · ตรวจถึงเมื่อวาน · กด "แก้ไข" ท้ายแถวเพื่อกรอกเวลาที่ถูกต้อง
                  {alertSummary.fixed > 0 && ` · แก้ไขแล้ว ${alertSummary.fixed} รายการ`}
                </p>
              </div>
            </div>
            <button onClick={() => { setView('daily'); setIssueFilter(issueFilter === 'bad' ? '' : 'bad'); }}
              className={`px-4 py-2 rounded-xl text-sm font-semibold ${issueFilter === 'bad'
                ? 'bg-teal-50 text-teal-700 border border-teal-500' : 'bg-teal-600 text-white hover:bg-teal-700'}`}>
              {issueFilter === 'bad' ? 'แสดงทั้งหมด' : 'ดูเฉพาะที่ไม่ครบ'}
            </button>
          </div>
          <div className="flex flex-wrap gap-2">
            {ISSUE_TYPES.filter((t) => alertSummary.byCode[t.code]).map((t) => {
              const active = issueFilter === t.code;
              return (
                <button key={t.code} onClick={() => { setView('daily'); setIssueFilter(active ? '' : t.code); }}
                  className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-xl text-sm border ${active
                    ? 'border-teal-500 bg-teal-50 text-teal-700' : 'border-gray-200 text-gray-700 hover:bg-gray-50'}`}>
                  <span className={`font-mono font-semibold ${t.level === 'crit' ? 'text-rose-600' : 'text-amber-600'}`}>{alertSummary.byCode[t.code]}</span>
                  {t.label}
                </button>
              );
            })}
          </div>
        </div>
      ) : (
        <div className="bg-emerald-50 border border-emerald-100 rounded-2xl px-4 py-3 flex items-center gap-2 text-sm text-emerald-800">
          <CheckCircle2 className="w-5 h-5 text-emerald-600" />
          สแกนครบทุกคนตามตารางงาน (ตรวจถึงเมื่อวาน){alertSummary.fixed > 0 && ` · แก้ไขแล้ว ${alertSummary.fixed} รายการ`}
        </div>
      ))}

      {rows !== null && (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {/* แถบเครื่องมือ */}
          <div className="px-4 py-3 border-b border-gray-100 flex flex-wrap items-center justify-between gap-2">
            <div className="flex items-center gap-1 bg-gray-100 rounded-xl p-1">
              <button onClick={() => setView('daily')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${view === 'daily' ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500'}`}>
                <CalendarDays className="w-4 h-4" /> สรุปรายวัน
              </button>
              <button onClick={() => setView('raw')}
                className={`inline-flex items-center gap-1.5 px-3 py-1.5 rounded-lg text-sm font-medium ${view === 'raw' ? 'bg-white text-teal-700 shadow-sm' : 'text-gray-500'}`}>
                <ListOrdered className="w-4 h-4" /> ทุกครั้งที่สแกน
              </button>
            </div>
            <div className="relative flex-1 min-w-[200px] max-w-xs">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหารหัส หรือชื่อพนักงาน…"
                className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-teal-500 outline-none" />
            </div>
            <span className="text-xs text-gray-400">
              {view === 'daily' ? `${daily.length} แถว • ${people} คน` : `${filtered.length} ครั้ง`}
            </span>
          </div>

          {rows.length === 0 && (view === 'raw' || allDaily.length === 0) ? (
            <div className="py-16 px-6 text-center text-sm space-y-1">
              <p className="text-amber-600 font-medium">ไม่พบการสแกนในช่วงวันที่ที่เลือก</p>
              <p className="text-gray-400 text-xs">ลองเปลี่ยนช่วงวันที่ หรือตรวจว่าเครื่องสแกนของสาขาส่งข้อมูลเข้าระบบแล้วหรือยัง</p>
            </div>
          ) : (view === 'raw' ? filtered.length === 0 : daily.length === 0) ? (
            <div className="py-16 text-center text-gray-400 text-sm">
              {search.trim() ? 'ไม่พบพนักงานที่ค้นหา'
                : issueFilter ? 'ไม่มีรายการในกรณีที่เลือก'
                : `ไม่พบการสแกนของวันที่ ${dateFilter}`}
            </div>
          ) : view === 'daily' ? (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm border-collapse">
                {/* หัวตารางสองชั้น — แยกให้เห็นชัดว่าฝั่งไหนคือเวลาที่สาขาลงตารางไว้ ฝั่งไหนคือเวลาที่สแกนจริง */}
                <thead className="text-[11px] text-gray-600">
                  <tr>
                    {/* หัวคอลัมน์นี้กินสองแถว (รวมสูง ~60px) — ป้าย + ตัวกรองต้องไม่เกินนั้น
                        ไม่งั้นแถวหัวตารางจะสูงขึ้นจนหลุดกับ sticky top-8 ของหัวแถวล่าง */}
                    <th rowSpan={2} className="px-3 py-1 text-left align-top sticky top-0 bg-gray-50 border-b border-gray-200">
                      <div className="h-7 flex items-center">วันที่</div>
                      {dateFilterEl}
                    </th>
                    <th rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อ</th>
                    <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-indigo-100 text-indigo-800 border-b border-l border-gray-200 font-semibold">ตารางงานที่ลงไว้</th>
                    <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-teal-100 text-teal-800 border-b border-l border-gray-200 font-semibold">สแกนจริง</th>
                    <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-rose-100 text-rose-800 border-b border-l border-gray-200 font-semibold">สาย (นาที)</th>
                    <th colSpan={3} className="h-8 px-3 text-center sticky top-0 bg-gray-50 border-b border-l border-gray-200 font-semibold">เวลาทำงาน (ชม.)</th>
                    <th rowSpan={2} className="h-8 px-3 text-right sticky top-0 bg-gray-50 border-b border-l border-gray-200">สแกน</th>
                    <th rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-gray-50 border-b border-l border-gray-200">สถานะ</th>
                    <th rowSpan={2} className="h-8 px-3 sticky top-0 bg-gray-50 border-b border-gray-200"><span className="sr-only">แก้ไข</span></th>
                  </tr>
                  <tr>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-indigo-50 border-b border-l border-gray-200 font-normal">เข้า</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-indigo-50 border-b border-gray-200 font-normal">ออกเบรค</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-indigo-50 border-b border-gray-200 font-normal">เข้าเบรค</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-indigo-50 border-b border-gray-200 font-normal">ออก</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-teal-50 border-b border-l border-gray-200 font-normal">เข้า</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-teal-50 border-b border-gray-200 font-normal">ออกเบรค</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-teal-50 border-b border-gray-200 font-normal">เข้าเบรค</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-teal-50 border-b border-gray-200 font-normal">ออก</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-rose-50 border-b border-l border-gray-200 font-normal">เข้าสาย</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-rose-50 border-b border-gray-200 font-normal">เบรคสาย</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-rose-50 border-b border-gray-200 font-normal">ออกก่อน</th>
                    <th className="px-3 py-1.5 text-center sticky top-8 bg-rose-50 border-b border-gray-200 font-semibold">รวมขาด</th>
                    <th className="px-3 py-1.5 text-right sticky top-8 bg-gray-50 border-b border-l border-gray-200 font-normal">รวม</th>
                    <th className="px-3 py-1.5 text-right sticky top-8 bg-gray-50 border-b border-gray-200 font-normal">พัก</th>
                    <th className="px-3 py-1.5 text-right sticky top-8 bg-gray-50 border-b border-gray-200 font-normal">สุทธิ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {daily.map((d) => {
                    const lv = d.issue.level;
                    const code = d.issue.code;
                    const fixedCls = (k) => (d.fix?.[k] ? 'text-sky-700 underline decoration-dotted' : '');
                    // ช่องที่ขาด -> ป้าย "ไม่ได้สแกน" แทนขีด เฉพาะแถวที่ถูกแจ้งเตือน
                    const scanCell = (t, missing, cls) => (missing ? <Missing warn={lv === 'warn'} /> : timeCell(t ? hhmm(t) : '', cls));
                    return (
                    <tr key={`${d.date}|${d.empCode}`} className={`hover:bg-teal-50/40 ${lv === 'crit' ? 'bg-rose-50/30' : ''}`}>
                      <td className={`px-3 py-2 font-medium text-gray-800 whitespace-nowrap ${ISSUE_STRIPE[lv] || ''}`}>{d.date}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{d.empCode}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{d.name || <Dash />}</td>

                      {/* ฝั่งตารางงานที่สาขาลงไว้ */}
                      <td className="px-3 py-2 text-center bg-indigo-50/40 border-l border-gray-200">{timeCell(d.plan?.in, 'text-indigo-700')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.breakOut, 'text-indigo-500')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.breakIn, 'text-indigo-500')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.out, 'text-indigo-700')}</td>

                      {/* ฝั่งที่สแกนจริง (ตัวเลขสีฟ้าขีดเส้นประ = เวลาที่สาขาแก้ไขแทน) */}
                      <td className="px-3 py-2 text-center border-l border-gray-200">{scanCell(d.first, code === 'none', `font-semibold text-emerald-700 ${fixedCls('timeIn')}`)}</td>
                      <td className="px-3 py-2 text-center">{scanCell(d.breakOut, code === 'none' || code === 'noBreak', `text-amber-600 ${fixedCls('breakOut')}`)}</td>
                      <td className="px-3 py-2 text-center">{scanCell(d.breakIn, code === 'none' || code === 'noBreak' || code === 'noBreakIn', `text-amber-600 ${fixedCls('breakIn')}`)}</td>
                      <td className="px-3 py-2 text-center">{scanCell(d.last, code === 'none' || code === 'noOut', `font-semibold text-rose-700 ${fixedCls('timeOut')}`)}</td>

                      {/* สรุปส่วนต่าง */}
                      <td className="px-3 py-2 text-center bg-rose-50/30 border-l border-gray-200">{lateCell(d.lateIn)}</td>
                      <td className="px-3 py-2 text-center bg-rose-50/30">{lateCell(d.lateBreakIn)}</td>
                      <td className="px-3 py-2 text-center bg-rose-50/30">{lateCell(d.earlyOut)}</td>
                      <td className="px-3 py-2 text-center bg-rose-50/30">{lateCell(d.shortMin)}</td>

                      {/* เวลาทำงาน */}
                      <td className="px-3 py-2 text-right font-mono text-gray-500 border-l border-gray-200">{num2(d.hours)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{num2(d.breakHours)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-gray-800">{num2(d.netHours)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400 border-l border-gray-200"
                        title={d.rawCount > d.count ? `สแกนจริง ${d.rawCount} ครั้ง (ที่ห่างกันไม่ถึง ${SCAN_MERGE_MIN} นาทีนับเป็นครั้งเดียว)` : undefined}>
                        {d.count}{d.rawCount > d.count && <span className="text-[10px] text-amber-600"> ({d.rawCount})</span>}
                      </td>

                      {/* สถานะแจ้งเตือน */}
                      <td className="px-3 py-2 border-l border-gray-200 whitespace-nowrap">
                        <span className={`inline-flex items-center px-2 py-0.5 rounded-full text-[11px] font-semibold ${ISSUE_PILL[lv]}`}
                          title={d.fix ? `${d.fix.reason}${d.fix.note ? ` — ${d.fix.note}` : ''} · โดย ${d.fix.savedBy || '-'} ${d.fix.savedAt || ''}` : undefined}>
                          {d.issue.label}
                        </span>
                        {d.fix && <div className="text-[10px] text-sky-700 mt-0.5">{d.fix.reason}</div>}
                      </td>
                      <td className="px-2 py-2 text-center">
                        {lv !== 'pending' && (isAlert(d.issue) || d.fix || lv === 'info') && (
                          <button onClick={() => setEditRow(d)}
                            className={`inline-flex items-center gap-1 px-2.5 py-1 rounded-lg text-xs font-medium border ${isAlert(d.issue)
                              ? 'border-teal-500 text-teal-700 hover:bg-teal-50' : 'border-gray-200 text-gray-500 hover:bg-gray-50'}`}>
                            <Pencil className="w-3 h-3" /> แก้ไข
                          </button>
                        )}
                      </td>
                    </tr>
                    );
                  })}
                </tbody>
              </table>
              <div className="px-4 py-3 text-xs text-gray-400 border-t border-gray-100 space-y-1">
                <p>
                  <span className="font-medium text-indigo-600">ตารางงานที่ลงไว้</span> = เวลาที่สาขากรอกในหน้าลงตารางรายสัปดาห์ ·
                  <span className="font-medium text-teal-600"> สแกนจริง</span> อ่านจากลำดับการสแกน 4 รอบ: เข้างาน → ออกเบรค → เข้าเบรค → ออกงาน ·
                  ช่องที่เป็น — คือไม่มีข้อมูลฝั่งนั้น (ยังไม่ได้ลงตาราง หรือวันนั้นสแกนไม่ครบ)
                </p>
                <p>
                  <span className="font-medium text-rose-600">เข้าสาย</span> = สแกนเข้า − เวลาเข้าที่ลงไว้ ·
                  <span className="font-medium text-rose-600"> เบรคสาย</span> = สแกนเข้าเบรค − เวลาสิ้นสุดเบรคที่ลงไว้
                  (ถ้าไม่ได้ลงช่วงเบรคไว้ จะเทียบกับ ออกเบรคจริง + ระยะเบรคที่อนุญาตแทน) ·
                  <span className="font-medium text-rose-600"> ออกก่อน</span> = เวลาออกที่ลงไว้ − สแกนออก ·
                  นับเฉพาะที่เกิน 0 นาที มาก่อนเวลาไม่ถือว่าติดลบ ·
                  <span className="font-medium text-rose-600"> รวมขาด</span> = สาย + เบรคสาย + ออกก่อน (หักลาเป็นชั่วโมงแล้ว) แจ้งเตือนเมื่อเกิน {SHORT_ALERT_MIN} นาที
                </p>
                <p>
                  <span className="font-medium">สถานะ</span> ตรวจเฉพาะเมื่อวานย้อนไป (วันนี้พนักงานอาจยังทำงานอยู่) ·
                  สแกนที่ห่างกันไม่ถึง {SCAN_MERGE_MIN} นาทีนับเป็นครั้งเดียว ·
                  <span className="font-medium text-sky-700"> เวลาสีฟ้าขีดเส้นประ</span> = เวลาที่สาขากดแก้ไขแทนเวลาสแกน (เวลาสแกนจริงดูได้ในแท็บ "ทุกครั้งที่สแกน")
                </p>
                <p>
                  <span className="font-medium">สุทธิ</span> = ชั่วโมงรวมหักเวลาพักแล้ว ·
                  จับคู่กับตารางงานด้วยรหัสพนักงานก่อน ถ้ารหัสไม่ตรงจะลองจับด้วยชื่อในวันเดียวกัน
                </p>
              </div>
            </div>
          ) : (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm border-collapse">
                <thead>
                  <tr className="text-gray-600 text-xs">
                    <th className="px-4 py-2 text-left align-top sticky top-0 bg-gray-50 border-b border-gray-200">
                      <div>เวลา</div>
                      {dateFilterEl}
                    </th>
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อ</th>
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">ประเภท</th>
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">เครื่อง</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {filtered.map((r, i) => (
                    <tr key={`${r.empCode}-${r.time}-${i}`} className="hover:bg-teal-50/40">
                      <td className="px-4 py-2 font-mono text-xs">{r.time}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{r.empCode}</td>
                      <td className="px-4 py-2">{r.name || <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-2 text-xs">
                        {r.stateLabel
                          ? <span className="px-2 py-0.5 rounded-full bg-gray-100 text-gray-600">{r.stateLabel}</span>
                          : <span className="text-gray-300">{r.state || '—'}</span>}
                      </td>
                      <td className="px-4 py-2 text-xs text-gray-400">{r.terminal || r.area}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
            </div>
          )}
        </div>
      )}

      {editRow && (
        <ScanFixModal row={editRow} branch={loadedBranch} onClose={() => setEditRow(null)} onSaved={reloadFixes} />
      )}
    </div>
  );
}
