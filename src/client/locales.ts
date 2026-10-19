/**
 * AStudio Connect settings card copy, per UI language.
 *
 * One namespace (`settings.astudio`) feeds the card through the injected `t`
 * seat. The key union is derived from the English dictionary so a copy key can
 * never be added to one language without the other.
 *
 * @module dsh-astudio-connect/client/locales
 */

/** English copy. */
export const en = {
  title: 'AStudio Connect',
  intro: 'Reuse models signed in to the AStudio app',
  loading: 'Loading…',
  refresh: 'Refresh',
  refreshing: 'Refreshing…',
  accountHeading: 'Account',
  signedIn: 'Signed in',
  signedOut: 'Not signed in',
  catalogLive: 'Live catalog',
  catalogSaved: 'Saved catalog',
  catalogFallback: 'Built-in catalog',
  contextHeading: 'Context',
  detailHeading: 'Detail',
  rate: 'Rate',
  rateUnknown: 'Unknown',
  probeHeading: 'Probe',
  probeStart: 'Probe',
  probeRedetect: 'Re-probe',
  probeUnknown: 'Unknown',
  probeNoResult: 'No probe results yet',
  requestFailed: 'Request failed',
  statusResponseInvalid: 'Status document invalid',
} as const

/** Copy keys of the `settings.astudio` namespace. */
export type AStudioSettingsKey = keyof typeof en

/** Simplified Chinese copy. */
export const zh: Record<AStudioSettingsKey, string> = {
  title: 'AStudio Connect',
  intro: '复用 AStudio 应用中已登录的模型',
  loading: '加载中…',
  refresh: '刷新',
  refreshing: '刷新中…',
  accountHeading: '账户',
  signedIn: '已登录',
  signedOut: '未登录',
  catalogLive: '实时目录',
  catalogSaved: '已保存目录',
  catalogFallback: '内置目录',
  contextHeading: '上下文',
  detailHeading: '详情',
  rate: '速率',
  rateUnknown: '未知',
  probeHeading: '探测',
  probeStart: '探测',
  probeRedetect: '重新探测',
  probeUnknown: '未知',
  probeNoResult: '暂无探测记录',
  requestFailed: '请求失败',
  statusResponseInvalid: '状态文档无效',
}
