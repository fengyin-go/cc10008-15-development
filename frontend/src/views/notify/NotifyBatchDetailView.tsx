import { useCallback, useEffect, useMemo, useState } from 'react'
import { Link, useLocation, useNavigate, useParams, useSearchParams } from 'react-router-dom'

import {
  BATCH_STATUS_LABELS,
  DELIVERY_STATUS_LABELS,
  SOURCE_LABELS,
  cancelSubscription,
  formatDateTime,
  formatDay,
  getNotificationBatch,
  markDeliveryFailure,
  normalizeRecipient,
  renderBatchPreview,
  resendDelivery,
  restoreChannelCredential,
  pollNotificationBatches,
  retryUnsentDeliveries,
  subscriptionOf,
  suppressDelivery,
} from '@/data/notify-service'
import type { NotificationBatch, NotificationDelivery } from '@/data/notify-types'

function deliveryTone(status: NotificationDelivery['status']): string {
  if (status === 'sent') return 'ok'
  if (status === 'pending' || status === 'sending') return 'info'
  if (status === 'invalid' || status === 'failed') return 'danger'
  return 'muted'
}

function batchTone(status: NotificationBatch['status']): string {
  if (status === 'sent') return 'ok'
  if (status === 'collecting' || status === 'pending' || status === 'sending') return 'info'
  if (status === 'paused' || status === 'partial') return 'warn'
  if (status === 'withdrawn' || status === 'cancelled') return 'muted'
  return 'danger'
}

export default function NotifyBatchDetailView() {
  const { batchId = '' } = useParams()
  const location = useLocation()
  const navigate = useNavigate()
  const [params] = useSearchParams()
  const [batch, setBatch] = useState<NotificationBatch | undefined>(undefined)
  const [notice, setNotice] = useState('')
  const [errorMessage, setErrorMessage] = useState('')
  const [expanded, setExpanded] = useState('')

  // 返回列表时优先沿用进入详情前的筛选参数；没有就退回当前查询串。
  const backTo = useMemo(() => {
    const state = location.state as { from?: string } | null
    if (state?.from) {
      return state.from
    }
    const search = params.toString()
    return search ? `/notify?${search}` : '/notify'
  }, [location.state, params])

  const reload = useCallback(() => {
    const next = getNotificationBatch(batchId)
    // 服务层返回的是持久化对象的同一引用，复制一份才能让 React 重新渲染。
    setBatch(next ? (JSON.parse(JSON.stringify(next)) as NotificationBatch) : undefined)
  }, [batchId])

  useEffect(() => {
    reload()
  }, [reload])

  // 批次仍在合并窗口中时定期结算，避免详情页一直显示「合并中」。
  useEffect(() => {
    if (!batch || batch.status !== 'collecting') {
      return
    }
    const timer = window.setInterval(() => {
      const result = pollNotificationBatches()
      if (result.changed || result.closed > 0 || result.dispatched > 0) {
        reload()
      }
    }, 2000)
    return () => window.clearInterval(timer)
  }, [batch, reload])

  function run(operation: () => { ok: boolean; message: string }) {
    const result = operation()
    if (!result.ok) {
      setErrorMessage(result.message)
      setNotice('')
    } else {
      setErrorMessage('')
      setNotice(result.message)
    }
    reload()
  }

  function retryAll() {
    const result = retryUnsentDeliveries(batchId)
    if (result.retried === 0) {
      setErrorMessage('没有可重试的未送达对象')
    } else {
      setErrorMessage('')
    }
    setNotice(`已重试 ${result.retried} 个未送达对象，已送达记录保持不变`)
    reload()
  }

  if (!batch) {
    return (
      <section className="page">
        <header className="page-head">
          <div>
            <h2>通知批次详情</h2>
            <p className="page-desc">批次可能已被清除或重置。</p>
          </div>
          <Link className="btn" to={backTo}>返回通知列表</Link>
        </header>
        <p className="error-text">没有找到批次 {batchId}</p>
      </section>
    )
  }

  const preview = renderBatchPreview(batch.id)
  const activeContributions = batch.contributions.filter((item) => !item.withdrawn)
  const withdrawnContributions = batch.contributions.filter((item) => item.withdrawn)

  return (
    <section className="page" data-module="notify-detail">
      <header className="page-head">
        <div>
          <h2>通知批次 {batch.id}</h2>
          <p className="page-desc">
            {batch.metric}｜{batch.channel}｜合并窗口 {formatDateTime(batch.windowStart)} → {formatDateTime(batch.windowEnd)}
          </p>
        </div>
        <div className="page-actions">
          <button className="btn" type="button" onClick={retryAll}>
            重试未送达部分
          </button>
          <Link className="btn" to={backTo}>返回通知列表</Link>
        </div>
      </header>

      <div className="stat-row">
        <article className="stat-card">
          <span className="stat-label">批次状态</span>
          <strong className="stat-value">
            <span className={`badge ${batchTone(batch.status)}`}>{BATCH_STATUS_LABELS[batch.status]}</span>
          </strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">原始事件 / 被抑制</span>
          <strong className="stat-value">{batch.rawEventCount} / {batch.suppressedCount}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">归属日（按窗口开始）</span>
          <strong className="stat-value">{formatDay(batch.windowStart)}</strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">送达 / 总数</span>
          <strong className="stat-value">
            {batch.deliveries.filter((item) => item.status === 'sent').length} / {batch.deliveries.length}
          </strong>
        </article>
        <article className="stat-card">
          <span className="stat-label">来源</span>
          <strong className="stat-value">
            {batch.sourceKinds.map((kind) => SOURCE_LABELS[kind] ?? kind).join('、')}
          </strong>
        </article>
      </div>

      <p className={`batch-reason ${batchTone(batch.status)}`}>{batch.statusReason}</p>

      <h3 className="section-title">参与合并的规则</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>规则编号</th>
            <th>触发条件</th>
            <th>优先级</th>
            <th>原始事件</th>
            <th>被抑制</th>
            <th>首 / 末事件</th>
            <th>状态</th>
          </tr>
        </thead>
        <tbody>
          {batch.contributions.map((item) => (
            <tr key={`${item.ruleId}-${item.firstEventAt}`}>
              <td>{item.ruleCode}</td>
              <td>{item.condition}</td>
              <td>{item.priority}</td>
              <td>{item.rawEventCount}</td>
              <td>{item.suppressedCount}</td>
              <td>
                {formatDateTime(item.firstEventAt)} / {formatDateTime(item.lastEventAt)}
              </td>
              <td>
                {item.withdrawn ? (
                  <span className="badge muted">已撤回（窗口内 {item.rawEventCount} 条未发送）</span>
                ) : (
                  <span className="badge info">合并中/已合并</span>
                )}
              </td>
            </tr>
          ))}
        </tbody>
      </table>
      {withdrawnContributions.length > 0 && (
        <p className="muted-text">
          规则停用后，{withdrawnContributions.map((item) => item.ruleCode).join('、')} 的待发送事件已撤回；
          已经送达的事件不会因规则恢复而补发。
        </p>
      )}

      <h3 className="section-title">送达记录</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>接收地址</th>
            <th>状态</th>
            <th>尝试次数</th>
            <th>失败旁证</th>
            <th>操作</th>
          </tr>
        </thead>
        <tbody>
          {batch.deliveries.map((delivery) => {
            const channel = batch.channel
            const unsubscribed = subscriptionOf(channel, delivery.recipient)?.active === false
            return (
              <tr key={delivery.id}>
                <td>{delivery.recipient || '（空地址）'}</td>
                <td>
                  <span className={`badge ${deliveryTone(delivery.status)}`}>
                    {DELIVERY_STATUS_LABELS[delivery.status]}
                  </span>
                </td>
                <td>{delivery.attempts}</td>
                <td>
                  {delivery.lastError && <p className="error-text">{delivery.lastError}</p>}
                  <button
                    className="link"
                    type="button"
                    onClick={() => setExpanded(expanded === delivery.id ? '' : delivery.id)}
                  >
                    {delivery.evidence.length} 条旁证（{expanded === delivery.id ? '收起' : '展开'}）
                  </button>
                  {expanded === delivery.id && (
                    <ul className="evidence-list">
                      {delivery.evidence.map((item, index) => (
                        <li key={index}>{item}</li>
                      ))}
                    </ul>
                  )}
                </td>
                <td className="row-actions">
                  {(delivery.status === 'sent' || delivery.status === 'pending') && !unsubscribed && (
                    <button
                      className="link"
                      type="button"
                      onClick={() =>
                        run(() => {
                          const result = cancelSubscription(channel, delivery.recipient)
                          return {
                            ok: true,
                            message: `已将 ${normalizeRecipient(channel, delivery.recipient).normalized} 标记为取消接收，旧批次重试也不会再发送（本次取消 ${result.cancelled} 条）`,
                          }
                        })
                      }
                    >
                      取消接收
                    </button>
                  )}
                  {unsubscribed && <span className="muted-text">已取消接收，不会重发</span>}
                  {delivery.status === 'pending' && (
                    <button
                      className="link"
                      type="button"
                      onClick={() => run(() => markDeliveryFailure(batch.id, delivery.id))}
                    >
                      模拟失败
                    </button>
                  )}
                  {(delivery.status === 'failed' || delivery.status === 'cancelled') && (
                    <button
                      className="link"
                      type="button"
                      onClick={() => run(() => resendDelivery(batch.id, delivery.id))}
                    >
                      仅重发这条
                    </button>
                  )}
                  {(delivery.status === 'pending' || delivery.status === 'failed') && (
                    <button
                      className="link"
                      type="button"
                      onClick={() => run(() => suppressDelivery(batch.id, delivery.id))}
                    >
                      抑制补发
                    </button>
                  )}
                </td>
              </tr>
            )
          })}
          {batch.deliveries.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={5}>批次还没有送达对象</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">异常证据（原始事件）</h3>
      <table className="data-table">
        <thead>
          <tr>
            <th>事件编号</th>
            <th>规则</th>
            <th>发生时间</th>
            <th>观测值</th>
            <th>说明</th>
            <th>事件状态</th>
          </tr>
        </thead>
        <tbody>
          {batch.evidence.map((event) => (
            <tr key={event.id}>
              <td>{event.id}</td>
              <td>{event.ruleCode}</td>
              <td>{formatDateTime(event.occurredAt)}</td>
              <td>{event.value}</td>
              <td>{event.detail}</td>
              <td>
                {event.status === 'notified' && <span className="badge ok">已送达并保留</span>}
                {event.status === 'withdrawn' && <span className="badge muted">已撤回，不补发</span>}
                {event.status === 'batched' && <span className="badge info">已并入批次</span>}
              </td>
            </tr>
          ))}
          {batch.evidence.length === 0 && (
            <tr>
              <td className="empty-state" colSpan={6}>批次没有原始事件</td>
            </tr>
          )}
        </tbody>
      </table>

      <h3 className="section-title">失败旁证汇总</h3>
      {batch.failureEvidence.length === 0 ? (
        <p className="muted-text">该批次没有失败或无效记录。</p>
      ) : (
        <ul className="evidence-list">
          {batch.failureEvidence.map((item, index) => <li key={index}>{item}</li>)}
        </ul>
      )}

      <h3 className="section-title">渲染后的消息</h3>
      {preview.ok ? (
        <pre className="message-preview">{preview.text}</pre>
      ) : (
        <p className="error-text">
          渲染失败：{preview.error}。仅拒绝渠道「{batch.channel}」，其他渠道已送达记录不受影响。
        </p>
      )}
      {preview.ok && (
        <p className="muted-text">
          {renderNote(batch)} 已发送 {batch.deliveries.filter((item) => item.status === 'sent').length} 条；
          同批次其余渠道的送达记录各自独立保存。
        </p>
      )}

      {activeContributions.length === 0 && withdrawnContributions.length > 0 && (
        <p className="notice-text">该批次所有规则已停用：待发送事件已撤回，已送达记录仍然保留。</p>
      )}

      <div className="page-actions detail-foot">
        <button
          className="btn"
          type="button"
          onClick={() => {
            const state = getNotificationBatch(batch.id)
            if (state) {
              restoreChannelCredential(state.channel)
              setNotice(`渠道「${state.channel}」凭据已恢复，仅续发未送达对象`)
              reload()
            }
          }}
        >
          恢复渠道凭据并续发
        </button>
        <button className="btn ghost" type="button" onClick={() => navigate(backTo)}>
          返回列表
        </button>
      </div>

      <footer className="page-foot">
        <span>批次创建 {formatDateTime(batch.createdAt)}，最近更新 {formatDateTime(batch.updatedAt)}</span>
        <span className="page-messages">
          {notice && <span className="notice-text">{notice}</span>}
          {errorMessage && <span className="error-text">{errorMessage}</span>}
        </span>
      </footer>
    </section>
  )
}

function renderNote(batch: NotificationBatch): string {
  if (batch.renderedMessage) {
    return `批次已在 ${formatDateTime(batch.sentAt ?? batch.updatedAt)} 按模板渲染；`
  }
  return '批次已按模板渲染；'
}
