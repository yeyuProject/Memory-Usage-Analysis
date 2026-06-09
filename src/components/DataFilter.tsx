import React, { useState } from 'react';
import { Card, Form, Select, DatePicker, Button, Space, Row, Col, Tag } from 'antd';
import { FilterOutlined, ClearOutlined } from '@ant-design/icons';
import dayjs from 'dayjs';
import { MemoryMetricType } from '../types/memory';
import { memoryService } from '../services/memory';

const { RangePicker } = DatePicker;
const { Option } = Select;

export interface FilterCriteria {
  processIds: number[];
  metrics: MemoryMetricType[];
  timeRange: [dayjs.Dayjs | null, dayjs.Dayjs | null] | null;
}

interface DataFilterProps {
  processes: { pid: number; name: string }[];
  onFilterChange: (criteria: FilterCriteria) => void;
  loading?: boolean;
}

const DataFilter: React.FC<DataFilterProps> = ({
  processes,
  onFilterChange,
  loading = false,
}) => {
  const [form] = Form.useForm();
  const [activeFilters, setActiveFilters] = useState<string[]>([]);

  const handleFilter = async () => {
    try {
      const values = await form.validateFields();
      const criteria: FilterCriteria = {
        processIds: values.processIds || [],
        metrics: values.metrics || ['workingSetSize', 'privateWorkingSetSize', 'commitSize'],
        timeRange: values.timeRange || null,
      };

      const filters: string[] = [];
      if (criteria.processIds.length > 0) {
        filters.push(`${criteria.processIds.length}个进程`);
      }
      if (criteria.metrics.length < 3) {
        filters.push(`${criteria.metrics.length}个指标`);
      }
      if (criteria.timeRange) {
        filters.push('自定义时间范围');
      }
      setActiveFilters(filters);

      onFilterChange(criteria);
    } catch (error) {
      console.error('Validation failed:', error);
    }
  };

  const handleClear = () => {
    form.resetFields();
    setActiveFilters([]);
    onFilterChange({
      processIds: [],
      metrics: ['workingSetSize', 'privateWorkingSetSize', 'commitSize'],
      timeRange: null,
    });
  };

  return (
    <Card
      title="数据筛选"
      size="small"
      extra={
        <Space>
          {activeFilters.map((filter, index) => (
            <Tag key={index} color="blue">
              {filter}
            </Tag>
          ))}
        </Space>
      }
    >
      <Form form={form} layout="vertical">
        <Row gutter={16}>
          <Col span={8}>
            <Form.Item name="processIds" label="选择进程">
              <Select
                mode="multiple"
                placeholder="选择要分析的进程"
                allowClear
                showSearch
                optionFilterProp="children"
                maxTagCount={3}
              >
                {processes.map((process) => (
                  <Option key={process.pid} value={process.pid}>
                    {process.name} (PID: {process.pid})
                  </Option>
                ))}
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="metrics" label="内存指标">
              <Select
                mode="multiple"
                placeholder="选择要显示的指标"
                allowClear
                maxTagCount={2}
              >
                <Option value="workingSetSize">
                  {memoryService.getMetricName('workingSetSize')}
                </Option>
                <Option value="privateWorkingSetSize">
                  {memoryService.getMetricName('privateWorkingSetSize')}
                </Option>
                <Option value="commitSize">
                  {memoryService.getMetricName('commitSize')}
                </Option>
              </Select>
            </Form.Item>
          </Col>
          <Col span={8}>
            <Form.Item name="timeRange" label="时间范围">
              <RangePicker
                showTime
                format="YYYY-MM-DD HH:mm:ss"
                style={{ width: '100%' }}
              />
            </Form.Item>
          </Col>
        </Row>
        <Row>
          <Col span={24} style={{ textAlign: 'right' }}>
            <Space>
              <Button icon={<ClearOutlined />} onClick={handleClear}>
                清除筛选
              </Button>
              <Button
                type="primary"
                icon={<FilterOutlined />}
                onClick={handleFilter}
                loading={loading}
              >
                应用筛选
              </Button>
            </Space>
          </Col>
        </Row>
      </Form>
    </Card>
  );
};

export default DataFilter;
