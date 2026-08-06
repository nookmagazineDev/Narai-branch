// ประวัติสแกนเข้า-ออก — ข้อมูลจากเครื่องสแกนหน้า ZKBio9 (ผ่าน /api/dashboard?attendance=1)
// สาขาเห็นเฉพาะของตัวเอง แอดมิน (branch = all) เลือกสาขาได้
//
// "เข้า/ออก" คิดจากเวลาสแกนแรกและสแกนสุดท้ายของวัน ไม่ได้อิง punch_state
// เพราะการตั้งค่าปุ่มเข้า/ออกของแต่ละเครื่องไม่เหมือนกัน (แสดง punch_state ไว้ในตารางรายการดิบแทน)
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Fingerprint, RefreshCw, Store, Search, CalendarDays, ListOrdered } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { fetchAttendance } from '../services/dashboardApi';
import { hhmm, summarizeDaily } from '../utils/attendance';

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;

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
      const res = await fetchAttendance({ branch, startDate, endDate });
      if (res?.status !== 'success') throw new Error(res?.message || 'ดึงข้อมูลไม่สำเร็จ');
      setRows(res.data || []);
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
  const daily = useMemo(() => summarizeDaily(filtered), [filtered]);

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
                <thead>
                  <tr className="text-gray-600 text-xs">
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">วันที่</th>
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th className="px-4 py-2.5 text-left sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อ</th>
                    <th className="px-4 py-2.5 text-center sticky top-0 bg-gray-50 border-b border-gray-200">เข้า</th>
                    <th className="px-4 py-2.5 text-center sticky top-0 bg-gray-50 border-b border-gray-200">ออก</th>
                    <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">รวม (ชม.)</th>
                    <th className="px-4 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">สแกน</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {daily.map((d) => (
                    <tr key={`${d.date}|${d.empCode}`} className="hover:bg-teal-50/40">
                      <td className="px-4 py-2 font-medium text-gray-800">{d.date}</td>
                      <td className="px-4 py-2 font-mono text-xs text-gray-500">{d.empCode}</td>
                      <td className="px-4 py-2">{d.name || <span className="text-gray-300">—</span>}</td>
                      <td className="px-4 py-2 text-center font-mono font-semibold text-emerald-700">{hhmm(d.first)}</td>
                      <td className="px-4 py-2 text-center font-mono font-semibold text-rose-700">
                        {d.count > 1 ? hhmm(d.last) : <span className="text-gray-300">—</span>}
                      </td>
                      <td className="px-4 py-2 text-right font-mono">{d.hours != null ? d.hours.toFixed(2) : '-'}</td>
                      <td className="px-4 py-2 text-right font-mono text-gray-400">{d.count}</td>
                    </tr>
                  ))}
                </tbody>
              </table>
              <p className="px-4 py-3 text-xs text-gray-400 border-t border-gray-100">
                แถวที่ช่อง "ออก" เป็น — คือวันที่สแกนครั้งเดียว (ยังไม่ได้สแกนออก หรือลืมสแกน)
              </p>
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
