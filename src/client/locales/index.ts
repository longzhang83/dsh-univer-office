import type { UniverLocaleKey } from './zh.ts'

declare module '@deepseek-ai/dsh-client-ui-slots' {
  interface LocaleNamespaceMap {
    /** Copy owned by the Univer preview and worktree surfaces. */
    univer: UniverLocaleKey
  }
}

/** Dictionary namespace owned by the Univer browser surfaces. */
export const UNIVER_LOCALE_NAMESPACE = 'univer'

export { en } from './en.ts'
export { zh } from './zh.ts'
export type { UniverLocaleKey } from './zh.ts'
