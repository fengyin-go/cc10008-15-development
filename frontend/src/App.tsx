import { useState } from 'react'
import { Link, Route, Routes } from 'react-router-dom'

import Overview from './views/Overview'
import QueryView from './views/query'
import ChartView from './views/chart'
import SourceView from './views/source'
import AggregateView from './views/aggregate'
import FilterView from './views/filter'
import ReportgenView from './views/reportgen'
import AnomalyView from './views/anomaly'
import DrillView from './views/drill'
import CompareView from './views/compare'
import PipelineView from './views/pipeline'
import DatastoreView from './views/datastore'
import ForecastView from './views/forecast'
import SegmentView from './views/segment'
import SchedulerView from './views/scheduler'
import NotifyView from './views/notify'
import NotifyBatchDetailView from './views/notify/NotifyBatchDetailView'
import CacheView from './views/cache'
import TagView from './views/tag'
import ShareView from './views/share'

const navItems = [{ label: "运营概览", path: "/" }, { label: "交互查询", path: "/query" }, { label: "可视化图表", path: "/chart" }, { label: "数据源接入", path: "/source" }, { label: "聚合计算", path: "/aggregate" }, { label: "数据筛选", path: "/filter" }, { label: "报告生成", path: "/reportgen" }, { label: "异常检测", path: "/anomaly" }, { label: "多维下钻", path: "/drill" }, { label: "对比分析", path: "/compare" }, { label: "分析流水线", path: "/pipeline" }, { label: "数据集管理", path: "/datastore" }, { label: "趋势预测", path: "/forecast" }, { label: "数据分片", path: "/segment" }, { label: "调度管理", path: "/scheduler" }, { label: "通知分发", path: "/notify" }, { label: "查询缓存", path: "/cache" }, { label: "数据标签", path: "/tag" }, { label: "数据分享", path: "/share" }]

export default function App() {
  const [operator] = useState('值班管理员')

  return (
    <div className="app-shell">
      <aside className="app-side">
        <h1 className="app-title">交互式数据分析工作台</h1>
        <nav className="nav-list">
          {navItems.map((item) => (
            <Link key={item.path} to={item.path} className="nav-item">
              {item.label}
            </Link>
          ))}
        </nav>
      </aside>
      <main className="app-main">
        <header className="app-head">
          <span className="head-desc">离线版交互式数据分析工具，涵盖多源接入、查询分析、可视化图表、报告生成、异常检测与数据服务编排，所有分析配置与结果持久化到浏览器本地存储。</span>
          <span className="head-user">当前值班：{operator}</span>
        </header>
        <Routes>
          <Route path="/" element={<Overview />} />
          <Route path="/query" element={<QueryView />} />
          <Route path="/chart" element={<ChartView />} />
          <Route path="/source" element={<SourceView />} />
          <Route path="/aggregate" element={<AggregateView />} />
          <Route path="/filter" element={<FilterView />} />
          <Route path="/reportgen" element={<ReportgenView />} />
          <Route path="/anomaly" element={<AnomalyView />} />
          <Route path="/drill" element={<DrillView />} />
          <Route path="/compare" element={<CompareView />} />
          <Route path="/pipeline" element={<PipelineView />} />
          <Route path="/datastore" element={<DatastoreView />} />
          <Route path="/forecast" element={<ForecastView />} />
          <Route path="/segment" element={<SegmentView />} />
          <Route path="/scheduler" element={<SchedulerView />} />
          <Route path="/notify" element={<NotifyView />} />
          <Route path="/notify/batches/:batchId" element={<NotifyBatchDetailView />} />
          <Route path="/cache" element={<CacheView />} />
          <Route path="/tag" element={<TagView />} />
          <Route path="/share" element={<ShareView />} />
        </Routes>
      </main>
    </div>
  )
}
