import { Outlet, NavLink, useNavigate, useLocation } from 'react-router-dom';
import { useAuth } from '../contexts/AuthContext';
import { Users, UserPlus, LogOut, Menu, X, LayoutDashboard, ChevronDown, ChevronRight, Calendar, PackageSearch } from 'lucide-react';
import { useState } from 'react';

export default function DashboardLayout() {
  const { user, logout } = useAuth();
  const navigate = useNavigate();
  const location = useLocation();
  const [isMobileMenuOpen, setIsMobileMenuOpen] = useState(false);
  const [openMenus, setOpenMenus] = useState({ 'พนักงาน': true });

  const toggleMenu = (name) => {
    setOpenMenus(prev => ({ ...prev, [name]: !prev[name] }));
  };

  const handleLogout = () => {
    logout();
    navigate('/login');
  };

  const navItems = [
    { name: 'แดชบอร์ด', path: '/', icon: LayoutDashboard },
    { 
      name: 'พนักงาน', 
      icon: Users,
      subItems: [
        { name: 'รายชื่อพนักงาน', path: '/employees' },
        { name: 'เพิ่มพนักงาน', path: '/add-employee' },
        { name: 'ลงตารางสัปดาห์', path: '/schedule/weekly' },
        { name: 'ตารางรายชั่วโมง', path: '/schedule/hourly' },
        { name: 'ประวัติ/รายงาน', path: '/schedule/history' },
      ]
    },
    {
      name: 'สต๊อก',
      icon: PackageSearch,
      subItems: [
        { name: 'นับสต๊อกและขอเบิก', path: '/stock/list' },
        ...(String(user?.branch).toLowerCase() === 'all' 
          ? [{ name: 'ดูยอดรวมทุกสาขา', path: '/stock/total' }] 
          : [])
      ]
    }
  ];

  return (
    <div className="flex h-screen bg-gray-50 overflow-hidden">
      {/* Mobile Menu Overlay */}
      {isMobileMenuOpen && (
        <div 
          className="fixed inset-0 bg-gray-900/50 z-20 lg:hidden backdrop-blur-sm"
          onClick={() => setIsMobileMenuOpen(false)}
        />
      )}

      {/* Sidebar */}
      <aside 
        className={`fixed inset-y-0 left-0 z-30 w-72 bg-white border-r border-gray-200 transform transition-transform duration-300 ease-in-out lg:translate-x-0 lg:static lg:inset-0 ${
          isMobileMenuOpen ? 'translate-x-0 shadow-2xl' : '-translate-x-full'
        }`}
      >
        <div className="h-full flex flex-col">
          {/* Sidebar Header */}
          <div className="h-20 flex items-center px-8 border-b border-gray-100">
            <div className="flex items-center gap-3 text-purple-600">
              <div className="p-2 bg-purple-100 rounded-xl">
                <Users className="w-6 h-6" />
              </div>
              <span className="text-xl font-bold tracking-tight text-gray-800">งานสาขา</span>
            </div>
          </div>

          {/* User Info */}
          <div className="p-6 mx-4 my-4 bg-gradient-to-br from-purple-50 to-indigo-50 rounded-2xl border border-purple-100/50">
            <p className="text-sm text-gray-500 mb-1">ยินดีต้อนรับ</p>
            <p className="font-semibold text-gray-800 truncate">{user?.username}</p>
            <div className="mt-2 inline-flex items-center px-2.5 py-1 rounded-full text-xs font-medium bg-purple-100 text-purple-800">
              สาขา: {user?.branch}
            </div>
          </div>

          {/* Navigation */}
          <nav className="flex-1 px-4 space-y-2 overflow-y-auto">
            {navItems.map((item) => {
              const Icon = item.icon;
              
              if (item.subItems) {
                const isOpen = openMenus[item.name];
                const isActive = item.subItems.some(sub => location.pathname === sub.path);
                
                return (
                  <div key={item.name} className="space-y-1">
                    <button
                      onClick={() => toggleMenu(item.name)}
                      className={`w-full flex items-center justify-between px-4 py-3 rounded-xl transition-all duration-200 ${
                        isActive && !isOpen
                          ? 'bg-purple-50 text-purple-700'
                          : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                      }`}
                    >
                      <div className="flex items-center gap-3">
                        <Icon className={`w-5 h-5 ${isActive ? 'text-purple-600' : ''}`} />
                        <span className="font-medium">{item.name}</span>
                      </div>
                      {isOpen ? <ChevronDown className="w-4 h-4 text-gray-400" /> : <ChevronRight className="w-4 h-4 text-gray-400" />}
                    </button>
                    
                    {isOpen && (
                      <div className="pl-11 pr-2 py-1 space-y-1">
                        {item.subItems.map(subItem => (
                          <NavLink
                            key={subItem.name}
                            to={subItem.path}
                            className={({ isActive }) =>
                              `block px-3 py-2 rounded-lg text-sm transition-colors ${
                                isActive
                                  ? 'bg-purple-600 text-white shadow-md shadow-purple-200 font-medium'
                                  : 'text-gray-500 hover:text-gray-900 hover:bg-gray-100'
                              }`
                            }
                            onClick={() => setIsMobileMenuOpen(false)}
                          >
                            {subItem.name}
                          </NavLink>
                        ))}
                      </div>
                    )}
                  </div>
                );
              }

              return (
                <NavLink
                  key={item.name}
                  to={item.path}
                  className={({ isActive }) =>
                    `flex items-center gap-3 px-4 py-3 rounded-xl transition-all duration-200 ${
                      isActive
                        ? 'bg-purple-600 text-white shadow-md shadow-purple-200'
                        : 'text-gray-600 hover:bg-gray-100 hover:text-gray-900'
                    }`
                  }
                  onClick={() => setIsMobileMenuOpen(false)}
                >
                  <Icon className="w-5 h-5" />
                  <span className="font-medium">{item.name}</span>
                </NavLink>
              );
            })}
          </nav>

          {/* Logout Button */}
          <div className="p-4 border-t border-gray-100">
            <button
              onClick={handleLogout}
              className="flex items-center gap-3 w-full px-4 py-3 text-red-600 hover:bg-red-50 hover:text-red-700 rounded-xl transition-colors font-medium"
            >
              <LogOut className="w-5 h-5" />
              <span>ออกจากระบบ</span>
            </button>
          </div>
        </div>
      </aside>

      {/* Main Content */}
      <main className="flex-1 flex flex-col min-w-0 overflow-hidden">
        {/* Header */}
        <header className="h-20 bg-white border-b border-gray-200 flex items-center justify-between px-4 lg:px-8 z-10 shadow-sm">
          <div className="flex items-center gap-2 lg:hidden">
            <div className="p-1.5 bg-purple-100 text-purple-600 rounded-lg">
              <Users className="w-5 h-5" />
            </div>
            <span className="text-lg font-bold text-gray-800">งานสาขา</span>
          </div>
          
          <div className="hidden lg:flex items-center gap-4 text-gray-800 ml-auto">
             <span className="text-sm text-gray-500">ผู้ใช้งาน:</span>
             <span className="font-semibold">{user?.username}</span>
             <span className="px-2 py-1 bg-purple-100 text-purple-800 text-xs font-medium rounded-full">สาขา: {user?.branch}</span>
          </div>

          <button
            onClick={() => setIsMobileMenuOpen(true)}
            className="p-2 rounded-lg text-gray-500 hover:bg-gray-100 focus:outline-none focus:ring-2 focus:ring-purple-500 lg:hidden"
          >
            <Menu className="w-6 h-6" />
          </button>
        </header>

        {/* Content Area */}
        <div className="flex-1 overflow-auto p-4 md:p-8">
          <Outlet />
        </div>
      </main>
    </div>
  );
}
