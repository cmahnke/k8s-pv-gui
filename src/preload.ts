import { contextBridge, ipcRenderer, webUtils } from 'electron'
import type { IpcRendererEvent } from 'electron'
import type { Api, KubectlTarget, OpProgress } from './shared/types'

const api: Api = {
  listContexts: () => ipcRenderer.invoke('k8s:listContexts'),
  listNamespaces: (opts) => ipcRenderer.invoke('k8s:listNamespaces', opts),
  listPods: (opts) => ipcRenderer.invoke('k8s:listPods', opts),
  list: (sel: KubectlTarget, p: string) => ipcRenderer.invoke('fs:list', { sel, path: p }),
  mkdir: (sel, dir, name) => ipcRenderer.invoke('fs:mkdir', { sel, dir, name }),
  rename: (sel, dir, from, to) => ipcRenderer.invoke('fs:rename', { sel, dir, from, to }),
  remove: (sel, dir, names) => ipcRenderer.invoke('fs:delete', { sel, dir, names }),
  download: (sel, paths) => ipcRenderer.invoke('fs:download', { sel, paths }),
  downloadZip: (sel, path, name) => ipcRenderer.invoke('fs:downloadZip', { sel, path, name }),
  uploadDialog: (sel, dir) => ipcRenderer.invoke('fs:upload', { sel, dir }),
  uploadPaths: (sel, dir, paths) => ipcRenderer.invoke('fs:uploadPaths', { sel, dir, paths }),
  dragStart: (payload) => ipcRenderer.invoke('drag:start', payload),
  openRemote: (payload) => ipcRenderer.invoke('fs:openRemote', payload),
  openStaged: (localPath: string) => ipcRenderer.invoke('shell:openStaged', { localPath }),
  getInfo: () => ipcRenderer.invoke('app:getInfo'),
  chooseKubeconfig: () => ipcRenderer.invoke('app:chooseKubeconfig'),

  // Resolve absolute filesystem path of a File object from a drop event.
  pathForFile: (file: File): string | null => {
    try {
      return webUtils.getPathForFile(file)
    } catch {
      return null
    }
  },

  onProgress: (cb: (p: OpProgress) => void) => {
    ipcRenderer.on('op:progress', (_e: IpcRendererEvent, payload: OpProgress) => cb(payload))
  },
}

contextBridge.exposeInMainWorld('api', api)
