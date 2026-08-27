import type { Api } from '../shared/types'

declare global {
  interface Window {
    api: Api
    /** debug/testing seam, see src/renderer/app.ts */
    __fm: {
      state: object
      navigate(path: string): Promise<void>
      refresh(): Promise<void>
      renderAll(): void
      backend: Api
    }
  }
}

export {}
