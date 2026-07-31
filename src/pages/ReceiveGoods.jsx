import { useState, useEffect, useMemo, Fragment } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { PackageCheck, Loader2, AlertCircle, AlertTriangle, Save, ChevronLeft, CheckCircle2, Pencil, Camera, X } from 'lucide-react';
import toast from 'react-hot-toast';

// อ่านไฟล์รูปแล้วย่อขนาด/บีบอัดก่อนแปลงเป็น base64 (กันไฟล์รูปจากมือถือใหญ่เกินไปตอนส่งขึ้น Apps Script)
const readAndCompressImage = (file) => new Promise((resolve, reject) => {
  const reader = new FileReader();
  reader.onload = (e) => {
    const img = new Image();
    img.onload = () => {
      const maxDim = 1280;
      let { width, height } = img;
      if (width > maxDim || height > maxDim) {
        const scale = maxDim / Math.max(width, height);
        width = Math.round(width * scale);
        height = Math.round(height * scale);
      }
      const canvas = document.createElement('canvas');
      canvas.width = width;
      canvas.height = height;
      canvas.getContext('2d').drawImage(img, 0, 0, width, height);
      resolve({ base64: canvas.toDataURL('image/jpeg', 0.75), mimeType: 'image/jpeg' });
    };
    img.onerror = () => reject(new Error('อ่านรูปภาพไม่สำเร็จ'));
    img.src = e.target.result;
  };
  reader.onerror = () => reject(new Error('อ่านไฟล์ไม่สำเร็จ'));
  reader.readAsDataURL(file);
});

// รับสินค้า — ดึงรายการที่โกดัง "จัดของ" ส่งมาแล้ว (ชีท จัดของ) จัดกลุ่มตามเลขที่ใบเบิก
// กดเข้าไปดูรายการสินค้าในใบนั้น เทียบ "จำนวนส่ง" กับที่รับจริง — ไม่แก้ไขถือว่า "ยืนยัน" ตรงกัน
// แก้ไขจำนวนถือว่า "แก้ไข" (มีส่วนต่าง) บันทึกทีเดียวทั้งใบลงชีท รับของ
export default function ReceiveGoods() {
  const { user } = useAuth();
  const branch = user?.branch;

  const [orders, setOrders] = useState([]);
  const [loading, setLoading] = useState(false);
  const [selectedOrder, setSelectedOrder] = useState(null); // { orderNo, date, items, received }
  const [qtyMap, setQtyMap] = useState({}); // index -> จำนวนที่รับจริงที่กรอก (string)
  const [noteMap, setNoteMap] = useState({}); // index -> หมายเหตุ (บังคับกรอกถ้าแก้ไขจำนวน)
  const [photoMap, setPhotoMap] = useState({}); // index -> { base64, mimeType, fileName } (บังคับแนบถ้าแก้ไขจำนวน)
  const [isSaving, setIsSaving] = useState(false);
  const [confirmingIdx, setConfirmingIdx] = useState(null); // index ที่กำลังกด "ยืนยันแก้ไข" อยู่
  const [justConfirmed, setJustConfirmed] = useState({}); // index -> true เมื่อกด "ยืนยันแก้ไข" สำเร็จในรอบนี้

  useEffect(() => {
    if (branch) loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [branch]);

  const loadOrders = async () => {
    setLoading(true);
    try {
      const res = await apiCall('getGoodsToReceive', { branch });
      if (res.status === 'success') {
        setOrders(res.data || []);
      } else {
        toast.error('ไม่สามารถดึงรายการรับสินค้าได้');
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      setLoading(false);
    }
  };

  const openOrder = (order) => {
    setSelectedOrder(order);
    const initial = {};
    (order.items || []).forEach((it, idx) => { initial[idx] = String(it.qtySent ?? ''); });
    setQtyMap(initial);
  };

  const closeOrder = () => {
    setSelectedOrder(null);
    setQtyMap({});
    setNoteMap({});
    setPhotoMap({});
    setJustConfirmed({});
  };

  const rowStatus = (item, idx) => {
    const val = qtyMap[idx];
    const sent = Number(item.qtySent) || 0;
    const cur = val === '' || val === undefined ? 0 : Number(val);
    return cur === sent ? 'ยืนยัน' : 'แก้ไข';
  };

  // โกดัง "จัดของ" ส่งจำนวนไม่ตรงกับที่สาขาเบิก (storeStatus = แก้ไข ในชีทจัดของ) —
  // ต้องให้สาขากดยืนยันรับทราบทีละรายการ แยกจากการกรอกจำนวนรับจริงของสาขาเอง (rowStatus ด้านบน)
  const isWarehouseEdited = (item) => item.storeStatus === 'แก้ไข';
  const needsAck = (item, idx) => isWarehouseEdited(item) && !item.alreadyReceived && !justConfirmed[idx];
  const orderHasUnresolvedEdit = (order) =>
    (order.items || []).some((it) => isWarehouseEdited(it) && !it.alreadyReceived);

  const handlePhotoChange = async (idx, file) => {
    if (!file) return;
    try {
      const { base64, mimeType } = await readAndCompressImage(file);
      setPhotoMap(prev => ({ ...prev, [idx]: { base64, mimeType, fileName: file.name } }));
    } catch (err) {
      toast.error(err.message || 'อ่านไฟล์รูปภาพไม่สำเร็จ');
    }
  };

  // สาขากด "ยืนยันแก้ไข" ทีละรายการ — ยอมรับจำนวนที่โกดังส่งมาจริง (qtySent) โดยไม่ต้องกรอกจำนวนรับเอง
  // บันทึกลงชีท รับของ ทันที (1 แถว) ด้วยสถานะ "ยืนยัน" แทนที่จะปล่อยค้างเป็น "แก้ไข"
  const handleConfirmEdit = async (idx, item) => {
    setConfirmingIdx(idx);
    try {
      await apiCall('confirmReceivedItem', {
        branch, orderNo: selectedOrder.orderNo, code: item.code, name: item.name,
        qtyRequested: item.qtyRequested, qtySent: item.qtySent,
        recorder: user?.username || 'Unknown',
      });
      setJustConfirmed(prev => ({ ...prev, [idx]: true }));
      toast.success(`ยืนยันรับ "${item.name}" เรียบร้อยแล้ว`);
    } catch (err) {
      toast.error(err.message || 'ยืนยันไม่สำเร็จ');
    } finally {
      setConfirmingIdx(null);
    }
  };

  const editedCount = useMemo(() => {
    if (!selectedOrder) return 0;
    return (selectedOrder.items || []).filter((it, idx) => rowStatus(it, idx) === 'แก้ไข').length;
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selectedOrder, qtyMap]);

  const handleSave = async () => {
    if (!selectedOrder) return;

    // รายการที่ยืนยันแก้ไขไปแล้วทีละรายการ (หรือเคยบันทึกไว้ก่อนหน้านี้) ไม่ต้องส่งซ้ำในการบันทึกรวมนี้
    const isHandled = (idx) => selectedOrder.items[idx].alreadyReceived || justConfirmed[idx];

    // รายการที่แก้ไขจำนวน (ไม่ตรงกับที่ส่งมา) บังคับต้องมีหมายเหตุ + รูปภาพแนบเสมอ
    const missing = [];
    selectedOrder.items.forEach((it, idx) => {
      if (isHandled(idx)) return;
      if (rowStatus(it, idx) !== 'แก้ไข') return;
      if (!String(noteMap[idx] || '').trim()) missing.push(`${it.name} — ยังไม่ได้ใส่หมายเหตุ`);
      if (!photoMap[idx]) missing.push(`${it.name} — ยังไม่ได้แนบรูปภาพ`);
    });
    if (missing.length) {
      toast.error(`กรุณากรอกให้ครบก่อนบันทึก:\n${missing.slice(0, 5).join('\n')}`, { duration: 6000 });
      return;
    }

    const payloadItems = selectedOrder.items
      .map((it, idx) => {
        if (isHandled(idx)) return null;
        const val = qtyMap[idx];
        const qtyReceived = val === '' || val === undefined ? 0 : Number(val);
        const status = rowStatus(it, idx);
        const photo = photoMap[idx];
        return {
          code: it.code, name: it.name,
          qtyRequested: it.qtyRequested, qtySent: it.qtySent,
          qtyReceived, status,
          note: status === 'แก้ไข' ? (noteMap[idx] || '') : '',
          photoBase64: status === 'แก้ไข' && photo ? photo.base64 : '',
          photoMimeType: status === 'แก้ไข' && photo ? photo.mimeType : '',
        };
      })
      .filter(Boolean);

    if (payloadItems.length === 0) {
      toast.error('ทุกรายการยืนยันรับไปแล้ว ไม่มีอะไรต้องบันทึกเพิ่ม');
      return;
    }

    setIsSaving(true);
    try {
      const res = await apiCall('saveGoodsReceived', {
        branch, orderNo: selectedOrder.orderNo, recorder: user?.username || 'Unknown', items: payloadItems,
      });
      if (res.status === 'success') {
        toast.success(res.message || 'บันทึกรับของเรียบร้อยแล้ว');
        closeOrder();
        loadOrders();
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
    <div className="max-w-5xl mx-auto space-y-5">
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex items-center gap-4">
        <div className="p-3 rounded-xl bg-teal-100 text-teal-600">
          <PackageCheck className="w-6 h-6" />
        </div>
        <div>
          <h1 className="text-2xl font-bold text-gray-800">รับสินค้า</h1>
          <p className="text-gray-500 mt-0.5 text-sm">
            ยืนยัน/แก้ไขจำนวนที่รับจริง เทียบกับที่โกดังจัดส่งมา · สาขา: <span className="font-semibold text-teal-600">{branch}</span>
          </p>
        </div>
      </div>

      {!selectedOrder ? (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          {loading ? (
            <div className="flex items-center justify-center py-16">
              <div className="flex flex-col items-center gap-3 text-teal-600">
                <Loader2 className="w-8 h-8 animate-spin" />
                <p className="font-medium text-sm">กำลังโหลดข้อมูล...</p>
              </div>
            </div>
          ) : orders.length === 0 ? (
            <div className="text-center py-16 text-gray-400">
              <AlertCircle className="w-10 h-10 mx-auto mb-3 opacity-40" />
              <p>ยังไม่มีรายการที่โกดังจัดของส่งมาให้รับ</p>
            </div>
          ) : (
            <table className="w-full text-sm border-collapse">
              <thead className="bg-teal-50 border-b">
                <tr>
                  <th className="px-4 py-3 text-left text-teal-800 font-semibold">เลขที่ใบเบิก</th>
                  <th className="px-4 py-3 text-left text-teal-800 font-semibold">วันที่จัดของ</th>
                  <th className="px-4 py-3 text-right text-teal-800 font-semibold">จำนวนรายการ</th>
                  <th className="px-4 py-3 text-center text-teal-800 font-semibold">สถานะ</th>
                </tr>
              </thead>
              <tbody className="divide-y">
                {orders.map((order) => (
                  <tr key={order.orderNo} className="hover:bg-teal-50/50 cursor-pointer transition-colors" onClick={() => openOrder(order)}>
                    <td className="px-4 py-3 font-mono font-semibold text-teal-700">
                      <span className="inline-flex items-center gap-1.5">
                        {order.orderNo}
                        {orderHasUnresolvedEdit(order) && (
                          <AlertTriangle className="w-4 h-4 text-amber-500" title="โกดังแก้ไขจำนวนบางรายการ — ต้องยืนยัน" />
                        )}
                      </span>
                    </td>
                    <td className="px-4 py-3 text-gray-600">{order.date}</td>
                    <td className="px-4 py-3 text-right text-gray-600">{(order.items || []).length} รายการ</td>
                    <td className="px-4 py-3 text-center">
                      {order.received ? (
                        <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                          <CheckCircle2 className="w-3 h-3" /> รับของแล้ว
                        </span>
                      ) : (
                        <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">รอยืนยันรับของ</span>
                      )}
                    </td>
                  </tr>
                ))}
              </tbody>
            </table>
          )}
        </div>
      ) : (
        <div className="bg-white rounded-2xl shadow-sm border border-gray-100 overflow-hidden">
          <div className="px-5 py-4 border-b border-gray-100 flex items-center justify-between bg-teal-50/50">
            <div className="flex items-center gap-3">
              <button onClick={closeOrder} className="p-1.5 rounded-lg text-teal-700 hover:bg-teal-100 transition-colors">
                <ChevronLeft className="w-5 h-5" />
              </button>
              <div>
                <h2 className="font-bold text-teal-800">ใบเบิกเลขที่ {selectedOrder.orderNo}</h2>
                <p className="text-xs text-gray-500 mt-0.5">
                  วันที่จัดของ {selectedOrder.date} · {selectedOrder.items.length} รายการ
                  {editedCount > 0 && <span className="text-amber-600 font-medium"> · แก้ไข {editedCount} รายการ</span>}
                </p>
              </div>
            </div>
            {selectedOrder.received && (
              <span className="text-xs font-medium text-emerald-600">เคยบันทึกรับของใบนี้ไว้แล้ว — บันทึกซ้ำจะเพิ่มประวัติใหม่</span>
            )}
          </div>

          <div className="overflow-x-auto max-h-[60vh] overflow-y-auto">
            <table className="min-w-full text-sm border-collapse">
              <thead className="bg-gray-50 sticky top-0 z-10">
                <tr>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase">รหัส</th>
                  <th className="px-4 py-2.5 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-gray-500 uppercase">จำนวนเบิก</th>
                  <th className="px-4 py-2.5 text-right text-xs font-semibold text-sky-600 uppercase bg-sky-50/60">จำนวนส่ง</th>
                  <th className="px-2 py-2.5 text-center text-xs font-semibold text-teal-700 uppercase bg-teal-50/80 w-36">จำนวนที่รับจริง</th>
                  <th className="px-4 py-2.5 text-center text-xs font-semibold text-gray-500 uppercase">สถานะ</th>
                </tr>
              </thead>
              <tbody className="divide-y divide-gray-100">
                {selectedOrder.items.map((it, idx) => {
                  const status = rowStatus(it, idx);
                  const isEdited = status === 'แก้ไข';
                  const photo = photoMap[idx];
                  const handled = it.alreadyReceived || justConfirmed[idx];
                  const showAckBanner = needsAck(it, idx);
                  return (
                    <Fragment key={idx}>
                      <tr className={`hover:bg-gray-50/50 transition-colors ${isEdited ? 'bg-amber-50/40' : ''} ${handled ? 'opacity-60' : ''}`}>
                        <td className="px-4 py-2.5 whitespace-nowrap text-xs font-mono text-gray-600">
                          <span className="inline-flex items-center gap-1.5">
                            {it.code}
                            {showAckBanner && <AlertTriangle className="w-3.5 h-3.5 text-amber-500" title="โกดังแก้ไขจำนวน รอยืนยัน" />}
                          </span>
                        </td>
                        <td className="px-4 py-2.5 text-sm text-gray-800 font-medium">{it.name}</td>
                        <td className="px-4 py-2.5 text-right text-sm text-gray-500">{it.qtyRequested}</td>
                        <td className="px-4 py-2.5 text-right text-sm text-sky-700 bg-sky-50/30 font-mono">{it.qtySent}</td>
                        <td className="px-2 py-2 bg-teal-50/30">
                          <input
                            type="number" min="0" step="any" inputMode="decimal"
                            value={qtyMap[idx] !== undefined ? qtyMap[idx] : ''}
                            onChange={(e) => setQtyMap(prev => ({ ...prev, [idx]: e.target.value }))}
                            disabled={handled}
                            className={`w-full px-2 py-1.5 border rounded-lg text-center text-sm bg-white focus:ring-2 outline-none disabled:bg-gray-100 disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-outer-spin-button]:appearance-none [&::-webkit-inner-spin-button]:appearance-none ${
                              isEdited ? 'border-amber-300 focus:ring-amber-500' : 'border-teal-200 focus:ring-teal-500'
                            }`}
                          />
                        </td>
                        <td className="px-4 py-2.5 text-center">
                          {handled ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                              <CheckCircle2 className="w-3 h-3" /> ยืนยันรับแล้ว
                            </span>
                          ) : isEdited ? (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">
                              <Pencil className="w-3 h-3" /> แก้ไข
                            </span>
                          ) : (
                            <span className="inline-flex items-center gap-1 px-2 py-0.5 rounded-full text-xs font-medium bg-emerald-100 text-emerald-700">
                              <CheckCircle2 className="w-3 h-3" /> ยืนยัน
                            </span>
                          )}
                        </td>
                      </tr>
                      {showAckBanner && (
                        <tr className="bg-amber-50/60">
                          <td colSpan={6} className="px-4 pb-3 pt-0">
                            <div className="flex flex-col sm:flex-row sm:items-center gap-2 sm:gap-3 bg-white border border-amber-300 rounded-xl p-3">
                              <AlertTriangle className="w-5 h-5 text-amber-500 shrink-0" />
                              <p className="flex-1 text-xs text-amber-800">
                                โกดังจัดของแก้ไขจำนวนสินค้านี้จากที่เบิก (เบิก <strong>{it.qtyRequested}</strong> ส่งจริง <strong>{it.qtySent}</strong>)
                                — กดยืนยันเพื่อรับทราบและรับตามจำนวนที่ส่งมา
                              </p>
                              <button
                                onClick={() => handleConfirmEdit(idx, it)}
                                disabled={confirmingIdx === idx}
                                className="shrink-0 flex items-center justify-center gap-1.5 px-4 py-2 rounded-lg text-xs font-semibold bg-amber-500 text-white hover:bg-amber-600 disabled:opacity-50"
                              >
                                {confirmingIdx === idx ? <Loader2 className="w-3.5 h-3.5 animate-spin" /> : <CheckCircle2 className="w-3.5 h-3.5" />}
                                ยืนยันแก้ไข
                              </button>
                            </div>
                          </td>
                        </tr>
                      )}
                      {isEdited && !handled && (
                        <tr className="bg-amber-50/40">
                          <td colSpan={6} className="px-4 pb-3 pt-0">
                            <div className="flex flex-col sm:flex-row gap-3 bg-white border border-amber-200 rounded-xl p-3">
                              <div className="flex-1 min-w-0">
                                <label className="block text-xs font-medium text-amber-800 mb-1">
                                  หมายเหตุ <span className="text-red-500">*</span> (บังคับกรอกเมื่อแก้ไขจำนวน)
                                </label>
                                <textarea
                                  rows={2}
                                  value={noteMap[idx] || ''}
                                  onChange={(e) => setNoteMap(prev => ({ ...prev, [idx]: e.target.value }))}
                                  placeholder="เช่น ของขาด/ของเกิน/ของเสียหาย ระบุสาเหตุ..."
                                  className="w-full px-3 py-2 border border-amber-200 rounded-lg text-sm focus:ring-2 focus:ring-amber-500 outline-none resize-none"
                                />
                              </div>
                              <div className="sm:w-52 shrink-0">
                                <label className="block text-xs font-medium text-amber-800 mb-1">
                                  รูปภาพ <span className="text-red-500">*</span> (บังคับแนบเมื่อแก้ไขจำนวน)
                                </label>
                                {photo ? (
                                  <div className="relative">
                                    <img src={photo.base64} alt={photo.fileName} className="w-full h-24 object-cover rounded-lg border border-amber-200" />
                                    <button
                                      type="button"
                                      onClick={() => setPhotoMap(prev => { const n = { ...prev }; delete n[idx]; return n; })}
                                      className="absolute -top-2 -right-2 bg-white border border-gray-200 rounded-full p-1 text-gray-500 hover:text-red-600 shadow-sm"
                                    >
                                      <X className="w-3.5 h-3.5" />
                                    </button>
                                  </div>
                                ) : (
                                  <label className="flex flex-col items-center justify-center gap-1 h-24 border-2 border-dashed border-amber-300 rounded-lg cursor-pointer hover:bg-amber-50 transition-colors text-amber-500">
                                    <Camera className="w-5 h-5" />
                                    <span className="text-[11px]">แนบรูปภาพ</span>
                                    <input
                                      type="file" accept="image/*" capture="environment" className="hidden"
                                      onChange={(e) => handlePhotoChange(idx, e.target.files?.[0])}
                                    />
                                  </label>
                                )}
                              </div>
                            </div>
                          </td>
                        </tr>
                      )}
                    </Fragment>
                  );
                })}
              </tbody>
            </table>
          </div>

          <div className="px-5 py-3 border-t border-gray-100 flex justify-end gap-2">
            <button onClick={closeOrder} disabled={isSaving}
              className="px-4 py-2 rounded-xl text-sm font-medium bg-white border border-gray-200 text-gray-600 hover:bg-gray-50 disabled:opacity-50">
              ย้อนกลับ
            </button>
            <button onClick={handleSave} disabled={isSaving}
              className="flex items-center gap-2 px-5 py-2 rounded-xl text-sm font-semibold bg-teal-600 text-white hover:bg-teal-700 disabled:opacity-50">
              {isSaving ? <Loader2 className="w-4 h-4 animate-spin" /> : <Save className="w-4 h-4" />}
              {isSaving ? 'กำลังบันทึก...' : 'บันทึกรับของ'}
            </button>
          </div>
        </div>
      )}
    </div>
  );
}
