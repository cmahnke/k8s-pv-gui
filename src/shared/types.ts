/** How a volume is attached to the pod. */
export type VolumeType = 'pvc' | 'hostPath' | 'emptyDir'

/** One volume mount point inside a running pod. */
export interface MountInfo {
  id: string
  container: string
  volume: string
  mountPath: string
  subPath: string
  type: VolumeType
  source: string
}

/** A running pod that mounts at least one browsable volume. */
export interface PodInfo {
  name: string
  mounts: MountInfo[]
}

/** Everything kubectl needs to reach a mount point. */
export interface KubectlTarget {
  context: string | null
  namespace: string | null
  pod: string | null
  container: string | null
}

export type EntryKind = 'dir' | 'file' | 'symlink'

/** One parsed line of remote `ls -la` output. */
export interface DirEntry {
  name: string
  type: EntryKind
  size: number
  owner: string
  group: string
  perms: string
  modified: number | null
  linkTarget: string | null
}

export type OpKind = 'download' | 'upload' | 'delete' | 'drag' | 'open'
export type OpState = 'running' | 'done' | 'error'

/** Progress message pushed from main to the renderer. */
export interface OpProgress {
  op: OpKind
  detail: string
  state?: OpState
}

export interface ContextList {
  contexts: string[]
  current: string | null
}

export interface AppInfo {
  version: string
  kubeconfig: string | null
}

export interface ChooseKubeconfigResult {
  canceled: boolean
  path?: string
  error?: string
}

/**
 * The API surface preload.js exposes to the renderer via contextBridge.
 * Implemented in src/preload.ts, consumed as window.api.
 */
export interface Api {
  listContexts(): Promise<ContextList>
  listNamespaces(opts: { context: string | null }): Promise<string[]>
  listPods(opts: { context: string | null; namespace: string }): Promise<PodInfo[]>
  list(sel: KubectlTarget, path: string): Promise<DirEntry[]>
  mkdir(sel: KubectlTarget, dir: string, name: string): Promise<string>
  rename(sel: KubectlTarget, dir: string, from: string, to: string): Promise<boolean>
  remove(sel: KubectlTarget, dir: string, names: string[]): Promise<boolean>
  download(sel: KubectlTarget, paths: string[]): Promise<{ canceled: boolean; count?: number }>
  downloadZip(
    sel: KubectlTarget,
    path: string,
    name: string,
  ): Promise<{ canceled: boolean; savedTo?: string }>
  uploadDialog(sel: KubectlTarget, dir: string): Promise<boolean>
  uploadPaths(sel: KubectlTarget, dir: string, paths: string[]): Promise<void>
  dragStart(payload: { sel: KubectlTarget; dir: string; names: string[] }): Promise<boolean>
  openRemote(payload: { sel: KubectlTarget; dir: string; name: string }): Promise<string>
  openStaged(localPath: string): Promise<string>
  getInfo(): Promise<AppInfo>
  chooseKubeconfig(): Promise<ChooseKubeconfigResult>
  pathForFile(file: File): string | null
  onProgress(cb: (p: OpProgress) => void): void
}
