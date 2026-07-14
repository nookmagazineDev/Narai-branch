// กรอกรายจ่าย (ต้นทุนจาก Supplier) — รายการคงที่ กรอกแค่ "จำนวน"
//   ราคา/หน่วย ดึงสดจากชีท 8.2 (/api/supprices) -> มูลค่า = จำนวน x ราคา
//   บันทึกลงชีท "ต้นทุนจากsup" (สเปรดชีต 1YXOaA...) ผ่าน Apps Script action saveSupCost
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Wallet, RefreshCw, Save, Store } from 'lucide-react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';

const baht = (n) =>
  '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

// รายการรหัสคงที่ (ชื่อ/ราคา อัปเดตสดจากชีท 8.2 — หน่วยตามใบรายการ)
const SUP_ITEMS = [
  { code: '11000265', unit: 'ลิตร' },
  { code: '11100006', unit: 'ขวด' },
  { code: '11100012', unit: 'ขวด' },
  { code: '11100046', unit: 'ลิตร' },
  { code: '11100047', unit: 'ลิตร' },
  { code: '11100049', unit: 'ลิตร' },
  { code: '11100051', unit: 'กก.' },
  { code: '11100052', unit: 'ลิตร' },
  { code: '11100091', unit: 'กป.' },
  { code: '11100092', unit: 'กป.' },
  { code: '11100100', unit: 'ถุง', name: 'น้ำแข็ง', manualPrice: true }, // กรอกราคา/หน่วยเอง (ไม่มีในชีท 8.2)
  { code: '11100101', unit: 'กล่อง' },
  { code: '11100102', unit: 'กล่อง' },
  { code: '11100103', unit: 'กล่อง' },
  { code: '11130003', unit: 'ถัง' },
];

const todayStr = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

export default function ExpenseEntry() {
  const { user } = useAuth();
  const isAdmin = String(user?.branch || '').toLowerCase() === 'all';

  const [prices, setPrices] = useState(null); // { code: {name, price} }
  const [loadingPrices, setLoadingPrices] = useState(true);
  const [qty, setQty] = useState({});        // code -> จำนวน (string)
  const [manualPrice, setManualPrice] = useState({}); // code -> ราคา/หน่วย (string) สำหรับรายการที่กรอกราคาเอง
  const [date, setDate] = useState(todayStr());
  const [saving, setSaving] = useState(false);

  // สาขา: ผู้ใช้ all เลือกได้, ผู้ใช้สาขาใช้ของตัวเอง
  const [branchList, setBranchList] = useState([]);
  const [selBranch, setSelBranch] = useState('');
  const branch = isAdmin ? selBranch : (user?.branch || '');

  useEffect(() => {
    let alive = true;
    fetch('/api/stockcount?prices=1')
      .then((r) => r.json())
      .then((res) => {
        if (!alive) return;
        if (res?.status === 'success') setPrices(res.data || {});
        else toast.error(res?.message || 'ดึงราคาจากชีท 8.2 ไม่สำเร็จ');
      })
      .catch(() => alive && toast.error('ดึงราคาจากชีท 8.2 ไม่สำเร็จ'))
      .finally(() => alive && setLoadingPrices(false));
    return () => { alive = false; };
  }, []);

  // ดึงข้อมูลที่บันทึกไว้ของ (สาขา+วันที่) มาแสดงเพื่อแก้ไข — บันทึกซ้ำจะทับแถวเดิม
  const [loadingExisting, setLoadingExisting] = useState(false);
  const [existingCount, setExistingCount] = useState(0);
  useEffect(() => {
    if (!branch || !date) return;
    let alive = true;
    setLoadingExisting(true);
    apiCall('getSupCost', { branch, date })
      .then((res) => {
        if (!alive || res?.status !== 'success') return;
        const saved = res.data || {};
        const q = {}, mp = {};
        SUP_ITEMS.forEach((it) => {
          const key = String(it.code).replace(/^0+/, '');
          if (saved[key] !== undefined) {
            q[it.code] = String(saved[key].qty ?? '');
            if (it.manualPrice) mp[it.code] = String(saved[key].price ?? '');
          }
        });
        setQty(q);
        setManualPrice(mp);
        const n = Object.keys(q).length;
        setExistingCount(n);
        if (n > 0) toast(`โหลดข้อมูลที่บันทึกไว้ ${n} รายการ — แก้ไขแล้วกดบันทึกจะอัปเดตรายการเดิม`, { icon: '📝', duration: 4000 });
      })
      .catch(() => {})
      .finally(() => alive && setLoadingExisting(false));
    return () => { alive = false; };
  }, [branch, date]);

  useEffect(() => {
    if (!isAdmin) return;
    apiCall('getBranches')
      .then((res) => {
        if (res?.status === 'success' && Array.isArray(res.data)) {
          const list = res.data
            .map((b) => String(b.name || '').toLowerCase().trim())
            .filter((n) => n && n !== 'all' && n !== 'ชื่อสาขา');
          setBranchList(list);
          setSelBranch((prev) => prev || list[0] || '');
        }
      })
      .catch(() => {});
  }, [isAdmin]);

  const norm = (c) => String(c).replace(/^0+/, '');
  const rows = useMemo(() => SUP_ITEMS.map((it) => {
    const q = parseFloat(qty[it.code]) || 0;
    if (it.manualPrice) {
      // รายการกรอกราคาเอง (ไม่ดึงจากชีท 8.2) — ราคา/หน่วยพิมพ์เอง
      const price = parseFloat(manualPrice[it.code]) || 0;
      return { ...it, name: it.name, price, hasPrice: price > 0, qty: q, amount: q * price };
    }
    const p = prices?.[norm(it.code)] || null;
    const price = p ? p.price : 0;
    return { ...it, name: p ? p.name : '(ไม่พบใน 8.2)', price, hasPrice: !!p, qty: q, amount: q * price };
  }), [prices, qty, manualPrice]);

  const total = rows.reduce((s, r) => s + r.amount, 0);
  const filledCount = rows.filter((r) => r.qty > 0).length;

  const save = async () => {
    const items = rows.filter((r) => r.qty > 0);
    if (!items.length) { toast.error('กรุณากรอกจำนวนอย่างน้อย 1 รายการ'); return; }
    const missingPrice = items.find((r) => r.manualPrice && !(r.price > 0));
    if (missingPrice) { toast.error(`กรุณากรอกราคา/หน่วยของ "${missingPrice.name}"`); return; }
    if (!branch) { toast.error('กรุณาเลือกสาขา'); return; }
    if (!date) { toast.error('กรุณาเลือกวันที่'); return; }
    setSaving(true);
    try {
      const res = await apiCall('saveSupCost', {
        branch,
        date,
        recorder: user?.username || '',
        items: items.map((r) => ({ code: r.code, name: r.name, unit: r.unit, qty: r.qty, price: r.price, manualPrice: !!r.manualPrice })),
      });
      toast.success(res.message || `บันทึกแล้ว ${items.length} รายการ`, { duration: 5000 });
      // คงค่าที่กรอกไว้ (โหมดดู/แก้ไขของวันนั้น) — แก้ต่อแล้วบันทึกซ้ำจะอัปเดตแถวเดิม
      setExistingCount(items.length);
    } catch (e) {
      toast.error(e.message || 'บันทึกไม่สำเร็จ');
    } finally {
      setSaving(false);
    }
  };

  return (
    <div className="max-w-5xl mx-auto space-y-5">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-emerald-100 text-emerald-600 rounded-xl"><Wallet className="w-6 h-6" /></div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-2">
              กรอกรายจ่าย
              {loadingExisting && <RefreshCw className="w-4 h-4 animate-spin text-gray-400" />}
              {!loadingExisting && existingCount > 0 && (
                <span className="text-xs font-medium px-2 py-1 rounded-full bg-amber-100 text-amber-700">แก้ไขข้อมูลเดิม ({existingCount} รายการ)</span>
              )}
            </h1>
            <p className="text-sm text-gray-500">ต้นทุนจาก Supplier • ราคา/หน่วยจากชีท 8.2 • บันทึกลงชีท "ต้นทุนจากsup"</p>
          </div>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {isAdmin ? (
            <div className="flex items-center gap-1.5 pl-3 pr-1 py-1 bg-purple-100 rounded-full">
              <Store className="w-4 h-4 text-purple-600 shrink-0" />
              <select
                value={selBranch}
                onChange={(e) => setSelBranch(e.target.value)}
                className="bg-transparent text-purple-800 text-sm font-medium pr-2 py-0.5 focus:outline-none cursor-pointer"
              >
                {branchList.length === 0 && <option value="">กำลังโหลดสาขา…</option>}
                {branchList.map((b) => <option key={b} value={b}>{b}</option>)}
              </select>
            </div>
          ) : (
            <span className="px-3 py-1.5 bg-purple-100 text-purple-800 text-sm font-medium rounded-full">สาขา: {branch || '-'}</span>
          )}
          <input
            type="date" value={date} max={todayStr()}
            onChange={(e) => setDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-emerald-500 outline-none"
          />
        </div>
      </div>

      {/* ตารางรายการ */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        {loadingPrices ? (
          <div className="py-16 flex flex-col items-center text-gray-400 text-sm">
            <RefreshCw className="w-6 h-6 animate-spin mb-3" /> กำลังดึงราคาจากชีท 8.2…
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead>
                <tr className="text-gray-600 text-xs uppercase bg-gray-50/70">
                  <th className="px-4 py-3 text-left">รหัส</th>
                  <th className="px-4 py-3 text-left">รายการ</th>
                  <th className="px-3 py-3 text-center">หน่วย</th>
                  <th className="px-3 py-3 text-right">ราคา/หน่วย</th>
                  <th className="px-3 py-3 text-center w-36 bg-emerald-50/60">จำนวน</th>
                  <th className="px-4 py-3 text-right">มูลค่า</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {rows.map((r) => (
                  <tr key={r.code} className={`hover:bg-gray-50/50 ${r.qty > 0 ? 'bg-emerald-50/30' : ''}`}>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{r.code}</td>
                    <td className={`px-4 py-2.5 font-medium ${r.hasPrice ? 'text-gray-800' : 'text-amber-600'}`}>{r.name}</td>
                    <td className="px-3 py-2.5 text-center text-gray-500">{r.unit}</td>
                    {r.manualPrice ? (
                      <td className="px-2 py-2">
                        <input
                          type="number" min="0" step="any" inputMode="decimal"
                          value={manualPrice[r.code] ?? ''}
                          onChange={(e) => setManualPrice((p) => ({ ...p, [r.code]: e.target.value }))}
                          className="w-full min-w-[96px] px-2 py-2 border border-emerald-200 bg-emerald-50/40 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-right font-mono text-base sm:text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          placeholder="ราคา/หน่วย"
                        />
                      </td>
                    ) : (
                      <td className="px-3 py-2.5 text-right font-mono text-gray-500">{r.hasPrice ? baht(r.price) : '-'}</td>
                    )}
                    <td className="px-2 py-2">
                      <input
                        type="number" min="0" step="any" inputMode="decimal"
                        value={qty[r.code] ?? ''}
                        onChange={(e) => setQty((p) => ({ ...p, [r.code]: e.target.value }))}
                        className="w-full min-w-[96px] px-2 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-center text-base sm:text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        placeholder="0"
                      />
                    </td>
                    <td className="px-4 py-2.5 text-right font-mono font-semibold text-emerald-700">{r.amount > 0 ? baht(r.amount) : '-'}</td>
                  </tr>
                ))}
              </tbody>
              <tfoot>
                <tr className="bg-gray-50 border-t-2 border-gray-200 font-bold text-gray-800">
                  <td className="px-4 py-3" colSpan={4}>รวม {filledCount} รายการ</td>
                  <td />
                  <td className="px-4 py-3 text-right font-mono text-emerald-700">{baht(total)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* ปุ่มบันทึก */}
      <div className="flex justify-end">
        <button
          onClick={save}
          disabled={saving || loadingPrices || filledCount === 0}
          className="inline-flex items-center gap-2 px-6 py-3 rounded-xl text-sm font-semibold bg-emerald-600 text-white hover:bg-emerald-700 disabled:opacity-50 shadow-md shadow-emerald-200"
        >
          {saving ? <RefreshCw className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          {saving ? 'กำลังบันทึก…' : `บันทึกรายจ่าย (${filledCount} รายการ • ${baht(total)})`}
        </button>
      </div>
    </div>
  );
}
