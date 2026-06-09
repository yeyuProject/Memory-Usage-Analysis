import React, { useState } from 'react';
import { Card, Button, Space, Select, message, Typography, Divider, Table } from 'antd';
import { DownloadOutlined } from '@ant-design/icons';
import { memoryService } from '../services/memory';
import { ProcessMemoryInfo } from '../types/memory';

const { Text } = Typography;
const { Option } = Select;

interface ReportExportProps {
  data: ProcessMemoryInfo[];
  processName?: string;
}

type ExportFormat = 'csv' | 'html' | 'json';

const ReportExport: React.FC<ReportExportProps> = ({ data, processName = 'Unknown' }) => {
  const [exportFormat, setExportFormat] = useState<ExportFormat>('csv');
  const [exporting, setExporting] = useState(false);

  const generateCSV = (): string => {
    const headers = ['时间戳', '进程ID', '进程名称', '工作集', '私有工作集', '提交大小'];
    const rows = data.map((item) => [
      new Date(item.timestamp).toLocaleString(),
      item.processId,
      item.processName,
      item.workingSetSize,
      item.privateWorkingSetSize,
      item.commitSize,
    ]);

    return [headers.join(','), ...rows.map((row) => row.join(','))].join('\n');
  };

  const generateHTML = (): string => {
    const tableRows = data
      .map(
        (item) => `
      <tr>
        <td>${new Date(item.timestamp).toLocaleString()}</td>
        <td>${item.processId}</td>
        <td>${item.processName}</td>
        <td>${memoryService.formatBytes(item.workingSetSize)}</td>
        <td>${memoryService.formatBytes(item.privateWorkingSetSize)}</td>
        <td>${memoryService.formatBytes(item.commitSize)}</td>
      </tr>`
      )
      .join('');

    return `
<!DOCTYPE html>
<html lang="zh-CN">
<head>
  <meta charset="UTF-8">
  <title>内存分析报告 - ${processName}</title>
  <style>
    body { font-family: Arial, sans-serif; margin: 20px; }
    h1 { color: #1976d2; }
    table { border-collapse: collapse; width: 100%; margin-top: 20px; }
    th, td { border: 1px solid #ddd; padding: 8px; text-align: left; }
    th { background-color: #1976d2; color: white; }
    tr:nth-child(even) { background-color: #f2f2f2; }
    .summary { margin: 20px 0; padding: 15px; background: #e3f2fd; border-radius: 4px; }
  </style>
</head>
<body>
  <h1>内存分析报告</h1>
  <div class="summary">
    <p><strong>进程名称:</strong> ${processName}</p>
    <p><strong>数据点数量:</strong> ${data.length}</p>
    <p><strong>报告生成时间:</strong> ${new Date().toLocaleString()}</p>
  </div>
  <table>
    <thead>
      <tr>
        <th>时间</th>
        <th>进程ID</th>
        <th>进程名称</th>
        <th>工作集</th>
        <th>私有工作集</th>
        <th>提交大小</th>
      </tr>
    </thead>
    <tbody>
      ${tableRows}
    </tbody>
  </table>
</body>
</html>`;
  };

  const generateJSON = (): string => {
    const report = {
      processName,
      generatedAt: new Date().toISOString(),
      dataPoints: data.length,
      data: data.map((item) => ({
        timestamp: new Date(item.timestamp).toISOString(),
        processId: item.processId,
        processName: item.processName,
        workingSetSize: item.workingSetSize,
        privateWorkingSetSize: item.privateWorkingSetSize,
        commitSize: item.commitSize,
        formatted: {
          workingSetSize: memoryService.formatBytes(item.workingSetSize),
          privateWorkingSetSize: memoryService.formatBytes(item.privateWorkingSetSize),
          commitSize: memoryService.formatBytes(item.commitSize),
        },
      })),
    };

    return JSON.stringify(report, null, 2);
  };

  const handleExport = async () => {
    if (data.length === 0) {
      message.error('没有数据可导出');
      return;
    }

    setExporting(true);

    try {
      let content: string;
      let mimeType: string;
      let extension: string;

      switch (exportFormat) {
        case 'csv':
          content = generateCSV();
          mimeType = 'text/csv;charset=utf-8';
          extension = 'csv';
          break;
        case 'html':
          content = generateHTML();
          mimeType = 'text/html;charset=utf-8';
          extension = 'html';
          break;
        case 'json':
          content = generateJSON();
          mimeType = 'application/json;charset=utf-8';
          extension = 'json';
          break;
        default:
          throw new Error('Unsupported format');
      }

      const blob = new Blob([content], { type: mimeType });
      const url = URL.createObjectURL(blob);
      const link = document.createElement('a');
      link.href = url;
      link.download = `memory-report-${processName}-${new Date().toISOString().slice(0, 10)}.${extension}`;
      document.body.appendChild(link);
      link.click();
      document.body.removeChild(link);
      URL.revokeObjectURL(url);

      message.success(`报告已导出为 ${extension.toUpperCase()} 格式`);
    } catch (error) {
      message.error('导出失败');
      console.error('Export error:', error);
    } finally {
      setExporting(false);
    }
  };

  const columns = [
    {
      title: '时间',
      dataIndex: 'timestamp',
      key: 'timestamp',
      render: (value: number) => new Date(value).toLocaleString(),
    },
    {
      title: '工作集',
      dataIndex: 'workingSetSize',
      key: 'workingSetSize',
      render: (value: number) => memoryService.formatBytes(value),
    },
    {
      title: '私有工作集',
      dataIndex: 'privateWorkingSetSize',
      key: 'privateWorkingSetSize',
      render: (value: number) => memoryService.formatBytes(value),
    },
    {
      title: '提交大小',
      dataIndex: 'commitSize',
      key: 'commitSize',
      render: (value: number) => memoryService.formatBytes(value),
    },
  ];

  return (
    <div>
      <Card title="报告导出">
        <Space direction="vertical" style={{ width: '100%' }}>
          <div style={{ display: 'flex', justifyContent: 'space-between', alignItems: 'center' }}>
            <Space>
              <Text>导出格式:</Text>
              <Select
                value={exportFormat}
                onChange={setExportFormat}
                style={{ width: 120 }}
              >
                <Option value="csv">CSV</Option>
                <Option value="html">HTML</Option>
                <Option value="json">JSON</Option>
              </Select>
            </Space>
            <Button
              type="primary"
              icon={<DownloadOutlined />}
              onClick={handleExport}
              loading={exporting}
              disabled={data.length === 0}
            >
              导出报告
            </Button>
          </div>

          <Divider />

          <div>
            <Text strong>数据预览</Text>
            <Text type="secondary" style={{ marginLeft: 8 }}>
              (共 {data.length} 条记录)
            </Text>
          </div>

          <Table
            columns={columns}
            dataSource={data.slice(0, 10)}
            rowKey="timestamp"
            size="small"
            pagination={false}
          />

          {data.length > 10 && (
            <Text type="secondary" style={{ textAlign: 'center', display: 'block' }}>
              ... 还有 {data.length - 10} 条记录
            </Text>
          )}
        </Space>
      </Card>
    </div>
  );
};

export default ReportExport;
