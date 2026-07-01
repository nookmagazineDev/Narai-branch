import { useAuth } from '../contexts/AuthContext';
import { useEffect, useMemo, useRef, useState, useCallback } from 'react';
import {
  DollarSign, Layers, TrendingUp, FileText, Users, BarChart3,
  RefreshCw, Calendar, AlertCircle, Scale, Ban,
  Eye, X, ShoppingBag, Search, CheckCircle, XCircle, ReceiptText, Store,
} from 'lucide-react';
import { fetchDashboard, fetchBills, fetchBillDetail, presetRange, PRESETS, fmtDate } from '../services/dashboardApi';
import { apiCall } from '../services/api';
import ProfitSummary from '../components/ProfitSummary';

const baht = (n) =>
  '฿' + Number(n || 0).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 });
const intf = (n) => Number(n || 0).toLocaleString('th-TH');

// ---- การ์ดสรุป (กดดูรายละเอียดได้ถ้าส่ง onClick) ----
function StatCard({ title, value, sub, icon: Icon, accent, onClick }) {
  const clickable = typeof onClick === 'function';
  const Wrapper = clickable ? 'button' : 'div';
  return (
    <Wrapper
      type={clickable ? 'button' : undefined}
      onClick={onClick}
      className={`w-full text-left bg-white rounded-2xl p-5 shadow-sm border border-gray-100 transition-all ${
        clickable ? 'cursor-pointer hover:shadow-md hover:border-indigo-300' : 'hover:shadow-md'
      }`}
    >
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0">
          <h3 className="text-gray-500 text-sm font-medium truncate">{title}</h3>
          <p className={`text-2xl font-bold mt-1 ${accent?.text || 'text-gray-800'}`}>{value}</p>
          {sub && <p className="text-xs text-gray-400 mt-1 truncate">{sub}</p>}
          {clickable && <p className={`text-[11px] font-semibold mt-1 ${accent?.text || 'text-indigo-500'}`}>คลิกดูรายละเอียด →</p>}
        </div>
        <div className={`w-11 h-11 shrink-0 rounded-xl flex items-center justify-center ${accent?.bg || 'bg-gray-50'} ${accent?.icon || 'text-gray-500'}`}>
          <Icon className="w-5 h-5" />
        </div>
      </div>
    </Wrapper>
  );
}

// ---- Modal แสดง breakdown รายไอเทม (ต้นทุน/โต๊ะเตรียม/ไม่นับคำนวณ) ----
function BreakdownModal({ open, onClose, title, rows, accent, showReason }) {
  if (!open) return null;
  const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.totalCost || 0), 0);
  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-3xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold">{title}</h3>
            <p className="text-xs text-gray-400 mt-0.5">{rows.length.toLocaleString('th-TH')} รายการ</p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800">✕</button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่มีข้อมูล</div>
          ) : (
            <div className="overflow-auto max-h-[60vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    {showReason && <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">เหตุผล</th>}
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">รหัส</th>
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ชื่อรายการ</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">จำนวน</th>
                    <th className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">ต้นทุน/หน่วย</th>
                    <th className={`px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200 ${accent}`}>ต้นทุนรวม</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {rows.map((r, i) => (
                    <tr key={i} className="hover:bg-gray-50/50">
                      {showReason && <td className="px-3 py-2"><span className="text-[10px] px-1.5 py-0.5 rounded bg-gray-100 text-gray-600">{r.reason}</span></td>}
                      <td className="px-3 py-2 font-mono text-gray-400">{r.itemCode}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.qty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.unitCost)}</td>
                      <td className={`px-3 py-2 text-right font-mono font-bold ${accent}`}>{baht(r.totalCost)}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={showReason ? 3 : 2}>รวมทั้งหมด</td>
                    <td className="px-3 py-2.5 text-right font-mono">{intf(totalQty)}</td>
                    <td />
                    <td className={`px-3 py-2.5 text-right font-mono ${accent}`}>{baht(totalCost)}</td>
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- badge ประเภทการชำระเงิน ----
function PaidBadge({ value }) {
  const v = String(value || '').toLowerCase();
  const cls = v.includes('cash') || v.includes('สด')
    ? 'bg-emerald-50 text-emerald-700'
    : v.includes('credit') || v.includes('บัตร')
      ? 'bg-violet-50 text-violet-700'
      : 'bg-amber-50 text-amber-700';
  return <span className={`px-2 py-0.5 rounded-full text-[10px] font-bold ${cls}`}>{value || '-'}</span>;
}

// ---- Modal: รายละเอียดรายการในบิลเดียว (line items) ----
function BillDetailModal({ open, onClose, bill, branch, outletId }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);

  useEffect(() => {
    if (!open || !bill) return;
    let alive = true;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(''); setRows([]);
    fetchBillDetail({ branch, outletId, date: bill.date, checkID: bill.checkID, signal: controller.signal })
      .then((res) => { if (alive) setRows(res.data || []); })
      .catch((e) => { if (alive && e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [open, bill, branch, outletId]);

  if (!open || !bill) return null;
  const totalQty = rows.reduce((s, r) => s + (r.qty || 0), 0);
  const totalGross = rows.reduce((s, r) => s + (r.grossPrice || 0), 0);
  const totalVat = rows.reduce((s, r) => s + (r.tax || 0), 0);
  const totalCost = rows.reduce((s, r) => s + (r.void ? 0 : r.lineCost || 0), 0);

  return (
    <div className="fixed inset-0 z-[60] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-4xl max-h-[85vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between shrink-0">
          <div>
            <h3 className="text-base font-bold flex items-center gap-2"><ShoppingBag className="w-4 h-4 text-amber-400" /> รายละเอียดรายการในบิล</h3>
            <p className="text-xs text-gray-400 mt-1">
              เลขที่บิล <span className="font-mono font-bold text-white bg-gray-800 px-2 py-0.5 rounded">{bill.checkID}</span>
              <span className="ml-2">โต๊ะ {bill.tableID ?? '-'} • {bill.date} • {bill.startTime || '-'}</span>
            </p>
          </div>
          <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          {loading ? (
            <div className="py-16 flex flex-col items-center text-gray-400 text-sm"><RefreshCw className="w-6 h-6 animate-spin mb-3" /> กำลังโหลดรายละเอียดบิล…</div>
          ) : error ? (
            <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm flex items-center gap-2"><XCircle className="w-4 h-4" /> {error}</div>
          ) : rows.length === 0 ? (
            <div className="py-16 text-center text-gray-400 text-sm">ไม่พบรายการในบิลนี้</div>
          ) : (
            <div className="overflow-auto max-h-[58vh] border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse">
                <thead>
                  <tr className="text-gray-600">
                    {['รหัส', 'ชื่อรายการ'].map((h) => <th key={h} className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">{h}</th>)}
                    {['จำนวน', 'ราคา/หน่วย', 'ก่อน Vat', 'Vat', 'รวม', 'ต้นทุน/หน่วย', 'ต้นทุนรวม'].map((h) => <th key={h} className="px-3 py-2.5 text-right sticky top-0 bg-gray-50 border-b border-gray-200">{h}</th>)}
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">สถานะ</th>
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {rows.map((r, i) => (
                    <tr key={i} className={`hover:bg-gray-50/50 ${r.void ? 'bg-rose-50/40 line-through text-gray-400' : ''}`}>
                      <td className="px-3 py-2 font-mono text-gray-400">{r.itemCode}</td>
                      <td className="px-3 py-2 font-medium text-gray-800">{r.name}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.qty)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.unitPrice)}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-600">{baht(r.grossPrice)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.tax)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600 font-semibold">{baht(r.grossPrice + r.tax)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.unitCost)}</td>
                      <td className="px-3 py-2 text-right font-mono text-rose-600 font-bold">{baht(r.lineCost)}</td>
                      <td className="px-3 py-2">
                        {r.void
                          ? <span className="inline-flex items-center gap-1 text-rose-600 font-semibold no-underline"><XCircle className="w-3 h-3" /> ยกเลิก</span>
                          : <span className="inline-flex items-center gap-1 text-emerald-600 font-semibold"><CheckCircle className="w-3 h-3" /> ปกติ</span>}
                      </td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={2}>รวมทั้งหมด</td>
                    <td className="px-3 py-2.5 text-right font-mono">{intf(totalQty)}</td>
                    <td />
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{baht(totalGross)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-gray-500">{baht(totalVat)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">{baht(totalGross + totalVat)}</td>
                    <td />
                    <td className="px-3 py-2.5 text-right font-mono text-rose-700">{baht(totalCost)}</td>
                    <td />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
    </div>
  );
}

// ---- Modal: ตารางรายการขาย (รายการบิลทั้งหมด) ----
function BillsModal({ open, onClose, branch, outletId, startDate, endDate }) {
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [rows, setRows] = useState([]);
  const [search, setSearch] = useState('');
  const [selected, setSelected] = useState(null); // บิลที่กดดูรายละเอียด

  useEffect(() => {
    if (!open) return;
    let alive = true;
    const controller = new AbortController();
    // eslint-disable-next-line react-hooks/set-state-in-effect
    setLoading(true); setError(''); setRows([]); setSearch(''); setSelected(null);
    fetchBills({ branch, outletId, startDate, endDate, signal: controller.signal })
      .then((res) => { if (alive) setRows(res.data || []); })
      .catch((e) => { if (alive && e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด'); })
      .finally(() => { if (alive) setLoading(false); });
    return () => { alive = false; controller.abort(); };
  }, [open, branch, outletId, startDate, endDate]);

  const filtered = useMemo(() => {
    const q = search.trim().toLowerCase();
    if (!q) return rows;
    return rows.filter((r) =>
      [r.checkID, r.tableID, r.cashierName, r.waiterName, r.paidType, r.memberTel, r.orderID]
        .some((v) => String(v ?? '').toLowerCase().includes(q))
    );
  }, [rows, search]);

  const totals = useMemo(() => filtered.reduce((a, r) => ({
    amount: a.amount + (r.amount || 0),
    beforeVat: a.beforeVat + (r.beforeVat || 0),
    vat: a.vat + (r.vat || 0),
    billTotal: a.billTotal + (r.billTotal || 0),
    billCost: a.billCost + (r.billCost || 0),
    cover: a.cover + (r.cover || 0),
  }), { amount: 0, beforeVat: 0, vat: 0, billTotal: 0, billCost: 0, cover: 0 }), [filtered]);

  if (!open) return null;
  const cols = [
    { h: 'วันที่' }, { h: 'Check ID' }, { h: 'โต๊ะ', r: true }, { h: 'แคชเชียร์' }, { h: 'พนักงานรับออเดอร์' },
    { h: 'Amount', r: true }, { h: 'ก่อน Vat', r: true }, { h: 'Vat', r: true }, { h: 'Bill Total', r: true },
    { h: 'ต้นทุนรวม', r: true }, { h: 'ชำระ' }, { h: 'สมาชิก' }, { h: 'Cover', r: true }, { h: 'Cover All', r: true }, { h: 'เวลาเริ่ม' },
  ];

  return (
    <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-[95vw] xl:max-w-7xl max-h-[88vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-6 py-4 bg-gray-900 text-white flex items-center justify-between gap-4 shrink-0">
          <div className="min-w-0">
            <h3 className="text-base font-bold flex items-center gap-2"><ReceiptText className="w-4 h-4 text-indigo-300" /> ตารางรายการขาย</h3>
            <p className="text-xs text-gray-400 mt-1">{loading ? 'กำลังโหลด…' : `พบ ${filtered.length.toLocaleString('th-TH')} บิล`} • {startDate} ถึง {endDate}</p>
          </div>
          <div className="flex items-center gap-2">
            <div className="relative hidden sm:block">
              <Search className="w-4 h-4 absolute left-2.5 top-1/2 -translate-y-1/2 text-gray-400" />
              <input
                value={search} onChange={(e) => setSearch(e.target.value)} placeholder="ค้นหาบิล…"
                className="pl-8 pr-3 py-1.5 rounded-lg bg-gray-800 text-white text-sm placeholder-gray-500 focus:outline-none focus:ring-2 focus:ring-indigo-500 w-56"
              />
            </div>
            <button onClick={onClose} className="text-gray-400 hover:text-white p-1 rounded-lg hover:bg-gray-800"><X className="w-5 h-5" /></button>
          </div>
        </div>
        <div className="flex-1 overflow-auto p-3">
          {loading ? (
            <div className="py-20 flex flex-col items-center text-gray-400 text-sm"><RefreshCw className="w-6 h-6 animate-spin mb-3" /> กำลังโหลดรายการบิล…</div>
          ) : error ? (
            <div className="p-4 bg-red-50 border border-red-200 text-red-700 rounded-xl text-sm flex items-center gap-2"><XCircle className="w-4 h-4" /> {error}</div>
          ) : filtered.length === 0 ? (
            <div className="py-20 text-center text-gray-400 text-sm">ไม่พบรายการบิล</div>
          ) : (
            <div className="overflow-auto border border-gray-100 rounded-xl">
              <table className="w-full text-left text-xs border-collapse whitespace-nowrap">
                <thead>
                  <tr className="text-gray-600">
                    <th className="px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200">ดูบิล</th>
                    {cols.map((c) => <th key={c.h} className={`px-3 py-2.5 sticky top-0 bg-gray-50 border-b border-gray-200 ${c.r ? 'text-right' : ''}`}>{c.h}</th>)}
                  </tr>
                </thead>
                <tbody className="divide-y divide-gray-100 text-gray-700">
                  {filtered.map((r, i) => (
                    <tr key={i} className="hover:bg-indigo-50/40 cursor-pointer" onClick={() => setSelected(r)}>
                      <td className="px-3 py-2">
                        <span className="inline-flex items-center gap-1 px-2 py-1 border border-indigo-200 text-indigo-600 rounded-lg text-[10px] font-semibold"><Eye className="w-3 h-3" /> ดู</span>
                      </td>
                      <td className="px-3 py-2 whitespace-nowrap">{r.date}</td>
                      <td className="px-3 py-2 font-mono">{r.checkID}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">{r.tableID ?? '-'}</td>
                      <td className="px-3 py-2 text-gray-600">{r.cashierName || '-'}</td>
                      <td className="px-3 py-2 text-gray-600">{r.waiterName || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono text-emerald-600 font-semibold">{baht(r.amount)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-600">{baht(r.beforeVat)}</td>
                      <td className="px-3 py-2 text-right font-mono text-gray-400">{baht(r.vat)}</td>
                      <td className="px-3 py-2 text-right font-mono text-amber-600 font-bold">{baht(r.billTotal)}</td>
                      <td className="px-3 py-2 text-right font-mono text-rose-600 font-semibold">{baht(r.billCost)}</td>
                      <td className="px-3 py-2"><PaidBadge value={r.paidType} /></td>
                      <td className="px-3 py-2 font-mono text-gray-600">{r.memberTel || '-'}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.cover)}</td>
                      <td className="px-3 py-2 text-right font-mono">{intf(r.coverAll)}</td>
                      <td className="px-3 py-2 text-gray-500">{r.startTime || '-'}</td>
                    </tr>
                  ))}
                </tbody>
                <tfoot>
                  <tr className="bg-gray-50 border-t-2 border-gray-300 font-bold text-gray-800 sticky bottom-0">
                    <td className="px-3 py-2.5" colSpan={6}>รวม {filtered.length.toLocaleString('th-TH')} บิล</td>
                    <td className="px-3 py-2.5 text-right font-mono text-emerald-700">{baht(totals.amount)}</td>
                    <td className="px-3 py-2.5 text-right font-mono">{baht(totals.beforeVat)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-gray-500">{baht(totals.vat)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-amber-700">{baht(totals.billTotal)}</td>
                    <td className="px-3 py-2.5 text-right font-mono text-rose-700">{baht(totals.billCost)}</td>
                    <td colSpan={2} />
                    <td className="px-3 py-2.5 text-right font-mono">{intf(totals.cover)}</td>
                    <td colSpan={2} />
                  </tr>
                </tfoot>
              </table>
            </div>
          )}
        </div>
      </div>
      <BillDetailModal open={!!selected} onClose={() => setSelected(null)} bill={selected} branch={branch} outletId={outletId} />
    </div>
  );
}

// ---- กราฟยอดขายรายวัน (SVG area chart, ไม่ต้องพึ่ง lib) ----
function DailySalesChart({ daily }) {
  const w = 760, h = 280, pad = { t: 16, r: 16, b: 28, l: 56 };
  const points = daily || [];
  if (!points.length) {
    return <div className="h-64 flex items-center justify-center text-gray-400 text-sm">ไม่มีข้อมูลในช่วงนี้</div>;
  }
  const max = Math.max(...points.map((p) => p.sales), 1);
  const iw = w - pad.l - pad.r, ih = h - pad.t - pad.b;
  const x = (i) => pad.l + (points.length === 1 ? iw / 2 : (i / (points.length - 1)) * iw);
  const y = (v) => pad.t + ih - (v / max) * ih;
  const line = points.map((p, i) => `${i === 0 ? 'M' : 'L'}${x(i).toFixed(1)},${y(p.sales).toFixed(1)}`).join(' ');
  const area = `${line} L${x(points.length - 1).toFixed(1)},${(pad.t + ih).toFixed(1)} L${x(0).toFixed(1)},${(pad.t + ih).toFixed(1)} Z`;
  const ticks = 4;
  const gridVals = Array.from({ length: ticks + 1 }, (_, i) => (max / ticks) * i);
  const labelEvery = Math.ceil(points.length / 8);

  return (
    <svg viewBox={`0 0 ${w} ${h}`} className="w-full h-auto" preserveAspectRatio="xMidYMid meet">
      <defs>
        <linearGradient id="salesFill" x1="0" y1="0" x2="0" y2="1">
          <stop offset="0%" stopColor="#6366f1" stopOpacity="0.35" />
          <stop offset="100%" stopColor="#6366f1" stopOpacity="0.02" />
        </linearGradient>
      </defs>
      {gridVals.map((v, i) => (
        <g key={i}>
          <line x1={pad.l} x2={w - pad.r} y1={y(v)} y2={y(v)} stroke="#f1f5f9" strokeWidth="1" />
          <text x={pad.l - 8} y={y(v) + 4} textAnchor="end" fontSize="10" fill="#94a3b8">
            {'฿' + Math.round(v).toLocaleString('th-TH')}
          </text>
        </g>
      ))}
      <path d={area} fill="url(#salesFill)" />
      <path d={line} fill="none" stroke="#6366f1" strokeWidth="2.5" strokeLinejoin="round" strokeLinecap="round" />
      {points.map((p, i) => (
        <g key={i}>
          <circle cx={x(i)} cy={y(p.sales)} r="2.5" fill="#6366f1">
            <title>{`${p.date}: ${baht(p.sales)}`}</title>
          </circle>
          {i % labelEvery === 0 && (
            <text x={x(i)} y={h - 10} textAnchor="middle" fontSize="9.5" fill="#94a3b8">
              {p.date.slice(5)}
            </text>
          )}
        </g>
      ))}
    </svg>
  );
}

export default function DashboardHome() {
  const { user } = useAuth();
  const isAdmin = String(user?.branch || '').toLowerCase() === 'all';

  // ผู้ใช้ระดับ all: เลือกสาขาที่จะดูได้ | ผู้ใช้ปกติ: ใช้สาขาของตัวเอง
  const [branchList, setBranchList] = useState([]);
  const [selBranch, setSelBranch] = useState(null); // { name, outletId }

  // สาขาที่ใช้ดึงข้อมูลจริง
  const branch = isAdmin ? (selBranch?.name || '') : (user?.branch || '');
  const outletId = isAdmin ? (selBranch?.outletId || '') : (user?.outletId || '');

  const [preset, setPreset] = useState('thisMonth');
  const initial = presetRange('thisMonth');
  const [startDate, setStartDate] = useState(initial.startDate);
  const [endDate, setEndDate] = useState(initial.endDate);

  const [data, setData] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState('');
  const [modal, setModal] = useState(null); // 'cost' | 'prep' | 'excluded'
  const [showBills, setShowBills] = useState(false); // ตารางรายการขาย
  const abortRef = useRef(null);

  const load = useCallback(
    async (sd, ed) => {
      if (!branch && !outletId) return;
      if (abortRef.current) abortRef.current.abort();
      const controller = new AbortController();
      abortRef.current = controller;
      setLoading(true);
      setError('');
      try {
        const res = await fetchDashboard({ branch, outletId, startDate: sd, endDate: ed, signal: controller.signal });
        setData(res.data);
      } catch (e) {
        if (e.name !== 'AbortError') setError(e.message || 'เกิดข้อผิดพลาด');
      } finally {
        setLoading(false);
      }
    },
    [branch, outletId]
  );

  // โหลดรายชื่อสาขา (เฉพาะผู้ใช้ระดับ all) แล้วเลือกสาขาแรกอัตโนมัติ
  useEffect(() => {
    if (!isAdmin) return;
    let alive = true;
    apiCall('getBranches')
      .then((res) => {
        if (!alive) return;
        if (res?.status === 'success' && Array.isArray(res.data)) {
          const list = res.data.filter((b) => String(b.name).toLowerCase() !== 'all');
          setBranchList(list);
          setSelBranch((prev) => prev || list[0] || null);
        }
      })
      .catch(() => {});
    return () => { alive = false; };
  }, [isAdmin]);

  // ออโต้โหลดข้อมูลเมื่อเข้าหน้า/เปลี่ยนสาขา (ใช้ช่วงวันที่ที่เลือกอยู่)
  useEffect(() => {
    if (!branch && !outletId) return;
    // eslint-disable-next-line react-hooks/exhaustive-deps
    load(startDate, endDate);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, outletId, load]);

  const applyPreset = (key) => {
    setPreset(key);
    if (key === 'custom') return;
    const r = presetRange(key);
    setStartDate(r.startDate);
    setEndDate(r.endDate);
    load(r.startDate, r.endDate);
  };

  const d = data || {};
  const profitPositive = (d.profit ?? 0) >= 0;

  const rangeText = useMemo(() => `${startDate} ถึง ${endDate}`, [startDate, endDate]);

  return (
    <div className="max-w-7xl mx-auto space-y-6">
      {/* Header */}
      <div className="flex flex-wrap items-center justify-between gap-3">
        <div className="flex items-center gap-3">
          <div className="p-2 bg-indigo-100 text-indigo-600 rounded-xl">
            <BarChart3 className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">แดชบอร์ดสาขา</h1>
            <p className="text-sm text-gray-500 flex items-center gap-1.5">
              <Calendar className="w-3.5 h-3.5" /> {rangeText}
            </p>
          </div>
        </div>
        <div className="flex items-center gap-2">
          {isAdmin ? (
            <div className="flex items-center gap-1.5 pl-3 pr-1 py-1 bg-purple-100 rounded-full">
              <Store className="w-4 h-4 text-purple-600 shrink-0" />
              <select
                value={selBranch?.name || ''}
                onChange={(e) => {
                  const b = branchList.find((x) => x.name === e.target.value);
                  if (b) setSelBranch(b);
                }}
                className="bg-transparent text-purple-800 text-sm font-medium pr-2 py-0.5 focus:outline-none cursor-pointer"
                title="เลือกสาขาที่ต้องการดู"
              >
                {branchList.length === 0 && <option value="">กำลังโหลดสาขา…</option>}
                {branchList.map((b) => (
                  <option key={b.name} value={b.name}>
                    {b.name}{b.outletId ? ` (${b.outletId})` : ''}
                  </option>
                ))}
              </select>
            </div>
          ) : (
            <span className="px-3 py-1.5 bg-purple-100 text-purple-800 text-sm font-medium rounded-full">
              สาขา: {branch || outletId || '-'}
            </span>
          )}
          <button
            onClick={() => load(startDate, endDate)}
            disabled={loading}
            className="p-2 rounded-lg bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50"
            title="โหลดใหม่"
          >
            <RefreshCw className={`w-4 h-4 ${loading ? 'animate-spin' : ''}`} />
          </button>
        </div>
      </div>

      {/* ตัวเลือกช่วงเวลา */}
      <div className="bg-white rounded-2xl p-4 shadow-sm border border-gray-100">
        <div className="flex flex-wrap items-center gap-2">
          {PRESETS.map((p) => (
            <button
              key={p.key}
              onClick={() => applyPreset(p.key)}
              className={`px-4 py-2 rounded-xl text-sm font-medium transition-all ${
                preset === p.key
                  ? 'bg-indigo-600 text-white shadow-md shadow-indigo-200'
                  : 'bg-gray-50 text-gray-600 hover:bg-gray-100'
              }`}
            >
              {p.label}
            </button>
          ))}
          {preset === 'custom' && (
            <div className="flex flex-wrap items-center gap-2 ml-1">
              <input
                type="date"
                value={startDate}
                max={endDate}
                onChange={(e) => setStartDate(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500"
              />
              <span className="text-gray-400">ถึง</span>
              <input
                type="date"
                value={endDate}
                min={startDate}
                max={fmtDate(new Date())}
                onChange={(e) => setEndDate(e.target.value)}
                className="px-3 py-2 border border-gray-200 rounded-xl text-sm focus:ring-2 focus:ring-indigo-500"
              />
              <button
                onClick={() => load(startDate, endDate)}
                className="px-4 py-2 rounded-xl text-sm font-medium bg-indigo-600 text-white hover:bg-indigo-700"
              >
                ค้นหา
              </button>
            </div>
          )}
        </div>
      </div>

      {error && (
        <div className="flex items-center gap-2 bg-red-50 border border-red-200 text-red-700 rounded-xl px-4 py-3 text-sm">
          <AlertCircle className="w-4 h-4 shrink-0" />
          <span>ดึงข้อมูลไม่สำเร็จ: {error}</span>
        </div>
      )}

      {/* สรุปกำไร/ขาดทุน (รายรับ–รายจ่าย) — ต้นทุนจากใบเบิก */}
      <ProfitSummary branch={branch} outletId={outletId} startDate={startDate} endDate={endDate} dash={d} />

      {/* การ์ดสรุป */}
      <div className="grid grid-cols-1 sm:grid-cols-2 lg:grid-cols-4 gap-4">
        <StatCard
          title="ยอดขายรวมทั้งหมด" value={baht(d.sales)} sub="ก่อน VAT (Bill − VAT)"
          icon={DollarSign} accent={{ text: 'text-emerald-600', bg: 'bg-emerald-50', icon: 'text-emerald-600' }}
          onClick={data ? () => setShowBills(true) : undefined}
        />
        <StatCard
          title="ต้นทุนรวมทั้งหมด" value={baht(d.cost)} sub="ต้นทุนวัตถุดิบ (ไม่รวมโต๊ะเตรียม)"
          icon={Layers} accent={{ text: 'text-rose-500', bg: 'bg-rose-50', icon: 'text-rose-500' }}
          onClick={data ? () => setModal('cost') : undefined}
        />
        <StatCard
          title="ต้นทุนโต๊ะเตรียม(กก)" value={baht(d.prepCost)}
          sub={`${intf(d.prepQty)} กก • วัตถุดิบเตรียม`}
          icon={Scale} accent={{ text: 'text-orange-500', bg: 'bg-orange-50', icon: 'text-orange-500' }}
          onClick={data ? () => setModal('prep') : undefined}
        />
        <StatCard
          title="กำไร / ขาดทุนสุทธิ" value={baht(d.profit)} sub="ยอดขาย − ต้นทุนรวม"
          icon={TrendingUp}
          accent={profitPositive
            ? { text: 'text-indigo-600', bg: 'bg-indigo-50', icon: 'text-indigo-600' }
            : { text: 'text-rose-600', bg: 'bg-rose-50', icon: 'text-rose-600' }}
        />
        <StatCard
          title="จำนวนบิลทั้งหมด" value={intf(d.bills)} sub="ใบเสร็จรับเงิน • ดูรายการบิล"
          icon={FileText} accent={{ text: 'text-amber-600', bg: 'bg-amber-50', icon: 'text-amber-600' }}
          onClick={data ? () => setShowBills(true) : undefined}
        />
        <StatCard
          title="ยอดเฉลี่ยต่อบิล" value={baht(d.avgPerBill)} sub="เฉลี่ยต่อบิล (รวม VAT)"
          icon={TrendingUp} accent={{ text: 'text-emerald-600', bg: 'bg-emerald-50', icon: 'text-emerald-600' }}
        />
        <StatCard
          title="จำนวนลูกค้าทั้งหมด" value={intf(d.covers)} sub="คน (Covers)"
          icon={Users} accent={{ text: 'text-sky-600', bg: 'bg-sky-50', icon: 'text-sky-600' }}
        />
        <StatCard
          title="รายการไม่นับคำนวณ" value={baht(d.excludedCost)}
          sub={`${intf(d.excludedQty)} ชิ้น • ไม่นำมาคิดต้นทุน`}
          icon={Ban} accent={{ text: 'text-gray-500', bg: 'bg-gray-100', icon: 'text-gray-500' }}
          onClick={data ? () => setModal('excluded') : undefined}
        />
      </div>

      {/* กราฟยอดขายรายวัน */}
      <div className="bg-white rounded-2xl p-5 shadow-sm border border-gray-100">
        <div className="mb-3">
          <h2 className="text-lg font-bold text-gray-800">ยอดขายรายวัน</h2>
          <p className="text-sm text-gray-400">แนวโน้มรายได้การขายในแต่ละวัน</p>
        </div>
        {loading && !data ? (
          <div className="h-64 flex items-center justify-center text-gray-400 text-sm">
            <RefreshCw className="w-5 h-5 animate-spin mr-2" /> กำลังโหลดข้อมูล...
          </div>
        ) : (
          <DailySalesChart daily={d.daily} />
        )}
      </div>

      {/* Modal รายละเอียดต้นทุน */}
      <BreakdownModal
        open={modal === 'cost'} onClose={() => setModal(null)}
        title="รายละเอียดต้นทุนรวม" rows={d.costBreakdown || []} accent="text-rose-600"
      />
      <BreakdownModal
        open={modal === 'prep'} onClose={() => setModal(null)}
        title="รายละเอียดต้นทุนโต๊ะเตรียม(กก)" rows={d.prepBreakdown || []} accent="text-orange-600"
      />
      <BreakdownModal
        open={modal === 'excluded'} onClose={() => setModal(null)}
        title="รายการไม่นับคำนวณ" rows={d.excludedBreakdown || []} accent="text-gray-600" showReason
      />

      {/* ตารางรายการขาย (กดดูรายการบิล → กดดูรายละเอียดบิล) */}
      <BillsModal
        open={showBills} onClose={() => setShowBills(false)}
        branch={branch} outletId={outletId} startDate={startDate} endDate={endDate}
      />
    </div>
  );
}
