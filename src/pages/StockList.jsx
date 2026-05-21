import React, { useState, useEffect } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Loader2, Save, Search, AlertCircle, PackageSearch, Eye } from 'lucide-react';
import toast from 'react-hot-toast';

export default function StockList() {
  const { user } = useAuth();
  const isAll = user?.branch?.toLowerCase() === 'all';

  const [loading, setLoading] = useState(false);
  const [items, setItems] = useState([]);
  const [employees, setEmployees] = useState([]);
  const [branches, setBranches] = useState([]);
  const [selectedBranch, setSelectedBranch] = useState('');
  const [searchTerm, setSearchTerm] = useState('');
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingCat, setIsEditingCat] = useState(false);
  const [requestDate, setRequestDate] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [counterName, setCounterName] = useState('');
  
  const [usageStartDate, setUsageStartDate] = useState('');
  const [usageEndDate, setUsageEndDate] = useState('');
  const [isFetchingUsage, setIsFetchingUsage] = useState(false);

  // Effective branch used for data loading
  const effectiveBranch = isAll ? selectedBranch : user?.branch;

  useEffect(() => {
    if (isAll) {
      // Load branch list for the dropdown selector
      apiCall('getBranches', {}).then(res => {
        if (res.status === 'success') setBranches(res.data);
      });
    } else {
      loadData(user?.branch);
    }
  }, []);

  const loadData = async (branch) => {
    if (!branch) return;
    setLoading(true);
    setItems([]);
    try {
      const [itemsRes, empRes] = await Promise.all([
        apiCall('getStockItems', { branch }),
        apiCall('getScheduleEmployees', { branch })
      ]);

      if (itemsRes.status === 'success') {
        setItems(itemsRes.data.map(item => ({ ...item, remaining: '', requested: '' })));
      } else {
        toast.error('ไม่สามารถดึงข้อมูลรายการสินค้าได้');
      }
      if (empRes.status === 'success') setEmployees(empRes.data);
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการเชื่อมต่อเซิร์ฟเวอร์');
    } finally {
      setLoading(false);
    }
  };

  const fetchUsageData = async () => {
    if (!effectiveBranch || !usageStartDate || !usageEndDate) {
      toast.error('กรุณาเลือกสาขา และระบุช่วงวันที่ให้ครบถ้วน');
      return;
    }
    // Find the outletId for the effective branch
    let currentOutletId = '';
    if (isAll) {
       const foundBranch = branches.find(b => b.name === effectiveBranch);
       if (foundBranch) currentOutletId = foundBranch.outletId;
    } else {
       currentOutletId = user?.outletId || '';
    }

    setIsFetchingUsage(true);
    try {
      // Use Vercel Serverless Function proxy
      const response = await fetch(`/api/usage?branch=${encodeURIComponent(effectiveBranch)}&outletId=${encodeURIComponent(currentOutletId)}&startDate=${encodeURIComponent(usageStartDate)}&endDate=${encodeURIComponent(usageEndDate)}`);
      const res = await response.json();
      
      if (res.status === 'success') {
        const usageMap = res.data;
        setItems(prevItems => prevItems.map(item => {
          const normId = String(item.productId).replace(/^0+/, '').toLowerCase();
          return {
            ...item,
            apiUsage: usageMap[normId] || 0
          };
        }));
        toast.success('ดึงข้อมูลยอดใช้สำเร็จ');
      } else {
        toast.error(res.message || 'เกิดข้อผิดพลาดในการดึงข้อมูล');
      }
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ API');
    } finally {
      setIsFetchingUsage(false);
    }
  };

  const handleBranchChange = (branch) => {
    setSelectedBranch(branch);
    setItems([]);
    setSearchTerm('');
    if (branch) loadData(branch);
  };

  const handleInputChange = (index, field, value) => {
    const newItems = [...items];
    newItems[index][field] = value;
    setItems(newItems);
  };

  const handleSave = async () => {
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
      if (!requestDate) { toast.error('กรุณาระบุวันที่ต้องการรับสินค้า'); return; }
      if (!requesterName) { toast.error('กรุณาเลือกชื่อผู้เบิก'); return; }
    }

    setIsSaving(true);
    try {
      const payloadItems = itemsToSave.map(item => ({ ...item, requested: item.requested ? Number(item.requested) : 0 }));
      const res = await apiCall('saveStock', {
        branch: effectiveBranch || 'Unknown',
        username: user?.username || 'Unknown',
        counterName,
        requestDate,
        requesterName,
        items: payloadItems
      });
      if (res.status === 'success') {
        toast.success(res.message || 'บันทึกข้อมูลเรียบร้อยแล้ว');
        setItems(items.map(item => ({ ...item, remaining: '', requested: '' })));
        setRequestDate('');
        setRequesterName('');
        setCounterName('');
        loadData(effectiveBranch);
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
          branch: effectiveBranch || 'Unknown',
          category: newCat
        });
        if (res.status === 'success') {
          toast.success(res.message || 'อัปเดตหมวดจัดเก็บเรียบร้อยแล้ว');
          loadData(effectiveBranch);
        } else {
          toast.error(res.message || 'เกิดข้อผิดพลาด');
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
    String(item.productId).toLowerCase().includes(searchTerm.toLowerCase())
  );

  // ---- Render ----
  const branchLabel = effectiveBranch || (isAll ? 'ยังไม่ได้เลือกสาขา' : user?.branch);

  return (
    <div className="max-w-7xl mx-auto space-y-5">

      {/* Header */}
      <div className="bg-white rounded-2xl shadow-sm border border-gray-100 p-5 flex flex-col md:flex-row md:items-center justify-between gap-4">
        <div className="flex items-center gap-4">
          <div className={`p-3 rounded-xl ${isAll ? 'bg-blue-100 text-blue-600' : 'bg-purple-100 text-purple-600'}`}>
            {isAll ? <Eye className="w-6 h-6" /> : <PackageSearch className="w-6 h-6" />}
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-800">
              {isAll ? 'ภาพรวมสต๊อกสินค้า' : 'นับสต๊อกและขอเบิกสินค้า'}
            </h1>
            <p className="text-gray-500 mt-0.5 text-sm">
              {isAll ? 'ดูข้อมูลแบบอ่านอย่างเดียว' : 'จัดการรายการสินค้า'} · สาขา:{' '}
              <span className={`font-semibold ${isAll ? 'text-blue-600' : 'text-purple-600'}`}>{branchLabel}</span>
            </p>
          </div>
        </div>

        {/* Save button — hidden for 'all' */}
        {!isAll && (
          <button
            onClick={handleSave}
            disabled={isSaving || !effectiveBranch}
            className="flex items-center justify-center gap-2 px-6 py-2.5 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-purple-200"
          >
            {isSaving ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
            <span>{isSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</span>
          </button>
        )}
      </div>

      {/* Branch selector for 'all' users */}
      {isAll && (
        <div className="bg-blue-50 border border-blue-100 rounded-2xl p-4 flex items-center gap-4">
          <label className="text-blue-900 font-medium whitespace-nowrap text-sm">🏪 เลือกสาขา :</label>
          <select
            value={selectedBranch}
            onChange={(e) => handleBranchChange(e.target.value)}
            className="px-4 py-2 border border-blue-200 rounded-xl focus:ring-2 focus:ring-blue-400 outline-none text-gray-700 bg-white min-w-[180px]"
          >
            <option value="">-- เลือกสาขา --</option>
            {branches.map((br, idx) => (
              <option key={idx} value={br.name}>{br.name}</option>
            ))}
          </select>
          {selectedBranch && (
            <span className="ml-auto text-xs text-blue-500 bg-blue-100 px-3 py-1 rounded-full">
              👁 โหมดดูอย่างเดียว
            </span>
          )}
        </div>
      )}

      {/* Requester fields — show only when requests exist and not 'all' */}
      {!isAll && items.some(item => item.requested !== '' && Number(item.requested) > 0) && (
        <div className="bg-purple-50 border border-purple-100 p-4 rounded-xl flex flex-col sm:flex-row items-start sm:items-center gap-6">
          <div className="flex items-center gap-3">
            <label className="text-purple-900 font-medium whitespace-nowrap text-sm">📅 วันที่ต้องการรับสินค้า <span className="text-red-500">*</span> :</label>
            <input type="date" value={requestDate} onChange={(e) => setRequestDate(e.target.value)}
              className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-gray-700 bg-white" />
          </div>
          <div className="flex items-center gap-3">
            <label className="text-purple-900 font-medium whitespace-nowrap text-sm">👤 ชื่อผู้เบิก <span className="text-red-500">*</span> :</label>
            <select value={requesterName} onChange={(e) => setRequesterName(e.target.value)}
              className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-gray-700 bg-white min-w-[200px]">
              <option value="">-- เลือกผู้เบิก --</option>
              {employees.map((emp, idx) => <option key={idx} value={emp.name}>{emp.name}</option>)}
            </select>
          </div>
        </div>
      )}

      {/* Only show table section if branch selected (for 'all') or always for branch users */}
      {(!isAll || selectedBranch) && (
        <>
          {/* Search */}
          <div className="flex flex-col md:flex-row gap-4 mb-4">
            <div className="relative flex-1">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Search className="h-5 w-5 text-gray-400" />
              </div>
              <input type="text"
                className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-purple-500 focus:border-purple-500 sm:text-sm"
                placeholder="ค้นหาด้วยรหัส หรือ ชื่อสินค้า..."
                value={searchTerm}
                onChange={(e) => setSearchTerm(e.target.value)} />
            </div>
            
            {/* Usage API Date Picker */}
            <div className="flex items-center gap-2 bg-emerald-50 border border-emerald-100 p-2 rounded-xl">
              <span className="text-sm font-medium text-emerald-800 ml-2 whitespace-nowrap">ยอดใช้ :</span>
              <input type="date" value={usageStartDate} onChange={(e) => setUsageStartDate(e.target.value)}
                className="px-2 py-1.5 border border-emerald-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              <span className="text-emerald-800 text-sm">-</span>
              <input type="date" value={usageEndDate} onChange={(e) => setUsageEndDate(e.target.value)}
                className="px-2 py-1.5 border border-emerald-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              <button 
                onClick={fetchUsageData}
                disabled={isFetchingUsage || !effectiveBranch || !usageStartDate || !usageEndDate}
                className="px-4 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 transition-colors">
                {isFetchingUsage ? <Loader2 className="w-4 h-4 animate-spin" /> : 'ดึงข้อมูล'}
              </button>
            </div>
          </div>

          <div className="bg-white rounded-2xl shadow-sm border border-purple-100 overflow-hidden">
            {/* Counter name row — hidden for 'all' */}
            {!isAll && (
              <div className="p-4 border-b border-purple-100 bg-purple-50/30 flex items-center gap-3 max-w-sm">
                <label className="text-purple-900 font-medium whitespace-nowrap text-sm">👤 พนักงานนับสต๊อก <span className="text-red-500">*</span> :</label>
                <select value={counterName} onChange={(e) => setCounterName(e.target.value)}
                  className="px-4 py-2 border border-purple-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-gray-700 bg-white w-full text-sm">
                  <option value="">-- เลือกพนักงาน --</option>
                  {employees.map((emp, idx) => <option key={idx} value={emp.name}>{emp.name}</option>)}
                </select>
              </div>
            )}

            <div className="overflow-x-auto">
              {loading ? (
                <div className="flex items-center justify-center py-16">
                  <div className="flex flex-col items-center gap-3 text-purple-600">
                    <Loader2 className="w-8 h-8 animate-spin" />
                    <p className="font-medium text-sm">กำลังโหลดข้อมูล...</p>
                  </div>
                </div>
              ) : (
                <table className="min-w-full divide-y divide-gray-200">
                  <thead className="bg-gray-50/50">
                    <tr>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">รหัส</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">หมวดจัดเก็บ</th>
                      <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">หน่วย</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-purple-600 uppercase w-32 bg-purple-50/60">ยอดยกมา</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-indigo-600 uppercase w-36 bg-indigo-50/60">คงเหลือล่าสุด</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-orange-600 uppercase w-36 bg-orange-50/60">ยอดเบิกล่าสุด</th>
                      <th className="px-4 py-3 text-center text-xs font-semibold text-emerald-600 uppercase w-32 bg-emerald-50/60">ยอดใช้จากระบบ</th>
                      {!isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase w-32">กรอกคงเหลือ</th>}
                      {!isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase w-32">ขอเบิก</th>}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {filteredItems.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-6 py-12 text-center text-gray-400">
                          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                          ไม่พบรายการสินค้า
                        </td>
                      </tr>
                    ) : filteredItems.map((item, index) => {
                      const originalIndex = items.findIndex(i => i.productId === item.productId);
                      return (
                        <tr key={item.productId || index} className="hover:bg-gray-50/50 transition-colors">
                          <td className="px-4 py-3 whitespace-nowrap text-xs font-mono text-gray-600">{item.productId}</td>
                          <td className="px-4 py-3 text-sm text-gray-800 font-medium">{item.name}</td>
                          <td className="px-4 py-3 whitespace-nowrap">
                            <div className="flex items-center gap-1.5 group">
                              <span className="text-xs text-gray-500">{item.storageCat || '-'}</span>
                              {!isAll && (
                                <button onClick={() => handleEditCategory(item)} disabled={isEditingCat}
                                  className="text-gray-300 hover:text-purple-500 opacity-0 group-hover:opacity-100 transition-opacity" title="แก้ไขหมวดจัดเก็บ">
                                  <svg xmlns="http://www.w3.org/2000/svg" className="h-3.5 w-3.5" fill="none" viewBox="0 0 24 24" stroke="currentColor">
                                    <path strokeLinecap="round" strokeLinejoin="round" strokeWidth={2} d="M15.232 5.232l3.536 3.536m-2.036-5.036a2.5 2.5 0 113.536 3.536L6.5 21.036H3v-3.572L16.732 3.732z" />
                                  </svg>
                                </button>
                              )}
                            </div>
                          </td>
                          <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">{item.unit}</td>

                          {/* ยอดยกมา */}
                          <td className="px-4 py-3 text-center bg-purple-50/30">
                            <div className="font-semibold text-purple-700 text-sm">
                              {item.previousBalance !== '' && item.previousBalance !== undefined ? item.previousBalance : '-'}
                            </div>
                            {item.previousBalanceDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5">{item.previousBalanceDate.split(' ')[0]}</div>
                            )}
                          </td>

                          {/* คงเหลือล่าสุด (from ข้อมูลนับสตอค) */}
                          <td className="px-4 py-3 text-center bg-indigo-50/30">
                            <div className="font-semibold text-indigo-700 text-sm">
                              {item.lastStock !== '' && item.lastStock !== undefined ? item.lastStock : '-'}
                            </div>
                            {item.lastStockDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5" title={`นับโดย: ${item.lastStockCounter || '-'}`}>
                                {item.lastStockDate.split(' ')[0]}
                                {item.lastStockCounter && <span className="ml-1 text-indigo-400">· {item.lastStockCounter}</span>}
                              </div>
                            )}
                          </td>

                          {/* ยอดเบิกล่าสุด */}
                          <td className="px-4 py-3 text-center bg-orange-50/30">
                            <div className="font-semibold text-orange-600 text-sm">
                              {item.lastRequest !== '' && item.lastRequest !== undefined ? item.lastRequest : '-'}
                            </div>
                            {item.lastRequestDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5" title={`ผู้เบิก: ${item.lastRequester || '-'}`}>
                                {item.lastRequestDate.split(' ')[0]}
                                {item.lastRequester && <span className="ml-1 text-orange-400">· {item.lastRequester}</span>}
                              </div>
                            )}
                          </td>

                          {/* ยอดใช้จาก API */}
                          <td className="px-4 py-3 text-center bg-emerald-50/30">
                            <div className="font-semibold text-emerald-600 text-sm">
                              {item.apiUsage !== undefined ? item.apiUsage : '-'}
                            </div>
                          </td>

                          {/* Input fields — hidden for 'all' */}
                          {!isAll && (
                            <td className="px-4 py-3 whitespace-nowrap">
                              <input type="number" min="0" step="any"
                                value={item.remaining}
                                onChange={(e) => handleInputChange(originalIndex, 'remaining', e.target.value)}
                                className="w-full px-3 py-2 border border-gray-200 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-center text-sm"
                                placeholder="จำนวน" />
                            </td>
                          )}
                          {!isAll && (
                            <td className="px-4 py-3 whitespace-nowrap">
                              <input type="number" min="0" step="any"
                                value={item.requested}
                                onChange={(e) => handleInputChange(originalIndex, 'requested', e.target.value)}
                                className="w-full px-3 py-2 border border-purple-200 bg-purple-50/30 rounded-lg focus:ring-2 focus:ring-purple-500 outline-none text-center text-sm font-semibold text-purple-700 placeholder:font-normal placeholder:text-gray-400"
                                placeholder="เบิก" />
                            </td>
                          )}
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
          </div>
        </>
      )}

      {/* Prompt to select branch for 'all' */}
      {isAll && !selectedBranch && (
        <div className="flex flex-col items-center justify-center py-20 text-gray-400 gap-3">
          <PackageSearch className="w-12 h-12 text-gray-300" />
          <p className="text-lg font-medium">เลือกสาขาเพื่อดูข้อมูลสต๊อก</p>
          <p className="text-sm">ใช้ตัวเลือกสาขาด้านบนเพื่อดูรายละเอียด</p>
        </div>
      )}
    </div>
  );
}
