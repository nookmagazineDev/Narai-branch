import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { CalendarCheck, Search, Loader2, AlertCircle, Save, History, X } from 'lucide-react';
import toast from 'react-hot-toast';

const todayYMD = () => {
  const d = new Date();
  return `${d.getFullYear()}-${String(d.getMonth() + 1).padStart(2, '0')}-${String(d.getDate()).padStart(2, '0')}`;
};

// ป๊อปอัปแสดงประวัติการบันทึกของรายการเดียว — เรียงล่าสุดขึ้นก่อน
function ClosingHistoryModal({ open, name, history, onClose }) {
  if (!open) return null;
  const rows = [...(history || [])].reverse();
  return (
    <div className="fixed inset-0 z-[70] flex items-center justify-center p-4 bg-gray-900/60 backdrop-blur-sm" onClick={onClose}>
      <div className="bg-white rounded-2xl w-full max-w-md max-h-[80vh] flex flex-col shadow-2xl overflow-hidden" onClick={(e) => e.stopPropagation()}>
        <div className="px-5 py-4 bg-indigo-600 text-white flex items-center justify-between shrink-0">
          <div className="min-w-0">
            <h3 className="text-sm font-bold flex items-center gap-2"><History className="w-4 h-4" /> ประวัติการบันทึก</h3>
            <p className="text-xs text-indigo-100 mt-0.5 truncate">{name}</p>
          </div>
          <button onClick={onClose} className="text-indigo-100 hover:text-white p-1"><X className="w-5 h-5" /></button>
        </div>
        <div className="flex-1 overflow-y-auto p-4">
          <div className="border border-gray-100 rounded-xl divide-y divide-gray-100">
            {rows.map((h, i) => (
              <div key={i} className={`px-4 py-2.5 ${i === 0 ? 'bg-indigo-50/50' : ''}`}>
                <div className="flex items-center justify-between">
                  <span className="text-sm font-semibold text-gray-800">
                    {Number(h.qty).toLocaleString('th-TH', { maximumFractionDigits: 2 })}
                    {i === 0 && <span className="ml-2 text-[10px] font-medium text-indigo-600 bg-indigo-100 px-2 py-0.5 rounded-full">ล่าสุด</span>}
                  </span>
                  <span className="text-sm font-mono text-emerald-700">
                    {Number(h.amount).toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} บาท
                  </span>
                </div>
                <p className="text-[11px] text-gray-400 mt-0.5">{h.time || '-'} · {h.recorder || '-'}</p>
              </div>
            ))}
          </div>
        </div>
      </div>
    </div>
  );
}

// ปิดยอดสิ้นเดือน — รายชื่อไอเทมเหมือนหน้านับสต๊อก แต่กรอกแค่ "ยอดคงเหลือสิ้นเดือน" ช่องเดียว
// แสดงมูลค่า/หน่วย และมูลค่ารวมของแต่ละไอเทมให้ดูควบคู่กัน บันทึกลงชีท "ปิดรอบสิ้นเดือน"
export default function MonthEndClosing() {
  const { user } = useAuth();
  const branch = user?.branch;

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [closingDate, setClosingDate] = useState(todayYMD());
  const [qtyMap, setQtyMap] = useState({}); // productId -> ยอดคงเหลือสิ้นเดือนที่กรอก (string)
  const [historyMap, setHistoryMap] = useState({}); // productId -> [{qty, price, amount, recorder, time}]
  const [historyFor, setHistoryFor] = useState(null); // { name, history }

  useEffect(() => {
    if (branch) loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

  useEffect(() => {
    if (branch && closingDate) loadExistingClosing();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch, closingDate]);

  const loadItems = async () => {
    setLoading(true);
    try {
      const res = await apiCall('getStockItems', { branch });
      if (res.status === 'success') {
        setItems(res.data);
      } else {
        toast.error('ไม่สามารถดึงรายการสินค้าได้');
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      setLoading(false);
    }
  };

  // ดึงยอดที่เคยบันทึกไว้ของวันที่นี้มาเติมให้ (แก้ไขต่อได้ ไม่ต้องกรอกใหม่ทั้งหมด) + ประวัติการบันทึกทั้งหมด
  const loadExistingClosing = async () => {
    try {
      const res = await apiCall('getMonthEndClosing', { branch, date: closingDate });
      if (res.status === 'success') {
        const map = {}, hist = {};
        Object.entries(res.data || {}).forEach(([code, v]) => {
          map[code] = String(v.qty ?? '');
          hist[code] = v.history || [];
        });
        setQtyMap(map);
        setHistoryMap(hist);
      }
    } catch (err) { /* ไม่มีข้อมูลเดิมก็ไม่เป็นไร เริ่มกรอกใหม่ */ }
  };

  const handleQtyChange = (productId, val) => {
    setQtyMap(prev => ({ ...prev, [productId]: val }));
  };

  const filteredItems = useMemo(() => {
    const t = searchTerm.trim().toLowerCase();
    if (!t) return items;
    return items.filter(it =>
      String(it.productId).toLowerCase().includes(t) || String(it.name).toLowerCase().includes(t)
    );
  }, [items, searchTerm]);

  const normId = (id) => String(id).replace(/^0+/, '').toLowerCase();

  const totals = useMemo(() => {
    let filled = 0, totalValue = 0;
    items.forEach(it => {
      const q = qtyMap[normId(it.productId)];
      if (q !== undefined && q !== '' && !isNaN(Number(q))) {
        filled++;
        totalValue += Number(q) * (Number(it.price) || 0);
      }
    });
    return { filled, totalValue };
  }, [items, qtyMap]);

  const handleSave = async () => {
    const payload = items
      .filter(it => {
        const q = qtyMap[normId(it.productId)];
        return q !== undefined && q !== '' && !isNaN(Number(q));
      })
      .map(it => ({
        productId: it.productId,
        name: it.name,
        unit: it.unit,
        price: Number(it.price) || 0,
        qty: Number(qtyMap[normId(it.productId)]),
      }));

    if (payload.length === 0) {
      toast.error('กรุณากรอกยอดคงเหลือสิ้นเดือนอย่างน้อย 1 รายการ');
      return;
    }

    setIsSaving(true);
    try {
      const res = await apiCall('saveMonthEndClosing', {
        branch, date: closingDate, recorder: user?.username || 'Unknown', items: payload,
      });
      if (res.status === 'success') {
        toast.success(res.message || 'บันทึกปิดยอดสิ้นเดือนเรียบร้อยแล้ว');
        loadExistingClosing(); // รีเฟรชประวัติ + ยอดล่าสุดหลังบันทึก
      } else {
        toast.error(res.message || 'บันทึกไม่สำเร็จ');
      }
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการบันทึก');
    } finally {
      setIsSaving(false);
    }
  };

  return (
    <div className="max-w-6xl mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 rounded-xl bg-indigo-100 text-indigo-600">
            <CalendarCheck className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">ปิดยอดสิ้นเดือน</h1>
            <p className="text-gray-500 mt-0.5 text-sm">
              กรอกยอดคงเหลือ ณ วันปิดยอด · สาขา: <span className="font-semibold text-indigo-600">{branch}</span>
            </p>
          </div>
        </div>

        <div className="flex items-center gap-3">
          <label className="text-sm font-medium text-gray-700 whitespace-nowrap">วันที่ปิดยอด :</label>
          <input type="date" value={closingDate} onChange={(e) => setClosingDate(e.target.value)}
            className="px-3 py-2 border border-gray-200 rounded-lg text-sm focus:ring-2 focus:ring-indigo-500 outline-none" />
        </div>
      </div>

      <div className="bg-indigo-50 border border-indigo-100 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-indigo-800">
          กรอกแล้ว <span className="font-bold">{totals.filled}</span> รายการ
        </div>
        <div className="text-sm text-indigo-800">
          มูลค่ารวมทั้งหมด <span className="font-bold text-lg">{totals.totalValue.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}</span> บาท
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving || loading || totals.filled === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-indigo-600 text-white rounded-xl font-medium hover:bg-indigo-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-indigo-200"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span className="text-sm">{isSaving ? 'กำลังบันทึก...' : 'บันทึกปิดยอดสิ้นเดือน'}</span>
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input type="text"
              className="block w-full pl-10 pr-3 py-2.5 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-indigo-500 focus:border-indigo-500 text-sm"
              placeholder="ค้นหาด้วยรหัส หรือ ชื่อสินค้า..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
        </div>

        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3 text-indigo-600">
                <Loader2 className="w-8 h-8 animate-spin" />
                <p className="font-medium text-sm">กำลังโหลดข้อมูล...</p>
              </div>
            </div>
          ) : (
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50 sticky top-0 z-10 shadow-sm">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">รหัส</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">หน่วย</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-sky-600 uppercase w-32 bg-sky-50/60">มูลค่า/หน่วย</th>
                  <th className="px-2 py-3 text-center text-xs font-semibold text-indigo-700 uppercase w-40 bg-indigo-50/80">ยอดคงเหลือสิ้นเดือน</th>
                  <th className="px-4 py-3 text-right text-xs font-semibold text-emerald-600 uppercase w-36 bg-emerald-50/60">มูลค่ารวม</th>
                  <th className="px-2 py-3 text-center text-xs font-semibold text-gray-400 uppercase w-14">ประวัติ</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={7} className="px-6 py-12 text-center text-gray-400">
                      <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                      ไม่พบรายการสินค้า
                    </td>
                  </tr>
                ) : filteredItems.map((item) => {
                  const key = normId(item.productId);
                  const qty = qtyMap[key] !== undefined ? qtyMap[key] : '';
                  const unitPrice = Number(item.price) || 0;
                  const rowTotal = qty !== '' && !isNaN(Number(qty)) ? Number(qty) * unitPrice : null;
                  return (
                    <tr key={item.productId} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs font-mono text-gray-600">{item.productId}</td>
                      <td className="px-4 py-2.5 text-sm text-gray-800 font-medium">{item.name}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">{item.unit}</td>
                      <td className="px-4 py-2.5 text-right text-sm text-sky-700 bg-sky-50/30 font-mono">
                        {unitPrice.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 })}
                      </td>
                      <td className="px-2 py-2 text-center bg-indigo-50/40">
                        <input
                          type="number" min="0" step="any" inputMode="decimal"
                          value={qty}
                          onChange={(e) => handleQtyChange(key, e.target.value)}
                          placeholder="0"
                          className="w-full px-2 py-2 border border-indigo-200 rounded-lg text-center text-sm bg-white focus:ring-2 focus:ring-indigo-500 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </td>
                      <td className="px-4 py-2.5 text-right text-sm font-semibold text-emerald-700 bg-emerald-50/30 font-mono">
                        {rowTotal !== null ? rowTotal.toLocaleString('th-TH', { minimumFractionDigits: 2, maximumFractionDigits: 2 }) : '-'}
                      </td>
                      <td className="px-2 py-2.5 text-center">
                        {(historyMap[key]?.length > 0) && (
                          <button
                            onClick={() => setHistoryFor({ name: item.name, history: historyMap[key] })}
                            title={`ดูประวัติการบันทึก (${historyMap[key].length} ครั้ง)`}
                            className="text-gray-300 hover:text-indigo-600 transition-colors relative"
                          >
                            <History className="w-4 h-4" />
                            {historyMap[key].length > 1 && (
                              <span className="absolute -top-1.5 -right-1.5 bg-indigo-600 text-white text-[9px] font-bold rounded-full w-3.5 h-3.5 flex items-center justify-center leading-none">
                                {historyMap[key].length}
                              </span>
                            )}
                          </button>
                        )}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>

      <ClosingHistoryModal
        open={!!historyFor}
        name={historyFor?.name}
        history={historyFor?.history}
        onClose={() => setHistoryFor(null)}
      />
    </div>
  );
}
