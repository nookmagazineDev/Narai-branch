import { useAuth } from '../contexts/AuthContext';
import { Users, FileSpreadsheet, Building } from 'lucide-react';

export default function DashboardHome() {
  const { user } = useAuth();

  return (
    <div className="max-w-4xl mx-auto space-y-6">
      <div className="bg-gradient-to-r from-purple-600 to-indigo-600 rounded-3xl p-8 md:p-12 text-white shadow-xl shadow-purple-200">
        <h1 className="text-3xl md:text-4xl font-bold mb-4">ระบบจัดการพนักงานสาขา</h1>
        <p className="text-purple-100 text-lg max-w-2xl">
          ยินดีต้อนรับเข้าสู่ระบบจัดการข้อมูลพนักงาน คุณสามารถเพิ่มข้อมูลพนักงานใหม่เข้าสู่ฐานข้อมูล Google Sheets ได้อย่างง่ายดายผ่านระบบนี้
        </p>
      </div>

      <div className="grid grid-cols-1 md:grid-cols-3 gap-6">
        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 flex flex-col items-center text-center hover:shadow-md transition-shadow">
          <div className="w-14 h-14 bg-indigo-50 text-indigo-600 rounded-2xl flex items-center justify-center mb-4">
            <Building className="w-7 h-7" />
          </div>
          <h3 className="text-gray-500 font-medium mb-1">สาขาปัจจุบัน</h3>
          <p className="text-2xl font-bold text-gray-800">{user?.branch || '-'}</p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 flex flex-col items-center text-center hover:shadow-md transition-shadow">
          <div className="w-14 h-14 bg-purple-50 text-purple-600 rounded-2xl flex items-center justify-center mb-4">
            <Users className="w-7 h-7" />
          </div>
          <h3 className="text-gray-500 font-medium mb-1">ผู้ใช้งาน</h3>
          <p className="text-xl font-bold text-gray-800">{user?.username || '-'}</p>
        </div>

        <div className="bg-white rounded-2xl p-6 shadow-sm border border-gray-100 flex flex-col items-center text-center hover:shadow-md transition-shadow">
          <div className="w-14 h-14 bg-emerald-50 text-emerald-600 rounded-2xl flex items-center justify-center mb-4">
            <FileSpreadsheet className="w-7 h-7" />
          </div>
          <h3 className="text-gray-500 font-medium mb-1">ฐานข้อมูล</h3>
          <p className="text-lg font-bold text-gray-800">Google Sheets</p>
        </div>
      </div>
    </div>
  );
}
