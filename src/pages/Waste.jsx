import { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Trash2, Search, Loader2, AlertCircle, Save } from 'lucide-react';
import toast from 'react-hot-toast';

// WASTE — บันทึกของเสีย: แสดงรายชื่อไอเทมเหมือนหน้านับสต๊อก กรอกแค่ "จำนวนที่เสีย" ช่องเดียว
// บันทึกลงชีท "waste" แบบเพิ่มแถวใหม่ทุกครั้ง (log ต่อเนื่อง ไม่ใช่ยอดสรุปรายวัน) แล้วเคลียร์ฟอร์มให้กรอกรอบใหม่ได้ทันที
export default function Waste() {
  const { user } = useAuth();
  const branch = user?.branch;

  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(false);
  const [isSaving, setIsSaving] = useState(false);
  const [searchTerm, setSearchTerm] = useState('');
  const [qtyMap, setQtyMap] = useState({}); // productId -> จำนวนที่เสียที่กรอก (string)

  useEffect(() => {
    if (branch) loadItems();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

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

  const filledCount = useMemo(() => {
    return items.filter(it => {
      const q = qtyMap[normId(it.productId)];
      return q !== undefined && q !== '' && !isNaN(Number(q)) && Number(q) > 0;
    }).length;
  }, [items, qtyMap]);

  const handleSave = async () => {
    const payload = items
      .filter(it => {
        const q = qtyMap[normId(it.productId)];
        return q !== undefined && q !== '' && !isNaN(Number(q)) && Number(q) > 0;
      })
      .map(it => ({
        productId: it.productId,
        name: it.name,
        unit: it.unit,
        qty: Number(qtyMap[normId(it.productId)]),
      }));

    if (payload.length === 0) {
      toast.error('กรุณากรอกจำนวนที่เสียอย่างน้อย 1 รายการ');
      return;
    }

    setIsSaving(true);
    try {
      const res = await apiCall('saveWaste', {
        branch, recorder: user?.username || 'Unknown', items: payload,
      });
      if (res.status === 'success') {
        toast.success(res.message || 'บันทึกของเสียเรียบร้อยแล้ว');
        setQtyMap({}); // เคลียร์ฟอร์ม พร้อมกรอกรอบใหม่ (บันทึกแบบ log ต่อเนื่อง ไม่ใช่ยอดที่ต้องแก้ไขซ้ำ)
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
          <div className="p-3 rounded-xl bg-rose-100 text-rose-600">
            <Trash2 className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">WASTE</h1>
            <p className="text-gray-500 mt-0.5 text-sm">
              บันทึกจำนวนสินค้าที่เสีย/ทิ้ง · สาขา: <span className="font-semibold text-rose-600">{branch}</span>
            </p>
          </div>
        </div>
      </div>

      <div className="bg-rose-50 border border-rose-100 rounded-2xl p-4 flex flex-wrap items-center justify-between gap-3">
        <div className="text-sm text-rose-800">
          กรอกแล้ว <span className="font-bold">{filledCount}</span> รายการ
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving || loading || filledCount === 0}
          className="flex items-center gap-2 px-5 py-2.5 bg-rose-600 text-white rounded-xl font-medium hover:bg-rose-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-rose-200"
        >
          {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
          <span className="text-sm">{isSaving ? 'กำลังบันทึก...' : 'บันทึกของเสีย'}</span>
        </button>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
        <div className="p-4 border-b border-gray-100">
          <div className="relative max-w-md">
            <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
              <Search className="h-5 w-5 text-gray-400" />
            </div>
            <input type="text"
              className="block w-full pl-10 pr-3 py-2.5 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-rose-500 focus:border-rose-500 text-sm"
              placeholder="ค้นหาด้วยรหัส หรือ ชื่อสินค้า..."
              value={searchTerm}
              onChange={(e) => setSearchTerm(e.target.value)} />
          </div>
        </div>

        <div className="overflow-x-auto max-h-[70vh] overflow-y-auto">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3 text-rose-600">
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
                  <th className="px-2 py-3 text-center text-xs font-semibold text-rose-700 uppercase w-40 bg-rose-50/80">จำนวนที่เสีย</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={4} className="px-6 py-12 text-center text-gray-400">
                      <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                      ไม่พบรายการสินค้า
                    </td>
                  </tr>
                ) : filteredItems.map((item) => {
                  const key = normId(item.productId);
                  const qty = qtyMap[key] !== undefined ? qtyMap[key] : '';
                  return (
                    <tr key={item.productId} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs font-mono text-gray-600">{item.productId}</td>
                      <td className="px-4 py-2.5 text-sm text-gray-800 font-medium">{item.name}</td>
                      <td className="px-4 py-2.5 whitespace-nowrap text-xs text-gray-500">{item.unit}</td>
                      <td className="px-2 py-2 text-center bg-rose-50/40">
                        <input
                          type="number" min="0" step="any" inputMode="decimal"
                          value={qty}
                          onChange={(e) => handleQtyChange(key, e.target.value)}
                          placeholder="0"
                          className="w-full px-2 py-2 border border-rose-200 rounded-lg text-center text-sm bg-white focus:ring-2 focus:ring-rose-500 outline-none [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none"
                        />
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          )}
        </div>
      </div>
    </div>
  );
}
