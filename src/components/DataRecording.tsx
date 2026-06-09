import React, { useState } from 'react';
import {
  Card,
  Button,
  Space,
  Table,
  Tag,
  Modal,
  Form,
  InputNumber,
  Select,
  message,
  Typography,
} from 'antd';
import {
  PlayCircleOutlined,
  PauseCircleOutlined,
  DeleteOutlined,
  EyeOutlined,
} from '@ant-design/icons';
import { useRecording } from '../hooks/useMemory';
import { memoryService } from '../services/memory';
import { RecordingConfig, RecordingSession } from '../types/memory';
import type { ColumnsType } from 'antd/es/table';

const { Text } = Typography;
const { Option } = Select;

interface DataRecordingProps {
  processId: number | null;
}

const DataRecording: React.FC<DataRecordingProps> = ({ processId }) => {
  const {
    sessions,
    loading,
    startRecording,
    stopRecording,
    deleteSession,
  } = useRecording();

  const [isModalOpen, setIsModalOpen] = useState(false);
  const [isDetailModalOpen, setIsDetailModalOpen] = useState(false);
  const [selectedSession, setSelectedSession] = useState<RecordingSession | null>(null);
  const [form] = Form.useForm();

  const handleStartRecording = async () => {
    if (!processId) {
      message.error('请先选择一个进程');
      return;
    }

    try {
      const values = await form.validateFields();
      const config: RecordingConfig = {
        processId,
        interval: values.interval,
        duration: values.duration * 60 * 1000, // Convert minutes to milliseconds
        metrics: values.metrics,
      };

      await startRecording(config);
      setIsModalOpen(false);
      form.resetFields();
      message.success('录制已开始');
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  const handleStopRecording = async (sessionId: string) => {
    await stopRecording(sessionId);
    message.success('录制已停止');
  };

  const handleDeleteSession = async (sessionId: string) => {
    Modal.confirm({
      title: '确认删除',
      content: '确定要删除这个录制会话吗？',
      onOk: async () => {
        await deleteSession(sessionId);
        message.success('会话已删除');
      },
    });
  };

  const handleViewDetail = (session: RecordingSession) => {
    setSelectedSession(session);
    setIsDetailModalOpen(true);
  };

  const columns: ColumnsType<RecordingSession> = [
    {
      title: '会话ID',
      dataIndex: 'id',
      key: 'id',
      width: 200,
      ellipsis: true,
    },
    {
      title: '进程ID',
      dataIndex: ['config', 'processId'],
      key: 'processId',
      width: 100,
    },
    {
      title: '采样间隔',
      dataIndex: ['config', 'interval'],
      key: 'interval',
      width: 100,
      render: (value) => `${value}ms`,
    },
    {
      title: '数据点',
      key: 'dataPoints',
      width: 100,
      render: (_, record) => record.data.length,
    },
    {
      title: '状态',
      dataIndex: 'status',
      key: 'status',
      width: 100,
      render: (status: string) => {
        const colorMap: Record<string, string> = {
          recording: 'processing',
          completed: 'success',
          stopped: 'warning',
        };
        const labelMap: Record<string, string> = {
          recording: '录制中',
          completed: '已完成',
          stopped: '已停止',
        };
        return <Tag color={colorMap[status]}>{labelMap[status]}</Tag>;
      },
    },
    {
      title: '开始时间',
      dataIndex: 'startTime',
      key: 'startTime',
      width: 180,
      render: (value) => new Date(value).toLocaleString(),
    },
    {
      title: '操作',
      key: 'action',
      width: 200,
      render: (_, record) => (
        <Space>
          {record.status === 'recording' && (
            <Button
              type="primary"
              danger
              size="small"
              icon={<PauseCircleOutlined />}
              onClick={() => handleStopRecording(record.id)}
            >
              停止
            </Button>
          )}
          <Button
            size="small"
            icon={<EyeOutlined />}
            onClick={() => handleViewDetail(record)}
          >
            查看
          </Button>
          <Button
            size="small"
            danger
            icon={<DeleteOutlined />}
            onClick={() => handleDeleteSession(record.id)}
          >
            删除
          </Button>
        </Space>
      ),
    },
  ];

  return (
    <div>
      <Card
        title="数据录制"
        extra={
          <Button
            type="primary"
            icon={<PlayCircleOutlined />}
            onClick={() => setIsModalOpen(true)}
            disabled={!processId}
          >
            新建录制
          </Button>
        }
      >
        {!processId ? (
          <div style={{ textAlign: 'center', padding: '40px 0' }}>
            <Text type="secondary">请先选择一个进程进行录制</Text>
          </div>
        ) : (
          <Table columns={columns} dataSource={sessions} rowKey="id" loading={loading} />
        )}
      </Card>

      {/* 新建录制模态框 */}
      <Modal
        title="新建录制"
        open={isModalOpen}
        onOk={handleStartRecording}
        onCancel={() => setIsModalOpen(false)}
        okText="开始录制"
        cancelText="取消"
      >
        <Form form={form} layout="vertical">
          <Form.Item
            name="interval"
            label="采样间隔"
            rules={[{ required: true, message: '请选择采样间隔' }]}
          >
            <Select placeholder="选择采样间隔">
              <Option value={500}>500ms</Option>
              <Option value={1000}>1秒</Option>
              <Option value={2000}>2秒</Option>
              <Option value={5000}>5秒</Option>
            </Select>
          </Form.Item>
          <Form.Item
            name="duration"
            label="录制时长（分钟）"
            rules={[{ required: true, message: '请输入录制时长' }]}
          >
            <InputNumber min={1} max={60} placeholder="输入录制时长" style={{ width: '100%' }} />
          </Form.Item>
          <Form.Item
            name="metrics"
            label="监控指标"
            rules={[{ required: true, message: '请选择监控指标' }]}
          >
            <Select mode="multiple" placeholder="选择监控指标">
              <Option value="workingSetSize">工作集</Option>
              <Option value="privateWorkingSetSize">私有工作集</Option>
              <Option value="commitSize">提交大小</Option>
            </Select>
          </Form.Item>
        </Form>
      </Modal>

      {/* 详情模态框 */}
      <Modal
        title="录制详情"
        open={isDetailModalOpen}
        onCancel={() => setIsDetailModalOpen(false)}
        footer={null}
        width={800}
      >
        {selectedSession && (
          <div>
            <p>
              <strong>会话ID:</strong> {selectedSession.id}
            </p>
            <p>
              <strong>进程ID:</strong> {selectedSession.config.processId}
            </p>
            <p>
              <strong>采样间隔:</strong> {selectedSession.config.interval}ms
            </p>
            <p>
              <strong>数据点数量:</strong> {selectedSession.data.length}
            </p>
            <p>
              <strong>状态:</strong> {selectedSession.status}
            </p>
            {selectedSession.data.length > 0 && (
              <Table
                dataSource={selectedSession.data.slice(-10)}
                rowKey="timestamp"
                size="small"
                pagination={false}
                columns={[
                  {
                    title: '时间',
                    dataIndex: 'timestamp',
                    key: 'timestamp',
                    render: (value) => new Date(value).toLocaleTimeString(),
                  },
                  {
                    title: '工作集',
                    dataIndex: 'workingSetSize',
                    key: 'workingSetSize',
                    render: (value) => memoryService.formatBytes(value),
                  },
                  {
                    title: '私有工作集',
                    dataIndex: 'privateWorkingSetSize',
                    key: 'privateWorkingSetSize',
                    render: (value) => memoryService.formatBytes(value),
                  },
                  {
                    title: '提交大小',
                    dataIndex: 'commitSize',
                    key: 'commitSize',
                    render: (value) => memoryService.formatBytes(value),
                  },
                ]}
              />
            )}
          </div>
        )}
      </Modal>
    </div>
  );
};

export default DataRecording;
