// ประวัติสแกนเข้า-ออก — ข้อมูลจากเครื่องสแกนหน้า ZKBio9 (ผ่าน /api/dashboard?attendance=1)
// สาขาเห็นเฉพาะของตัวเอง แอดมิน (branch = all) เลือกสาขาได้
//
// ตารางสรุปรายวันวางคู่กันสองฝั่ง: เวลาที่สาขา "ลงตารางไว้" (hr_timesheet ผ่าน getHistoryData)
// กับเวลาที่ "สแกนจริง" แล้วสรุปส่วนต่างให้เลยว่าเข้าสาย/กลับจากเบรคสาย/ออกก่อนเวลากี่นาที
//
// "เข้า/ออก" คิดจากเวลาสแกนแรกและสแกนสุดท้ายของวัน ไม่ได้อิง punch_state
// เพราะการตั้งค่าปุ่มเข้า/ออกของแต่ละเครื่องไม่เหมือนกัน (แสดง punch_state ไว้ในตารางรายการดิบแทน)
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Fingerprint, RefreshCw, Store, Search, CalendarDays, ListOrdered } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { fetchAttendance } from '../services/dashboardApi';
import { hhmm, summarizeDaily, attachSchedule } from '../utils/attendance';

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

const Dash = () => <span className="text-gray-300">—</span>;
const timeCell = (t, cls = '') => (t ? <span className={`font-mono ${cls}`}>{t}</span> : <Dash />);
/** จำนวนนาทีที่สาย — 0 = ตรงเวลา (เขียว), มากกว่านั้นเน้นแดง, null = เทียบไม่ได้ */
const lateCell = (v) => {
  if (v == null) return <Dash />;
  if (v <= 0) return <span className="font-mono text-emerald-600">0</span>;
  return <span className="font-mono font-semibold text-rose-600">{v}</span>;
};
const num2 = (v) => (v != null ? v.toFixed(2) : '-');

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
  const [search, setSearch] = useState('');
  const [view, setView] = useState('daily'); // 'daily' = สรุปรายวัน | 'raw' = รายการสแกนทั้งหมด

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

  const load = async () => {
    if (!branch) { toast.error('กรุณาเลือกสาขา'); return; }
    if (!startDate || !endDate) { toast.error('กรุณาเลือกช่วงวันที่'); return; }
    setLoading(true);
    try {
      // ตารางงานเป็นของเสริม ถ้าดึงไม่ได้ก็ยังต้องเห็นเวลาสแกนตามปกติ
      const [res, sched] = await Promise.all([
        fetchAttendance({ branch, startDate, endDate }),
        apiCall('getHistoryData', { branch, startDate, endDate }).catch(() => null),
      ]);
      if (res?.status !== 'success') throw new Error(res?.message || 'ดึงข้อมูลไม่สำเร็จ');
      setRows(res.data || []);
      setSchedRows(Array.isArray(sched?.data) ? sched.data : []);
      if (!sched) toast('ดึงตารางงานมาเทียบไม่ได้ — แสดงเฉพาะเวลาสแกน', { icon: '⚠️' });
      setLoadedRange(startDate === endDate ? startDate : `${startDate} ถึง ${endDate}`);
      toast.success(`พบการสแกน ${res.data?.length || 0} ครั้ง`);
    } catch (e) {
      toast.error(e.message || 'ดึงข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = rows || [];
    if (!q) return list;
    return list.filter((r) => String(r.empCode).toLowerCase().includes(q) || String(r.name || '').toLowerCase().includes(q));
  }, [rows, search]);

  // สรุปรายวัน: พนักงาน 1 คน x 1 วัน = 1 แถว (เข้า = สแกนแรก, ออก = สแกนสุดท้าย)
  // แล้วเทียบกับตารางงานที่สาขาลงไว้ เพื่อคิดว่าสาย/ออกก่อนเวลากี่นาที
  const daily = useMemo(() => attachSchedule(summarizeDaily(filtered), schedRows), [filtered, schedRows]);

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
        <button onClick={() => { setStartDate(today); setEndDate(today); }}
          className="px-3 py-2 rounded-xl text-sm border border-gray-200 text-gray-600 hover:bg-gray-50">วันนี้</button>
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {loading ? 'กำลังดึงข้อมูล…' : 'ดึงข้อมูล'}
        </button>
        {!loading && loadedRange && <span className="text-xs text-gray-400">ข้อมูล: {loadedRange}</span>}
      </div>

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

          {rows.length === 0 ? (
            <div className="py-16 px-6 text-center text-sm space-y-1">
              <p className="text-amber-600 font-medium">ไม่พบการสแกนในช่วงวันที่ที่เลือก</p>
              <p className="text-gray-400 text-xs">ลองเปลี่ยนช่วงวันที่ หรือตรวจว่าเครื่องสแกนของสาขาส่งข้อมูลเข้าระบบแล้วหรือยัง</p>
            </div>
          ) : filtered.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่พบพนักงานที่ค้นหา</div>
          ) : view === 'daily' ? (
            <div className="overflow-auto max-h-[65vh]">
              <table className="w-full text-sm border-collapse">
                {/* หัวตารางสองชั้น — แยกให้เห็นชัดว่าฝั่งไหนคือเวลาที่สาขาลงตารางไว้ ฝั่งไหนคือเวลาที่สแกนจริง */}
                <thead className="text-[11px] text-gray-600">
                  <tr>
                    <th rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-gray-50 border-b border-gray-200">วันที่</th>
                    <th rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th rowSpan={2} className="h-8 px-3 text-left sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อ</th>
                    <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-indigo-100 text-indigo-800 border-b border-l border-gray-200 font-semibold">ตารางงานที่ลงไว้</th>
                    <th colSpan={4} className="h-8 px-3 text-center sticky top-0 bg-teal-100 text-teal-800 border-b border-l border-gray-200 font-semibold">สแกนจริง</th>
                    <th colSpan={3} className="h-8 px-3 text-center sticky top-0 bg-rose-100 text-rose-800 border-b border-l border-gray-200 font-semibold">สาย (นาที)</th>
                    <th colSpan={3} className="h-8 px-3 text-center sticky top-0 bg-gray-50 border-b border-l border-gray-200 font-semibold">เวลาทำงาน (ชม.)</th>
                    <th rowSpan={2} className="h-8 px-3 text-right sticky top-0 bg-gray-50 border-b border-l border-gray-200">สแกน</th>
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
                    <th className="px-3 py-1.5 text-right sticky top-8 bg-gray-50 border-b border-l border-gray-200 font-normal">รวม</th>
                    <th className="px-3 py-1.5 text-right sticky top-8 bg-gray-50 border-b border-gray-200 font-normal">พัก</th>
                    <th className="px-3 py-1.5 text-right sticky top-8 bg-gray-50 border-b border-gray-200 font-normal">สุทธิ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {daily.map((d) => (
                    <tr key={`${d.date}|${d.empCode}`} className="hover:bg-teal-50/40">
                      <td className="px-3 py-2 font-medium text-gray-800 whitespace-nowrap">{d.date}</td>
                      <td className="px-3 py-2 font-mono text-xs text-gray-500">{d.empCode}</td>
                      <td className="px-3 py-2 whitespace-nowrap">{d.name || <Dash />}</td>

                      {/* ฝั่งตารางงานที่สาขาลงไว้ */}
                      <td className="px-3 py-2 text-center bg-indigo-50/40 border-l border-gray-200">{timeCell(d.plan?.in, 'text-indigo-700')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.breakOut, 'text-indigo-500')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.breakIn, 'text-indigo-500')}</td>
                      <td className="px-3 py-2 text-center bg-indigo-50/40">{timeCell(d.plan?.out, 'text-indigo-700')}</td>

                      {/* ฝั่งที่สแกนจริง */}
                      <td className="px-3 py-2 text-center border-l border-gray-200">{timeCell(hhmm(d.first), 'font-semibold text-emerald-700')}</td>
                      <td className="px-3 py-2 text-center">{timeCell(d.breakOut ? hhmm(d.breakOut) : '', 'text-amber-600')}</td>
                      <td className="px-3 py-2 text-center">{timeCell(d.breakIn ? hhmm(d.breakIn) : '', 'text-amber-600')}</td>
                      <td className="px-3 py-2 text-center">{timeCell(d.last ? hhmm(d.last) : '', 'font-semibold text-rose-700')}</td>

                      {/* สรุปส่วนต่าง */}
                      <td className="px-3 py-2 text-center bg-rose-50/30 border-l border-gray-200">{lateCell(d.lateIn)}</td>
                      <td className="px-3 py-2 text-center bg-rose-50/30">{lateCell(d.lateBreakIn)}</td>
                      <td className="px-3 py-2 text-center bg-rose-50/30">{lateCell(d.earlyOut)}</td>

                      {/* เวลาทำงาน */}
                      <td className="px-3 py-2 text-right font-mono text-gray-500 border-l border-gray-200">{num2(d.hours)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{num2(d.breakHours)}</td>
                      <td className="px-3 py-2 text-right font-mono font-bold text-gray-800">{num2(d.netHours)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400 border-l border-gray-200">{d.count}</td>
                    </tr>
                  ))}
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
                  นับเฉพาะที่เกิน 0 นาที มาก่อนเวลาไม่ถือว่าติดลบ
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
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">เวลา</th>
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
    </div>
  );
}
