// กรอกรายจ่าย (ต้นทุนจาก Supplier) — รายการคงที่ กรอกแค่ "จำนวน"
//   ราคา/หน่วย ดึงสดจากชีท 8.2 (/api/supprices) -> มูลค่า = จำนวน x ราคา
//   บันทึกลงชีท "ต้นทุนจากsup" (สเปรดชีต 1YXOaA...) ผ่าน Apps Script action saveSupCost
//
// มี 2 หมวดให้สลับด้วยปุ่มด้านบนตาราง
//   • ซัพพลายเออร์ — รายการคงที่ตาม SUP_ITEMS ด้านล่าง
//   • ผัก, ผลไม้   — รายการไม่คงที่ ดึงจากชีท 8.2 ตามช่วงรหัส (ผักเพิ่ม/เลิกขายได้เรื่อยๆ จึงไม่ฮาร์ดโค้ด)
//                    ราคา/หน่วยกรอกเองได้ทุกแถว เพราะราคาผักขึ้นลงรายวัน โชว์ราคาชีท 8.2 ใต้ช่องให้เทียบ
// ทั้งสองหมวดใช้ช่องกรอก/ปุ่มบันทึกชุดเดียวกัน กดบันทึกครั้งเดียวได้ทั้งสองหมวด
// (ฝั่งชีทแยกแถวตาม "วันที่+สาขา+รหัส" อยู่แล้ว จึงไม่ต้องแก้ Apps Script)
import { useEffect, useMemo, useState } from 'react';
import toast from 'react-hot-toast';
import { Wallet, RefreshCw, Save, Store, Truck, Carrot, Search } from 'lucide-react';
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

// หมวด "ผัก,ผลไม้" — ช่วงรหัสเดียวกับที่ตารางสรุปกำไรใช้แยกหมวด (ProfitSummary.jsx)
// รายการจริงมาจากชีท 8.2 ทั้งหมด: มีผักตัวใหม่ในชีทก็ขึ้นเองโดยไม่ต้องแก้โค้ด
// เพดานตั้งเผื่อถึง 11090999: ผักตัวใหม่ในชีทได้รหัสต่อท้ายไปเรื่อยๆ (เช่น 11090152 ข้าวโพดฝัก,
// 11090153 แตงกวา) ถ้าล็อกเพดานไว้ที่รหัสสุดท้ายที่เคยมี ผักใหม่จะหายไปจากหน้านี้เงียบๆ
// หมวดถัดไป (เครื่องดื่ม) เริ่มที่ 11100001 จึงไม่ทับกัน
const VEG_CODE_MIN = 11090003;
const VEG_CODE_MAX = 11090999;
const isVegCode = (code) => {
  const n = parseInt(String(code).replace(/\D/g, ''), 10) || 0;
  return n >= VEG_CODE_MIN && n <= VEG_CODE_MAX;
};

const TABS = [
  { key: 'sup', label: 'ซัพพลายเออร์', icon: Truck },
  { key: 'veg', label: 'ผัก, ผลไม้', icon: Carrot },
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
  const [tab, setTab] = useState('sup');     // หมวดที่กำลังแสดง: sup | veg
  const [vegSearch, setVegSearch] = useState(''); // ค้นหาในหมวดผัก (รายการเยอะกว่าหมวดซัพพลายเออร์)

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
        // รายการที่ไม่ได้อยู่ในลิสต์คงที่ (เช่น ผักจากชีท 8.2) — คีย์ที่ใช้คือรหัสที่ตัดศูนย์นำหน้าแล้ว
        // ซึ่งตรงกับคีย์ของแถวหมวดผัก จึงเติมได้เลยไม่ต้องรอราคาโหลดเสร็จ
        const supKeys = new Set(SUP_ITEMS.map((it) => String(it.code).replace(/^0+/, '')));
        Object.keys(saved).forEach((key) => {
          if (supKeys.has(key)) return;
          q[key] = String(saved[key].qty ?? '');
          mp[key] = String(saved[key].price ?? ''); // ใช้เฉพาะแถวที่ไม่มีราคาในชีท 8.2
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
  const supRows = useMemo(() => SUP_ITEMS.map((it) => {
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

  // หมวดผัก: ทุกรหัสในชีท 8.2 ที่อยู่ในช่วงรหัสผัก เรียงตามรหัส
  //
  // ราคา/หน่วยของผักกรอกเองได้ทุกแถว (ราคาผักขึ้นลงรายวัน ราคาในชีท 8.2 เป็นแค่ค่าตั้งต้น)
  //   ไม่ได้แตะช่อง = ใช้ราคาจากชีท / พิมพ์ทับ = ใช้ราคาที่พิมพ์ / ลบจนว่าง = ถือว่ายังไม่กรอกราคา
  // ทุกแถวส่ง manualPrice: true เสมอ ไม่งั้นฝั่งชีทจะเอาราคาจาก 8.2 มาทับราคาที่พิมพ์
  const vegRows = useMemo(() => {
    if (!prices) return [];
    return Object.keys(prices)
      .filter(isVegCode)
      .sort((a, b) => Number(a) - Number(b))
      .map((code) => {
        const p = prices[code] || {};
        const sheetPrice = Number(p.price) || 0;
        const typed = manualPrice[code];
        const price = typed === undefined ? sheetPrice : (parseFloat(typed) || 0);
        const q = parseFloat(qty[code]) || 0;
        return {
          code,
          name: String(p.name || '').trim() || '(ไม่มีชื่อในชีท 8.2)',
          unit: String(p.unit || '').trim(),
          manualPrice: true,
          sheetPrice,
          price,
          hasPrice: price > 0,
          qty: q,
          amount: q * price,
        };
      });
  }, [prices, qty, manualPrice]);

  const vegShown = useMemo(() => {
    const kw = vegSearch.trim().toLowerCase();
    if (!kw) return vegRows;
    return vegRows.filter((r) => r.name.toLowerCase().includes(kw) || r.code.includes(kw));
  }, [vegRows, vegSearch]);

  const allRows = useMemo(() => [...supRows, ...vegRows], [supRows, vegRows]);
  const filledRows = allRows.filter((r) => r.qty > 0);
  const total = filledRows.reduce((s, r) => s + r.amount, 0);
  const filledCount = filledRows.length;
  const countOf = (rows) => rows.filter((r) => r.qty > 0).length;
  const tabCount = { sup: countOf(supRows), veg: countOf(vegRows) };

  const viewRows = tab === 'veg' ? vegShown : supRows;
  const viewTotal = viewRows.reduce((s, r) => s + r.amount, 0);
  const viewFilled = countOf(viewRows);

  const save = async () => {
    const items = filledRows;
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
            <p className="text-sm text-gray-500">ต้นทุนจาก Supplier + ผัก,ผลไม้ • ราคา/หน่วยจากชีท 8.2 (หมวดผักแก้ราคาเองได้) • บันทึกลงชีท "ต้นทุนจากsup"</p>
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
        {/* ปุ่มสลับหมวด */}
        <div className="flex flex-wrap items-center gap-2 px-4 py-3 border-b border-gray-100 bg-gray-50/60">
          {TABS.map(({ key, label, icon: Icon }) => (
            <button
              key={key}
              onClick={() => setTab(key)}
              className={`inline-flex items-center gap-2 px-4 py-2 rounded-xl text-sm font-semibold transition-colors ${
                tab === key
                  ? 'bg-emerald-600 text-white shadow-sm shadow-emerald-200'
                  : 'bg-white text-gray-600 border border-gray-200 hover:bg-gray-50'
              }`}
            >
              <Icon className="w-4 h-4" />
              {label}
              {tabCount[key] > 0 && (
                <span className={`text-xs px-1.5 py-0.5 rounded-full ${tab === key ? 'bg-white/25 text-white' : 'bg-emerald-100 text-emerald-700'}`}>
                  {tabCount[key]}
                </span>
              )}
            </button>
          ))}
          {tab === 'veg' && (
            <div className="relative ml-auto">
              <Search className="w-4 h-4 text-gray-400 absolute left-3 top-1/2 -translate-y-1/2" />
              <input
                value={vegSearch}
                onChange={(e) => setVegSearch(e.target.value)}
                placeholder="ค้นหาผัก / รหัส"
                className="w-48 sm:w-60 pl-9 pr-3 py-2 border border-gray-200 rounded-xl text-sm bg-white focus:ring-2 focus:ring-emerald-500 outline-none"
              />
            </div>
          )}
        </div>

        {tab === 'veg' && !loadingPrices && vegRows.length > 0 && (
          <p className="px-4 py-2 text-xs text-gray-500 border-b border-gray-100 bg-emerald-50/40">
            ราคา/หน่วยของผักแก้ได้ทุกแถว — ราคาจากชีท 8.2 แสดงไว้ใต้ช่องกรอกเสมอ พิมพ์ทับได้ถ้าราคาวันนี้ไม่เท่าในชีท
          </p>
        )}

        {loadingPrices ? (
          <div className="py-16 flex flex-col items-center text-gray-400 text-sm">
            <RefreshCw className="w-6 h-6 animate-spin mb-3" /> กำลังดึงราคาจากชีท 8.2…
          </div>
        ) : viewRows.length === 0 ? (
          <div className="py-16 flex flex-col items-center text-gray-400 text-sm gap-2">
            <Carrot className="w-6 h-6" />
            {vegSearch.trim()
              ? `ไม่พบรายการที่ตรงกับ "${vegSearch.trim()}"`
              : `ไม่พบรายการผักในชีท 8.2 (ช่วงรหัส ${VEG_CODE_MIN}–${VEG_CODE_MAX})`}
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
                {viewRows.map((r) => (
                  <tr key={r.code} className={`hover:bg-gray-50/50 ${r.qty > 0 ? 'bg-emerald-50/30' : ''}`}>
                    <td className="px-4 py-2.5 font-mono text-xs text-gray-500">{r.code}</td>
                    <td className={`px-4 py-2.5 font-medium ${r.hasPrice ? 'text-gray-800' : 'text-amber-600'}`}>{r.name}</td>
                    <td className="px-3 py-2.5 text-center text-gray-500">{r.unit || '-'}</td>
                    {r.manualPrice ? (
                      <td className="px-2 py-2">
                        <input
                          type="number" min="0" step="any" inputMode="decimal"
                          value={manualPrice[r.code] ?? (r.sheetPrice > 0 ? String(r.sheetPrice) : '')}
                          onChange={(e) => setManualPrice((p) => ({ ...p, [r.code]: e.target.value }))}
                          className="w-full min-w-[96px] px-2 py-2 border border-emerald-200 bg-emerald-50/40 rounded-lg focus:ring-2 focus:ring-emerald-500 outline-none text-right font-mono text-base sm:text-sm [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                          placeholder="ราคา/หน่วย"
                        />
                        {/* ราคาจากชีท 8.2 โชว์ใต้ช่องเสมอ ให้เทียบได้ว่าราคาวันนี้ต่างจากราคากลางแค่ไหน
                            ถ้าพิมพ์ทับไปแล้วบรรทัดนี้กดคืนค่าได้ */}
                        {r.sheetPrice !== undefined && (
                          r.sheetPrice <= 0 ? (
                            <div className="mt-1 text-right text-[11px] text-gray-400">ยังไม่มีราคาในชีท 8.2</div>
                          ) : r.price === r.sheetPrice ? (
                            <div className="mt-1 text-right text-[11px] text-gray-400">ชีท 8.2 {baht(r.sheetPrice)}</div>
                          ) : (
                            <button
                              type="button"
                              onClick={() => setManualPrice((p) => { const n = { ...p }; delete n[r.code]; return n; })}
                              className="mt-1 w-full text-right text-[11px] text-amber-600 hover:text-amber-700 hover:underline"
                            >
                              ชีท 8.2 {baht(r.sheetPrice)} — กดคืนค่า
                            </button>
                          )
                        )}
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
                  <td className="px-4 py-3" colSpan={4}>
                    รวมหมวดนี้ {viewFilled} รายการ
                    {filledCount > viewFilled && (
                      <span className="ml-2 font-normal text-xs text-gray-500">(อีกหมวดกรอกไว้ {filledCount - viewFilled} รายการ)</span>
                    )}
                  </td>
                  <td />
                  <td className="px-4 py-3 text-right font-mono text-emerald-700">{baht(viewTotal)}</td>
                </tr>
              </tfoot>
            </table>
          </div>
        )}
      </div>

      {/* ปุ่มบันทึก — บันทึกทั้งสองหมวดพร้อมกัน */}
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
