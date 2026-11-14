import { SEED_ROWS } from './seed'
import type { EntryRow } from './types'

// 本地持久化：数据放在 localStorage 里，刷新、关掉再打开都还在。
const STORAGE_KEY = 'interactive-analytics-lab:entries'

function clone<T>(value: T): T {
  return JSON.parse(JSON.stringify(value)) as T
}

function readStorage(): Record<string, EntryRow[]> {
  const fallback = clone(SEED_ROWS)
  if (typeof window === 'undefined' || !window.localStorage) {
    return fallback
  }
  const raw = window.localStorage.getItem(STORAGE_KEY)
  if (!raw) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
  try {
    const parsed = JSON.parse(raw) as Record<string, EntryRow[]>
    // 通知模块在旧骨架里只有「通知分发样例N」这种占位规则，无法驱动批次聚合。
    // 只在整组都是占位规则时换成真实种子，并保留用户点过的状态；改过内容的一律不动。
    const merged: Record<string, EntryRow[]> = { ...fallback, ...parsed }
    const storedNotify = parsed.notify
    if (Array.isArray(storedNotify) && storedNotify.length > 0 && storedNotify.every(isPlaceholderNotifyRow)) {
      merged.notify = fallback.notify.map((seedRow) => {
        const storedRow = storedNotify.find((item) => Number(item.id) === Number(seedRow.id))
        return { ...seedRow, status: storedRow?.status ?? seedRow.status }
      })
    }
    return merged
  } catch {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(fallback))
    return fallback
  }
}

/** 旧骨架的通知规则：编号 NOTI-000N，字段全是“通知分发样例N”。 */
function isPlaceholderNotifyRow(row: EntryRow): boolean {
  return (
    /^NOTI-000\d+$/.test(String(row['规则编号'] ?? '')) &&
    String(row['触发条件'] ?? '').includes('通知分发样例')
  )
}

let cache: Record<string, EntryRow[]> | null = null

export function allRows(): Record<string, EntryRow[]> {
  if (cache === null) {
    cache = readStorage()
  }
  return cache
}

export function listRows(key: string): EntryRow[] {
  return allRows()[key] ?? []
}

export function saveRows(key: string, rows: EntryRow[]): void {
  const next = { ...allRows(), [key]: rows }
  cache = next
  if (typeof window !== 'undefined' && window.localStorage) {
    window.localStorage.setItem(STORAGE_KEY, JSON.stringify(next))
  }
}

export function resetRows(key: string): EntryRow[] {
  const rows = clone(SEED_ROWS[key] ?? [])
  saveRows(key, rows)
  return rows
}

export function storageKey(): string {
  return STORAGE_KEY
}
