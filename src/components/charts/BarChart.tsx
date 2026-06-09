import React from 'react';
import {
  BarChart,
  Bar,
  XAxis,
  YAxis,
  CartesianGrid,
  Tooltip,
  Legend,
  ResponsiveContainer,
} from 'recharts';
import { Card, Empty } from 'antd';
import { memoryService } from '../../services/memory';
import { ProcessMemoryInfo, MemoryMetricType } from '../../types/memory';

interface MemoryBarChartProps {
  data: ProcessMemoryInfo[];
  title?: string;
  metrics?: MemoryMetricType[];
}

const METRIC_COLORS: Record<MemoryMetricType, string> = {
  workingSetSize: '#1890ff',
  privateWorkingSetSize: '#52c41a',
  commitSize: '#faad14',
};

const MemoryBarChart: React.FC<MemoryBarChartProps> = ({
  data,
  title = '进程内存对比',
  metrics = ['workingSetSize', 'privateWorkingSetSize', 'commitSize'],
}) => {
  if (!data || data.length === 0) {
    return (
      <Card title={title}>
        <Empty description="暂无数据" />
      </Card>
    );
  }

  const chartData = data.map((item) => ({
    name: item.processName,
    ...metrics.reduce((acc, metric) => {
      acc[metric] = item[metric];
      return acc;
    }, {} as Record<string, number>),
  }));

  return (
    <Card title={title}>
      <ResponsiveContainer width="100%" height={400}>
        <BarChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis dataKey="name" tick={{ fontSize: 12 }} />
          <YAxis
            tickFormatter={(value: number) => memoryService.formatBytes(value)}
            tick={{ fontSize: 12 }}
          />
          <Tooltip
            formatter={(value: any, name: any) => [
              memoryService.formatBytes(Number(value)),
              memoryService.getMetricName(name as MemoryMetricType),
            ]}
          />
          <Legend
            formatter={(value: string) => memoryService.getMetricName(value as MemoryMetricType)}
          />
          {metrics.map((metric) => (
            <Bar
              key={metric}
              dataKey={metric}
              fill={METRIC_COLORS[metric]}
              radius={[4, 4, 0, 0]}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </Card>
  );
};

export default MemoryBarChart;
