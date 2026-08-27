import { execFile, spawn } from 'child_process'
import fs from 'fs'
import fsp from 'fs/promises'
import os from 'os'
import path from 'path'
import type { IpcMainInvokeEvent } from 'electron'
import { app, BrowserWindow, ipcMain, dialog, nativeImage, shell } from 'electron'
import { ZipArchive } from 'archiver'
import type {
  ContextList,
  DirEntry,
  KubectlTarget,
  MountInfo,
  OpKind,
  OpProgress,
  OpState,
  PodInfo,
} from './shared/types'

let mainWindow: Electron.BrowserWindow | null = null
let stagingRoot: string | null = null

// ---------------------------------------------------------------------------
// command line arguments
// ---------------------------------------------------------------------------

function pkgVersion(): string {
  try {
    const raw = fs.readFileSync(path.join(__dirname, '..', 'package.json'), 'utf8')
    const pkg: { version?: string } = JSON.parse(raw)
    return pkg.version ?? '0.0.0'
  } catch {
    return '0.0.0'
  }
}

const USAGE = `K8s Volume Explorer ${pkgVersion()} — browse Kubernetes volumes like a file manager

Usage:
  npm start [options]          development
  k8s-volume-explorer [opts]   packaged app

Options:
  -h, --help                  Show this help and exit
  -k, --kubeconfig <file>     Use this kubeconfig file instead of the default
                              (~/.kube/config, honoring $KUBECONFIG).
                              Also accepts --kubeconfig=<file>.

Examples:
  npm start -- --kubeconfig ~/clusters/staging.yaml
  ./dist/K8sVolumeExplorer --kubeconfig=/etc/rancher/kubeconfig.yaml

Everything else happens in the app window.`

interface CliArgs {
  help: boolean
  kubeconfig: string | null
}

function parseCliArgs(argv: string[]): CliArgs {
  const opts: CliArgs = { help: false, kubeconfig: null }
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i]!
    if (a === '-h' || a === '--help') {
      opts.help = true
    } else if (a === '-k' || a === '--kubeconfig') {
      opts.kubeconfig = argv[++i] ?? null
      if (!opts.kubeconfig || opts.kubeconfig.startsWith('-')) {
        fail('error: --kubeconfig requires a file path')
      }
    } else if (a.startsWith('--kubeconfig=')) {
      opts.kubeconfig = a.slice('--kubeconfig='.length)
    } else if (/^-psn_/i.test(a)) {
      // legacy macOS launchd "-psn_..." argument, ignore
    } else {
      // Not ours — could be an Electron/Chromium runtime switch
      // (--remote-debugging-port, --disable-gpu, …). Warn but keep going.
      console.warn(`warning: ignoring unrecognized argument "${a}"`)
    }
  }
  return opts

  function fail(msg: string): never {
    console.error(`${msg}\n\n${USAGE}`)
    process.exit(1)
  }
}

const cli = parseCliArgs(process.argv.slice(app.isPackaged ? 1 : 2))
if (cli.help) {
  console.log(USAGE)
  process.exit(0)
}
if (cli.kubeconfig && !fs.existsSync(cli.kubeconfig)) {
  console.error(`error: kubeconfig file not found: ${cli.kubeconfig}\n\n${USAGE}`)
  process.exit(1)
}
// Runtime-mutable: starts from --kubeconfig CLI arg, may be changed via the
// in-app picker. All kubectl invocations read it at call time.
let activeKubeconfig: string | null = cli.kubeconfig

function kubeconfigArgs(configFile: string | null = activeKubeconfig): string[] {
  return configFile ? ['--kubeconfig', configFile] : []
}

// ---------------------------------------------------------------------------
// kubectl helpers
// ---------------------------------------------------------------------------

interface RunOptions {
  timeout?: number
  maxBuffer?: number
}

function runKubectl(
  args: string[],
  { timeout = 30000, maxBuffer = 32 * 1024 * 1024 }: RunOptions = {},
): Promise<string> {
  return new Promise((resolve, reject) => {
    execFile(
      'kubectl',
      [...kubeconfigArgs(), ...args],
      { timeout, maxBuffer, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err) {
          const msg = (stderr || err.message || 'kubectl failed').trim()
          reject(new Error(msg))
        } else {
          resolve(stdout)
        }
      },
    )
  })
}

function podArgs(sel: Partial<KubectlTarget> & { pod?: string | null }): string[] {
  const args: string[] = []
  if (sel.context) args.push('--context', sel.context)
  if (sel.namespace) args.push('-n', sel.namespace)
  if (sel.pod) args.push('exec', sel.pod)
  if (sel.container) args.push('-c', sel.container)
  return args
}

// Quote a single argument for use inside an `sh -c` command string.
function shq(s: string): string {
  return "'" + String(s).replace(/'/g, "'\\''") + "'"
}

function send(payload: OpProgress): void {
  if (mainWindow && !mainWindow.isDestroyed()) {
    mainWindow.webContents.send('op:progress', payload)
  }
}

function progress(op: OpKind, detail: string, state: OpState = 'running'): void {
  const payload: OpProgress = { op, detail, state }
  send(payload)
}

// ---------------------------------------------------------------------------
// cluster inspection
// ---------------------------------------------------------------------------

async function listContexts(): Promise<ContextList> {
  try {
    const out = await runKubectl(['config', 'get-contexts', '-o', 'name'])
    const contexts = out
      .split('\n')
      .map((s) => s.trim())
      .filter(Boolean)
    let current: string | null = null
    try {
      current = (await runKubectl(['config', 'current-context'])).trim()
    } catch {
      // no current context set
    }
    return {
      contexts,
      current: current !== null && contexts.includes(current) ? current : contexts[0] || null,
    }
  } catch (e) {
    throw new Error('Could not read kubeconfig: ' + (e instanceof Error ? e.message : String(e)), {
      cause: e,
    })
  }
}

interface NamespaceQuery {
  context: string | null
}

async function listNamespaces({ context }: NamespaceQuery): Promise<string[]> {
  const out = await runKubectl([
    ...(context ? ['--context', context] : []),
    'get',
    'namespaces',
    '-o',
    'json',
  ])
  interface NamespaceList {
    items: { metadata: { name: string } }[]
  }
  const data: NamespaceList = JSON.parse(out)
  return data.items.map((i) => i.metadata.name).sort()
}

// minimal structural typing of the parts of `kubectl get pods -o json` we use
interface RawVolumeMount {
  name: string
  mountPath: string
  subPath?: string
}
interface RawVolume {
  name: string
  persistentVolumeClaim?: { claimName: string }
  hostPath?: { path: string }
  emptyDir?: { sizeLimit?: string }
}
interface RawContainer {
  name: string
  volumeMounts?: RawVolumeMount[]
}
interface RawPod {
  metadata: { name: string; deletionTimestamp?: string }
  status: { phase: string }
  spec: { containers: RawContainer[]; volumes?: RawVolume[] }
}

const BROWSABLE_TYPES = ['pvc', 'hostPath', 'emptyDir']

async function listPods({
  context,
  namespace,
}: {
  context: string | null
  namespace: string
}): Promise<PodInfo[]> {
  const out = await runKubectl([
    ...(context ? ['--context', context] : []),
    '-n',
    namespace,
    'get',
    'pods',
    '-o',
    'json',
  ])
  const data: { items: RawPod[] } = JSON.parse(out)
  const pods = data.items
    .filter((p) => p.status.phase === 'Running' && p.metadata.deletionTimestamp === undefined)
    .map((p) => ({ name: p.metadata.name, mounts: collectMounts(p) }))
    .filter((p) => p.mounts.length > 0)
  pods.sort((a, b) => a.name.localeCompare(b.name))
  return pods
}

function collectMounts(pod: RawPod): MountInfo[] {
  const volumes = new Map((pod.spec.volumes ?? []).map((v) => [v.name, v]))
  const mounts: MountInfo[] = []
  for (const c of pod.spec.containers ?? []) {
    for (const vm of c.volumeMounts ?? []) {
      const vol = volumes.get(vm.name)
      if (!vol) continue
      let type: MountInfo['type']
      let source
      if (vol.persistentVolumeClaim) {
        type = 'pvc'
        source = vol.persistentVolumeClaim.claimName
      } else if (vol.hostPath) {
        type = 'hostPath'
        source = vol.hostPath.path
      } else if (vol.emptyDir) {
        type = 'emptyDir'
        source = '(ephemeral)'
      } else continue
      mounts.push({
        id: `${c.name}:${vm.mountPath}`,
        container: c.name,
        volume: vol.name,
        mountPath: vm.mountPath.replace(/\/+$/, '') || '/',
        subPath: vm.subPath ?? '',
        type,
        source,
      })
    }
  }
  return mounts.filter((m) => BROWSABLE_TYPES.includes(m.type))
}

// ---------------------------------------------------------------------------
// remote file operations
// ---------------------------------------------------------------------------

export function parseLsLine(line: string): DirEntry | null {
  // total N
  if (/^total\s+\d+$/.test(line)) return null
  // permissions links owner group size datename name...
  const m = line.match(/^([-dlbcps][rwxstST-]{9})\s+(\d+)\s+(\S+)\s+(\S+)\s+(\d+)\s+(.+)$/)
  if (!m) return null
  const perms = m[1]!
  const owner = m[3]!
  const group = m[4]!
  const size = Number(m[5])
  const rest = m[6]!

  let type: EntryKindOf = 'file'
  if (perms[0] === 'd') type = 'dir'
  else if (perms[0] === 'l') type = 'symlink'

  // rest = date time name   OR   name (rare)
  let modified: number | null = null
  let name = rest

  // ISO style: YYYY-MM-DD HH:MM name
  let m2 = rest.match(/^(\d{4}-\d{2}-\d{2})\s+(\d{2}:\d{2})\s+(.*)$/)
  if (m2) {
    modified = new Date(`${m2[1]}T${m2[2]}:00`).getTime()
    name = m2[3]!
  } else {
    // Short style: May  1 12:33 name | May  1 2024 name
    m2 = rest.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{2}:\d{2})\s+(.*)$/)
    if (m2) {
      modified =
        new Date(`${m2[1]} ${m2[2]}, ${new Date().getFullYear()} ${m2[3]}`).getTime() || null
      name = m2[4]!
    } else {
      m2 = rest.match(/^([A-Z][a-z]{2})\s+(\d{1,2})\s+(\d{4})\s+(.*)$/)
      if (m2) {
        modified = new Date(`${m2[1]} ${m2[2]}, ${m2[3]}`).getTime() || null
        name = m2[4]!
      }
    }
  }

  let linkTarget: string | null = null
  if (type === 'symlink') {
    const idx = name.indexOf(' -> ')
    if (idx !== -1) {
      linkTarget = name.slice(idx + 4)
      name = name.slice(0, idx)
    }
  }
  if (!name || name === '.' || name === '..') return null
  return { name, type, size, owner, group, perms, modified, linkTarget }
}

type EntryKindOf = DirEntry['type']

function posixJoin(...parts: string[]): string {
  return parts.join('/').replace(/\/+/g, '/')
}

function basename(p: string): string {
  const parts = p.split('/')
  return parts[parts.length - 1] || p
}

async function listDir(sel: KubectlTarget, remotePath: string): Promise<DirEntry[]> {
  const base = podArgs(sel)
  const lsArgs = [...base, '--', 'ls', '-la', '--time-style=long-iso', '--', remotePath]
  let out: string
  try {
    out = await runKubectl(lsArgs)
  } catch {
    try {
      // BusyBox / minimal images may not support --time-style or --
      out = await runKubectl([...base, '--', 'ls', '-la', remotePath])
    } catch (secondErr) {
      throw explainExecFailure(
        secondErr instanceof Error ? secondErr : new Error(String(secondErr)),
        sel,
      )
    }
  }
  const lines = out.split('\n')
  const entries: DirEntry[] = []
  for (const line of lines) {
    if (!line.trim()) continue
    const entry = parseLsLine(line)
    if (entry) entries.push(entry)
  }
  entries.sort((a, b) => {
    if (a.type !== b.type) return a.type === 'dir' ? -1 : 1
    return a.name.localeCompare(b.name, undefined, { sensitivity: 'base' })
  })
  return entries
}

function explainExecFailure(err: Error, sel: KubectlTarget): Error {
  if (
    /exit code 12[67]/.test(err.message) ||
    /executable file not found/i.test(err.message) ||
    (/not found/i.test(err.message) && /exec/i.test(err.message))
  ) {
    return new Error(
      `Container "${sel.container}" in pod "${sel.pod}" has no shell or coreutils ` +
        `(distroless image?) — its filesystem cannot be browsed with kubectl exec. Try a different pod.`,
    )
  }
  return err
}

// Download one remote item (file or directory) into destDir via kubectl cp.
async function downloadItem(
  sel: KubectlTarget,
  remotePath: string,
  destDir: string,
): Promise<string> {
  const name = basename(remotePath)
  const localDest = path.join(destDir, name)
  const cpArgs = [
    ...(sel.context ? ['--context', sel.context] : []),
    '-n',
    sel.namespace!,
    ...(sel.container ? ['-c', sel.container] : []),
    'cp',
    `${sel.pod}:${remotePath}`,
    localDest,
  ]
  progress('download', `Downloading ${name}`)
  try {
    await runKubectl(cpArgs, { timeout: 10 * 60 * 1000, maxBuffer: 1024 * 1024 })
    return localDest
  } catch (e) {
    // Fallback for containers without tar: stream single files with cat.
    const statRes = await runKubectl([...podArgs(sel), '--', 'ls', '-ld', remotePath]).catch(
      () => '',
    )
    if (statRes.startsWith('d')) throw e
    await catToFile(sel, remotePath, localDest)
    return localDest
  }
}

function catToFile(sel: KubectlTarget, remotePath: string, localDest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const child = spawn(
      'kubectl',
      [...kubeconfigArgs(), ...podArgs(sel), '-i', '--', 'cat', remotePath],
      { stdio: ['ignore', 'pipe', 'pipe'] },
    )
    const ws = fs.createWriteStream(localDest)
    child.stdout!.pipe(ws)
    let stderr = ''
    child.stderr!.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    ws.on('error', reject)
    child.on('close', (code) => {
      ws.end(() => (code === 0 ? resolve() : reject(new Error(stderr || `cat exited ${code}`))))
    })
  })
}

async function uploadItem(sel: KubectlTarget, localPath: string, remoteDir: string): Promise<void> {
  const name = path.basename(localPath)
  const dest = posixJoin(remoteDir, name)
  progress('upload', `Uploading ${name}`)
  const cpArgs = [
    ...(sel.context ? ['--context', sel.context] : []),
    '-n',
    sel.namespace!,
    ...(sel.container ? ['-c', sel.container] : []),
    'cp',
    localPath,
    `${sel.pod}:${dest}`,
  ]
  try {
    await runKubectl(cpArgs, { timeout: 30 * 60 * 1000 })
  } catch (e) {
    // Fallback without tar: only works for plain files.
    const st = await fsp.stat(localPath).catch(() => null)
    if (!st || !st.isFile()) throw e
    await pipeFileToCat(sel, localPath, dest)
  }
}

function pipeFileToCat(sel: KubectlTarget, localPath: string, remoteDest: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const parent = remoteDest.split('/').slice(0, -1).join('/') || '/'
    const leaf = basename(remoteDest)
    const child = spawn(
      'kubectl',
      [
        ...kubeconfigArgs(),
        ...podArgs(sel),
        '-i',
        '--',
        'sh',
        '-c',
        `cat > ${shq(posixJoin(parent, leaf))}`,
      ],
      { stdio: ['pipe', 'ignore', 'pipe'] },
    )
    const rs = fs.createReadStream(localPath)
    rs.pipe(child.stdin!)
    let stderr = ''
    child.stderr!.on('data', (d) => {
      stderr += d.toString()
    })
    child.on('error', reject)
    child.on('close', (code) =>
      code === 0 ? resolve() : reject(new Error(stderr || `write failed (${code})`)),
    )
  })
}

async function remoteExec(sel: KubectlTarget, script: string): Promise<string> {
  return runKubectl([...podArgs(sel), '--', 'sh', '-c', script], { maxBuffer: 1024 * 1024 })
}

// ---------------------------------------------------------------------------
// IPC handlers
// ---------------------------------------------------------------------------

interface ListRequest {
  sel: KubectlTarget
  path: string
}
interface MkdirRequest {
  sel: KubectlTarget
  dir: string
  name: string
}
interface RenameRequest {
  sel: KubectlTarget
  dir: string
  from: string
  to: string
}
interface DeleteRequest {
  sel: KubectlTarget
  dir: string
  names: string[]
}
interface DownloadRequest {
  sel: KubectlTarget
  paths: string[]
}
interface DragStartRequest {
  sel: KubectlTarget
  dir: string
  names: string[]
}
interface OpenRemoteRequest {
  sel: KubectlTarget
  dir: string
  name: string
}
interface UploadPathsRequest {
  sel: KubectlTarget
  dir: string
  paths: string[]
}
interface OpenStagedRequest {
  localPath: string
}

function registerIpc(): void {
  ipcMain.handle('k8s:listContexts', (): Promise<ContextList> => listContexts())

  ipcMain.handle('k8s:listNamespaces', (_e: IpcMainInvokeEvent, opts: NamespaceQuery) =>
    listNamespaces(opts),
  )

  ipcMain.handle(
    'k8s:listPods',
    (_e: IpcMainInvokeEvent, opts: { context: string | null; namespace: string }) => listPods(opts),
  )

  ipcMain.handle('fs:list', (_e: IpcMainInvokeEvent, req: ListRequest) =>
    listDir(req.sel, req.path),
  )

  ipcMain.handle('fs:mkdir', async (_e: IpcMainInvokeEvent, req: MkdirRequest): Promise<string> => {
    const target = posixJoin(req.dir, req.name)
    await remoteExec(req.sel, `mkdir -p ${shq(target)}`)
    return target
  })

  ipcMain.handle(
    'fs:rename',
    async (_e: IpcMainInvokeEvent, req: RenameRequest): Promise<boolean> => {
      const a = posixJoin(req.dir, req.from)
      const b = posixJoin(req.dir, req.to)
      if (/[/]/.test(req.to)) throw new Error('Name must not contain "/"')
      await remoteExec(req.sel, `mv ${shq(a)} ${shq(b)}`)
      return true
    },
  )

  ipcMain.handle(
    'fs:delete',
    async (_e: IpcMainInvokeEvent, req: DeleteRequest): Promise<boolean> => {
      for (const n of req.names) {
        progress('delete', `Deleting ${n}`)
        await remoteExec(req.sel, `rm -rf -- ${shq(posixJoin(req.dir, n))}`)
      }
      return true
    },
  )

  ipcMain.handle('fs:download', async (_e: IpcMainInvokeEvent, req: DownloadRequest) => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose download destination',
      properties: ['openDirectory', 'createDirectory'],
    })
    if (res.canceled || !res.filePaths[0]) return { canceled: true }
    const results: string[] = []
    for (const p of req.paths) {
      try {
        results.push(await downloadItem(req.sel, p, res.filePaths[0]))
      } catch (e) {
        progress(
          'download',
          `Failed: ${basename(p)} — ${e instanceof Error ? e.message : e}`,
          'error',
        )
      }
    }
    progress('download', `Downloaded to ${res.filePaths[0]}`, 'done')
    shell.openPath(res.filePaths[0])
    return { canceled: false, count: results.length }
  })

  ipcMain.handle(
    'fs:upload',
    async (_e: IpcMainInvokeEvent, req: { sel: KubectlTarget; dir: string }) => {
      const res = await dialog.showOpenDialog(mainWindow!, {
        title: 'Choose files or folders to upload',
        properties: ['openFile', 'openDirectory', 'multiSelections'],
      })
      if (res.canceled || res.filePaths.length === 0) return false
      await uploadPaths(req.sel, req.dir, res.filePaths)
      return true
    },
  )

  ipcMain.handle(
    'drag:start',
    async (e: IpcMainInvokeEvent, req: DragStartRequest): Promise<boolean> => {
      const stamp = Date.now().toString(36)
      const stageDir = path.join(stagingRoot!, stamp)
      await fsp.mkdir(stageDir, { recursive: true })
      const localFiles: string[] = []
      for (const n of req.names) {
        const remotePath = posixJoin(req.dir, n)
        try {
          localFiles.push(await downloadItem(req.sel, remotePath, stageDir))
        } catch (err) {
          progress(
            'drag',
            `Failed staging ${n}: ${err instanceof Error ? err.message : err}`,
            'error',
          )
        }
      }
      if (localFiles.length === 0) return false
      let icon = nativeImage.createEmpty()
      try {
        const iconFile = path.join(__dirname, 'renderer', 'icon-drag.png')
        const img = nativeImage.createFromPath(iconFile)
        if (!img.isEmpty()) icon = img
      } catch {
        // icon is optional
      }
      e.sender.startDrag({ file: '', files: localFiles, icon })
      return true
    },
  )

  ipcMain.handle(
    'fs:openRemote',
    async (_e: IpcMainInvokeEvent, req: OpenRemoteRequest): Promise<string> => {
      const stamp = Date.now().toString(36)
      const stageDir = path.join(stagingRoot!, `open-${stamp}`)
      await fsp.mkdir(stageDir, { recursive: true })
      const localPath = await downloadItem(req.sel, posixJoin(req.dir, req.name), stageDir)
      progress('open', req.name, 'done')
      shell.openPath(localPath)
      return localPath
    },
  )

  ipcMain.handle(
    'fs:uploadPaths',
    (_e: IpcMainInvokeEvent, req: UploadPathsRequest): Promise<void> =>
      uploadPaths(req.sel, req.dir, req.paths),
  )

  ipcMain.handle('shell:openStaged', (_e: IpcMainInvokeEvent, req: OpenStagedRequest) =>
    shell.openPath(req.localPath),
  )

  ipcMain.handle('app:getInfo', () => ({
    version: app.getVersion(),
    kubeconfig: activeKubeconfig,
  }))

  ipcMain.handle('app:chooseKubeconfig', async () => {
    const res = await dialog.showOpenDialog(mainWindow!, {
      title: 'Choose kubeconfig file',
      // No `filters`: kubeconfigs usually live at ~/.kube/config without an
      // extension, which macOS greys out under any extension-based filter
      // (the file is validated with kubectl below anyway).
      defaultPath: path.join(os.homedir(), '.kube', 'config'),
      properties: ['openFile'],
    })
    if (res.canceled || !res.filePaths[0]) return { canceled: true }
    const file = res.filePaths[0]

    // validate before committing: kubectl must be able to read it
    try {
      await runKubectl([...kubeconfigArgs(file), 'config', 'get-contexts', '-o', 'name'], {
        timeout: 15000,
      })
    } catch (e) {
      return {
        canceled: false,
        path: file,
        error: `kubectl rejected this file: ${e instanceof Error ? e.message : String(e)}`,
      }
    }
    activeKubeconfig = file
    progress('open', `kubeconfig: ${file}`, 'done')
    return { canceled: false, path: file }
  })
}

async function uploadPaths(sel: KubectlTarget, dir: string, localPaths: string[]): Promise<void> {
  for (const lp of localPaths) {
    try {
      await uploadItem(sel, lp, dir)
    } catch (e) {
      progress(
        'upload',
        `Failed: ${path.basename(lp)} — ${e instanceof Error ? e.message : e}`,
        'error',
      )
    }
  }
  progress('upload', 'Upload finished', 'done')
}

/** Zip a local directory; the archive contains the folder itself as root. */
function zipDirectory(srcDir: string, outZip: string): Promise<void> {
  return new Promise((resolve, reject) => {
    const output = fs.createWriteStream(outZip)
    const archive = new ZipArchive({
      zlib: { level: 9 }, // Sets the compression level.
    })
    output.on('close', () => resolve())
    output.on('error', reject)
    archive.on('error', reject)
    archive.pipe(output)
    archive.directory(srcDir, basename(srcDir))
    archive.finalize().catch(reject)
  })
}

interface DownloadZipRequest {
  sel: KubectlTarget
  path: string
  name: string
}

ipcMain.handle('fs:downloadZip', async (_e: IpcMainInvokeEvent, req: DownloadZipRequest) => {
  const res = await dialog.showSaveDialog(mainWindow!, {
    title: 'Save folder as ZIP',
    defaultPath: path.join(app.getPath('downloads'), `${req.name}.zip`),
    filters: [{ name: 'Zip archive', extensions: ['zip'] }],
  })
  if (res.canceled || !res.filePath) return { canceled: true }

  const stageDir = path.join(stagingRoot!, `zip-${Date.now().toString(36)}`)
  await fsp.mkdir(stageDir, { recursive: true })
  try {
    progress('download', `Downloading ${req.name}…`)
    const localDir = await downloadItem(req.sel, req.path, stageDir)
    progress('download', `Zipping ${req.name}…`)
    await zipDirectory(localDir, res.filePath)
    progress('download', `Saved ${path.basename(res.filePath)}`, 'done')
    return { canceled: false, savedTo: res.filePath }
  } finally {
    fsp.rm(stageDir, { recursive: true, force: true }).catch(() => {})
  }
})

// ---------------------------------------------------------------------------
// window / lifecycle
// ---------------------------------------------------------------------------

function createWindow(): void {
  mainWindow = new BrowserWindow({
    width: 1100,
    height: 720,
    minWidth: 780,
    titleBarStyle: 'hiddenInset',
    trafficLightPosition: { x: 14, y: 14 },
    webPreferences: {
      preload: path.join(__dirname, 'preload.js'),
      contextIsolation: true,
      nodeIntegration: false,
      sandbox: false,
    },
  })
  mainWindow.loadFile(path.join(__dirname, 'renderer', 'index.html'))
}

app.whenReady().then(async () => {
  stagingRoot = path.join(os.tmpdir(), 'k8s-pv-gui-staging')
  await fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
  await fsp.mkdir(stagingRoot, { recursive: true })
  registerIpc()
  createWindow()

  app.on('activate', () => {
    if (BrowserWindow.getAllWindows().length === 0) createWindow()
  })
})

app.on('window-all-closed', () => {
  app.quit()
})

app.on('will-quit', () => {
  if (stagingRoot) fsp.rm(stagingRoot, { recursive: true, force: true }).catch(() => {})
})
