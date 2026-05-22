import { useState, useEffect, useMemo } from 'react';
import { PackageSearch, Search, Loader2, AlertCircle } from 'lucide-react';
import { toast } from 'react-hot-toast';
import { apiCall } from '../services/api';

export default function StockTotalList() {
  const [items, setItems] = useState([]);
  const [loading, setLoading] = useState(true);
  const [searchTerm, setSearchTerm] = useState('');
  
  // Date Picker state (defaults to today)
  const [apiStartDate, setApiStartDate] = useState('');
  const [apiEndDate, setApiEndDate] = useState('');
  
  const [isFetchingApi, setIsFetchingApi] = useState(false);
  const [branches, setBranches] = useState([]);

  useEffect(() => {
    // Set default dates to today
    const today = new Date();
    const localDateStr = new Date(today.getTime() - (today.getTimezoneOffset() * 60000)).toISOString().split('T')[0];
    setApiStartDate(localDateStr);
    setApiEndDate(localDateStr);
    
    fetchInitialData();
  }, []);

  const fetchInitialData = async () => {
    setLoading(true);
    try {
      const branchesRes = await apiCall('getBranches');
      if (branchesRes.status === 'success') {
        const validBranches = branchesRes.data.filter(b => String(b.name).toLowerCase() !== 'all');
        setBranches(validBranches);
      }
      
      // Load initial stock totals without end date (latest available)
      const itemsRes = await apiCall('getStockTotal', { endDate: '' });
      if (itemsRes.status === 'success') {
        setItems(itemsRes.data);
      }
    } catch (err) {
      toast.error('เกิดข้อผิดพลาดในการโหลดข้อมูลเริ่มต้น');
    } finally {
      setLoading(false);
    }
  };

  const fetchData = async () => {
    if (!apiStartDate || !apiEndDate) {
      toast.error('กรุณาระบุช่วงวันที่ให้ครบถ้วน');
      return;
    }

    setIsFetchingApi(true);
    try {
      // 1. Fetch Total Stock from Apps Script up to apiEndDate
      const stockResPromise = apiCall('getStockTotal', { endDate: apiEndDate });

      // 2. Fetch Usage & Received for ALL branches concurrently
      const validBranches = branches.filter(b => b.outletId);
      
      const usagePromises = validBranches.map(b => 
        fetch(`/api/usage?branch=${encodeURIComponent(b.name)}&outletId=${encodeURIComponent(b.outletId)}&startDate=${encodeURIComponent(apiStartDate)}&endDate=${encodeURIComponent(apiEndDate)}`)
        .then(r => r.json()).catch(() => ({ status: 'error' }))
      );
      
      const receivedPromises = validBranches.map(b => 
        fetch(`/api/orderd?branch=${encodeURIComponent(b.name)}&outletId=${encodeURIComponent(b.outletId)}&startDate=${encodeURIComponent(apiStartDate)}&endDate=${encodeURIComponent(apiEndDate)}`)
        .then(r => r.json()).catch(() => ({ status: 'error' }))
      );

      const [stockRes, usageResults, receivedResults] = await Promise.all([
        stockResPromise,
        Promise.all(usagePromises),
        Promise.all(receivedPromises)
      ]);

      if (stockRes.status !== 'success') {
        toast.error('ไม่สามารถดึงยอดคงเหลือรวมได้');
        setIsFetchingApi(false);
        return;
      }

      let baseItems = stockRes.data;

      // Aggregate Usage
      const totalUsageMap = {};
      usageResults.forEach(res => {
        if (res.status === 'success' && res.data) {
          Object.entries(res.data).forEach(([pid, data]) => {
            if (!totalUsageMap[pid]) totalUsageMap[pid] = 0;
            totalUsageMap[pid] += (data.total || 0);
          });
        }
      });

      // Aggregate Received
      const totalReceivedMap = {};
      receivedResults.forEach(res => {
        if (res.status === 'success' && res.data) {
          Object.entries(res.data).forEach(([pid, data]) => {
            if (!totalReceivedMap[pid]) totalReceivedMap[pid] = 0;
            totalReceivedMap[pid] += (data.total || 0);
          });
        }
      });

      // Merge into base items
      const mergedItems = baseItems.map(item => {
        const normId = String(item.productId).replace(/^0+/, '').toLowerCase();
        return {
          ...item,
          totalUsage: totalUsageMap[normId] || 0,
          totalReceived: totalReceivedMap[normId] || 0
        };
      });

      setItems(mergedItems);
      toast.success('ดึงข้อมูลยอดรวมสำเร็จ');

    } catch (error) {
      toast.error('เกิดข้อผิดพลาดในการดึงข้อมูล');
    } finally {
      setIsFetchingApi(false);
    }
  };

  const filteredItems = useMemo(() => {
    return items.filter(item => {
      if (!searchTerm) return true;
      const lowerSearch = searchTerm.toLowerCase();
      return (
        String(item.productId || '').toLowerCase().includes(lowerSearch) ||
        String(item.name || '').toLowerCase().includes(lowerSearch) ||
        String(item.storageCat || '').toLowerCase().includes(lowerSearch)
      );
    });
  }, [items, searchTerm]);

  return (
    <div className="max-w-7xl mx-auto pb-12 animate-in fade-in slide-in-from-bottom-4 duration-500">
      <div className="mb-6">
        <h1 className="text-2xl font-bold text-gray-800 flex items-center gap-3">
          <div className="p-2 bg-fuchsia-100 text-fuchsia-600 rounded-xl">
            <PackageSearch className="w-6 h-6" />
          </div>
          ดูยอดรวมทุกสาขา
        </h1>
        <p className="text-gray-500 mt-1 ml-11">ดูยอดคงเหลือรวม ยอดรับ และยอดใช้ ของทุกสาขาแบบเรียลไทม์</p>
      </div>

      <div className="flex flex-col md:flex-row gap-4 mb-4">
        <div className="relative flex-1">
          <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
            <Search className="h-5 w-5 text-gray-400" />
          </div>
          <input type="text"
            className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl bg-white placeholder-gray-500 focus:outline-none focus:ring-1 focus:ring-fuchsia-500 focus:border-fuchsia-500 sm:text-sm"
            placeholder="ค้นหาด้วยรหัส หรือ ชื่อสินค้า..."
            value={searchTerm}
            onChange={(e) => setSearchTerm(e.target.value)} />
        </div>
        
        <div className="flex items-center gap-2 bg-gradient-to-r from-fuchsia-50 to-pink-50 border border-fuchsia-100 p-2 rounded-xl">
          <span className="text-sm font-medium text-gray-700 ml-2 whitespace-nowrap">วันที่ :</span>
          <input type="date" value={apiStartDate} onChange={(e) => setApiStartDate(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500" />
          <span className="text-gray-500 text-sm">-</span>
          <input type="date" value={apiEndDate} onChange={(e) => setApiEndDate(e.target.value)}
            className="px-2 py-1.5 border border-gray-200 rounded-lg text-sm focus:outline-none focus:ring-1 focus:ring-fuchsia-500" />
          <button
            onClick={fetchData}
            disabled={isFetchingApi || loading || !apiStartDate || !apiEndDate}
            className="px-4 py-1.5 bg-fuchsia-600 text-white text-sm rounded-lg hover:bg-fuchsia-700 disabled:opacity-50 flex items-center gap-2 transition-colors whitespace-nowrap">
            {isFetchingApi ? <Loader2 className="w-4 h-4 animate-spin" /> : 'คำนวณยอดรวม'}
          </button>
        </div>
      </div>

      <div className="bg-white rounded-2xl shadow-sm border border-fuchsia-100 overflow-hidden">
        {loading ? (
          <div className="py-20 flex flex-col items-center justify-center text-fuchsia-600">
            <Loader2 className="w-10 h-10 animate-spin mb-4" />
            <p className="font-medium text-sm">กำลังโหลดข้อมูลรวมทุกสาขา...</p>
          </div>
        ) : (
          <div className="overflow-x-auto">
            <table className="min-w-full divide-y divide-gray-200">
              <thead className="bg-gray-50/50">
                <tr>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-28">รหัส</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase">ชื่อสินค้า</th>
                  <th className="px-4 py-3 text-left text-xs font-semibold text-gray-500 uppercase w-16">หน่วย</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-emerald-600 uppercase w-32 bg-emerald-50/60">ยอดใช้รวม</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-sky-600 uppercase w-32 bg-sky-50/60">ยอดรับรวม</th>
                  <th className="px-4 py-3 text-center text-xs font-semibold text-fuchsia-600 uppercase w-36 bg-fuchsia-50/60">คงเหลือรวมระบบ</th>
                </tr>
              </thead>
              <tbody className="bg-white divide-y divide-gray-100">
                {filteredItems.length === 0 ? (
                  <tr>
                    <td colSpan={6} className="px-6 py-12 text-center text-gray-400">
                      <AlertCircle className="w-8 h-8 mx-auto mb-2" />
                      ไม่พบรายการสินค้า
                    </td>
                  </tr>
                ) : filteredItems.map((item, index) => {
                  return (
                    <tr key={item.productId || index} className="hover:bg-gray-50/50 transition-colors">
                      <td className="px-4 py-3 whitespace-nowrap text-xs font-mono text-gray-600">{item.productId}</td>
                      <td className="px-4 py-3 text-sm text-gray-800 font-medium">{item.name}</td>
                      <td className="px-4 py-3 whitespace-nowrap text-xs text-gray-500">{item.unit}</td>

                      {/* ยอดใช้รวม */}
                      <td className="px-4 py-3 text-center bg-emerald-50/30">
                        <div className="font-semibold text-emerald-600 text-sm">
                          {item.totalUsage !== undefined && item.totalUsage > 0 ? Number(item.totalUsage.toFixed(2)) : '-'}
                        </div>
                      </td>

                      {/* ยอดรับรวม */}
                      <td className="px-4 py-3 text-center bg-sky-50/30">
                        <div className="font-semibold text-sky-600 text-sm">
                          {item.totalReceived !== undefined && item.totalReceived > 0 ? Number(item.totalReceived.toFixed(2)) : '-'}
                        </div>
                      </td>

                      {/* ยอดคงเหลือรวมจากระบบ = (คงเหลือที่นับได้ล่าสุดของแต่ละสาขา หรือ ยกมา) + ยอดรับรวม - ยอดใช้รวม */}
                      <td className="px-4 py-3 text-center bg-fuchsia-50/30 border-l-2 border-fuchsia-200">
                        {(() => {
                          const base = parseFloat(item.totalRemaining);
                          const received = item.totalReceived || 0;
                          const usage = item.totalUsage || 0;
                          
                          if (isNaN(base) && !item.totalReceived && !item.totalUsage) {
                            return <div className="font-bold text-gray-400 text-sm">-</div>;
                          }
                          
                          const startBal = isNaN(base) ? 0 : base;
                          const systemBalance = Number((startBal + received - usage).toFixed(2));
                          const color = systemBalance < 0 ? 'text-red-600' : 'text-fuchsia-800';
                          
                          return (
                            <>
                              <div className={`font-bold text-sm ${color}`}>
                                {systemBalance}
                              </div>
                              <div className="text-[10px] text-fuchsia-400 mt-0.5">
                                นับล่าสุด+รับ-ใช้
                              </div>
                              {item.lastDate && (
                                <div className="text-[10px] text-gray-400" title="นับ/ยกมา ล่าสุด (อาจต่างกันในแต่ละสาขา)">
                                  อิงวันที่: {item.lastDate.split(' ')[0]}
                                </div>
                              )}
                            </>
                          );
                        })()}
                      </td>
                    </tr>
                  );
                })}
              </tbody>
            </table>
          </div>
        )}
      </div>
    </div>
  );
}
