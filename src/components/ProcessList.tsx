import React, { useState, useMemo } from 'react';
import { Table, Input, Button, Space, Tag, Card } from 'antd';
import { SearchOutlined, ReloadOutlined } from '@ant-design/icons';
import type { ColumnsType } from 'antd/es/table';
import { useProcessList } from '../hooks/useMemory';

interface ProcessItem {
  pid: number;
  name: string;
}

interface ProcessListProps {
  onSelect?: (process: ProcessItem) => void;
  selectedPid?: number | null;
}

const ProcessList: React.FC<ProcessListProps> = ({ onSelect, selectedPid }) => {
  const { processes, loading, refresh } = useProcessList();
  const [searchText, setSearchText] = useState('');

  const filteredProcesses = useMemo(() => {
    if (!searchText) return processes;

    const lowerSearch = searchText.toLowerCase();
    return processes.filter(
      (process) =>
        process.name.toLowerCase().includes(lowerSearch) ||
        process.pid.toString().includes(searchText)
    );
  }, [processes, searchText]);

  const columns: ColumnsType<ProcessItem> = [
    {
      title: 'PID',
      dataIndex: 'pid',
      key: 'pid',
      width: 100,
      sorter: (a, b) => a.pid - b.pid,
    },
    {
      title: '进程名称',
      dataIndex: 'name',
      key: 'name',
      sorter: (a, b) => a.name.localeCompare(b.name),
    },
    {
      title: '状态',
      key: 'status',
      width: 100,
      render: (_, record) => (
        <Tag color={selectedPid === record.pid ? 'green' : 'default'}>
          {selectedPid === record.pid ? '已选择' : '运行中'}
        </Tag>
      ),
    },
    {
      title: '操作',
      key: 'action',
      width: 120,
      render: (_, record) => (
        <Button
          type="primary"
          size="small"
          onClick={() => onSelect?.(record)}
          disabled={selectedPid === record.pid}
        >
          {selectedPid === record.pid ? '已选择' : '选择'}
        </Button>
      ),
    },
  ];

  return (
    <Card
      title="进程列表"
      extra={
        <Space>
          <Input
            placeholder="搜索进程名称或PID"
            prefix={<SearchOutlined />}
            value={searchText}
            onChange={(e) => setSearchText(e.target.value)}
            style={{ width: 250 }}
            allowClear
          />
          <Button icon={<ReloadOutlined />} onClick={refresh} loading={loading}>
            刷新
          </Button>
        </Space>
      }
    >
      <Table
        columns={columns}
        dataSource={filteredProcesses}
        rowKey="pid"
        loading={loading}
        size="small"
        pagination={{
          pageSize: 10,
          showSizeChanger: true,
          showQuickJumper: true,
          showTotal: (total) => `共 ${total} 个进程`,
        }}
        onRow={(record) => ({
          onClick: () => onSelect?.(record),
          style: { cursor: 'pointer' },
        })}
      />
    </Card>
  );
};

export default ProcessList;
