import React, { useState, useEffect } from 'react';
import { Card, Row, Col, Statistic, Button, Space, Select, Typography } from 'antd';
import { PlayCircleOutlined, PauseCircleOutlined, ReloadOutlined } from '@ant-design/icons';
import { useProcessMemory, useSystemMemory } from '../hooks/useMemory';
import { memoryService } from '../services/memory';
import { ProcessMemoryInfo, MemoryMetricType } from '../types/memory';

const { Text } = Typography;
const { Option } = Select;

interface RealtimeMonitorProps {
  processId: number | null;
}

const RealtimeMonitor: React.FC<RealtimeMonitorProps> = ({ processId }) => {
  const [isMonitoring, setIsMonitoring] = useState(false);
  const [interval, setInterval] = useState(1000);
  const [history, setHistory] = useState<ProcessMemoryInfo[]>([]);
  const maxHistoryLength = 60; // 1 minute of data at 1 second intervals

  const { memoryInfo, refresh } = useProcessMemory(
    processId,
    isMonitoring ? interval : 0
  );

  const { systemInfo } = useSystemMemory(2000);

  useEffect(() => {
    if (memoryInfo && isMonitoring) {
      setHistory((prev) => {
        const newHistory = [...prev, memoryInfo];
        if (newHistory.length > maxHistoryLength) {
          return newHistory.slice(newHistory.length - maxHistoryLength);
        }
        return newHistory;
      });
    }
  }, [memoryInfo, isMonitoring]);

  const handleToggleMonitoring = () => {
    if (!processId) return;

    if (isMonitoring) {
      setIsMonitoring(false);
    } else {
      setHistory([]);
      setIsMonitoring(true);
    }
  };

  const handleRefresh = () => {
    refresh();
  };

  const renderMemoryCard = (
    title: string,
    value: number | undefined,
    metric: MemoryMetricType
  ) => (
    <Card>
      <Statistic
        title={title}
        value={value ? memoryService.formatBytes(value) : '--'}
        valueStyle={{ color: memoryService.getMetricColor(metric) }}
      />
    </Card>
  );

  const renderSystemMemoryCard = () => {
    if (!systemInfo) return null;

    const usedPercent = systemInfo.memoryLoad;
    const usedColor = usedPercent > 80 ? '#ff4d4f' : usedPercent > 60 ? '#faad14' : '#52c41a';

    return (
      <Card title="系统内存">
        <Row gutter={[16, 16]}>
          <Col span={12}>
            <Statistic
              title="总物理内存"
              value={memoryService.formatBytes(systemInfo.totalPhysicalMemory)}
            />
          </Col>
          <Col span={12}>
            <Statistic
              title="可用物理内存"
              value={memoryService.formatBytes(systemInfo.availablePhysicalMemory)}
              valueStyle={{ color: '#52c41a' }}
            />
          </Col>
          <Col span={24}>
            <div style={{ textAlign: 'center' }}>
              <Text>内存使用率</Text>
              <div
                style={{
                  fontSize: 24,
                  fontWeight: 'bold',
                  color: usedColor,
                }}
              >
                {usedPercent}%
              </div>
            </div>
          </Col>
        </Row>
      </Card>
    );
  };

  return (
    <div>
      <Card
        title="实时监控"
        extra={
          <Space>
            <Select
              value={interval}
              onChange={setInterval}
              style={{ width: 120 }}
              disabled={isMonitoring}
            >
              <Option value={500}>500ms</Option>
              <Option value={1000}>1秒</Option>
              <Option value={2000}>2秒</Option>
              <Option value={5000}>5秒</Option>
            </Select>
            <Button
              type={isMonitoring ? 'default' : 'primary'}
              icon={isMonitoring ? <PauseCircleOutlined /> : <PlayCircleOutlined />}
              onClick={handleToggleMonitoring}
              disabled={!processId}
            >
              {isMonitoring ? '停止监控' : '开始监控'}
            </Button>
            <Button icon={<ReloadOutlined />} onClick={handleRefresh} disabled={isMonitoring}>
              刷新
            </Button>
          </Space>
        }
      >
        {!processId ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Text type="secondary">请先选择一个进程进行监控</Text>
          </div>
        ) : (
          <>
            <Row gutter={[16, 16]} style={{ marginBottom: 16 }}>
              <Col span={8}>
                {renderMemoryCard('工作集', memoryInfo?.workingSetSize, 'workingSetSize')}
              </Col>
              <Col span={8}>
                {renderMemoryCard(
                  '私有工作集',
                  memoryInfo?.privateWorkingSetSize,
                  'privateWorkingSetSize'
                )}
              </Col>
              <Col span={8}>
                {renderMemoryCard('提交大小', memoryInfo?.commitSize, 'commitSize')}
              </Col>
            </Row>

            <Row gutter={[16, 16]}>
              <Col span={16}>
                <Card title="内存使用趋势">
                  <div
                    style={{
                      height: 200,
                      display: 'flex',
                      alignItems: 'center',
                      justifyContent: 'center',
                    }}
                  >
                    {history.length === 0 ? (
                      <Text type="secondary">
                        {isMonitoring ? '正在收集数据...' : '开始监控后将显示趋势图'}
                      </Text>
                    ) : (
                      <div style={{ width: '100%' }}>
                        <div
                          style={{
                            display: 'flex',
                            justifyContent: 'space-between',
                            marginBottom: 8,
                          }}
                        >
                          <Text>最近 {history.length} 个数据点</Text>
                          <Text>
                            最新: {memoryService.formatBytes(history[history.length - 1].workingSetSize)}
                          </Text>
                        </div>
                        <div
                          style={{
                            height: 160,
                            background: '#f5f5f5',
                            borderRadius: 4,
                            display: 'flex',
                            alignItems: 'end',
                            padding: '0 4px',
                            gap: 2,
                          }}
                        >
                          {history.slice(-30).map((item, index) => {
                            const maxMemory = Math.max(
                              ...history.slice(-30).map((h) => h.workingSetSize)
                            );
                            const height = (item.workingSetSize / maxMemory) * 100;
                            return (
                              <div
                                key={index}
                                style={{
                                  flex: 1,
                                  height: `${height}%`,
                                  background: '#1890ff',
                                  borderRadius: '2px 2px 0 0',
                                  minHeight: 4,
                                }}
                              />
                            );
                          })}
                        </div>
                      </div>
                    )}
                  </div>
                </Card>
              </Col>
              <Col span={8}>{renderSystemMemoryCard()}</Col>
            </Row>
          </>
        )}
      </Card>
    </div>
  );
};

export default RealtimeMonitor;
