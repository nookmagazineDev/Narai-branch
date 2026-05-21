import { useState } from 'react';
import { useAuth } from '../contexts/AuthContext';
import { useNavigate } from 'react-router-dom';
import { apiCall } from '../services/api';
import toast from 'react-hot-toast';
import { LogIn, User, Lock } from 'lucide-react';

export default function Login() {
  const [username, setUsername] = useState('');
  const [password, setPassword] = useState('');
  const [loading, setLoading] = useState(false);
  const { login } = useAuth();
  const navigate = useNavigate();

  const handleLogin = async (e) => {
    e.preventDefault();
    if (!username || !password) {
      toast.error('กรุณากรอกข้อมูลให้ครบถ้วน');
      return;
    }

    setLoading(true);
    try {
      const response = await apiCall('login', { username, password });
      if (response.status === 'success') {
        login(response.data);
        toast.success(`เข้าสู่ระบบสำเร็จ สาขา: ${response.data.branch}`);
        navigate('/');
      }
    } catch (error) {
      toast.error(error.message || 'การเข้าสู่ระบบล้มเหลว');
    } finally {
      setLoading(false);
    }
  };

  return (
    <div className="min-h-screen flex items-center justify-center bg-gradient-to-br from-indigo-100 via-purple-50 to-pink-100">
      <div className="max-w-md w-full p-8 bg-white/80 backdrop-blur-xl rounded-3xl shadow-2xl border border-white/50">
        <div className="text-center mb-8">
          <div className="w-16 h-16 bg-gradient-to-tr from-indigo-600 to-purple-600 rounded-2xl flex items-center justify-center mx-auto mb-4 shadow-lg shadow-purple-500/30">
            <LogIn className="text-white w-8 h-8" />
          </div>
          <h2 className="text-3xl font-bold text-gray-800">เข้าสู่ระบบ</h2>
          <p className="text-gray-500 mt-2">ระบบจัดการพนักงานสาขา</p>
        </div>

        <form onSubmit={handleLogin} className="space-y-6">
          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">ชื่อผู้ใช้งาน (Username)</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <User className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="text"
                className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white/50 transition-all"
                placeholder="กรอกชื่อผู้ใช้งาน"
                value={username}
                onChange={(e) => setUsername(e.target.value)}
              />
            </div>
          </div>

          <div>
            <label className="block text-sm font-medium text-gray-700 mb-2">รหัสผ่าน (Password)</label>
            <div className="relative">
              <div className="absolute inset-y-0 left-0 pl-3 flex items-center pointer-events-none">
                <Lock className="h-5 w-5 text-gray-400" />
              </div>
              <input
                type="password"
                className="block w-full pl-10 pr-3 py-3 border border-gray-200 rounded-xl focus:ring-2 focus:ring-purple-500 focus:border-purple-500 bg-white/50 transition-all"
                placeholder="กรอกรหัสผ่าน"
                value={password}
                onChange={(e) => setPassword(e.target.value)}
              />
            </div>
          </div>

          <button
            type="submit"
            disabled={loading}
            className="w-full flex justify-center py-3 px-4 border border-transparent rounded-xl shadow-md text-sm font-semibold text-white bg-gradient-to-r from-indigo-600 to-purple-600 hover:from-indigo-700 hover:to-purple-700 focus:outline-none focus:ring-2 focus:ring-offset-2 focus:ring-purple-500 disabled:opacity-50 disabled:cursor-not-allowed transition-all transform hover:-translate-y-0.5"
          >
            {loading ? 'กำลังเข้าสู่ระบบ...' : 'เข้าสู่ระบบ'}
          </button>
        </form>
      </div>
    </div>
  );
}
