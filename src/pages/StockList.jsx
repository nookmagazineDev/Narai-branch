import React, { useState, useEffect, useMemo } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { apiCall } from '../services/api';
import { Loader2, Save, Search, AlertCircle, PackageSearch, Eye, FileText, ClipboardList } from 'lucide-react';
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
  const [filterCategory, setFilterCategory] = useState('');
  const [sortBy, setSortBy] = useState('storageCat');
  const [isSaving, setIsSaving] = useState(false);
  const [isEditingCat, setIsEditingCat] = useState(false);
  const [requestDate, setRequestDate] = useState('');
  const [requesterName, setRequesterName] = useState('');
  const [counterName, setCounterName] = useState('');
  
  const [apiStartDate, setApiStartDate] = useState('');
  const [apiEndDate, setApiEndDate] = useState('');
  const [isFetchingApi, setIsFetchingApi] = useState(false);
  const [selectedUsageDetails, setSelectedUsageDetails] = useState(null);
  const [recipeMap, setRecipeMap] = useState({});
  const [usageByMenu, setUsageByMenu] = useState({});
  const [selectedReceivedDetails, setSelectedReceivedDetails] = useState(null);
  const [selectedStockHistory, setSelectedStockHistory] = useState(null);
  const [pendingOrders, setPendingOrders] = useState([]);
  const [showPendingModal, setShowPendingModal] = useState(false);
  const [isLoadingPending, setIsLoadingPending] = useState(false);
  const [isSubmittingOrder, setIsSubmittingOrder] = useState(false);

  // Effective branch used for data loading
  const effectiveBranch = isAll ? selectedBranch : user?.branch;

  useEffect(() => {
    if (isAll) {
      // Load branch list for the dropdown selector
      apiCall('getBranches', {}).then(res => {
        if (res.status === 'success') setBranches(res.data);
      });
      // โหลดสูตรเมนู (วัตถุดิบ -> รายชื่อเมนู) ครั้งเดียว ใช้แสดงในป๊อปอัปรายละเอียดการเบิกใช้
      fetch('/api/recipe')
        .then(r => r.json())
        .then(res => { if (res.status === 'success') setRecipeMap(res.data || {}); })
        .catch(() => {});
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

  const fetchApiData = async () => {
    if (!effectiveBranch || !apiStartDate || !apiEndDate) {
      toast.error('กรุณาเลือกสาขา และระบุช่วงวันที่ให้ครบถ้วน');
      return;
    }
    let currentOutletId = '';
    if (isAll) {
      const foundBranch = branches.find(b => b.name === effectiveBranch);
      if (foundBranch) currentOutletId = foundBranch.outletId;
    } else {
      currentOutletId = user?.outletId || '';
    }

    setIsFetchingApi(true);
    try {
      const qs = `branch=${encodeURIComponent(effectiveBranch)}&outletId=${encodeURIComponent(currentOutletId)}&startDate=${encodeURIComponent(apiStartDate)}&endDate=${encodeURIComponent(apiEndDate)}`;
      const [usageRes, receivedRes, usageMenuRes] = await Promise.all([
        fetch(`/api/usage?${qs}`).then(r => r.json()),
        fetch(`/api/orderd?${qs}`).then(r => r.json()),
        fetch(`/api/usagemenu?${qs}`).then(r => r.json()).catch(() => ({ status: 'error' })),
      ]);

      // ยอดใช้แยกตามเมนูที่ขายจริง (Method 2) — ถ้าไม่มีข้อมูลจะเป็น {}
      setUsageByMenu(usageMenuRes.status === 'success' ? (usageMenuRes.data || {}) : {});

      setItems(prevItems => prevItems.map(item => {
        const normId = String(item.productId).replace(/^0+/, '').toLowerCase();
        return {
          ...item,
          apiUsage: usageRes.status === 'success' ? (usageRes.data[normId] || null) : item.apiUsage,
          apiReceived: receivedRes.status === 'success' ? (receivedRes.data[normId] || null) : item.apiReceived,
        };
      }));

      const msgs = [];
      if (usageRes.status === 'success') msgs.push('ยอดใช้');
      else toast.error('ยอดใช้: ' + (usageRes.message || 'เกิดข้อผิดพลาด'));
      if (receivedRes.status === 'success') msgs.push('ยอดรับเข้า');
      else toast.error('ยอดรับ: ' + (receivedRes.message || 'เกิดข้อผิดพลาด'));
      if (msgs.length > 0) toast.success(`ดึงข้อมูล ${msgs.join(' และ ')} สำเร็จ`);
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ API');
    } finally {
      setIsFetchingApi(false);
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

  // --- Generate order number: YY + MM + running (0001) ---
  const generateOrderNo = async (outletId) => {
    const now = new Date();
    const yy = String(now.getFullYear()).slice(-2);
    const mm = String(now.getMonth() + 1).padStart(2, '0');
    const prefix = `${yy}${mm}`;
    try {
      const res = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
      const data = await res.json();
      let maxRun = 0;
      if (data.status === 'success' && Array.isArray(data.all)) {
        data.all.forEach(order => {
          const no = String(order.no || order.No || order.Ord_No || '');
          if (no.startsWith(prefix)) {
            const run = parseInt(no.slice(prefix.length), 10);
            if (!isNaN(run) && run > maxRun) maxRun = run;
          }
        });
      }
      const nextRun = String(maxRun + 1).padStart(4, '0');
      return `${prefix}${nextRun}`;
    } catch {
      return `${prefix}0001`;
    }
  };

  // --- Fetch pending orders ---
  const fetchPendingOrders = async () => {
    const outletId = isAll
      ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
      : (user?.outletId || '');
    if (!outletId) { toast.error('ไม่พบรหัสสาขา'); return; }
    setIsLoadingPending(true);
    try {
      const res = await fetch(`/api/pending_orders?outletId=${encodeURIComponent(outletId)}`);
      const data = await res.json();
      if (data.status === 'success') {
        setPendingOrders(data.data || []);
        setShowPendingModal(true);
      } else {
        toast.error(data.message || 'ไม่สามารถดึงข้อมูลใบเบิกค้างได้');
      }
    } catch (err) {
      toast.error(err.message || 'เกิดข้อผิดพลาดในการเชื่อมต่อ');
    } finally {
      setIsLoadingPending(false);
    }
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

        // --- ส่งใบเบิกไปยัง External API ถ้ามีรายการขอเบิก ---
        if (hasRequests) {
          setIsSubmittingOrder(true);
          try {
            const outletId = isAll
              ? (branches.find(b => b.name === effectiveBranch)?.outletId || '')
              : (user?.outletId || '');
            if (outletId) {
              const orderNo = await generateOrderNo(outletId);
              const orderRes = await fetch(
                `/api/insert_order?outletId=${encodeURIComponent(outletId)}&deldate=${encodeURIComponent(requestDate)}&no=${encodeURIComponent(orderNo)}`
              );
              const orderData = await orderRes.json();
              if (orderData.status === 'success') {
                toast.success(`📋 ส่งใบเบิกสำเร็จ! เลขที่ใบเบิก: ${orderNo}`, { duration: 6000 });
              } else {
                toast.error(`ส่งใบเบิกไม่สำเร็จ: ${orderData.message || 'เกิดข้อผิดพลาด'}`);
              }
            }
          } catch (err) {
            toast.error('ส่งใบเบิกไปยังระบบไม่สำเร็จ: ' + err.message);
          } finally {
            setIsSubmittingOrder(false);
          }
        }

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

  const uniqueCategories = useMemo(() => {
    const cats = new Set();
    items.forEach(item => {
      if (item.storageCat) cats.add(String(item.storageCat));
    });
    return Array.from(cats).sort((a, b) => a.localeCompare(b, 'th'));
  }, [items]);

  const sortedAndFilteredItems = useMemo(() => {
    let result = items.filter(item => {
      const itemNameStr = String(item.name || '').toLowerCase();
      const itemCatStr = String(item.storageCat || '');
      
      const matchSearch = itemNameStr.includes(searchTerm.toLowerCase()) ||
                          String(item.productId || '').toLowerCase().includes(searchTerm.toLowerCase());
      const matchCat = filterCategory === '' || itemCatStr === filterCategory;
      return matchSearch && matchCat;
    });

    result.sort((a, b) => {
      if (sortBy === 'storageCat') {
        const catA = String(a.storageCat || '');
        const catB = String(b.storageCat || '');
        return catA.localeCompare(catB, 'th') || String(a.productId || '').localeCompare(String(b.productId || ''));
      } else if (sortBy === 'productId') {
        return String(a.productId || '').localeCompare(String(b.productId || ''));
      } else if (sortBy === 'name') {
        return String(a.name || '').localeCompare(String(b.name || ''), 'th');
      }
      return 0;
    });

    return result;
  }, [items, searchTerm, filterCategory, sortBy]);

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

        {/* Save + Pending Orders buttons — hidden for 'all' */}
        {!isAll && (
          <div className="flex gap-2">
            <button
              onClick={fetchPendingOrders}
              disabled={isLoadingPending}
              className="flex items-center justify-center gap-2 px-4 py-2.5 bg-amber-500 text-white rounded-xl font-medium hover:bg-amber-600 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-amber-200"
            >
              {isLoadingPending ? <Loader2 className="w-4 h-4 animate-spin" /> : <ClipboardList className="w-4 h-4" />}
              <span className="text-sm">ใบเบิกค้าง</span>
            </button>
            <button
              onClick={handleSave}
              disabled={isSaving || isSubmittingOrder || !effectiveBranch}
              className="flex items-center justify-center gap-2 px-6 py-2.5 bg-purple-600 text-white rounded-xl font-medium hover:bg-purple-700 transition-all disabled:opacity-40 disabled:cursor-not-allowed shadow-sm shadow-purple-200"
            >
              {(isSaving || isSubmittingOrder) ? <Loader2 className="w-5 h-5 animate-spin" /> : <Save className="w-5 h-5" />}
              <span>{isSubmittingOrder ? 'กำลังส่งใบเบิก...' : isSaving ? 'กำลังบันทึก...' : 'บันทึกข้อมูล'}</span>
            </button>
          </div>
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
            <div className="relative flex-1 flex gap-2">
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
              <select 
                value={filterCategory} 
                onChange={(e) => setFilterCategory(e.target.value)}
                className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 text-gray-700 max-w-[200px]"
              >
                <option value="">ทั้งหมด (ทุกหมวด)</option>
                {uniqueCategories.map((cat, idx) => (
                  <option key={idx} value={cat}>{cat}</option>
                ))}
              </select>
              <select 
                value={sortBy} 
                onChange={(e) => setSortBy(e.target.value)}
                className="border border-gray-200 rounded-xl px-3 py-3 bg-white text-sm focus:outline-none focus:ring-1 focus:ring-purple-500 text-gray-700"
              >
                <option value="storageCat">เรียงตามหมวดจัดเก็บ</option>
                <option value="productId">เรียงตามรหัสสินค้า</option>
                <option value="name">เรียงตามชื่อสินค้า</option>
              </select>
            </div>
            
            {/* Shared Date Picker for Usage + Received */}
            <div className="flex items-center gap-2 bg-gradient-to-r from-emerald-50 to-sky-50 border border-emerald-100 p-2 rounded-xl">
              <span className="text-sm font-medium text-gray-700 ml-2 whitespace-nowrap">วันที่ :</span>
              <input type="date" value={apiStartDate} onChange={(e) => setApiStartDate(e.target.value)}
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              <span className="text-gray-500 text-sm">-</span>
              <input type="date" value={apiEndDate} onChange={(e) => setApiEndDate(e.target.value)}
                className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-emerald-500" />
              <button
                onClick={fetchApiData}
                disabled={isFetchingApi || !effectiveBranch || !apiStartDate || !apiEndDate}
                className="px-4 py-1.5 bg-emerald-600 text-white text-sm rounded-lg hover:bg-emerald-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
                {isFetchingApi ? <Loader2 className="w-4 h-4 animate-spin" /> : 'ดึงข้อมูลยอดใช้,ยอดรับเข้า'}
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
                      {isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-emerald-600 uppercase w-32 bg-emerald-50/60">ยอดใช้จากระบบ</th>}
                      <th className="px-4 py-3 text-center text-xs font-semibold text-sky-600 uppercase w-32 bg-sky-50/60">ยอดรับ</th>
                      {isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-amber-700 uppercase w-36 bg-amber-50/80">ยอดคงเหลือจากระบบ</th>}
                      {!isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase w-32">กรอกคงเหลือ</th>}
                      {!isAll && <th className="px-4 py-3 text-center text-xs font-semibold text-gray-500 uppercase w-32">ขอเบิก</th>}
                    </tr>
                  </thead>
                  <tbody className="bg-white divide-y divide-gray-100">
                    {sortedAndFilteredItems.length === 0 ? (
                      <tr>
                        <td colSpan={10} className="px-6 py-12 text-center text-gray-400">
                          <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                          ไม่พบรายการสินค้า
                        </td>
                      </tr>
                    ) : sortedAndFilteredItems.map((item, index) => {
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
                            <div
                              className={`font-semibold text-purple-700 text-sm ${item.stockHistory && item.stockHistory.length > 1 ? 'cursor-pointer hover:underline hover:text-purple-900' : ''}`}
                              onClick={() => item.stockHistory && item.stockHistory.length > 1 && setSelectedStockHistory({ name: item.name, history: item.stockHistory, highlight: 'previous' })}
                              title={item.stockHistory && item.stockHistory.length > 1 ? 'คลิกเพื่อดูประวัติ' : ''}
                            >
                              {item.previousBalance !== '' && item.previousBalance !== undefined ? item.previousBalance : '-'}
                            </div>
                            {item.previousBalanceDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5">{String(item.previousBalanceDate || '').split(' ')[0]}</div>
                            )}
                          </td>

                          {/* คงเหลือล่าสุด (from ข้อมูลนับสตอค) */}
                          <td className="px-4 py-3 text-center bg-indigo-50/30">
                            <div
                              className={`font-semibold text-indigo-700 text-sm ${item.stockHistory && item.stockHistory.length > 0 ? 'cursor-pointer hover:underline hover:text-indigo-900' : ''}`}
                              onClick={() => item.stockHistory && item.stockHistory.length > 0 && setSelectedStockHistory({ name: item.name, history: item.stockHistory, highlight: 'last' })}
                              title={item.stockHistory && item.stockHistory.length > 0 ? 'คลิกเพื่อดูประวัติ' : ''}
                            >
                              {item.lastStock !== '' && item.lastStock !== undefined ? item.lastStock : '-'}
                            </div>
                            {item.lastStockDate && (
                              <div className="text-[10px] text-gray-400 mt-0.5" title={`นับโดย: ${item.lastStockCounter || '-'}`}>
                                {String(item.lastStockDate || '').split(' ')[0]}
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
                                {String(item.lastRequestDate || '').split(' ')[0]}
                                {item.lastRequester && <span className="ml-1 text-orange-400">· {item.lastRequester}</span>}
                              </div>
                            )}
                          </td>

                          {/* ยอดใช้จาก API — เฉพาะ isAll */}
                          {isAll && (
                          <td className="px-4 py-3 text-center bg-emerald-50/30">
                            {item.apiUsage && item.apiUsage.total !== undefined ? (
                              <div
                                className="font-semibold text-emerald-600 text-sm cursor-pointer hover:underline hover:text-emerald-800"
                                onClick={() => {
                                  const nid = String(item.productId).replace(/^0+/, '').toLowerCase();
                                  setSelectedUsageDetails({ name: item.name, details: item.apiUsage.details, menus: recipeMap[nid] || [], byMenu: usageByMenu[nid] || [] });
                                }}
                                title="คลิกเพื่อดูรายละเอียด"
                              >
                                {item.apiUsage.total}
                              </div>
                            ) : (
                              <div className="font-semibold text-emerald-600 text-sm">-</div>
                            )}
                          </td>
                          )}

                          {/* ยอดรับจาก API — ทุกคนเห็นได้ */}
                          <td className="px-4 py-3 text-center bg-sky-50/30">
                            {item.apiReceived && item.apiReceived.total !== undefined ? (
                              <div
                                className="font-semibold text-sky-600 text-sm cursor-pointer hover:underline hover:text-sky-800"
                                onClick={() => setSelectedReceivedDetails({ name: item.name, details: item.apiReceived.details })}
                                title="คลิกเพื่อดูรายละเอียด"
                              >
                                {item.apiReceived.total}
                              </div>
                            ) : (
                              <div className="font-semibold text-sky-600 text-sm">-</div>
                            )}
                          </td>

                          {/* ยอดคงเหลือจากระบบ — เฉพาะ isAll */}
                          {isAll && (
                          <td className="px-4 py-3 text-center bg-amber-50/50 border-l-2 border-amber-200">
                            {(() => {
                              const prevBal = parseFloat(item.previousBalance);
                              const received = item.apiReceived?.total;
                              const usage = item.apiUsage?.total;
                              const hasReceived = received !== undefined && received !== null;
                              const hasUsage = usage !== undefined && usage !== null;
                              if (isNaN(prevBal) && !hasReceived && !hasUsage) {
                                return <div className="font-bold text-amber-700 text-sm">-</div>;
                              }
                              const base = isNaN(prevBal) ? 0 : prevBal;
                              const rec = hasReceived ? received : 0;
                              const use = hasUsage ? usage : 0;
                              const systemBalance = Number((base + rec - use).toFixed(2));
                              const color = systemBalance < 0 ? 'text-red-600' : 'text-amber-800';
                              return (
                                <div className={`font-bold text-sm ${color}`}>
                                  {systemBalance}
                                </div>
                              );
                            })()}
                            <div className="text-[10px] text-amber-400 mt-0.5">ยกมา+รับ-ใช้</div>
                          </td>
                          )}

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

      {/* Usage Details Modal */}
      {selectedUsageDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-opacity" onClick={() => setSelectedUsageDetails(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-emerald-50 flex justify-between items-center">
              <h3 className="font-bold text-emerald-800">รายละเอียดการเบิกใช้</h3>
              <button onClick={() => setSelectedUsageDetails(null)} className="text-emerald-400 hover:text-emerald-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-96 overflow-y-auto">
              <p className="text-sm text-gray-700 mb-4 font-semibold border-b pb-3">{selectedUsageDetails.name}</p>
              <table className="w-full text-sm text-left border-collapse">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className="px-4 py-2 font-semibold text-gray-700 rounded-tl-md">วันที่</th>
                    <th className="px-4 py-2 font-semibold text-gray-700 text-right rounded-tr-md">จำนวน</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(selectedUsageDetails.details).sort(([a], [b]) => a.localeCompare(b)).map(([date, qty], idx) => (
                    <tr key={idx} className="hover:bg-emerald-50/50 transition-colors">
                      <td className="px-4 py-3 text-gray-600">{date}</td>
                      <td className="px-4 py-3 text-gray-900 text-right font-bold">{qty}</td>
                    </tr>
                  ))}
                  {Object.keys(selectedUsageDetails.details).length === 0 && (
                    <tr>
                      <td colSpan="2" className="px-4 py-6 text-center text-gray-400">ไม่มีข้อมูลการเบิกใช้</td>
                    </tr>
                  )}
                </tbody>
              </table>

              {/* ยอดใช้แยกตามเมนู */}
              <div className="mt-5 pt-4 border-t">
                {selectedUsageDetails.byMenu && selectedUsageDetails.byMenu.length > 0 ? (
                  <>
                    {/* Method 2: เมนูที่ขายจริง + ปริมาณที่ใช้ */}
                    <p className="text-sm font-semibold text-emerald-800 mb-2">
                      ใช้จากเมนู (ตามยอดขายจริง)
                      <span className="ml-1 text-emerald-500 font-normal">({selectedUsageDetails.byMenu.length} เมนู)</span>
                    </p>
                    <table className="w-full text-sm text-left border-collapse">
                      <thead className="bg-emerald-50 border-b">
                        <tr>
                          <th className="px-3 py-2 font-semibold text-emerald-800 rounded-tl-md">เมนู</th>
                          <th className="px-3 py-2 font-semibold text-emerald-800 text-right rounded-tr-md">ปริมาณใช้</th>
                        </tr>
                      </thead>
                      <tbody className="divide-y">
                        {selectedUsageDetails.byMenu.map((row, idx) => (
                          <tr key={idx} className="hover:bg-emerald-50/50">
                            <td className="px-3 py-2 text-gray-700">{row.menu}</td>
                            <td className="px-3 py-2 text-gray-900 text-right font-bold">{row.qty}</td>
                          </tr>
                        ))}
                      </tbody>
                    </table>
                  </>
                ) : (
                  <>
                    {/* Fallback: เมนูที่มีวัตถุดิบนี้ตามสูตร (ยังไม่มีข้อมูลยอดขายรายเมนู) */}
                    <p className="text-sm font-semibold text-emerald-800 mb-2">
                      เมนูที่ใช้วัตถุดิบนี้ <span className="text-gray-400 font-normal">(ตามสูตร)</span>
                      {selectedUsageDetails.menus && selectedUsageDetails.menus.length > 0 && (
                        <span className="ml-1 text-emerald-500 font-normal">({selectedUsageDetails.menus.length} เมนู)</span>
                      )}
                    </p>
                    {selectedUsageDetails.menus && selectedUsageDetails.menus.length > 0 ? (
                      <ul className="space-y-1 max-h-48 overflow-y-auto">
                        {selectedUsageDetails.menus.map((menu, idx) => (
                          <li key={idx} className="flex items-start gap-2 text-sm text-gray-700 bg-emerald-50/40 rounded px-3 py-1.5">
                            <span className="text-emerald-400 mt-0.5">•</span>
                            <span>{menu}</span>
                          </li>
                        ))}
                      </ul>
                    ) : (
                      <p className="text-sm text-gray-400 py-2">ไม่พบเมนูที่ใช้วัตถุดิบนี้ในสูตร</p>
                    )}
                  </>
                )}
              </div>
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button 
                onClick={() => setSelectedUsageDetails(null)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 hover:text-gray-900 transition-colors text-sm font-medium focus:outline-none focus:ring-2 focus:ring-emerald-500/20"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Received Details Modal */}
      {selectedReceivedDetails && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm transition-opacity" onClick={() => setSelectedReceivedDetails(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-sm overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-sky-50 flex justify-between items-center">
              <h3 className="font-bold text-sky-800">รายละเอียดการรับสินค้า</h3>
              <button onClick={() => setSelectedReceivedDetails(null)} className="text-sky-400 hover:text-sky-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-96 overflow-y-auto">
              <p className="text-sm text-gray-700 mb-4 font-semibold border-b pb-3">{selectedReceivedDetails.name}</p>
              <table className="w-full text-sm text-left border-collapse">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className="px-4 py-2 font-semibold text-gray-700">วันที่</th>
                    <th className="px-4 py-2 font-semibold text-gray-700 text-right">จำนวนรับ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {Object.entries(selectedReceivedDetails.details).sort(([a], [b]) => a.localeCompare(b)).map(([date, qty], idx) => (
                    <tr key={idx} className="hover:bg-sky-50/50 transition-colors">
                      <td className="px-4 py-3 text-gray-600">{date}</td>
                      <td className="px-4 py-3 text-gray-900 text-right font-bold">{qty}</td>
                    </tr>
                  ))}
                  {Object.keys(selectedReceivedDetails.details).length === 0 && (
                    <tr>
                      <td colSpan="2" className="px-4 py-6 text-center text-gray-400">ไม่มีข้อมูลการรับสินค้า</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setSelectedReceivedDetails(null)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 hover:text-gray-900 transition-colors text-sm font-medium focus:outline-none focus:ring-2 focus:ring-sky-500/20"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Stock Count History Modal */}
      {selectedStockHistory && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setSelectedStockHistory(null)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-md overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-indigo-50 flex justify-between items-center">
              <h3 className="font-bold text-indigo-800">ประวัติการนับสต็อก</h3>
              <button onClick={() => setSelectedStockHistory(null)} className="text-indigo-400 hover:text-indigo-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-96 overflow-y-auto">
              <p className="text-sm text-gray-700 mb-4 font-semibold border-b pb-3">{selectedStockHistory.name}</p>
              <table className="w-full text-sm text-left border-collapse">
                <thead className="bg-gray-100 border-b">
                  <tr>
                    <th className="px-4 py-2 font-semibold text-gray-700">วันที่นับ</th>
                    <th className="px-4 py-2 font-semibold text-gray-700 text-right">ยอดคงเหลือ</th>
                    <th className="px-4 py-2 font-semibold text-gray-700">ผู้นับ</th>
                  </tr>
                </thead>
                <tbody className="divide-y">
                  {[...selectedStockHistory.history].reverse().map((entry, idx) => {
                    const isLatest = idx === 0;
                    const isPrevious = idx === 1;
                    return (
                      <tr
                        key={idx}
                        className={`transition-colors ${isLatest ? 'bg-indigo-50 font-semibold' : isPrevious ? 'bg-purple-50' : 'hover:bg-gray-50'}`}
                      >
                        <td className="px-4 py-3 text-gray-700">
                          {entry.date}
                          {isLatest && <span className="ml-2 text-[10px] bg-indigo-500 text-white px-1.5 py-0.5 rounded-full">ล่าสุด</span>}
                          {isPrevious && <span className="ml-2 text-[10px] bg-purple-400 text-white px-1.5 py-0.5 rounded-full">ยกมา</span>}
                        </td>
                        <td className={`px-4 py-3 text-right font-bold ${isLatest ? 'text-indigo-700' : isPrevious ? 'text-purple-700' : 'text-gray-800'}`}>
                          {entry.remaining}
                        </td>
                        <td className="px-4 py-3 text-gray-500 text-xs">{entry.counter || '-'}</td>
                      </tr>
                    );
                  })}
                  {selectedStockHistory.history.length === 0 && (
                    <tr>
                      <td colSpan="3" className="px-4 py-6 text-center text-gray-400">ไม่มีข้อมูลประวัติ</td>
                    </tr>
                  )}
                </tbody>
              </table>
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setSelectedStockHistory(null)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium focus:outline-none focus:ring-2 focus:ring-indigo-500/20"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}

      {/* Pending Orders Modal */}
      {showPendingModal && (
        <div className="fixed inset-0 z-50 flex items-center justify-center p-4 bg-black/50 backdrop-blur-sm" onClick={() => setShowPendingModal(false)}>
          <div className="bg-white rounded-xl shadow-2xl w-full max-w-2xl overflow-hidden" onClick={e => e.stopPropagation()}>
            <div className="px-5 py-4 border-b bg-amber-50 flex justify-between items-center">
              <h3 className="font-bold text-amber-800 flex items-center gap-2">
                <FileText className="w-5 h-5" />
                ใบเบิกที่ยังไม่ได้รับของ
              </h3>
              <button onClick={() => setShowPendingModal(false)} className="text-amber-400 hover:text-amber-700 font-bold text-xl leading-none">&times;</button>
            </div>
            <div className="p-5 max-h-[60vh] overflow-y-auto">
              {pendingOrders.length === 0 ? (
                <div className="text-center py-10 text-gray-400">
                  <ClipboardList className="w-10 h-10 mx-auto mb-3 opacity-40" />
                  <p>ไม่มีใบเบิกค้างในขณะนี้</p>
                </div>
              ) : (
                <table className="w-full text-sm border-collapse">
                  <thead className="bg-amber-50 border-b">
                    <tr>
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">เลขที่ใบเบิก</th>
                      <th className="px-4 py-2 text-left text-amber-800 font-semibold">วันที่เบิก</th>
                      <th className="px-4 py-2 text-center text-amber-800 font-semibold">สถานะ</th>
                    </tr>
                  </thead>
                  <tbody className="divide-y">
                    {pendingOrders.map((order, idx) => {
                      const no = order.no || order.No || order.Ord_No || '-';
                      const date = order.deldate || order.DelDate || order.Ord_DelDate || order.date || '-';
                      const status = order.status || order.Status || order.Ord_Status || 'รอรับ';
                      return (
                        <tr key={idx} className="hover:bg-amber-50/50 transition-colors">
                          <td className="px-4 py-3 font-mono font-semibold text-amber-700">{no}</td>
                          <td className="px-4 py-3 text-gray-600">{String(date).split('T')[0]}</td>
                          <td className="px-4 py-3 text-center">
                            <span className="px-2 py-0.5 rounded-full text-xs font-medium bg-amber-100 text-amber-700">{status}</span>
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              )}
            </div>
            <div className="px-5 py-3 border-t bg-gray-50 flex justify-end">
              <button
                onClick={() => setShowPendingModal(false)}
                className="px-5 py-2 bg-white border border-gray-200 shadow-sm text-gray-700 rounded-lg hover:bg-gray-50 transition-colors text-sm font-medium"
              >
                ปิด
              </button>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}
