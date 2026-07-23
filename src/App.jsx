import { BrowserRouter as Router, Routes, Route, Navigate } from 'react-router-dom';
import { Toaster } from 'react-hot-toast';
import { AuthProvider, useAuth } from './contexts/AuthContext';
import Login from './pages/Login';
import DashboardLayout from './layouts/DashboardLayout';
import DashboardHome from './pages/DashboardHome';
import AddEmployee from './pages/AddEmployee';
import EmployeeList from './pages/EmployeeList';
import ScheduleWeekly from './pages/ScheduleWeekly';
import ScheduleHourly from './pages/ScheduleHourly';
import ScheduleHistory from './pages/ScheduleHistory';
import StockList from './pages/StockList';
import StockTotalList from './pages/StockTotalList';
import MonthEndClosing from './pages/MonthEndClosing';
import ExpenseEntry from './pages/ExpenseEntry';
import SalesSearch from './pages/SalesSearch';

// Protected Route wrapper
const ProtectedRoute = ({ children }) => {
  const { user, loading } = useAuth();
  
  if (loading) return null;
  
  if (!user) {
    return <Navigate to="/login" replace />;
  }

  return children;
};

// Public Route wrapper (redirects to dashboard if already logged in)
const PublicRoute = ({ children }) => {
  const { user, loading } = useAuth();
  
  if (loading) return null;

  if (user) {
    return <Navigate to="/" replace />;
  }

  return children;
};

function App() {
  return (
    <AuthProvider>
      <Router>
        <Toaster position="top-right" />
        <Routes>
          <Route 
            path="/login" 
            element={
              <PublicRoute>
                <Login />
              </PublicRoute>
            } 
          />
          
          <Route 
            path="/" 
            element={
              <ProtectedRoute>
                <DashboardLayout />
              </ProtectedRoute>
            }
          >
            <Route index element={<DashboardHome />} />
            <Route path="add-employee" element={<AddEmployee />} />
            <Route path="employees" element={<EmployeeList />} />
            <Route path="schedule/weekly" element={<ScheduleWeekly />} />
            <Route path="schedule/hourly" element={<ScheduleHourly />} />
            <Route path="schedule/history" element={<ScheduleHistory />} />
            <Route path="stock/list" element={<StockList />} />
            <Route path="stock/total" element={<StockTotalList />} />
            <Route path="stock/month-end" element={<MonthEndClosing />} />
            <Route path="expense" element={<ExpenseEntry />} />
            <Route path="sales-search" element={<SalesSearch />} />
          </Route>
          
          <Route path="*" element={<Navigate to="/" replace />} />
        </Routes>
      </Router>
    </AuthProvider>
  );
}

export default App;
