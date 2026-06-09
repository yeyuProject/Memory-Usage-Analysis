import { useState } from 'react';
import { ConfigProvider } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from './components/Layout';

function App() {
  const [currentPage, setCurrentPage] = useState('dashboard');

  const handleMenuSelect = (key: string) => {
    setCurrentPage(key);
  };

  const renderContent = () => {
    switch (currentPage) {
      case 'dashboard':
        return (
          <div>
            <h2>仪表盘</h2>
            <p>欢迎使用Windows内存占用分析工具</p>
          </div>
        );
      case 'monitor':
        return (
          <div>
            <h2>实时监控</h2>
            <p>实时监控内存使用情况</p>
          </div>
        );
      case 'recording':
        return (
          <div>
            <h2>数据录制</h2>
            <p>录制内存使用数据</p>
          </div>
        );
      case 'report':
        return (
          <div>
            <h2>报告导出</h2>
            <p>导出分析报告</p>
          </div>
        );
      case 'settings':
        return (
          <div>
            <h2>设置</h2>
            <p>应用程序设置</p>
          </div>
        );
      default:
        return (
          <div>
            <h2>仪表盘</h2>
            <p>欢迎使用Windows内存占用分析工具</p>
          </div>
        );
    }
  };

  return (
    <ConfigProvider locale={zhCN}>
      <AppLayout onMenuSelect={handleMenuSelect}>
        {renderContent()}
      </AppLayout>
    </ConfigProvider>
  );
}

export default App;
