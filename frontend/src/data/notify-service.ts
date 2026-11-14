import { listRows } from './local-store'
import type {
  BatchContribution,
  ChannelCredentialState,
  IngestNotificationInput,
  IngestNotificationResult,
  NotificationBatch,
  NotificationBatchStatus,
  NotificationDelivery,
  NotificationDeliveryStatus,
  NotificationEvent,
  NotificationRule,
  NotificationSource,
  NotificationState,
  PollNotificationResult,
  RetryBatchResult,
  SubscriptionRecord,
  WithdrawRuleResult,
} from './notify-types'

/**
 * 通知合并与送达的本地引擎。
 *
 * - 原始事件按「监控指标 + 通知渠道 + 合并窗口秒」聚合成一个批次；
 * - 批次与送达记录分别持久化，报告推送与普通告警共用渠道时互不覆盖；
 * - 所有发送动作都是幂等的：只处理未送达的地址，已送达记录不会重发。
 */

const STORAGE_KEY = 'interactive-analytics-lab:notify-state'
const SMS_RENDER_LIMIT = 120
const EMAIL_RENDER_LIMIT = 5000

export const BATCH_STATUS_LABELS: Record<NotificationBatchStatus, string> = {
  collecting: '合并中',
  pending: '待发送',
  sending: '发送中',
  paused: '已暂停',
  sent: '已送达',
  partial: '部分送达',
  failed: '发送失败',
  withdrawn: '已撤回',
  cancelled: '已取消',
}

export const DELIVERY_STATUS_LABELS: Record<NotificationDeliveryStatus, string> = {
  pending: '待发送',
  sending: '发送中',
  sent: '已送达',
  failed: '发送失败',
  invalid: '地址无效',
  cancelled: '已取消',
}

export const SOURCE_LABELS: Record<NotificationSource, string> = {
  anomaly: '异常告警',
  reportgen: '报告推送',
}

let cache: NotificationState | null = null

function defaultState(): NotificationState {
  return {
    version: 1,
    sequence: 0,
    events: [],
    batches: [],
    credentials: {},
    subscriptions: {},
  }
}

function normalizeState(raw: unknown): NotificationState {
  const fallback = defaultState()
  if (!raw || typeof raw !== 'object') {
    return fallback
  }
  const parsed = raw as Partial<NotificationState>
  if (parsed.version !== 1 || !Array.isArray(parsed.batches) || !Array.isArray(parsed.events)) {
    return fallback
  }
  return {
    version: 1,
    sequence: Number(parsed.sequence) || 0,
    events: parsed.events.filter((item) => Object.prototype.hasOwnProperty.call(item, 'id')),
    // 老数据没有 windowSeconds 字段：按已有窗口补出来，刷新后仍能接着聚合。
    batches: parsed.batches
      .filter((item) => Object.prototype.hasOwnProperty.call(item, 'id'))
      .map((item) => ({
        ...item,
        windowSeconds:
          Number(item.windowSeconds) > 0
            ? Number(item.windowSeconds)
            : Math.max(1, Math.round((Number(item.windowEnd) - Number(item.windowStart)) / 1000)),
        withdrawnEventCount: Number(item.withdrawnEventCount) || 0,
        failureEvidence: Array.isArray(item.failureEvidence) ? item.failureEvidence : [],
        deliveries: (item.deliveries ?? []).map((delivery) => ({
          ...delivery,
          valid: delivery.valid ?? delivery.status !== 'invalid',
          evidence: Array.isArray(delivery.evidence) ? delivery.evidence : [],
          ruleIds: Array.isArray(delivery.ruleIds) ? delivery.ruleIds : [],
        })),
      })),
    credentials: parsed.credentials && typeof parsed.credentials === 'object' ? parsed.credentials : {},
    subscriptions: parsed.subscriptions && typeof parsed.subscriptions === 'object' ? parsed.subscriptions : {},
    lastPollAt: Number(parsed.lastPollAt) || undefined,
  }
}

function readState(): NotificationState {
  if (cache !== null) {
    return cache
  }
  if (typeof window === 'undefined' || !window.localStorage) {
    cache = defaultState()
    return cache
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    cache = defaultState()
    return cache
  }
  try {
    cache = normalizeState(JSON.parse(raw) as unknown)
  } catch {
    cache = defaultState()
  }
  return cache
}

function persist(state: NotificationState): void {
  cache = state
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(state))
  }
}

export function resetNotificationState(): void {
  cache = defaultState()
  persist(cache)
}

export function notificationStorageKey(): string {
  return STORAGE_KEY
}

// ---------------------------------------------------------------------------
// 时间与解析
// ---------------------------------------------------------------------------

function pad(value: number, length = 2): string {
  return String(value).padStart(length, '0')
}

export function formatDateTime(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())} ${pad(date.getHours())}:${pad(date.getMinutes())}:${pad(date.getSeconds())}`
}

export function formatDay(timestamp: number): string {
  const date = new Date(timestamp)
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`
}

function hashString(text: string): string {
  let hash = 5381
  for (let index = 0; index < text.length; index += 1) {
    hash = ((hash << 5) + hash + text.charCodeAt(index)) >>> 0
  }
  return hash.toString(36)
}

function splitList(value: unknown, patterns: RegExp): string[] {
  if (value === undefined || value === null) {
    return []
  }
  return String(value)
    .split(patterns)
    .map((item) => item.trim())
    .filter((item) => item.length > 0)
}

function parseWindowSeconds(value: unknown): number {
  const parsed = Number(String(value ?? '').replace(/[^0-9.]/g, ''))
  if (!Number.isFinite(parsed) || parsed <= 0) {
    return 60
  }
  return Math.max(1, Math.round(parsed))
}

function parseMetric(condition: string): string {
  // 只取第一个分号前的片段，避免条件里的“；”被当成分隔符。
  const head = condition.split(/[；;]/)[0] ?? ''
  const matched = head.match(/监控指标\s*(?:[=：:]|为)\s*([^，,。|]+)/)
  if (matched && matched[1].trim()) {
    return matched[1].trim()
  }
  return head.trim() || '未命名指标'
}

function parseBoolean(value: unknown, fallback = true): boolean {
  const text = String(value ?? '').trim()
  if (!text) {
    return fallback
  }
  return ['是', 'true', '1', '开启', '启用', 'on'].includes(text.toLowerCase())
}

export function listNotificationRules(): NotificationRule[] {
  return listRows('notify').map((row) => {
    const condition = String(row['触发条件'] ?? '')
    const channels = splitList(row['通知渠道'], /[\/、|,，；;]/)
    return {
      id: Number(row.id),
      code: String(row['规则编号'] ?? `NOTI-${pad(Number(row.id), 4)}`),
      metric: parseMetric(condition),
      condition: condition || '未填写触发条件',
      channel: String(row['通知渠道'] ?? ''),
      channels: channels.length > 0 ? channels : [String(row['通知渠道'] ?? '').trim()].filter(Boolean),
      recipients: splitList(row['接收列表'], /[;；,，、\n]/),
      template: String(row['消息模板'] ?? ''),
      mergeWindowSec: parseWindowSeconds(row['合并窗口秒']),
      dedupe: parseBoolean(row['重复抑制']),
      priority: String(row['优先级'] ?? 'P3'),
      enabled: String(row.status ?? '') === '已启用',
      sourceRow: row,
    }
  })
}

function ruleById(ruleId: number): NotificationRule | undefined {
  return listNotificationRules().find((rule) => rule.id === ruleId)
}

// ---------------------------------------------------------------------------
// 地址与模板
// ---------------------------------------------------------------------------

type ChannelKind = 'email' | 'sms' | 'other'

function channelKind(channel: string): ChannelKind {
  const text = channel.toLowerCase()
  if (text.includes('邮件') || text.includes('email') || text.includes('mail')) {
    return 'email'
  }
  if (text.includes('短信') || text.includes('sms')) {
    return 'sms'
  }
  return 'other'
}

export type NormalizedRecipient = {
  raw: string
  normalized: string
  valid: boolean
  error: string
}

export function normalizeRecipient(channel: string, raw: string): NormalizedRecipient {
  const trimmed = raw.trim()
  const kind = channelKind(channel)
  if (kind === 'email') {
    const normalized = trimmed.replace(/^mailto:/i, '').replace(/[<>]/g, '').trim().toLowerCase()
    const valid = /^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(normalized)
    return {
      raw: trimmed,
      normalized,
      valid,
      error: valid ? '' : `邮箱地址格式无效：${trimmed || '空地址'}`,
    }
  }
  if (kind === 'sms') {
    const normalized = trimmed.replace(/[\s-]/g, '').replace(/^00/, '+')
    const valid = /^\+?\d{9,15}$/.test(normalized)
    return {
      raw: trimmed,
      normalized,
      valid,
      error: valid ? '' : `手机号格式无效：${trimmed || '空地址'}`,
    }
  }
  const normalized = trimmed.toLowerCase()
  const valid = normalized.length > 0 && normalized.length <= 128 && !/\s/.test(normalized)
  return {
    raw: trimmed,
    normalized,
    valid,
    error: valid ? '' : `接收地址不可用：${trimmed || '空地址'}`,
  }
}

function uniqueRecipients(
  contributions: BatchContribution[],
  channel: string,
): { recipient: string; normalized: string; valid: boolean; error: string; ruleIds: number[] }[] {
  const map = new Map<string, { recipient: string; normalized: string; valid: boolean; error: string; ruleIds: number[] }>()
  for (const contribution of contributions) {
    if (contribution.withdrawn) {
      continue
    }
    for (const raw of contribution.recipients) {
      const checked = normalizeRecipient(channel, raw)
      const key = checked.normalized || `empty:${raw}`
      const existing = map.get(key)
      if (existing) {
        if (!existing.ruleIds.includes(contribution.ruleId)) {
          existing.ruleIds.push(contribution.ruleId)
        }
        continue
      }
      map.set(key, {
        recipient: checked.raw,
        normalized: checked.normalized,
        valid: checked.valid,
        error: checked.error,
        ruleIds: [contribution.ruleId],
      })
    }
  }
  return [...map.values()]
}

type RenderResult = { ok: true; text: string } | { ok: false; error: string }

function primaryContribution(batch: NotificationBatch): BatchContribution | undefined {
  return batch.contributions
    .filter((item) => !item.withdrawn)
    .sort((left, right) => {
      if (left.firstEventAt !== right.firstEventAt) {
        return left.firstEventAt - right.firstEventAt
      }
      return left.ruleId - right.ruleId
    })[0]
}

function templateVariables(batch: NotificationBatch, contribution: BatchContribution): Record<string, string> {
  const active = batch.contributions.filter((item) => !item.withdrawn)
  const rules = active
    .map((item) => `${item.ruleCode}（${item.condition}）`)
    .join('；')
  const lastEvent = [...batch.evidence]
    .filter((event) => event.status !== 'withdrawn')
    .sort((left, right) => right.occurredAt - left.occurredAt)[0]
  const representedEventCount = active.reduce((sum, item) => sum + item.rawEventCount, 0)
  return {
    metric: batch.metric,
    指标: batch.metric,
    condition: contribution.condition,
    条件: contribution.condition,
    count: String(representedEventCount),
    数量: String(representedEventCount),
    suppressed: String(batch.suppressedCount),
    抑制: String(batch.suppressedCount),
    window: `${formatDateTime(batch.windowStart)} → ${formatDateTime(batch.windowEnd)}`,
    窗口: `${formatDateTime(batch.windowStart)} → ${formatDateTime(batch.windowEnd)}`,
    windowStart: formatDateTime(batch.windowStart),
    windowEnd: formatDateTime(batch.windowEnd),
    attribution: formatDay(batch.windowStart),
    归属日: formatDay(batch.windowStart),
    channel: batch.channel,
    渠道: batch.channel,
    priority: contribution.priority,
    优先级: contribution.priority,
    rules,
    规则: rules,
    source: SOURCE_LABELS[batch.sourceKinds[0] ?? 'anomaly'],
    来源: SOURCE_LABELS[batch.sourceKinds[0] ?? 'anomaly'],
    value: lastEvent?.value ?? '',
    值: lastEvent?.value ?? '',
  }
}

/**
 * 渲染消息。语法错误会让整批失败；渠道自身的限制（例如短信长度）只拒绝该渠道，
 * 不影响同规则其他渠道已经送达的记录。
 */
export function renderBatchMessage(batch: NotificationBatch): RenderResult {
  const primary = primaryContribution(batch)
  if (!primary) {
    return { ok: false, error: '没有生效中的规则可渲染消息模板' }
  }
  // 模板优先用规则当前配置：修好模板后重试可以成功；规则已停用时退回入批时的快照。
  const liveRule = listNotificationRules().find((rule) => rule.id === primary.ruleId)
  const template = (liveRule?.enabled ? liveRule.template : primary.template).trim()
  if (!template) {
    return { ok: false, error: `规则 ${primary.ruleCode} 的消息模板为空` }
  }
  const variables = templateVariables(batch, primary)
  let unknown = ''
  const rendered = template.replace(/\{\{([^{}]+)\}\}/g, (_match, token: string) => {
    const key = token.trim()
    if (Object.prototype.hasOwnProperty.call(variables, key)) {
      return variables[key]
    }
    if (!unknown) {
      unknown = key
    }
    return ''
  })
  if (unknown) {
    return { ok: false, error: `消息模板占位符 {{${unknown}}} 未登记，渲染失败` }
  }
  if (rendered.includes('{{') || rendered.includes('}}')) {
    return { ok: false, error: '消息模板占位符未闭合，渲染失败' }
  }
  if (channelKind(batch.channel) === 'sms' && rendered.length > SMS_RENDER_LIMIT) {
    return {
      ok: false,
      error: `短信渲染结果 ${rendered.length} 字，超过 ${SMS_RENDER_LIMIT} 字上限，仅拒绝该渠道`,
    }
  }
  if (channelKind(batch.channel) === 'email' && rendered.length > EMAIL_RENDER_LIMIT) {
    return {
      ok: false,
      error: `邮件渲染结果 ${rendered.length} 字，超过 ${EMAIL_RENDER_LIMIT} 字上限，仅拒绝该渠道`,
    }
  }
  return { ok: true, text: rendered }
}

export function renderBatchPreview(batchId: string): RenderResult {
  const batch = getNotificationBatch(batchId)
  if (!batch) {
    return { ok: false, error: `没有找到批次 ${batchId}` }
  }
  return renderBatchMessage(batch)
}

// ---------------------------------------------------------------------------
// 批次与送达的基础维护
// ---------------------------------------------------------------------------

function recomputeSuppression(batch: NotificationBatch): void {
  const active = batch.contributions
    .filter((item) => !item.withdrawn)
    .sort((left, right) => {
      if (left.firstEventAt !== right.firstEventAt) {
        return left.firstEventAt - right.firstEventAt
      }
      return left.ruleId - right.ruleId
    })
  let represented = false
  for (const contribution of active) {
    contribution.suppressedCount = represented
      ? contribution.rawEventCount
      : Math.max(0, contribution.rawEventCount - 1)
    represented = true
  }
  // 已撤回的规则没有参与本次通知，不计入“被合并抑制”，单独用撤销数量说明。
  for (const contribution of batch.contributions.filter((item) => item.withdrawn)) {
    contribution.suppressedCount = 0
  }
  batch.suppressedCount = active.reduce((sum, item) => sum + item.suppressedCount, 0)
  batch.withdrawnEventCount = batch.contributions
    .filter((item) => item.withdrawn)
    .reduce((sum, item) => sum + item.rawEventCount, 0)
}

function activeContributions(batch: NotificationBatch): BatchContribution[] {
  return batch.contributions.filter((item) => !item.withdrawn)
}

/**
 * 按当前生效规则重建送达名单：
 * - 同一地址（归一化后）只保留一条送达记录；
 * - 无效地址单独隔离成 invalid，不影响同批其他地址；
 * - 已送达记录永远保留，不会被后续名单变化覆盖。
 */
function refreshDeliveries(batch: NotificationBatch, state: NotificationState, now: number): void {
  // 接收名单以当前规则为准：修正或删除地址后，旧批次重试时能同步生效；
  // 规则已不存在时退回事件并入批次时保存的快照。
  const currentRules = listNotificationRules()
  const contributions = activeContributions(batch).map((item) => {
    const live = currentRules.find((rule) => rule.id === item.ruleId)
    return live && live.enabled ? { ...item, recipients: live.recipients } : item
  })
  const desired = uniqueRecipients(contributions, batch.channel)
  const desiredKeys = new Set(desired.map((item) => item.normalized || `empty:${item.recipient}`))
  const existingByKey = new Map(
    batch.deliveries.map((item) => [item.normalizedRecipient || `empty:${item.recipient}`, item]),
  )

  for (const delivery of batch.deliveries) {
    const key = delivery.normalizedRecipient || `empty:${delivery.recipient}`
    if (desiredKeys.has(key)) {
      continue
    }
    // 批次里已经没有生效规则需要这个地址：只收回尚未送达的对象，已送达的保留为历史。
    if (delivery.status !== 'sent' && delivery.status !== 'cancelled') {
      delivery.status = 'cancelled'
      delivery.lastError = '规则已停用或接收名单已变更，待发送对象已撤回'
      delivery.evidence.push(`${formatDateTime(now)} 撤回：${delivery.lastError}`)
      delivery.updatedAt = now
    }
  }

  for (const desiredItem of desired) {
    const key = desiredItem.normalized || `empty:${desiredItem.recipient}`
    let delivery = existingByKey.get(key)
    if (!delivery) {
      const id = `D-${batch.id}-${hashString(key)}`
      delivery = {
        id,
        batchId: batch.id,
        channel: batch.channel,
        recipient: desiredItem.recipient,
        normalizedRecipient: desiredItem.normalized,
        status: desiredItem.valid ? 'pending' : 'invalid',
        attempts: 0,
        lastError: desiredItem.valid ? '' : desiredItem.error,
        evidence: desiredItem.valid
          ? []
          : [`${formatDateTime(now)} 地址校验未通过：${desiredItem.error}（仅隔离该地址）`],
        ruleIds: [...desiredItem.ruleIds],
        valid: desiredItem.valid,
        createdAt: now,
        updatedAt: now,
      }
      batch.deliveries.push(delivery)
      existingByKey.set(key, delivery)
    } else {
      delivery.ruleIds = [...desiredItem.ruleIds]
      delivery.recipient = desiredItem.recipient
      delivery.valid = desiredItem.valid
      if (delivery.status === 'invalid' && desiredItem.valid && delivery.attempts === 0) {
        // 地址被修正后重新参与发送。
        delivery.status = 'pending'
        delivery.lastError = ''
        delivery.updatedAt = now
        delivery.evidence.push(`${formatDateTime(now)} 地址格式已修正，重新进入待发送`)
      }
      if (delivery.status !== 'sent' && !desiredItem.valid && delivery.status !== 'cancelled') {
        delivery.status = 'invalid'
        delivery.lastError = desiredItem.error
        if (!delivery.evidence.some((item) => item.includes('地址校验未通过'))) {
          delivery.evidence.push(`${formatDateTime(now)} 地址校验未通过：${desiredItem.error}（仅隔离该地址）`)
        }
        delivery.updatedAt = now
      }
    }
    // 用户已取消接收：旧批次、重试都不能再发。
    if (delivery.status === 'pending' || delivery.status === 'failed') {
      const subscription = state.subscriptions[subscriptionKey(batch.channel, desiredItem.normalized)]
      if (subscription && !subscription.active) {
        delivery.status = 'cancelled'
        delivery.lastError = '接收人已取消接收，待发送消息已取消'
        delivery.evidence.push(`${formatDateTime(now)} ${delivery.lastError}`)
        delivery.updatedAt = now
      }
    }
  }

  // 送达记录按地址稳定排序，刷新页面后顺序不跳。
  batch.deliveries.sort((left, right) => {
    if (left.createdAt !== right.createdAt) {
      return left.createdAt - right.createdAt
    }
    return left.recipient.localeCompare(right.recipient)
  })
}

function subscriptionKey(channel: string, recipient: string): string {
  return `${channel}::${recipient}`
}

function credentialState(state: NotificationState, channel: string): ChannelCredentialState | undefined {
  return state.credentials[channel]
}

function channelPaused(state: NotificationState, channel: string): boolean {
  return credentialState(state, channel)?.status === 'invalid'
}

function refreshFailureEvidence(batch: NotificationBatch): void {
  const evidence: string[] = []
  for (const delivery of batch.deliveries) {
    if (delivery.status === 'failed' || delivery.status === 'invalid') {
      const label = delivery.status === 'invalid' ? '地址无效' : '发送失败'
      evidence.push(
        `渠道「${batch.channel}」｜${label}｜${delivery.recipient || '空地址'}：${delivery.lastError || '未记录原因'}`,
      )
    }
  }
  // 渠道级失败（模板渲染、凭据失效）保留在批次上，不只挂在单条送达记录里。
  for (const item of batch.failureEvidence) {
    // 只保留仍然成立的渠道级旁证：凭据恢复后不再显示“凭据失效”。
    if (item.includes('消息模板渲染失败') && !evidence.includes(item)) {
      evidence.push(item)
    }
  }
  if (batch.pauseReason && !evidence.includes(batch.pauseReason)) {
    evidence.push(batch.pauseReason)
  }
  batch.failureEvidence = evidence
}

/**
 * 只要批次有送达记录，就把已经随批次发出去的事件标成 notified：
 * 之后规则被停用或恢复都不会再补发这些事件。
 */
function markNotifiedEvents(batch: NotificationBatch): void {
  const sentRules = new Set<number>()
  for (const delivery of batch.deliveries) {
    if (delivery.status === 'sent') {
      for (const ruleId of delivery.ruleIds) {
        sentRules.add(ruleId)
      }
    }
  }
  for (const event of batch.evidence) {
    if (event.status === 'withdrawn') {
      continue
    }
    const contribution = batch.contributions.find((item) => item.ruleId === event.ruleId)
    if (contribution?.withdrawn && !sentRules.has(event.ruleId)) {
      event.status = 'withdrawn'
      continue
    }
    if (sentRules.has(event.ruleId) || !contribution?.withdrawn) {
      event.status = 'notified'
    }
  }
}

function finalizeBatchStatus(batch: NotificationBatch, state: NotificationState): void {
  refreshFailureEvidence(batch)
  const deliveries = batch.deliveries
  const sent = deliveries.filter((item) => item.status === 'sent').length
  const failed = deliveries.filter((item) => item.status === 'failed' || item.status === 'invalid').length
  const cancelled = deliveries.filter((item) => item.status === 'cancelled').length
  const pending = deliveries.filter((item) => item.status === 'pending' || item.status === 'sending').length

  if (activeContributions(batch).length === 0 && batch.withdrawnEventCount > 0) {
    batch.status = 'withdrawn'
    batch.statusReason =
      sent > 0
        ? `规则已停用，未送达对象已撤回；${sent} 条已送达记录保留，不会补发`
        : '规则已停用，合并窗口内的待发送事件已全部撤回'
    return
  }
  if (batch.finalizedAt === undefined) {
    batch.status = 'collecting'
    batch.statusReason = '合并窗口进行中，事件会继续并入本批次'
    return
  }
  if (deliveries.length === 0) {
    batch.status = 'failed'
    batch.statusReason = '接收列表为空，没有可送达对象'
    return
  }
  if (pending > 0 && channelPaused(state, batch.channel)) {
    batch.status = 'paused'
    batch.statusReason = batch.pauseReason ?? `渠道「${batch.channel}」凭据失效，待发送批次已保留`
    return
  }
  if (pending > 0) {
    batch.status = 'pending'
    batch.statusReason = `窗口已结束，仍有 ${pending} 个对象待发送`
    return
  }
  if (sent > 0) {
    markNotifiedEvents(batch)
  }
  if (sent === deliveries.length) {
    batch.status = 'sent'
    batch.statusReason = `${sent} 个对象全部送达`
    batch.sentAt = batch.sentAt ?? batch.updatedAt
    return
  }
  if (sent > 0) {
    batch.status = 'partial'
    batch.statusReason = `已送达 ${sent} 个，失败或无效 ${failed} 个，取消 ${cancelled} 个；重试只补发未送达部分`
    return
  }
  if (cancelled === deliveries.length) {
    batch.status = 'cancelled'
    batch.statusReason = '所有待发送对象已取消，不会重试'
    return
  }
  if (failed > 0) {
    batch.status = 'failed'
    batch.statusReason = `全部 ${failed} 个对象发送失败或地址无效`
    return
  }
  batch.status = 'failed'
  batch.statusReason = '没有可用的送达结果'
}

function simulateSend(delivery: NotificationDelivery, now: number): void {
  // 离线模拟：地址含 fail 的永远失败，含 retry 的首次失败、重试成功。
  if (delivery.normalizedRecipient.includes('fail')) {
    delivery.attempts += 1
    delivery.status = 'failed'
    delivery.lastError = '接收服务器持续拒绝投递（模拟永久失败）'
    delivery.evidence.push(`${formatDateTime(now)} 第 ${delivery.attempts} 次投递失败：${delivery.lastError}`)
    delivery.updatedAt = now
    return
  }
  if (delivery.normalizedRecipient.includes('retry') && delivery.attempts === 0) {
    delivery.attempts = 1
    delivery.status = 'failed'
    delivery.lastError = 'SMTP 451 服务临时不可用（模拟首次失败）'
    delivery.evidence.push(`${formatDateTime(now)} 第 1 次投递失败：${delivery.lastError}`)
    delivery.updatedAt = now
    return
  }
  delivery.attempts += 1
  delivery.status = 'sent'
  delivery.lastError = ''
  delivery.sentAt = now
  delivery.updatedAt = now
  delivery.evidence.push(`${formatDateTime(now)} 第 ${delivery.attempts} 次投递成功（${delivery.channel}）`)
}

/**
 * 对一个批次做一轮分发。只会处理 pending 状态的送达记录；
 * 已送达、地址无效、已取消的记录都不进入发送队列。
 */
function dispatchBatch(batch: NotificationBatch, state: NotificationState, now: number): number {
  if (batch.status === 'withdrawn' || batch.status === 'cancelled') {
    return 0
  }
  const credential = credentialState(state, batch.channel)
  if (credential?.status === 'invalid') {
    batch.status = 'paused'
    batch.pauseReason = `通知渠道「${batch.channel}」凭据失效：${credential.reason}；待发送批次已保留，轮询暂停`
    batch.statusReason = batch.pauseReason
    batch.failureEvidence = [
      ...batch.failureEvidence.filter((item) => !item.includes('凭据失效')),
      batch.pauseReason,
    ]
    return 0
  }
  batch.pauseReason = undefined

  const render = renderBatchMessage(batch)
  if (!render.ok) {
    batch.renderedMessage = undefined
    const error = `消息模板渲染失败：${render.error}`
    const already = batch.failureEvidence.some((item) => item.includes('消息模板渲染失败'))
    if (!already) {
      batch.failureEvidence.push(`${formatDateTime(now)} ${error}（仅拒绝渠道「${batch.channel}」）`)
    }
    for (const delivery of batch.deliveries) {
      if (delivery.status === 'pending') {
        delivery.status = 'failed'
        delivery.lastError = error
        delivery.evidence.push(`${formatDateTime(now)} ${error}（未计入投递尝试）`)
        delivery.updatedAt = now
      }
    }
    if (batch.finalizedAt !== undefined) {
      finalizeBatchStatus(batch, state)
    }
    return 0
  }

  batch.renderedMessage = render.text
  let dispatched = 0
  for (const delivery of batch.deliveries) {
    if (delivery.status !== 'pending') {
      continue
    }
    const subscription = state.subscriptions[subscriptionKey(batch.channel, delivery.normalizedRecipient)]
    if (subscription && !subscription.active) {
      delivery.status = 'cancelled'
      delivery.lastError = '接收人已取消接收，不再发送'
      delivery.evidence.push(`${formatDateTime(now)} ${delivery.lastError}`)
      delivery.updatedAt = now
      continue
    }
    simulateSend(delivery, now)
    dispatched += 1
  }
  if (batch.finalizedAt !== undefined) {
    finalizeBatchStatus(batch, state)
  }
  return dispatched
}

function settleBatch(
  batch: NotificationBatch,
  state: NotificationState,
  now: number,
  reason: string,
): number {
  if (batch.status !== 'collecting') {
    return 0
  }
  batch.finalizedAt = now
  batch.updatedAt = now
  batch.statusReason = reason
  refreshDeliveries(batch, state, now)
  const dispatched = dispatchBatch(batch, state, now)
  if (batch.status === 'collecting') {
    finalizeBatchStatus(batch, state)
  }
  return dispatched
}

function ensureBatch(
  state: NotificationState,
  source: NotificationSource,
  metric: string,
  channel: string,
  occurredAt: number,
  windowMs: number,
): NotificationBatch {
  // 聚合键严格按「监控指标 + 通知渠道 + 合并窗口」：报告推送与普通告警即使共用渠道，
  // 只要指标不同就各自成批，批次和送达记录互不覆盖。
  const open = state.batches.find(
    (batch) =>
      batch.status === 'collecting' &&
      batch.metric === metric &&
      batch.channel === channel &&
      batch.windowSeconds === windowMs / 1000 &&
      occurredAt >= batch.windowStart &&
      occurredAt < batch.windowEnd,
  )
  if (open) {
    return open
  }
  state.sequence += 1
  const sequence = state.sequence
  const day = formatDay(occurredAt).replace(/-/g, '')
  const batch: NotificationBatch = {
    id: `B-${day}-${pad(sequence, 4)}`,
    metric,
    channel,
    sourceKinds: [source],
    windowStart: occurredAt,
    windowEnd: occurredAt + windowMs,
    windowSeconds: windowMs / 1000,
    status: 'collecting',
    statusReason: '合并窗口进行中，事件会继续并入本批次',
    contributions: [],
    evidence: [],
    rawEventCount: 0,
    suppressedCount: 0,
    withdrawnEventCount: 0,
    deliveries: [],
    failureEvidence: [],
    createdAt: occurredAt,
    updatedAt: occurredAt,
  }
  state.batches.push(batch)
  return batch
}

function addContribution(
  batch: NotificationBatch,
  rule: NotificationRule,
  event: NotificationEvent,
): void {
  let contribution = batch.contributions.find(
    (item) => item.ruleId === rule.id && !item.withdrawn,
  )
  if (!contribution) {
    contribution = {
      ruleId: rule.id,
      ruleCode: rule.code,
      priority: rule.priority,
      condition: rule.condition,
      dedupe: rule.dedupe,
      template: rule.template,
      recipients: [...rule.recipients],
      mergeWindowSec: rule.mergeWindowSec,
      rawEventCount: 0,
      suppressedCount: 0,
      eventIds: [],
      firstEventAt: event.occurredAt,
      lastEventAt: event.occurredAt,
      withdrawn: false,
    }
    batch.contributions.push(contribution)
  }
  contribution.rawEventCount += 1
  contribution.eventIds.push(event.id)
  contribution.firstEventAt = Math.min(contribution.firstEventAt, event.occurredAt)
  contribution.lastEventAt = Math.max(contribution.lastEventAt, event.occurredAt)
  batch.rawEventCount += 1
  batch.evidence.push(event)
  recomputeSuppression(batch)
}

function appendEvent(
  state: NotificationState,
  batch: NotificationBatch,
  rule: NotificationRule,
  source: NotificationSource,
  occurredAt: number,
  value: string,
  detail: string,
): NotificationEvent {
  state.sequence += 1
  const event: NotificationEvent = {
    id: `E-${batch.id}-${pad(state.sequence, 4)}`,
    batchId: batch.id,
    ruleId: rule.id,
    ruleCode: rule.code,
    source,
    metric: batch.metric,
    condition: rule.condition,
    channel: batch.channel,
    occurredAt,
    value,
    detail,
    status: 'batched',
  }
  state.events.push(event)
  return event
}

// ---------------------------------------------------------------------------
// 对外操作
// ---------------------------------------------------------------------------

export function ingestNotification(input: IngestNotificationInput): IngestNotificationResult {
  const state = readState()
  ensureLifecycle(state)
  const rule = ruleById(Number(input.ruleId))
  if (!rule) {
    return { accepted: false, reason: `没有找到编号为 ${input.ruleId} 的通知规则` }
  }
  if (!rule.enabled) {
    return {
      accepted: false,
      reason: `规则 ${rule.code} 当前状态「${String(rule.sourceRow.status)}」，只有已启用的规则才能接收事件`,
    }
  }
  if (rule.channels.length === 0) {
    return { accepted: false, reason: `规则 ${rule.code} 没有可用的通知渠道` }
  }
  const source = input.source ?? 'anomaly'
  const occurredAt = Number.isFinite(input.occurredAt) ? Number(input.occurredAt) : Date.now()
  const value = input.value ?? `模拟值 ${Math.round(occurredAt % 1000)}`
  const detail = input.detail ?? `规则 ${rule.code} 命中触发条件：${rule.condition}`
  const windowMs = rule.mergeWindowSec * 1000
  let primaryBatchId = ''
  let primaryEventId = ''

  for (const channel of rule.channels) {
    const batch = ensureBatch(state, source, rule.metric, channel, occurredAt, windowMs)
    batch.sourceKinds = Array.from(new Set([...batch.sourceKinds, source]))
    batch.updatedAt = occurredAt
    const event = appendEvent(state, batch, rule, source, occurredAt, value, detail)
    addContribution(batch, rule, event)
    // 事件到达时就建立送达名单，无效地址可以立即被隔离，其他地址继续等待窗口结束。
    refreshDeliveries(batch, state, occurredAt)
    finalizeBatchStatus(batch, state)
    if (!primaryBatchId) {
      primaryBatchId = batch.id
      primaryEventId = event.id
    }
  }

  persist(state)
  return {
    accepted: true,
    reason: `事件已并入批次 ${primaryBatchId}`,
    batchId: primaryBatchId,
    eventId: primaryEventId,
  }
}

/**
 * 报告生成完成后调用：把报告推送事件送进「报告生成」类规则的合并窗口，
 * 与普通告警共用渠道时仍按指标各自成批，不会覆盖告警批次的送达记录。
 */
export function emitReportGenerationEvent(
  reportName: string,
  now: number = Date.now(),
): { accepted: number; batches: string[] } {
  const rules = listNotificationRules().filter(
    (rule) => rule.enabled && rule.metric.includes('报告'),
  )
  const batches: string[] = []
  for (const rule of rules) {
    const result = ingestNotification({
      ruleId: rule.id,
      source: 'reportgen',
      occurredAt: now,
      value: reportName,
      detail: `报告模板「${reportName}」已生效，触发推送`,
    })
    if (result.accepted && result.batchId && !batches.includes(result.batchId)) {
      batches.push(result.batchId)
    }
  }
  return { accepted: rules.length, batches }
}

export function pollNotificationBatches(now: number = Date.now()): PollNotificationResult {
  const state = readState()
  ensureLifecycle(state)
  let changed = false
  let closed = 0
  let dispatched = 0
  const pausedChannels: string[] = []

  for (const batch of state.batches) {
    if (batch.status === 'collecting' && batch.windowEnd <= now) {
      // 窗口到点必须给出确定状态：即使渠道凭据失效，也结算成 paused 而不是一直「合并中」。
      dispatched += settleBatch(
        batch,
        state,
        now,
        `合并窗口已于 ${formatDateTime(batch.windowEnd)} 结束，窗口起点 ${formatDateTime(batch.windowStart)}（归属日 ${formatDay(batch.windowStart)}）`,
      )
      closed += 1
      changed = true
      continue
    }
    if (batch.status === 'paused' && !channelPaused(state, batch.channel)) {
      // 凭据恢复：只继续尚未送达的对象，已送达记录不动。
      batch.pauseReason = undefined
      batch.status = 'pending'
      dispatched += dispatchBatch(batch, state, now)
      changed = true
    }
    if (batch.status === 'paused') {
      pausedChannels.push(batch.channel)
    }
  }

  state.lastPollAt = now
  persist(state)
  return {
    changed,
    closed,
    dispatched,
    pausedChannels: Array.from(new Set(pausedChannels)),
    summary:
      closed === 0 && dispatched === 0
        ? pausedChannels.length > 0
          ? `没有到期的合并窗口；${[...new Set(pausedChannels)].join('、')} 渠道凭据失效，轮询已暂停`
          : '没有到期的合并窗口，批次保持合并中'
        : `结算 ${closed} 个窗口，补发 ${dispatched} 条未送达记录`,
  }
}

/** 手动把当前所有合并中的窗口结算掉，便于离线演示，不改变窗口归属。 */
export function settleOpenBatches(now: number = Date.now()): PollNotificationResult {
  const state = readState()
  ensureLifecycle(state)
  let closed = 0
  let dispatched = 0
  const pausedChannels: string[] = []
  for (const batch of state.batches) {
    if (batch.status === 'collecting') {
      dispatched += settleBatch(
        batch,
        state,
        now,
        `手动结算：窗口起点 ${formatDateTime(batch.windowStart)}（归属日 ${formatDay(batch.windowStart)}）`,
      )
      closed += 1
    }
    if (batch.status === 'paused') {
      pausedChannels.push(batch.channel)
    }
  }
  state.lastPollAt = now
  persist(state)
  return {
    changed: closed > 0,
    closed,
    dispatched,
    pausedChannels: Array.from(new Set(pausedChannels)),
    summary: `手动结算 ${closed} 个窗口，补发 ${dispatched} 条未送达记录`,
  }
}

function applyRuleWithdrawal(
  state: NotificationState,
  ruleId: number,
  now: number,
): { batches: number; events: number } {
  let batchCount = 0
  let eventCount = 0
  for (const batch of state.batches) {
    const contributions = batch.contributions.filter(
      (item) => item.ruleId === ruleId && !item.withdrawn,
    )
    if (contributions.length === 0) {
      continue
    }
    // 这条规则是否已经通过本批次的送达记录真正发出去过：
    // 送达记录的接收人来自这条规则，并且该规则贡献的事件编号在批次证据里。
    const notifiedRule = batch.deliveries.some(
      (item) =>
        item.status === 'sent' &&
        item.ruleIds.includes(ruleId) &&
        batch.evidence.some((event) => event.ruleId === ruleId),
    )
    for (const contribution of contributions) {
      contribution.withdrawn = true
      contribution.withdrawnAt = now
      eventCount += contribution.rawEventCount
    }
    for (const event of batch.evidence) {
      if (event.ruleId === ruleId) {
        // 已随本批次送达的事件保留 notified；恢复规则后也不会补发。
        event.status = notifiedRule ? 'notified' : 'withdrawn'
      }
    }
    recomputeSuppression(batch)
    refreshDeliveries(batch, state, now)
    finalizeBatchStatus(batch, state)
    batch.updatedAt = now
    batchCount += 1
  }
  return { batches: batchCount, events: eventCount }
}

export function withdrawNotificationBatchesForRule(
  ruleId: number,
  now: number = Date.now(),
): WithdrawRuleResult {
  const state = readState()
  const result = applyRuleWithdrawal(state, ruleId, now)
  persist(state)
  return { batches: result.batches, events: result.events }
}

function ensureLifecycle(state: NotificationState): void {
  const rules = listNotificationRules()
  let changed = false
  for (const rule of rules) {
    if (rule.enabled) {
      continue
    }
    const touched = applyRuleWithdrawal(state, rule.id, Date.now())
    if (touched.batches > 0) {
      changed = true
    }
  }
  if (changed) {
    persist(state)
  }
}

export function listNotificationBatches(): NotificationBatch[] {
  const state = readState()
  ensureLifecycle(state)
  return [...state.batches].sort((left, right) => {
    if (left.windowStart !== right.windowStart) {
      return right.windowStart - left.windowStart
    }
    return right.createdAt - left.createdAt
  })
}

export function getNotificationBatch(batchId: string): NotificationBatch | undefined {
  const state = readState()
  ensureLifecycle(state)
  return state.batches.find((batch) => batch.id === batchId)
}

export function setChannelCredential(
  channel: string,
  status: 'valid' | 'invalid',
  reason = '',
  now: number = Date.now(),
): { changed: number; batches: NotificationBatch[] } {
  const state = readState()
  const paused = status === 'invalid'
  state.credentials[channel] = {
    status: paused ? 'invalid' : 'valid',
    reason: paused ? reason || '凭据校验失败或已过期' : '',
    updatedAt: now,
  }
  let changed = 0
  for (const batch of state.batches) {
    if (batch.channel !== channel) {
      continue
    }
    if (paused) {
      if (batch.status === 'pending' || batch.status === 'paused') {
        batch.status = 'paused'
        batch.pauseReason = `通知渠道「${channel}」凭据失效：${state.credentials[channel].reason}；待发送批次已保留，轮询暂停`
        batch.statusReason = batch.pauseReason
        batch.failureEvidence = [
          ...batch.failureEvidence.filter((item) => !item.includes('凭据失效')),
          batch.pauseReason,
        ]
        batch.updatedAt = now
        changed += 1
      } else if (batch.status === 'collecting') {
        batch.pauseReason = `通知渠道「${channel}」凭据失效：${state.credentials[channel].reason}；窗口结束后批次将保留并暂停发送`
      }
    }
    // 恢复凭据时不重发已送达记录，只把 paused 批次重新拉回待发送。
    if (!paused && batch.status === 'paused' && batch.finalizedAt !== undefined) {
      batch.pauseReason = undefined
      batch.status = 'pending'
      batch.statusReason = '渠道凭据已恢复，仅继续发送尚未送达的对象'
      batch.updatedAt = now
      changed += 1
    }
  }
  persist(state)
  return { changed, batches: listNotificationBatches() }
}

export function restoreChannelCredential(
  channel: string,
  now: number = Date.now(),
): PollNotificationResult {
  setChannelCredential(channel, 'valid', '', now)
  let closed = 0
  let dispatched = 0
  const state = readState()
  for (const batch of state.batches) {
    if (batch.channel !== channel || batch.status !== 'pending') {
      continue
    }
    dispatched += dispatchBatch(batch, state, now)
    closed += 1
  }
  persist(state)
  return {
    changed: closed > 0,
    closed,
    dispatched,
    pausedChannels: [],
    summary:
      closed === 0
        ? `渠道「${channel}」凭据已恢复，没有需要续发的对象`
        : `渠道「${channel}」凭据已恢复，续发 ${dispatched} 条未送达记录（已送达不重发）`,
  }
}

export function cancelSubscription(
  channel: string,
  recipient: string,
  now: number = Date.now(),
): { cancelled: number; subscription: SubscriptionRecord | undefined } {
  const checked = normalizeRecipient(channel, recipient)
  const state = readState()
  const key = subscriptionKey(channel, checked.normalized)
  const record: SubscriptionRecord = {
    channel,
    recipient: checked.normalized,
    active: false,
    updatedAt: now,
  }
  state.subscriptions[key] = record
  let cancelled = 0
  for (const batch of state.batches) {
    if (batch.channel !== channel) {
      continue
    }
    for (const delivery of batch.deliveries) {
      if (delivery.normalizedRecipient !== checked.normalized) {
        continue
      }
      if (delivery.status === 'pending' || delivery.status === 'failed') {
        delivery.status = 'cancelled'
        delivery.lastError = '接收人已取消接收，旧批次重试也不会再发送'
        delivery.evidence.push(`${formatDateTime(now)} ${delivery.lastError}`)
        delivery.updatedAt = now
        cancelled += 1
      }
    }
    if (batch.finalizedAt !== undefined) {
      finalizeBatchStatus(batch, state)
    }
    batch.updatedAt = now
  }
  persist(state)
  return { cancelled, subscription: record }
}

export function markDeliveryFailure(
  batchId: string,
  deliveryId: string,
  reason = '模拟一次投递失败',
  now: number = Date.now(),
): { ok: boolean; message: string; batch?: NotificationBatch } {
  const state = readState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  const delivery = batch.deliveries.find((item) => item.id === deliveryId)
  if (!delivery) {
    return { ok: false, message: `批次里没有找到送达记录 ${deliveryId}` }
  }
  if (delivery.status === 'sent') {
    return { ok: false, message: '该对象已送达，不能补记为失败' }
  }
  if (delivery.status === 'invalid' || delivery.status === 'cancelled') {
    return { ok: false, message: `该对象当前状态「${DELIVERY_STATUS_LABELS[delivery.status]}」，不参与重试` }
  }
  delivery.status = 'failed'
  delivery.lastError = reason
  delivery.evidence.push(`${formatDateTime(now)} 模拟失败：${reason}`)
  delivery.updatedAt = now
  finalizeBatchStatus(batch, state)
  batch.updatedAt = now
  persist(state)
  return { ok: true, message: `已标记 ${delivery.recipient} 发送失败，可只重试未送达部分`, batch }
}

export function retryUnsentDeliveries(
  batchId: string,
  now: number = Date.now(),
): RetryBatchResult {
  const state = readState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { retried: 0 }
  }
  if (batch.status === 'collecting') {
    // 还在合并窗口里：先不要手动重试，否则会把窗口提前结束。
    return { retried: 0, batch }
  }
  if (batch.status === 'withdrawn' || batch.status === 'cancelled') {
    return { retried: 0, batch }
  }
  if (channelPaused(state, batch.channel)) {
    batch.status = 'paused'
    batch.statusReason = `渠道「${batch.channel}」凭据失效，重试已暂停`
    batch.updatedAt = now
    persist(state)
    return { retried: 0, batch }
  }
  // 重试前按最新接收列表刷新一次：修掉无效地址后能重新进入待发送，
  // 已经移除的地址则收回未送达对象。
  refreshDeliveries(batch, state, now)
  let retried = 0
  for (const delivery of batch.deliveries) {
    if (delivery.status !== 'failed' && delivery.status !== 'invalid') {
      continue
    }
    // 地址无效的记录只在地址被修正后才重新参与；格式仍然无效就继续隔离。
    if (delivery.status === 'invalid' && !delivery.valid) {
      continue
    }
    delivery.status = 'pending'
    delivery.lastError = ''
    delivery.updatedAt = now
    delivery.evidence.push(`${formatDateTime(now)} 进入重试队列（只补发未送达部分）`)
    retried += 1
  }
  const dispatched = dispatchBatch(batch, state, now)
  finalizeBatchStatus(batch, state)
  batch.updatedAt = now
  persist(state)
  return { retried: Math.max(retried, dispatched), batch }
}

/**
 * 手动抑制：之后的重新触发不要再发出去，只影响该送达对象，
 * 不动同批次其他地址，也不改已送达的历史记录。
 */
export function suppressDelivery(
  batchId: string,
  deliveryId: string,
  now: number = Date.now(),
): { ok: boolean; message: string; batch?: NotificationBatch } {
  const state = readState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  const delivery = batch.deliveries.find((item) => item.id === deliveryId)
  if (!delivery) {
    return { ok: false, message: `批次里没有找到送达记录 ${deliveryId}` }
  }
  if (delivery.status !== 'pending' && delivery.status !== 'failed') {
    return {
      ok: false,
      message: `对象当前状态「${DELIVERY_STATUS_LABELS[delivery.status]}」，不参与抑制`,
    }
  }
  delivery.status = 'cancelled'
  delivery.lastError = '已手动抑制，不再补发'
  delivery.evidence.push(`${formatDateTime(now)} 手动抑制：不再补发该地址`)
  delivery.updatedAt = now
  finalizeBatchStatus(batch, state)
  batch.updatedAt = now
  persist(state)
  return { ok: true, message: `已抑制 ${delivery.recipient} 的后续补发`, batch }
}

export function resendDelivery(
  batchId: string,
  deliveryId: string,
  now: number = Date.now(),
): { ok: boolean; message: string; batch?: NotificationBatch } {
  const state = readState()
  const batch = state.batches.find((item) => item.id === batchId)
  if (!batch) {
    return { ok: false, message: `没有找到批次 ${batchId}` }
  }
  const delivery = batch.deliveries.find((item) => item.id === deliveryId)
  if (!delivery) {
    return { ok: false, message: `批次里没有找到送达记录 ${deliveryId}` }
  }
  if (delivery.status === 'sent') {
    return { ok: false, message: '该对象已经送达，不会重复发送' }
  }
  if (delivery.status === 'invalid') {
    return { ok: false, message: '地址无效，需修正接收列表后才会重新校验' }
  }
  const subscription = state.subscriptions[subscriptionKey(batch.channel, delivery.normalizedRecipient)]
  if (subscription && !subscription.active) {
    return { ok: false, message: '接收人已取消接收，不能再次发送' }
  }
  if (channelPaused(state, batch.channel)) {
    return { ok: false, message: `渠道「${batch.channel}」凭据失效，重试已暂停` }
  }
  const render = renderBatchMessage(batch)
  if (!render.ok) {
    delivery.lastError = `消息模板渲染失败：${render.error}`
    delivery.status = 'failed'
    delivery.updatedAt = now
    delivery.evidence.push(`${formatDateTime(now)} 重发被拒绝：${delivery.lastError}`)
    finalizeBatchStatus(batch, state)
    persist(state)
    return { ok: false, message: delivery.lastError, batch }
  }
  delivery.status = 'pending'
  delivery.lastError = ''
  delivery.updatedAt = now
  delivery.evidence.push(`${formatDateTime(now)} 进入重发队列`)
  simulateSend(delivery, now)
  if (batch.finalizedAt === undefined) {
    batch.finalizedAt = now
  }
  batch.renderedMessage = render.text
  finalizeBatchStatus(batch, state)
  batch.updatedAt = now
  persist(state)
  return { ok: true, message: `已重发 ${delivery.recipient}（${DELIVERY_STATUS_LABELS[delivery.status]}）`, batch }
}

export function notificationStats(): {
  rules: number
  enabled: number
  collecting: number
  pending: number
  failed: number
  paused: number
} {
  const rules = listNotificationRules()
  const batches = listNotificationBatches()
  return {
    rules: rules.length,
    enabled: rules.filter((rule) => rule.enabled).length,
    collecting: batches.filter((batch) => batch.status === 'collecting').length,
    pending: batches.filter((batch) => batch.status === 'pending' || batch.status === 'sending').length,
    failed: batches.filter((batch) => batch.status === 'failed' || batch.status === 'partial').length,
    paused: batches.filter((batch) => batch.status === 'paused').length,
  }
}

export function channelCredential(channel: string): ChannelCredentialState | undefined {
  return readState().credentials[channel]
}

/** 某个接收人在该渠道上是否已取消接收；详情页据此隐藏「取消接收」按钮。 */
export function subscriptionOf(channel: string, recipient: string): SubscriptionRecord | undefined {
  const state = readState()
  return state.subscriptions[subscriptionKey(channel, normalizeRecipient(channel, recipient).normalized)]
}
