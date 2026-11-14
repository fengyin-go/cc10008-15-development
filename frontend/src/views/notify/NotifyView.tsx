import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useSearchParams } from 'react-router-dom'

import { downloadEntries, listEntries, moduleMeta, runAction as applyAction } from '@/api/local-service'
import { DEMO_RULE_IDS, seedDemoNotifications, triggerDemoEvent } from '@/data/notify-demo'
import {
  BATCH_STATUS_LABELS,
  channelCredential,
  formatDateTime,
  formatDay,
  listNotificationBatches,
  listNotificationRules,
  notificationStats,
  pollNotificationBatches,
  restoreChannelCredential,
  setChannelCredential,
  settleOpenBatches,
} from '@/data/notify-service'
import type { NotificationBatch, NotificationBatchStatus } from '@/data/notify-types'
import type { EntryRow } from '@/data/types'

const meta = moduleMeta('notify')
const columns = [
  '规则编号',
  '触发条件',
  '通知渠道',
  '接收列表',
  '消息模板',
  '合并窗口秒',
  '重复抑制',
  '优先级',
]
const actions = ['提交校验', '启用通知', '停用通知']
const statuses = ['草稿', '待校验', '已启用', '已停用']

const BATCH_FILTER_STATUSES: NotificationBatchStatus[] = [
  'collecting',
  'pending',
  'paused',
  'sent',
  'partial',
  'failed',
  'withdrawn',
  'cancelled',
]

function batchTone(status: NotificationBatchStatus): string {
  if (status === 'sent') return 'ok'
  if (status === 'collecting' || status === 'pending' || status === 'sending') return 'info'
  if (status === 'paused') return 'warn'
  if (status === 'partial') return 'warn'
  if (status === 'withdrawn' || status === 'cancelled') return 'muted'
  return 'danger'
}

function sendProgress(batch: NotificationBatch): string {
  const sent = batch.deliveries.filter((item) => item.status === 'sent').length
  return `${sent}/${batch.deliveries.length}`
}

function batchRules(batch: NotificationBatch): string {
  const active = batch.contributions.filter((item) => !item.withdrawn)
  if (active.length === 0) {
    return '—'
  }
  return active
    .map((item) => `${item.ruleCode}（抑制 ${item.suppressedCount} 条）`)
    .join('、')
}

export default function NotifyView() {
  const [rows, setRows] = useState<EntryRow[]>([])
  const [total, setTotal] = useState(0)
  const [errorMessage, setErrorMessage] = useState('')
  const [notice, setNotice] = useState('')
  const [filters, setFilters] = useState<Record<string, string>>({})
  const [params, setParams] = useSearchParams()
  const [batches, setBatches] = useState<NotificationBatch[]>([])
  const [stats, setStats] = useState(() => notificationStats())
  const [expanded, setExpanded] = useState('')
  const filterFields = useMemo(() => columns.slice(0, 3), [])

  const statusFilter = params.get('batchStatus') ?? ''
  const channelFilter = params.get('batchChannel') ?? ''
  const keyword = params.get('batchKeyword') ?? ''

  const updateParam = useCallback(
    (key: string, value: string) => {
      const next = new URLSearchParams(params)
      if (value) {
        next.set(key, value)
      } else {
        next.delete(key)
      }
      setParams(next, { replace: true })
    },
    [params, setParams],
  )

  const reload = useCallback(() => {
    setErrorMessage('')
    try {
      const payload = listEntries(meta.key, filters)
      setRows(payload.items)
      setTotal(payload.total)
      setBatches(listNotificationBatches())
      setStats(notificationStats())
    } catch (error) {
      setErrorMessage(error instanceof Error ? error.message : '通知分发列表读取失败')
    }
  }, [filters])

  useEffect(() => {
    reload()
  }, [reload])

  // 合并窗口到点后自动结算，保证批次不会一直停在「合并中」。
  // 只在存在合并中 / 待发送的批次时轮询；凭据失效的渠道会由服务层暂停，不会误发。
  const hasOpenWork = batches.some(
    (batch) => batch.status === 'collecting' || batch.status === 'pending',
  )
  useEffect(() => {
    if (!hasOpenWork) {
      return
    }
    const timer = window.setInterval(() => {
      const result = pollNotificationBatches()
      if (result.changed || result.closed > 0 || result.dispatched > 0) {
        reload()
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [hasOpenWork, reload])

  const visibleBatches = useMemo(() => {
    const text = keyword.trim().toLowerCase()
    return batches.filter((batch) => {
      if (statusFilter && batch.status !== statusFilter) {
        return false
      }
      if (channelFilter && batch.channel !== channelFilter) {
        return false
      }
      if (!text) {
        return true
      }
      return (
        batch.id.toLowerCase().includes(text) ||
        batch.metric.toLowerCase().includes(text) ||
        batch.contributions.some((item) => item.ruleCode.toLowerCase().includes(text))
      )
    })
  }, [batches, statusFilter, channelFilter, keyword])

  const channels = useMemo(() => {
    const set = new Set<string>()
    for (const batch of batches) {
      set.add(batch.channel)
    }
    for (const rule of listNotificationRules()) {
      for (const channel of rule.channels) {
        set.add(channel)
      }
    }
    return [...set]
  }, [batches])

  function runAction(action: string, row: EntryRow) {
    setErrorMessage('')
    setNotice('')
    const result = applyAction(meta.key, Number(row.id), action)
    if (!result.ok) {
      setErrorMessage(result.message)
      return
    }
    setNotice(result.message)
    reload()
  }

  function trigger(ruleId: number) {
    setErrorMessage('')
    const message = triggerDemoEvent(ruleId)
    setNotice(`${message}；窗口结束后会结算成唯一通知批次`)
    reload()
  }

  function settleNow() {
    const result = settleOpenBatches()
    setNotice(result.summary)
    reload()
  }

  function pollOnce() {
    const result = pollNotificationBatches()
    setErrorMessage(result.pausedChannels.length > 0 ? result.summary : '')
    setNotice(result.pausedChannels.length > 0 ? '' : result.summary)
    reload()
  }

  function seedDemo() {
    const notes = seedDemoNotifications()
    setErrorMessage('')
    setNotice(notes.join('；'))
    reload()
  }

  function toggleCredential(channel: string) {
    const current = channelCredential(channel)
    if (current?.status === 'invalid') {
      const result = restoreChannelCredential(channel)
      setNotice(result.summary)
    } else {
      const result = setChannelCredential(channel, 'invalid', '凭据校验失败或已过期（演示）')
      setNotice(`渠道「${channel}」已标记凭据失效，${result.changed} 个待发送批次被保留并暂停轮询`)
    }
    setErrorMessage('')
    reload()
  }

  return (
    <section className="page" data-module="notify">
      <header className="page-head">
        <div>
          <h2>通知分发管理</h2>
          <p className="page-desc">
            通知按触发条件、通知渠道和合并窗口聚合成单个批次；发送失败只重试未送达部分，报告推送与普通告警共用通道时批次和送达记录互不覆盖。
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={seedDemo}>
            生成演示批次
          </button>
          <button
            className="btn"
            type="button"
            onClick={() => {
              // 同一个指标连点两次：验证一个窗口内只生成一个批次，多余事件被抑制。
              trigger(DEMO_RULE_IDS.primary)
              trigger(DEMO_RULE_IDS.overlapping)
              setNotice('已在同一合并窗口内各触发一次 9001 / 9002，事件会并入同一批次')
            }}
          >
            触发同一指标两条规则
          </button>
          <button className="btn" type="button" onClick={pollOnce}>
            轮询一次
          </button>
          <button className="btn" type="button" onClick={settleNow}>
            立即结算窗口
          </button>
          <button className="btn" type="button" onClick={() => downloadEntries(meta.key)}>
            导出通知分发清单
          </button>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">通知规则总数</span>
          <strong className="stat-value">{stats.rules}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">已启用规则</span>
          <strong className="stat-value">{stats.enabled}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">合并中批次</span>
          <strong className="stat-value">{stats.collecting}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">待发送 / 已暂停</span>
          <strong className="stat-value">
            {stats.pending} / {stats.paused}
          </strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">失败 / 部分送达</span>
          <strong className="stat-value">{stats.failed}</strong>
        </article>
      </div>

      <p className="status-legend">
        {statuses.map((status: string) => (
          <span key={status} className="legend-item">
            {status}：{rows.filter((row) => String(row.status) === status).length}
          </span>
        ))}
        {channels.map((channel) => {
          const state = channelCredential(channel)
          return (
            <span key={channel} className={`legend-item ${state?.status === 'invalid' ? 'legend-danger' : ''}`}>
              {channel}：{state?.status === 'invalid' ? '凭据失效，轮询暂停' : '凭据正常'}
            </span>
          )
        })}
      </p>

      <h3 className="section-title">通知规则</h3>

      <form className="filter-bar" onSubmit={(event) => { event.preventDefault(); reload() }}>
        {filterFields.map((field) => (
          <label key={field} className="filter-item">
            <span>{field}</span>
            <input
              value={filters[field] ?? ''}
              placeholder={`按${field}检索`}
              onChange={(event) => setFilters((prev) => ({ ...prev, [field]: event.target.value }))}
            />
          </label>
        ))}
        <button className="btn" type="submit">查询</button>
        <button className="btn ghost" type="button" onClick={() => setFilters({})}>重置条件</button>
      </form>

      <table className="data-table">
        <thead>
          <tr>
            {columns.map((column) => <th key={column}>{column}</th>)}
            <th>当前状态</th>
            <th>可执行动作</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => (
            <tr key={String(row.id)}>
              {columns.map((column) => <td key={column}>{row[column] ?? '—'}</td>)}
              <td>{row.status}</td>
              <td className="row-actions">
                {actions.map((action) => (
                  <button key={action} className="link" type="button" onClick={() => runAction(action, row)}>
                    {action}
                  </button>
                ))}
                {String(row.status) === '已启用' && (
                  <button className="link" type="button" onClick={() => trigger(Number(row.id))}>
                    触发一次事件
                  </button>
                )}
              </td>
            </tr>
          ))}
          {rows.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={columns.length + 2}>暂无通知分发数据，可先登记通知规则</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">通知批次</h3>
      <div className="filter-bar">
        <label className="filter-item">
          <span>批次 / 指标 / 规则</span>
          <input
            value={keyword}
            placeholder="按批次号、指标或规则编号检索"
            onChange={(event) => updateParam('batchKeyword', event.target.value)}
          />
        </label>
        <label className="filter-item">
          <span>批次状态</span>
          <select value={statusFilter} onChange={(event) => updateParam('batchStatus', event.target.value)}>
            <option value="">全部</option>
            {BATCH_FILTER_STATUSES.map((status) => (
              <option key={status} value={status}>{BATCH_STATUS_LABELS[status]}</option>
            ))}
          </select>
        </label>
        <label className="filter-item">
          <span>通知渠道</span>
          <select value={channelFilter} onChange={(event) => updateParam('batchChannel', event.target.value)}>
            <option value="">全部</option>
            {channels.map((channel) => (
              <option key={channel} value={channel}>{channel}</option>
            ))}
          </select>
        </label>
        <button
          className="btn ghost"
          type="button"
          onClick={() => setParams(new URLSearchParams(), { replace: true })}
        >
          重置批次筛选
        </button>
      </div>

      <table className="data-table">
        <thead>
          <tr>
            <th>批次编号</th>
            <th>监控指标</th>
            <th>渠道</th>
            <th>合并窗口（归属日）</th>
            <th>原始 / 抑制</th>
            <th>触发规则</th>
            <th>送达进度</th>
            <th>批次状态</th>
            <th>失败旁证</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {visibleBatches.map((batch) => (
            <tr key={batch.id}>
              <td>{batch.id}</td>
              <td>{batch.metric}</td>
              <td>{batch.channel}</td>
              <td>
                {formatDateTime(batch.windowStart)} → {formatDateTime(batch.windowEnd)}
                <br />
                <span className="muted-text">归属 {formatDay(batch.windowStart)}</span>
              </td>
              <td>
                {batch.rawEventCount} / {batch.suppressedCount}
                {batch.withdrawnEventCount > 0 && (
                  <span className="muted-text">（撤回 {batch.withdrawnEventCount}）</span>
                )}
              </td>
              <td>{batchRules(batch)}</td>
              <td>{sendProgress(batch)}</td>
              <td>
                <span className={`badge ${batchTone(batch.status)}`}>{BATCH_STATUS_LABELS[batch.status]}</span>
              </td>
              <td>
                {batch.failureEvidence.length === 0 && batch.withdrawnEventCount === 0 ? (
                  <span className="muted-text">—</span>
                ) : batch.failureEvidence.length === 0 ? (
                  <span className="muted-text">已撤回 {batch.withdrawnEventCount} 条，无发送失败</span>
                ) : (
                  <button
                    className="link"
                    type="button"
                    onClick={() => setExpanded(expanded === batch.id ? '' : batch.id)}
                  >
                    {batch.failureEvidence.length} 条（{expanded === batch.id ? '收起' : '展开'}）
                  </button>
                )}
                {expanded === batch.id && (
                  <ul className="evidence-list">
                    {batch.failureEvidence.map((item, index) => (
                      <li key={index}>{item}</li>
                    ))}
                  </ul>
                )}
              </td>
              <td className="row-actions">
                <Link
                  className="link"
                  to={`/notify/batches/${batch.id}`}
                  state={{ from: `/notify?${params.toString()}` }}
                >
                  详情
                </Link>
              </td>
            </tr>
          ))}
          {visibleBatches.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={10}>
                没有符合条件的通知批次，可点「生成演示批次」或触发一次规则事件
              </td>
            </tr>
          )}
        </tbody>
      </table>

      <div className="channel-row">
        {channels.map((channel) => {
          const state = channelCredential(channel)
          return (
            <article key={channel} className="channel-card">
              <div>
                <strong>{channel}</strong>
                <span className={`badge ${state?.status === 'invalid' ? 'danger' : 'ok'}`}>
                  {state?.status === 'invalid' ? '凭据失效' : '凭据正常'}
                </span>
              </div>
              <p className="muted-text">
                {state?.status === 'invalid'
                  ? `${state.reason}｜待发送批次已保留，轮询暂停`
                  : '凭据可用，窗口到期后自动发送'}
              </p>
              <button className="btn" type="button" onClick={() => toggleCredential(channel)}>
                {state?.status === 'invalid' ? '恢复凭据并续发' : '标记凭据失效'}
              </button>
            </article>
          )
        })}
      </div>

      <footer className="page-foot">
        <span>共 {total} 条通知规则，{visibleBatches.length} / {batches.length} 个批次</span>
        <span className="page-messages">
          {notice && <span className="notice-text">{notice}</span>}
          {errorMessage && <span className="error-text">{errorMessage}</span>}
        </span>
      </footer>
    </section>
  )
}
