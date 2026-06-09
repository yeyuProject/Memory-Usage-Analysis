import { useState } from 'react';
import { ConfigProvider, Row, Col } from 'antd';
import zhCN from 'antd/locale/zh_CN';
import AppLayout from './components/Layout';
import ProcessList from './components/ProcessList';
import RealtimeMonitor from './components/RealtimeMonitor';
import DataRecording from './components/DataRecording';
import MemoryPieChart from './components/charts/PieChart';
import { useProcessMemory } from './hooks/useMemory';

function App() {
  const [currentPage, setCurrentPage] = useState('dashboard');
  const [selectedPid, setSelectedPid] = useState<number | null>(null);

  const { memoryInfo } = useProcessMemory(selectedPid);

  const handleMenuSelect = (key: string) => {
    setCurrentPage(key);
  };

  const handleProcessSelect = (process: { pid: number; name: string }) => {
    setSelectedPid(process.pid);
  };

  const renderContent = () => {
    switch (currentPage) {
      case 'dashboard':
        return (
          <div>
            <h2>仪表盘</h2>
            <p>欢迎使用Windows内存占用分析工具</p>
            <Row gutter={[16, 16]} style={{ marginTop: 16 }}>
              <Col span={24}>
                <ProcessList onSelect={handleProcessSelect} selectedPid={selectedPid} />
              </Col>
              {selectedPid && (
                <Col span={24}>
                  <MemoryPieChart
                    data={memoryInfo}
                    title={`进程 ${selectedPid} 内存分布`}
                  />
                </Col>
              )}
            </Row>
          </div>
        );
      case 'monitor':
        return <RealtimeMonitor processId={selectedPid} />;
      case 'recording':
        return <DataRecording processId={selectedPid} />;
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
