import React from 'react';
import { PieChart, Pie, Cell, ResponsiveContainer, Tooltip, Legend } from 'recharts';
import { Card, Empty } from 'antd';
import { memoryService } from '../../services/memory';
import { ProcessMemoryInfo } from '../../types/memory';

interface MemoryPieChartProps {
  data: ProcessMemoryInfo | null;
  title?: string;
}

const COLORS = ['#1890ff', '#52c41a', '#faad14', '#ff4d4f'];

const MemoryPieChart: React.FC<MemoryPieChartProps> = ({
  data,
  title = '内存使用分布',
}) => {
  if (!data) {
    return (
      <Card title={title}>
        <Empty description="暂无数据" />
      </Card>
    );
  }

  const chartData = [
    {
      name: memoryService.getMetricName('workingSetSize'),
      value: data.workingSetSize,
    },
    {
      name: memoryService.getMetricName('privateWorkingSetSize'),
      value: data.privateWorkingSetSize,
    },
    {
      name: memoryService.getMetricName('commitSize'),
      value: data.commitSize,
    },
  ];

  const renderCustomizedLabel = ({
    cx,
    cy,
    midAngle,
    innerRadius,
    outerRadius,
    percent,
  }: any) => {
    const RADIAN = Math.PI / 180;
    const radius = innerRadius + (outerRadius - innerRadius) * 0.5;
    const x = cx + radius * Math.cos(-midAngle * RADIAN);
    const y = cy + radius * Math.sin(-midAngle * RADIAN);

    return (
      <text
        x={x}
        y={y}
        fill="white"
        textAnchor={x > cx ? 'start' : 'end'}
        dominantBaseline="central"
      >
        {`${(percent * 100).toFixed(0)}%`}
      </text>
    );
  };

  return (
    <Card title={title}>
      <ResponsiveContainer width="100%" height={300}>
        <PieChart>
          <Pie
            data={chartData}
            cx="50%"
            cy="50%"
            labelLine={false}
            label={renderCustomizedLabel}
            outerRadius={100}
            fill="#8884d8"
            dataKey="value"
          >
            {chartData.map((_entry, index) => (
              <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />
            ))}
          </Pie>
          <Tooltip
            formatter={(value: any) => memoryService.formatBytes(Number(value))}
          />
          <Legend />
        </PieChart>
      </ResponsiveContainer>
    </Card>
  );
};

export default MemoryPieChart;
