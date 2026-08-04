// ค้นหารายการขาย — เลือกช่วงวันที่ + เลือกเมนูขายได้หลายรายการ ดูจำนวน/ยอดเงิน รวมและรายวัน
// ข้อมูลจาก office-server /itemsales (ผ่าน /api/dashboard?itemsales=1) — รวมทุกโต๊ะ (รวมโต๊ะ 600) ไม่นับเฉพาะรายการที่ยกเลิก (void)
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Search, RefreshCw, Store, X, CheckSquare, Square } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { tryGetJson } from '../services/dashboardApi';

const baht = (n) => '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intf = (n) => Number(n || 0).toLocaleString('th-TH', { maximumFractionDigits: 2 });

const pad = (n) => String(n).padStart(2, '0');
const fmtDate = (d) => `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())}`;
const monthStart = () => { const d = new Date(); return fmtDate(new Date(d.getFullYear(), d.getMonth(), 1)); };

export default function SalesSearch() {
  const { user } = useAuth();
  const isAdmin = String(user?.branch || '').toLowerCase() === 'all';

  const [branchList, setBranchList] = useState([]);
  const [selBranch, setSelBranch] = useState('');
  const branch = isAdmin ? selBranch : (user?.branch || '');

  const [startDate, setStartDate] = useState(monthStart());
  const [endDate, setEndDate] = useState(fmtDate(new Date()));
  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState(null);      // [{itemCode, name, qty, amt, daily}]
  const [loadedRange, setLoadedRange] = useState('');
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState({});  // itemCode -> true

  useEffect(() => {
    if (!isAdmin) return;
    apiCall('getBranches')
      .then((res) => {
        if (res?.status === 'success' && Array.isArray(res.data)) {
          const list = res.data.map((b) => String(b.name || '').toLowerCase().trim())
            .filter((n) => n && n !== 'all' && n !== 'ชื่อสาขา');
          setBranchList(list);
          // เริ่มต้นที่สาขาใหญ่ที่มีข้อมูลขายแน่ๆ (บางสาขาเช่น clk ไม่มีข้อมูลจาก POS)
          setSelBranch((prev) => prev || (list.includes('crm') ? 'crm' : list[0]) || '');
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  const load = async () => {
    if (!branch) { toast.error('กรุณาเลือกสาขา'); return; }
    if (!startDate || !endDate) { toast.error('กรุณาเลือกช่วงวันที่'); return; }
    setLoading(true);
    try {
      const qs = `branch=${encodeURIComponent(branch)}&startDate=${encodeURIComponent(startDate)}&endDate=${encodeURIComponent(endDate)}&itemsales=1`;
      const res = await tryGetJson(`/api/dashboard?${qs}`);
      if (res?.status !== 'success') throw new Error(res?.message || 'ดึงข้อมูลไม่สำเร็จ');
      setItems(res.data || []);
      setLoadedRange(`${startDate} ถึง ${endDate}`);
      setSelected({});
      toast.success(`พบ ${res.data?.length || 0} รายการขายในช่วงนี้`);
    } catch (e) {
      toast.error(e.message || 'ดึงข้อมูลไม่สำเร็จ');
    } finally {
      setLoading(false);
    }
  };

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    const list = items || [];
    if (!q) return list;
    return list.filter((it) => String(it.name || '').toLowerCase().includes(q) || String(it.itemCode).includes(q));
  }, [items, search]);

  const selectedItems = useMemo(() => (items || []).filter((it) => selected[it.itemCode]), [items, selected]);
  const selCount = selectedItems.length;
  const sumQty = selectedItems.reduce((s, it) => s + it.qty, 0);
  const sumAmt = selectedItems.reduce((s, it) => s + it.amt, 0);

  // ตารางรายวัน: แถว = วันที่ / คอลัมน์ = เมนูที่เลือก
  const dates = useMemo(() => {
    const set = new Set();
    selectedItems.forEach((it) => Object.keys(it.daily || {}).forEach((d) => set.add(d)));
    return [...set].sort();
  }, [selectedItems]);

  const toggle = (code) => setSelected((p) => ({ ...p, [code]: !p[code] }));

  return (
    <div className="max-w-7xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-sky-100 text-sky-600 rounded-xl"><Search className="w-6 h-6" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">ค้นหารายการขาย</h1>
            <p className="text-sm text-gray-500">เลือกหลายเมนู + ช่วงวันที่ • จำนวนที่ขายและยอดเงิน (รวมทุกโต๊ะ ไม่นับรายการที่ยกเลิก)</p>
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

      {/* เลือกช่วงวันที่ */}
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100 flex flex-wrap items-center gap-2">
        <input type="date" value={startDate} max={endDate} onChange={(e) => setStartDate(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-sky-500 outline-none" />
        <span className="text-gray-400">ถึง</span>
        <input type="date" value={endDate} min={startDate} max={fmtDate(new Date())} onChange={(e) => setEndDate(e.target.value)}
          className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-sky-500 outline-none" />
        <button onClick={load} disabled={loading}
          className="inline-flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-sky-600 text-white hover:bg-sky-700 disabled:opacity-50">
          {loading ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Search className="w-4 h-4" />}
          {loading ? 'กำลังดึงข้อมูล…' : 'ดึงข้อมูล'}
        </button>
        {loadedRange && <span className="text-xs text-gray-400">ข้อมูล: {loadedRange}</span>}
      </div>

      {items !== null && (
        <div className="grid grid-cols-1 lg:grid-cols-2 gap-4">
          {/* ซ้าย: เลือกรายการ */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-gray-100 space-y-2">
              <div className="flex items-center justify-between gap-2">
                <h2 className="font-bold text-gray-800 text-sm">เลือกรายการขาย <span className="text-gray-400 font-normal">({filtered.length} รายการ)</span></h2>
                {selCount > 0 && (
                  <button onClick={() => setSelected({})} className="text-xs text-rose-500 hover:underline inline-flex items-center gap-1"><X className="w-3 h-3" /> ล้างที่เลือก ({selCount})</button>
                )}
              </div>
              <div className="relative">
                <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
                <input value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาชื่อเมนู หรือรหัส…"
                  className="w-full pl-8 pr-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-sky-500 outline-none" />
              </div>
            </div>
            <div className="flex-1 overflow-y-auto max-h-[55vh] divide-y divide-gray-50">
              {(items || []).length === 0 ? (
                <div className="py-12 px-6 text-center text-sm space-y-1">
                  <p className="text-amber-600 font-medium">สาขานี้ไม่มีข้อมูลขายในช่วงวันที่ที่เลือก</p>
                  <p className="text-gray-400 text-xs">ลองเปลี่ยนสาขาที่มุมขวาบน หรือเปลี่ยนช่วงวันที่แล้วกด "ดึงข้อมูล" ใหม่<br />(บางสาขา เช่น clk, hps, smp, npt, zk3 ยังไม่มีข้อมูลจากระบบขาย POS)</p>
                </div>
              ) : filtered.length === 0 ? (
                <div className="py-12 text-center text-gray-400 text-sm">ไม่พบรายการที่ค้นหา</div>
              ) : filtered.map((it) => {
                const on = !!selected[it.itemCode];
                return (
                  <button key={it.itemCode} onClick={() => toggle(it.itemCode)}
                    className={`w-full flex items-center gap-2 px-4 py-2 text-left hover:bg-sky-50/50 ${on ? 'bg-sky-50' : ''}`}>
                    {on ? <CheckSquare className="w-4 h-4 text-sky-600 shrink-0" /> : <Square className="w-4 h-4 text-gray-300 shrink-0" />}
                    <span className="font-mono text-[10px] text-gray-400 w-14 shrink-0">{it.itemCode}</span>
                    <span className={`flex-1 text-sm truncate ${on ? 'font-semibold text-sky-800' : 'text-gray-700'}`}>{it.name}</span>
                    <span className="font-mono text-xs text-gray-500 shrink-0">{intf(it.qty)}</span>
                  </button>
                );
              })}
            </div>
          </div>

          {/* ขวา: ผลลัพธ์ของที่เลือก */}
          <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden flex flex-col">
            <div className="px-4 py-3 border-b border-gray-100 flex items-center justify-between">
              <h2 className="font-bold text-gray-800 text-sm">ผลลัพธ์ ({selCount} เมนูที่เลือก)</h2>
              {selCount > 0 && (
                <div className="text-right text-xs">
                  <span className="text-gray-500">รวม </span>
                  <span className="font-mono font-bold text-sky-700">{intf(sumQty)}</span>
                  <span className="text-gray-500"> ชิ้น • </span>
                  <span className="font-mono font-bold text-emerald-700">{baht(sumAmt)}</span>
                </div>
              )}
            </div>
            {selCount === 0 ? (
              <div className="py-16 text-center text-gray-400 text-sm">ติ๊กเลือกเมนูฝั่งซ้าย เพื่อดูยอดขายรวมและรายวัน</div>
            ) : (
              <div className="flex-1 overflow-auto max-h-[55vh] p-3 space-y-3">
                {/* สรุปต่อเมนู */}
                <table className="w-full text-xs border-collapse">
                  <thead>
                    <tr className="text-gray-600 bg-gray-50">
                      <th className="px-3 py-2 text-left">เมนู</th>
                      <th className="px-3 py-2 text-right">จำนวน</th>
                      <th className="px-3 py-2 text-right">ยอดเงิน</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y divide-gray-100">
                    {selectedItems.map((it) => (
                      <tr key={it.itemCode}>
                        <td className="px-3 py-2 font-medium text-gray-800">{it.name}</td>
                        <td className="px-3 py-2 text-right font-mono text-sky-700 font-semibold">{intf(it.qty)}</td>
                        <td className="px-3 py-2 text-right font-mono text-emerald-700">{baht(it.amt)}</td>
                      </tr>
                    ))}
                    <tr className="bg-gray-50 font-bold text-gray-800">
                      <td className="px-3 py-2">รวม</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(sumQty)}</td>
                      <td className="px-3 py-2 text-right font-mono">{baht(sumAmt)}</td>
                    </tr>
                  </tbody>
                </table>

                {/* รายวัน: แถว=วันที่ คอลัมน์=เมนู */}
                <div className="overflow-x-auto border border-gray-100 rounded-xl">
                  <table className="w-full text-xs border-collapse whitespace-nowrap">
                    <thead>
                      <tr className="text-gray-600">
                        <th className="px-3 py-2 text-left sticky top-0 bg-gray-50 border-b border-gray-200">วันที่</th>
                        {selectedItems.map((it) => (
                          <th key={it.itemCode} className="px-3 py-2 text-right sticky top-0 bg-gray-50 border-b border-gray-200 max-w-[140px] truncate" title={it.name}>{it.name}</th>
                        ))}
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-gray-100 text-gray-700">
                      {dates.map((dt) => (
                        <tr key={dt} className="hover:bg-gray-50/50">
                          <td className="px-3 py-2 font-medium text-gray-800">{dt}</td>
                          {selectedItems.map((it) => {
                            const d = it.daily?.[dt];
                            return <td key={it.itemCode} className="px-3 py-2 text-right font-mono">{d ? intf(d.qty) : '-'}</td>;
                          })}
                        </tr>
                      ))}
                    </tbody>
                    <tfoot>
                      <tr className="bg-gray-50 border-t-2 border-gray-200 font-bold text-gray-800">
                        <td className="px-3 py-2">รวม</td>
                        {selectedItems.map((it) => (
                          <td key={it.itemCode} className="px-3 py-2 text-right font-mono text-sky-700">{intf(it.qty)}</td>
                        ))}
                      </tr>
                    </tfoot>
                  </table>
                </div>
              </div>
            )}
          </div>
        </div>
      )}
    </div>
  );
}
