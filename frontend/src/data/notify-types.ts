import type { EntryRow } from './types'

/**
 * 通知批次领域类型。
 *
 * 这里的结构独立于页面：批次、原始事件、送达记录都持久化在 localStorage 里，
 * 刷新页面或从明细返回列表后仍然保持一致。
 */

export type NotificationSource = 'anomaly' | 'reportgen'

export type NotificationEventStatus = 'batched' | 'notified' | 'withdrawn'

export type NotificationDeliveryStatus =
  | 'pending'
  | 'sending'
  | 'sent'
  | 'failed'
  | 'invalid'
  | 'cancelled'

export type NotificationBatchStatus =
  | 'collecting'
  | 'pending'
  | 'sending'
  | 'paused'
  | 'sent'
  | 'partial'
  | 'failed'
  | 'withdrawn'
  | 'cancelled'

export type NotificationRule = {
  id: number
  code: string
  metric: string
  condition: string
  channel: string
  /** 一条规则可以配置多个渠道；每个渠道各自聚合成批次。 */
  channels: string[]
  recipients: string[]
  template: string
  mergeWindowSec: number
  dedupe: boolean
  priority: string
  enabled: boolean
  sourceRow: EntryRow
}

export type NotificationEvent = {
  id: string
  batchId: string
  ruleId: number
  ruleCode: string
  source: NotificationSource
  metric: string
  condition: string
  channel: string
  occurredAt: number
  value: string
  detail: string
  status: NotificationEventStatus
}

export type BatchContribution = {
  ruleId: number
  ruleCode: string
  priority: string
  condition: string
  /** 该规则是否开启重复抑制；批次本身始终只生成一条通知。 */
  dedupe: boolean
  template: string
  recipients: string[]
  mergeWindowSec: number
  rawEventCount: number
  suppressedCount: number
  eventIds: string[]
  firstEventAt: number
  lastEventAt: number
  withdrawn: boolean
  withdrawnAt?: number
}

export type NotificationDelivery = {
  id: string
  batchId: string
  channel: string
  recipient: string
  normalizedRecipient: string
  status: NotificationDeliveryStatus
  attempts: number
  lastError: string
  evidence: string[]
  /** 该接收人来自哪些规则；撤回单条规则时用来判断是否还有其他规则要发。 */
  ruleIds: number[]
  /** 地址格式是否有效；无效地址只隔离这一条，不影响同批其他对象。 */
  valid: boolean
  createdAt: number
  updatedAt: number
  sentAt?: number
}

export type NotificationBatch = {
  id: string
  metric: string
  channel: string
  sourceKinds: NotificationSource[]
  windowStart: number
  windowEnd: number
  /** 参与聚合的合并窗口秒数：同指标同渠道但窗口长度不同，不并入同一批次。 */
  windowSeconds: number
  status: NotificationBatchStatus
  statusReason: string
  contributions: BatchContribution[]
  evidence: NotificationEvent[]
  rawEventCount: number
  suppressedCount: number
  withdrawnEventCount: number
  deliveries: NotificationDelivery[]
  failureEvidence: string[]
  renderedMessage?: string
  forcedTemplateError?: string
  pauseReason?: string
  createdAt: number
  updatedAt: number
  finalizedAt?: number
  sentAt?: number
}

export type ChannelCredentialState = {
  status: 'valid' | 'invalid'
  reason: string
  updatedAt: number
}

export type SubscriptionRecord = {
  channel: string
  recipient: string
  active: boolean
  updatedAt: number
}

export type NotificationState = {
  version: 1
  sequence: number
  events: NotificationEvent[]
  batches: NotificationBatch[]
  credentials: Record<string, ChannelCredentialState>
  subscriptions: Record<string, SubscriptionRecord>
  lastPollAt?: number
}

export type IngestNotificationInput = {
  ruleId: number
  source?: NotificationSource
  occurredAt?: number
  value?: string
  detail?: string
}

export type IngestNotificationResult = {
  accepted: boolean
  reason: string
  batchId?: string
  eventId?: string
}

export type PollNotificationResult = {
  changed: boolean
  closed: number
  dispatched: number
  pausedChannels: string[]
  summary: string
}

export type WithdrawRuleResult = {
  batches: number
  events: number
}

export type RetryBatchResult = {
  retried: number
  batch?: NotificationBatch
}
