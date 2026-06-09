import React from 'react';
import {
  LineChart,
  Line,
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

interface MemoryLineChartProps {
  data: ProcessMemoryInfo[];
  title?: string;
  metrics?: MemoryMetricType[];
}

const METRIC_COLORS: Record<MemoryMetricType, string> = {
  workingSetSize: '#1890ff',
  privateWorkingSetSize: '#52c41a',
  commitSize: '#faad14',
};

const MemoryLineChart: React.FC<MemoryLineChartProps> = ({
  data,
  title = '内存使用趋势',
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
    ...item,
    time: new Date(item.timestamp).toLocaleTimeString(),
  }));

  return (
    <Card title={title}>
      <ResponsiveContainer width="100%" height={400}>
        <LineChart data={chartData}>
          <CartesianGrid strokeDasharray="3 3" />
          <XAxis
            dataKey="time"
            tick={{ fontSize: 12 }}
            interval="preserveStartEnd"
          />
          <YAxis
            tickFormatter={(value: number) => memoryService.formatBytes(value)}
            tick={{ fontSize: 12 }}
          />
          <Tooltip
            formatter={(value: any, name: any) => [
              memoryService.formatBytes(Number(value)),
              memoryService.getMetricName(name as MemoryMetricType),
            ]}
            labelFormatter={(label: any) => `时间: ${label}`}
          />
          <Legend
            formatter={(value: string) => memoryService.getMetricName(value as MemoryMetricType)}
          />
          {metrics.map((metric) => (
            <Line
              key={metric}
              type="monotone"
              dataKey={metric}
              stroke={METRIC_COLORS[metric]}
              activeDot={{ r: 8 }}
              strokeWidth={2}
            />
          ))}
        </LineChart>
      </ResponsiveContainer>
    </Card>
  );
};

export default MemoryLineChart;
