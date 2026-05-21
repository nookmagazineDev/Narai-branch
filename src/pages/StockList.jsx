import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Loader2, Save, Search, AlertCircle, PackageSearch } from 'lucide-react';
import toast from 'react-hot-toast';

export default function StockList() {
  const { user } = useAuth();
  const [loading, setLoading] = useState(true);
  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [searchTerm, setSearchTerm] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingCat, setIsEditingCat] = useState(false);
  const [requestDate, setRequestDate] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [counterName, setCounterName] = useState('');

  useEffect(() => {
    loadData();
  }, []);

  const loadData = async () => {
    setLoading(true);
    try {
      const [itemsRes, empRes] = await Promise.all([
        apiCall('getStockItems', { branch: user?.branch }),
        apiCall('getScheduleEmployees', { branch: user?.branch })
      ]);
      
      if (itemsRes.status === 'success') {
        const initializedItems = itemsRes.data.map(item => ({
          ...item,
          remaining: '',
          requested: ''
        }));
        setItems(initializedItems);
      } else {
        toast.error('ไม่สามารถดึงข้อมูลรายการสินค้าได้');
      }

      if (empRes.status === 'success') {
        setEmployees(empRes.data);
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      setLoading(false);
    }
  };

  const handleInputChange = (index, field, value) => {
    const newItems = [...items];
    newItems[index][field] = value;
    setItems(newItems);
  };

  const handleSave = async () => {
    // Filter items that have either remaining or requested values filled
    const itemsToSave = items.filter(
      item => (item.remaining !== '' && item.remaining !== null) || (item.requested !== '' && Number(item.requested) > 0)
    );

    if (itemsToSave.length === 0) {
      toast.error('กรุณากรอกข้อมูลคงเหลือหรือยอดขอเบิกอย่างน้อย 1 รายการ');
      return;
    }

    const hasRemaining = itemsToSave.some(item => item.remaining !== '');
    if (hasRemaining && !counterName) {
      toast.error('กรุณาเลือกชื่อพนักงานนับสต๊อก');
      return;
    }

    const hasRequests = itemsToSave.some(item => item.requested !== '' && Number(item.requested) > 0);
    if (hasRequests) {
      if (!requestDate) {
        toast.error('กรุณาระบุวันที่ต้องการรับสินค้า (สำหรับรายการเบิก)');
        return;
      }
      if (!requesterName) {
        toast.error('กรุณาเลือกชื่อผู้เบิก');
        return;
      }
    }

    setIsSaving(true);
    try {
      // Prepare payload, convert requested to number
      const payloadItems = itemsToSave.map(item => ({
        ...item,
        requested: item.requested ? Number(item.requested) : 0
      }));

      const res = await apiCall('saveStock', {
        branch: user?.branch || 'Unknown',
        username: user?.username || 'Unknown',
        counterName: counterName,
        requestDate: requestDate,
        requesterName: requesterName,
        items: payloadItems
      });

      if (res.status === 'success') {
        toast.success(res.message || 'บันทึกข้อมูลเรียบร้อยแล้ว');
        // Reset inputs after successful save
        setItems(items.map(item => ({ ...item, remaining: '', requested: '' })));
        setRequestDate('');
        setRequesterName('');
        setCounterName('');
        // รีเฟรชข้อมูลอัตโนมัติ
        loadData();
      } else {
        toast.error(res.message || 'เกิดข้อผิดพลาดในการบันทึกข้อมูล');
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      setIsSaving(false);
    }
  };

  const handleEditCategory = async (item) => {
    const newCat = window.prompt(`ระบุหมวดจัดเก็บสำหรับ: ${item.name}`, item.storageCat);
    if (newCat !== null && newCat !== item.storageCat) {
      setIsEditingCat(true);
      try {
        const res = await apiCall('updateStorageCategory', {
          productId: item.productId,
          name: item.name,
          branch: user?.branch || 'Unknown',
          category: newCat
        });
        if (res.status === 'success') {
          toast.success(res.message || 'อัปเดตหมวดจัดเก็บเรียบร้อยแล้ว');
          loadData();
        } else {
          toast.error(res.message || 'เกิดข้อผิดพลาดในการอัปเดตหมวดจัดเก็บ');
        }
      } catch (err) {
        toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
      } finally {
        setIsEditingCat(false);
      }
    }
  };

  const filteredItems = items.filter(item => 
    item.name.toLowerCase().includes(searchTerm.toLowerCase()) ||
    item.productId.toLowerCase().includes(searchTerm.toLowerCase())
  );

  if (loading) {
    return (
      <div className="flex items-center justify-center h-64">
        <div className="flex flex-col items-center gap-3 text-purple-600">
          <Loader2 className="w-8 h-8 animate-spin" />
          <p className="font-medium">กำลังโหลดข้อมูลรายการสินค้า...</p>
        </div>
      </div>
    );
  }

  return (
    <div className="max-w-6xl mx-auto space-y-6">
      {/* Header section */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-6 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className="p-3 bg-purple-100 text-purple-600 rounded-xl">
            <PackageSearch className="w-6 h-6" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">นับสต๊อกและขอเบิกสินค้า</h1>
            <p className="text-gray-500 mt-1">จัดการรายการสินค้า สาขา: <span className="font-semibold text-purple-600">{user?.branch}</span></p>
          </div>
        </div>
        <button
          onClick={handleSave}
          disabled={isSaving}
          className="flex items-center justify-center gap-2 px-6 py-2.5 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700 focus:ring-4 focus:ring-purple-100 transition-all disabled:opacity-50 disabled:cursor-not-allowed shadow-sm shadow-purple-200"
        >
          {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
          <span>{isSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</span>
        </button>
      </div>

      {/* Request Date and Requester Input (Shows only if there's any request) */}
      {items.some(item => item.requested !== '' && Number(item.requested) > 0) && (
        <div className="bg-purple-50 border border-purple-100 p-4 rounded-xl flex flex-col sm:flex-row items-start sm:items-center gap-6 animate-in fade-in slide-in-from-top-4 duration-300">
          <div className="flex items-center gap-3">
            <label className="text-purple-900 font-medium whitespace-nowrap">📅 วันที่ต้องการรับสินค้า <span className="text-red-500">*</span> :</label>
            <input 
              type="date" 
              value={requestDate}
              onChange={(e) => setRequestDate(e.target.value)}
              className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none text-gray-700 bg-white"
            />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-purple-900 font-medium whitespace-nowrap">👤 ชื่อผู้เบิก <span className="text-red-500">*</span> :</label>
            <select
              value={requesterName}
              onChange={(e) => setRequesterName(e.target.value)}
              className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none text-gray-700 bg-white min-w-[200px]"
            >
              <option value="">-- เลือกผู้เบิก --</option>
              {employees.map((emp, idx) => (
                <option key={idx} value={emp.name}>{emp.name}</option>
              ))}
            </select>
          </div>
        </div>
      )}

      {/* Search Bar */}
      <div className="relative">
        <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
          <Search className="h-5 w-5 text-gray-400" />
        </div>
        <input
          type="text"
          className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl leading-5 bg-white placeholder-gray-500 focus:outline-none focus:placeholder-gray-400 focus:ring-1 focus:ring-purple-500 focus:border-purple-500 sm:text-sm transition-colors"
          placeholder="ค้นหาด้วยรหัส หรือ ชื่อสินค้า..."
          value={searchTerm}
          onChange={(e) => setSearchTerm(e.target.value)}
        />
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-purple-100 overflow-hidden mt-6">
        {/* Counter Name Header */}
        <div className="p-4 border-b border-purple-100 bg-purple-50/30 flex items-center gap-3 max-w-md">
          <label className="text-purple-900 font-medium whitespace-nowrap">👤 ชื่อพนักงานนับสต๊อก <span className="text-red-500">*</span> :</label>
          <select
            value={counterName}
            onChange={(e) => setCounterName(e.target.value)}
            className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none text-gray-700 bg-white w-full"
          >
            <option value="">-- เลือกพนักงาน --</option>
            {employees.map((emp, idx) => (
              <option key={idx} value={emp.name}>{emp.name}</option>
            ))}
          </select>
        </div>

        <div className="overflow-x-auto">
          <table className="min-w-full divide-y divide-gray-200">
            <thead className="bg-gray-50/50">
              <tr>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider w-32">
                  รหัสสินค้า
                </th>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider">
                  ชื่อสินค้า
                </th>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider w-32">
                  หมวดจัดเก็บ
                </th>
                <th scope="col" className="px-6 py-4 text-left text-xs font-semibold text-gray-600 uppercase tracking-wider w-24">
                  หน่วย
                </th>
                <th scope="col" className="px-6 py-4 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider w-32 bg-purple-50/50">
                  ยอดยกมา
                </th>
                <th scope="col" className="px-6 py-4 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider w-40">
                  คงเหลือ
                </th>
                <th scope="col" className="px-6 py-4 text-center text-xs font-semibold text-gray-600 uppercase tracking-wider w-40">
                  ขอเบิก
                </th>
              </tr>
            </thead>
            <tbody className="bg-white divide-y divide-gray-200">
              {filteredItems.length === 0 ? (
                <tr>
                  <td colSpan="7" className="px-6 py-12 text-center text-gray-500">
                    <AlertCircle className="w-8 h-8 mx-auto text-gray-400 mb-2" />
                    ไม่พบรายการสินค้าที่ค้นหา
                  </td>
                </tr>
              ) : (
                filteredItems.map((item, index) => {
                  // Find original index to update the correct item in state
                  const originalIndex = items.findIndex(i => i.productId === item.productId);
                  return (
                    <tr key={item.productId || index} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-6 py-4 whitespace-nowrap text-sm font-medium text-gray-900">
                        {item.productId}
                      </td>
                      <td className="px-6 py-4 text-sm text-gray-700">
                        {item.name}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <div className="flex items-center gap-2 group">
                          <span className="text-sm text-gray-600">{item.storageCat || '-'}</span>
                          <button
                            onClick={() => handleEditCategory(item)}
                            disabled={isEditingCat}
                            className="text-gray-400 hover:text-purple-600 opacity-0 group-hover:opacity-100 transition-opacity"
                            title="แก้ไขหมวดจัดเก็บ"
                          >
                            <svg xmlns="http://www.w3.org/2000/svg" className="h-4 w-4" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                              <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                            </svg>
                          </button>
                        </div>
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-sm text-gray-500">
                        {item.unit}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap text-center bg-purple-50/30">
                        <div className="font-semibold text-gray-700">{item.previousBalance !== '' && item.previousBalance !== undefined ? item.previousBalance : '-'}</div>
                        {item.previousBalanceDate && (
                          <div className="text-[10px] text-gray-400 mt-0.5" title={item.previousBalanceDate}>
                            {item.previousBalanceDate.split(' ')[0]}
                          </div>
                        )}
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={item.remaining}
                          onChange={(e) => handleInputChange(originalIndex, 'remaining', e.target.value)}
                          className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all text-center"
                          placeholder="จำนวน"
                        />
                      </td>
                      <td className="px-6 py-4 whitespace-nowrap">
                        <input
                          type="number"
                          min="0"
                          step="any"
                          value={item.requested}
                          onChange={(e) => handleInputChange(originalIndex, 'requested', e.target.value)}
                          className="w-full px-3 py-2 border border-purple-200 bg-purple-50/30 rounded-lg focus:ring-2 focus:ring-purple-500 focus:border-purple-500 outline-none transition-all text-center font-semibold text-purple-700 placeholder:font-normal placeholder:text-gray-400"
                          placeholder="เบิก"
                        />
                      </td>
                    </tr>
                  );
                })
              )}
            </tbody>
          </table>
        </div>
      </div>
    </div>
  );
}
