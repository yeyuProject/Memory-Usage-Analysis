import React, { useState, useEffect } from 'react';
import { Card, Form, InputNumber, Button, Space, List, Tag, message, Typography, Switch } from 'antd';
import { BellOutlined, DeleteOutlined, WarningOutlined } from '@ant-design/icons';
import { MemoryMetricType } from '../types/memory';
import { memoryService } from '../services/memory';

const { Text } = Typography;

interface NotificationRule {
  id: string;
  metric: MemoryMetricType;
  threshold: number;
  enabled: boolean;
  triggered: boolean;
  lastTriggered?: number;
}

interface NotificationHistory {
  id: string;
  ruleId: string;
  metric: MemoryMetricType;
  threshold: number;
  actualValue: number;
  timestamp: number;
}

interface NotificationProps {
  currentMemoryInfo?: {
    workingSetSize: number;
    privateWorkingSetSize: number;
    commitSize: number;
  } | null;
}

const Notification: React.FC<NotificationProps> = ({ currentMemoryInfo }) => {
  const [form] = Form.useForm();
  const [rules, setRules] = useState<NotificationRule[]>([]);
  const [history, setHistory] = useState<NotificationHistory[]>([]);
  const [notificationsEnabled, setNotificationsEnabled] = useState(true);

  useEffect(() => {
    if (!currentMemoryInfo || !notificationsEnabled) return;

    rules.forEach((rule) => {
      if (!rule.enabled) return;

      const actualValue = currentMemoryInfo[rule.metric];
      if (actualValue >= rule.threshold && !rule.triggered) {
        const newHistory: NotificationHistory = {
          id: `notif_${Date.now()}`,
          ruleId: rule.id,
          metric: rule.metric,
          threshold: rule.threshold,
          actualValue,
          timestamp: Date.now(),
        };

        setHistory((prev) => [newHistory, ...prev].slice(0, 50));
        setRules((prev) =>
          prev.map((r) =>
            r.id === rule.id
              ? { ...r, triggered: true, lastTriggered: Date.now() }
              : r
          )
        );

        message.warning({
          content: `${memoryService.getMetricName(rule.metric)}超过阈值: ${memoryService.formatBytes(actualValue)} > ${memoryService.formatBytes(rule.threshold)}`,
          duration: 5,
        });
      } else if (actualValue < rule.threshold && rule.triggered) {
        setRules((prev) =>
          prev.map((r) => (r.id === rule.id ? { ...r, triggered: false } : r))
        );
      }
    });
  }, [currentMemoryInfo, rules, notificationsEnabled]);

  const handleAddRule = async () => {
    try {
      const values = await form.validateFields();
      const newRule: NotificationRule = {
        id: `rule_${Date.now()}`,
        metric: values.metric,
        threshold: values.threshold * 1024 * 1024,
        enabled: true,
        triggered: false,
      };

      setRules((prev) => [...prev, newRule]);
      form.resetFields();
      message.success('通知规则已添加');
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  const handleDeleteRule = (ruleId: string) => {
    setRules((prev) => prev.filter((r) => r.id !== ruleId));
    message.success('通知规则已删除');
  };

  const handleToggleRule = (ruleId: string, enabled: boolean) => {
    setRules((prev) =>
      prev.map((r) => (r.id === ruleId ? { ...r, enabled } : r))
    );
  };

  const handleClearHistory = () => {
    setHistory([]);
    message.success('通知历史已清除');
  };

  return (
    <div>
      <Card
        title="通知设置"
        extra={
          <Space>
            <Text>全局通知:</Text>
            <Switch
              checked={notificationsEnabled}
              onChange={setNotificationsEnabled}
              checkedChildren="开"
              unCheckedChildren="关"
            />
          </Space>
        }
      >
        <Form form={form} layout="inline" style={{ marginBottom: 16 }}>
          <Form.Item
            name="metric"
            label="监控指标"
            rules={[{ required: true, message: '请选择指标' }]}
          >
            <select style={{ width: 150, padding: '4px 11px' }}>
              <option value="workingSetSize">工作集</option>
              <option value="privateWorkingSetSize">私有工作集</option>
              <option value="commitSize">提交大小</option>
            </select>
          </Form.Item>
          <Form.Item
            name="threshold"
            label="阈值(MB)"
            rules={[{ required: true, message: '请输入阈值' }]}
          >
            <InputNumber min={1} max={10240} placeholder="输入阈值" />
          </Form.Item>
          <Form.Item>
            <Button type="primary" icon={<BellOutlined />} onClick={handleAddRule}>
              添加规则
            </Button>
          </Form.Item>
        </Form>

        <List
          header={<Text strong>通知规则</Text>}
          dataSource={rules}
          locale={{ emptyText: '暂无通知规则' }}
          renderItem={(rule) => (
            <List.Item
              actions={[
                <Switch
                  key="toggle"
                  size="small"
                  checked={rule.enabled}
                  onChange={(checked) => handleToggleRule(rule.id, checked)}
                />,
                <Button
                  key="delete"
                  size="small"
                  danger
                  icon={<DeleteOutlined />}
                  onClick={() => handleDeleteRule(rule.id)}
                />,
              ]}
            >
              <List.Item.Meta
                avatar={
                  rule.triggered ? (
                    <WarningOutlined style={{ color: '#ff4d4f', fontSize: 20 }} />
                  ) : (
                    <BellOutlined style={{ color: '#1890ff', fontSize: 20 }} />
                  )
                }
                title={
                  <Space>
                    <Text>{memoryService.getMetricName(rule.metric)}</Text>
                    {rule.triggered && <Tag color="error">已触发</Tag>}
                    {!rule.enabled && <Tag color="default">已禁用</Tag>}
                  </Space>
                }
                description={`阈值: ${memoryService.formatBytes(rule.threshold)}`}
              />
            </List.Item>
          )}
        />
      </Card>

      <Card
        title="通知历史"
        style={{ marginTop: 16 }}
        extra={
          <Button size="small" onClick={handleClearHistory} disabled={history.length === 0}>
            清除历史
          </Button>
        }
      >
        <List
          dataSource={history}
          locale={{ emptyText: '暂无通知历史' }}
          renderItem={(item) => (
            <List.Item>
              <List.Item.Meta
                avatar={<WarningOutlined style={{ color: '#ff4d4f' }} />}
                title={
                  <Space>
                    <Text>{memoryService.getMetricName(item.metric)}</Text>
                    <Text type="danger">
                      {memoryService.formatBytes(item.actualValue)} &gt;{' '}
                      {memoryService.formatBytes(item.threshold)}
                    </Text>
                  </Space>
                }
                description={new Date(item.timestamp).toLocaleString()}
              />
            </List.Item>
          )}
        />
      </Card>
    </div>
  );
};

export default Notification;
