import {
  ingestNotification,
  listNotificationRules,
  pollNotificationBatches,
  resetNotificationState,
  settleOpenBatches,
} from './notify-service'

/**
 * 演示数据：只在用户主动点「重置并生成演示批次」时播种，不混进通用示例数据。
 *
 * 覆盖的异常场景：
 * 1. 合并窗口 23:59:30 开始、跨过零点，归属日仍按窗口起点记为前一天；
 * 2. NOTI-9001 / 9002 / 9005 合并同一监控指标，批次要说明各自条件与被抑制数量；
 * 3. 报告推送 NOTI-9003 与告警共用邮件通道，批次和送达记录互相独立；
 * 4. 接收列表含重复地址与无效地址，只隔离无效的那一个；
 * 5. 电话接收人 13800138000 在历史批次送达过一次；窗口结束后重新触发时
 *    用户已取消接收，旧批次重试也不会再收到。
 */

export const DEMO_RULE_IDS = { primary: 1, overlapping: 2, report: 3, sms: 4 } as const

export function triggerDemoEvent(
  ruleId: number,
  occurredAt: number = Date.now(),
  value?: string,
): string {
  const rule = listNotificationRules().find((item) => item.id === ruleId)
  if (!rule) {
    return `没有找到编号为 ${ruleId} 的通知规则`
  }
  const result = ingestNotification({
    ruleId,
    source: rule.metric.includes('报告') ? 'reportgen' : 'anomaly',
    occurredAt,
    value: value ?? (rule.metric.includes('报告') ? '即时报告' : '即时异常样本'),
    detail: `手动触发：规则 ${rule.code} 命中「${rule.condition}」`,
  })
  return result.reason
}

function previousDayWindow(now: number): { windowStart: number; midnight: number } {
  const anchor = new Date(now)
  anchor.setDate(anchor.getDate() - 1)
  const windowStart = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate(),
    23,
    59,
    30,
    0,
  ).getTime()
  const midnight = new Date(
    anchor.getFullYear(),
    anchor.getMonth(),
    anchor.getDate() + 1,
    0,
    0,
    0,
    0,
  ).getTime()
  return { windowStart, midnight }
}

/** 重置通知状态并播种跨零点、共通道、重复接收人的演示批次。 */
export function seedDemoNotifications(now: number = Date.now()): string[] {
  resetNotificationState()
  const { windowStart, midnight } = previousDayWindow(now)
  const notes: string[] = []

  // 规则 1：窗口起点 23:59:30，5 条事件里最后一条落在 00:00:02，验证跨零点归属。
  for (let index = 0; index < 5; index += 1) {
    ingestNotification({
      ruleId: DEMO_RULE_IDS.primary,
      source: 'anomaly',
      occurredAt: windowStart + index * 8000,
      value: `${6 + index}.2%`,
      detail: `第 ${index + 1} 个异常样本，失败率 ${6 + index}.2%（阈值 5%）`,
    })
  }
  // 规则 2：同一指标的另一条规则，3 条事件，在邮件通道并入规则 1 的批次。
  for (let index = 0; index < 3; index += 1) {
    ingestNotification({
      ruleId: DEMO_RULE_IDS.overlapping,
      source: 'anomaly',
      occurredAt: windowStart + 10_000 + index * 12_000,
      value: `${11 + index}.4%`,
      detail: `失败率 ${11 + index}.4%，超过 10% 阈值`,
    })
  }
  // 规则 4：短信通道，同一指标，接收人重复且含无效号码。
  for (let index = 0; index < 2; index += 1) {
    ingestNotification({
      ruleId: DEMO_RULE_IDS.sms,
      source: 'anomaly',
      occurredAt: windowStart + 20_000 + index * 9000,
      value: `${8 + index}.5%`,
      detail: `失败率 ${8 + index}.5%，超过 8% 短信阈值`,
    })
  }
  // 规则 3：报告推送，窗口从 00:00:10 起，与告警共用邮件通道。
  for (let index = 0; index < 2; index += 1) {
    ingestNotification({
      ruleId: DEMO_RULE_IDS.report,
      source: 'reportgen',
      occurredAt: midnight + 10_000 + index * 70_000,
      value: index === 0 ? '日报 2026-11-14' : '日报 2026-11-14（重跑）',
      detail: index === 0 ? '日报模板生成完成，准备推送' : '日报模板重跑完成',
    })
  }

  pollNotificationBatches(midnight + 500_000)
  settleOpenBatches(midnight + 600_000)

  notes.push('告警窗口 23:59:30 跨零点，批次归属按窗口起点记为前一天')
  notes.push('NOTI-9001 / 9002 / 9005 在同一邮件批次里说明各自条件与抑制数量')
  notes.push('报告推送 NOTI-9003 与告警共用邮件通道，批次号与送达记录互不覆盖')
  notes.push('NOTI-9005 的接收列表含重复号码；12345 判定为无效地址并单独隔离')
  return notes
}
