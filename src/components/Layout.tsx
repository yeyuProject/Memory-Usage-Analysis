import React, { useState } from 'react';
import { Layout, Menu, theme } from 'antd';
import {
  DashboardOutlined,
  LineChartOutlined,
  PieChartOutlined,
  VideoCameraOutlined,
  SettingOutlined,
  FileTextOutlined,
} from '@ant-design/icons';
import type { MenuProps } from 'antd';

const { Header, Sider, Content } = Layout;

type MenuItem = Required<MenuProps>['items'][number];

function getItem(
  label: React.ReactNode,
  key: React.Key,
  icon?: React.ReactNode,
  children?: MenuItem[],
): MenuItem {
  return {
    key,
    icon,
    children,
    label,
  } as MenuItem;
}

const items: MenuItem[] = [
  getItem('仪表盘', 'dashboard', <DashboardOutlined />),
  getItem('实时监控', 'monitor', <LineChartOutlined />),
  getItem('数据分析', 'analysis', <PieChartOutlined />, [
    getItem('饼图分析', 'pie-chart'),
    getItem('折线图分析', 'line-chart'),
    getItem('柱状图分析', 'bar-chart'),
  ]),
  getItem('数据录制', 'recording', <VideoCameraOutlined />),
  getItem('报告导出', 'report', <FileTextOutlined />),
  getItem('设置', 'settings', <SettingOutlined />),
];

interface AppLayoutProps {
  children: React.ReactNode;
  onMenuSelect?: (key: string) => void;
}

const AppLayout: React.FC<AppLayoutProps> = ({ children, onMenuSelect }) => {
  const [collapsed, setCollapsed] = useState(false);
  const {
    token: { colorBgContainer, borderRadiusLG },
  } = theme.useToken();

  const handleMenuClick: MenuProps['onClick'] = (e) => {
    onMenuSelect?.(e.key);
  };

  return (
    <Layout style={{ minHeight: '100vh' }}>
      <Sider
        collapsible
        collapsed={collapsed}
        onCollapse={(value) => setCollapsed(value)}
        theme="light"
        style={{
          overflow: 'auto',
          height: '100vh',
          position: 'fixed',
          left: 0,
          top: 0,
          bottom: 0,
        }}
      >
        <div
          style={{
            height: 64,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'center',
            borderBottom: '1px solid #f0f0f0',
          }}
        >
          <h1 style={{ margin: 0, fontSize: collapsed ? 14 : 18, color: '#1976d2' }}>
            {collapsed ? 'MUA' : 'Memory Analysis'}
          </h1>
        </div>
        <Menu
          theme="light"
          defaultSelectedKeys={['dashboard']}
          mode="inline"
          items={items}
          onClick={handleMenuClick}
        />
      </Sider>
      <Layout style={{ marginLeft: collapsed ? 80 : 200, transition: 'margin-left 0.2s' }}>
        <Header
          style={{
            padding: '0 24px',
            background: colorBgContainer,
            display: 'flex',
            alignItems: 'center',
            justifyContent: 'space-between',
            borderBottom: '1px solid #f0f0f0',
            position: 'sticky',
            top: 0,
            zIndex: 10,
          }}
        >
          <h2 style={{ margin: 0, fontSize: 18, fontWeight: 500 }}>Windows内存占用分析</h2>
          <div style={{ display: 'flex', alignItems: 'center', gap: 16 }}>
            <span style={{ color: '#666', fontSize: 14 }}>v1.0.0</span>
          </div>
        </Header>
        <Content
          style={{
            margin: '24px 16px',
            padding: 24,
            background: colorBgContainer,
            borderRadius: borderRadiusLG,
            minHeight: 280,
            overflow: 'auto',
          }}
        >
          {children}
        </Content>
      </Layout>
    </Layout>
  );
};

export default AppLayout;
