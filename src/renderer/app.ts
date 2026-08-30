import type { Api, DirEntry, KubectlTarget, MountInfo, PodInfo } from '../shared/types'

// SAFETY: every selector passed here targets a static id/class present in
// index.html, so querySelector always resolves to the requested element type.
const $ = <T extends HTMLElement = HTMLElement>(sel: string): T => document.querySelector(sel) as T

// Mutable copy of the preload API: internal calls go through this so the
// console / automated tests can stub remote methods (window.__fm.backend).
const backend: Api = { ...window.api }

interface AppState {
  contexts: string[]
  currentContext: string | null
  namespaces: string[]
  namespace: string | null
  pods: PodInfo[]
  pod: string | null
  mounts: MountInfo[]
  mount: MountInfo | null
  cwd: string
  entries: DirEntry[]
  selection: Set<string>
  loading: boolean
}

const state: AppState = {
  contexts: [],
  currentContext: null,
  namespaces: [],
  namespace: null,
  pods: [],
  pod: null,
  mounts: [],
  mount: null,
  cwd: '/',
  entries: [],
  selection: new Set<string>(),
  loading: false,
}

// ---------------------------------------------------------------------------
// status bar
// ---------------------------------------------------------------------------

let spinnerCount = 0

function setStatus(text: string, cls = ''): void {
  const el = $('#status-text')
  el.textContent = text
  el.className = cls
}

function busy(on: boolean): void {
  state.loading = on
  spinnerCount += on ? 1 : -1
  if (spinnerCount < 0) spinnerCount = 0
  $<HTMLElement>('#status-spinner').hidden = spinnerCount === 0
  $<HTMLButtonElement>('#btn-refresh').disabled =
    !state.currentContext || !state.namespace || !state.pod || !state.mount
}

function setProgress(percent: number | undefined, state: string | undefined): void {
  const wrap = $<HTMLElement>('#progress-wrap')
  const bar = $<HTMLElement>('#progress-bar')
  if (state === 'done' || state === 'error') {
    // briefly show 100% on done, then hide
    if (state === 'done' && typeof percent !== 'number') {
      bar.style.width = '100%'
      wrap.hidden = false
      wrap.classList.remove('indeterminate')
    } else if (typeof percent === 'number') {
      bar.style.width = `${percent}%`
    }
    setTimeout(() => {
      wrap.hidden = true
      wrap.classList.remove('indeterminate')
      bar.style.width = '0'
      bar.style.transform = ''
    }, 900)
    return
  }
  if (typeof percent === 'number') {
    wrap.hidden = false
    wrap.classList.remove('indeterminate')
    bar.style.width = `${percent}%`
  } else if (state === 'running') {
    wrap.hidden = false
    wrap.classList.add('indeterminate')
    bar.style.width = ''
  } else {
    wrap.hidden = true
    wrap.classList.remove('indeterminate')
  }
}

window.api.onProgress(({ op, detail, state, percent }) => {
  setStatus(
    `${op}: ${detail}`,
    state === 'error' ? 'state-error' : state === 'done' ? 'state-done' : '',
  )
  setProgress(percent, state)
})

// ---------------------------------------------------------------------------
// error banner – beautiful presentation for cluster connection failures
// ---------------------------------------------------------------------------

let pendingRetry: (() => void) | null = null

function isConnectionErrorMessage(msg: string): boolean {
  return /connection.*refused|was refused|unable to connect|did you specify the right host|6443.*refused|ECONNREFUSED|connection timed out|network is unreachable|no such host|certificate.*expired|tls.*handshake|dial tcp|cluster unreachable/i.test(
    msg,
  )
}

function hideBanner(): void {
  $<HTMLElement>('#error-banner').hidden = true
  pendingRetry = null
}

function showBanner(opts: {
  title: string
  detail: string
  hint: string
  retry?: () => void
}): void {
  $<HTMLElement>('#error-banner-title').textContent = opts.title
  $<HTMLElement>('#error-banner-detail').textContent = opts.detail
  $<HTMLElement>('#error-banner-hint').textContent = opts.hint
  const banner = $<HTMLElement>('#error-banner')
  banner.hidden = false
  pendingRetry = opts.retry ?? null
  $<HTMLButtonElement>('#error-banner-retry').hidden = !opts.retry
  // Bring into view on small windows
  banner.scrollIntoView({ block: 'nearest', behavior: 'smooth' })
}

function wireBannerActions(): void {
  $<HTMLButtonElement>('#error-banner-retry').addEventListener('click', () => {
    hideBanner()
    if (pendingRetry) pendingRetry()
  })
  $<HTMLButtonElement>('#error-banner-config').addEventListener('click', () => {
    hideBanner()
    void chooseKubeconfig()
  })
  $<HTMLButtonElement>('#error-banner-dismiss').addEventListener('click', () => hideBanner())
}
wireBannerActions()

// Catch clauses compile to `any` here (useUnknownInCatchVariables is off),
// so call sites may forward thrown values directly.
function showError(error: Error | string, retry?: () => void): void {
  console.error(error)
  const raw = error instanceof Error ? error.message : error
  // Strip the "Cluster unreachable: " prefix we add in main for clean display
  const detail = raw.replace(/^Cluster unreachable:\s*/i, '').trim() || raw
  if (isConnectionErrorMessage(raw)) {
    const kubeHint = state.currentContext
      ? `Context "${state.currentContext}" points at a server that isn't reachable.`
      : 'No reachable server found for the current kubeconfig.'
    showBanner({
      title: 'Cannot reach Kubernetes cluster',
      detail,
      hint:
        `${kubeHint} ` +
        'Check that your cluster is running, your kubeconfig points at the right host (e.g. not 127.0.0.1:6443 when the cluster is stopped), and that your network/VPN allows the connection. ' +
        'You can retry or pick a different kubeconfig.',
      retry: retry ?? (() => void init()),
    })
    setStatus('Cluster unreachable — see banner for details', 'state-error')
    return
  }
  hideBanner()
  setStatus(raw, 'state-error')
}

// ---------------------------------------------------------------------------
// selectors (context -> namespace -> pod -> volume)
// ---------------------------------------------------------------------------

async function init(): Promise<void> {
  try {
    hideBanner()
    const info = await backend.getInfo()
    $('#welcome-kubeconfig').textContent = info.kubeconfig ? `kubeconfig: ${info.kubeconfig}` : ''
    const { contexts, current } = await backend.listContexts()
    state.contexts = contexts
    fillSelect($<HTMLSelectElement>('#sel-context'), contexts, current)
    state.currentContext = current
    if (current) await loadNamespaces()
    else setStatus('No kubectl context found', 'state-error')
  } catch (e) {
    showError(e as Error, () => void init())
  }
}

async function loadNamespaces(): Promise<void> {
  disableAll('#sel-namespace', '#sel-pod', '#sel-mount')
  try {
    busy(true)
    hideBanner()
    setStatus('Loading namespaces…')
    state.namespaces = await backend.listNamespaces({ context: state.currentContext })
    fillSelect($<HTMLSelectElement>('#sel-namespace'), state.namespaces, state.namespaces[0])
    state.namespace = state.namespaces[0] || null
    enable('#sel-namespace')
    if (state.namespace) await loadPods()
  } catch (e) {
    showError(e as Error, () => void loadNamespaces())
  } finally {
    busy(false)
  }
}

async function loadPods(): Promise<void> {
  disableAll('#sel-pod', '#sel-mount')
  resetFileView()
  if (!state.namespace) return
  try {
    busy(true)
    hideBanner()
    setStatus('Listing pods with volumes…')
    state.pods = await backend.listPods({
      context: state.currentContext!,
      namespace: state.namespace,
    })
    const podNames = state.pods.map((p) => p.name)
    fillSelect($<HTMLSelectElement>('#sel-pod'), podNames, podNames[0] || '')
    enable('#sel-pod')
    state.pod = podNames[0] || null
    if (state.pod) await loadMounts()
    else setStatus(`No running pods mounting volumes in "${state.namespace}"`, 'state-error')
  } catch (e) {
    showError(e as Error, () => void loadPods())
  } finally {
    busy(false)
  }
}

async function loadMounts(): Promise<void> {
  disableAll('#sel-mount')
  resetFileView()
  const pod = state.pods.find((p) => p.name === state.pod)
  state.mounts = pod ? pod.mounts : []
  const labels = state.mounts.map(
    (m) =>
      `${m.type === 'pvc' ? '⛁' : m.type === 'hostPath' ? '⛁' : '◇'} ${m.source || m.volume} → ${m.mountPath}`,
  )
  fillSelect(
    $<HTMLSelectElement>('#sel-mount'),
    labels.map((l, i): [string, string] => [String(i), l]),
    '0',
  )
  enable('#sel-mount')
  state.mount = state.mounts.length ? state.mounts[0]! : null
  if (state.mount) await navigate(state.mount.mountPath)
  else setStatus('This pod has no PVC/hostPath/emptyDir mounts', 'state-error')
}

function mountSel(): KubectlTarget | null {
  if (!state.mount) return null
  return {
    context: state.currentContext,
    namespace: state.namespace,
    pod: state.pod,
    container: state.mount.container,
  }
}

// ---------------------------------------------------------------------------
// directory listing
// ---------------------------------------------------------------------------

async function navigate(dir: string): Promise<void> {
  const sel = mountSel()
  if (!sel) return
  try {
    busy(true)
    hideBanner()
    setStatus(`Loading ${dir} …`)
    const entries = await backend.list(sel, dir)
    state.cwd = dir.replace(/\/+$/, '') || '/'
    state.entries = entries
    state.selection.clear()
    renderAll()
    setStatus(
      `${entries.length} item${entries.length === 1 ? '' : 's'} — ${describeMount(state.mount)}`,
    )
  } catch (e) {
    showError(e as Error, () => void navigate(dir))
  } finally {
    busy(false)
  }
}

function describeMount(m: MountInfo | null): string {
  if (!m) return ''
  const kind =
    m.type === 'pvc' ? `PVC ${m.source}` : m.type === 'hostPath' ? `hostPath ${m.source}` : m.type
  return `${kind} · pod ${state.pod}/${m.container}`
}

function renderAll(): void {
  renderBreadcrumb()
  renderRows()
  renderWelcome()
  updateToolbar()
}

function renderWelcome(): void {
  $<HTMLElement>('#welcome').hidden = !!state.mount
}

function updateToolbar(): void {
  const ready = !!state.mount && !state.loading
  $<HTMLButtonElement>('#btn-newfolder').disabled = !ready
  $<HTMLButtonElement>('#btn-refresh').disabled = !ready
}

function renderBreadcrumb(): void {
  const bc = $('#breadcrumb')
  bc.innerHTML = ''
  const root = state.mount ? state.mount.mountPath : '/'
  const rel = state.cwd.startsWith(root) ? state.cwd.slice(root.length) : '/'
  const parts = rel.split('/').filter(Boolean)

  const rootLabel = state.mount ? state.mount.source || state.mount.volume : '/'
  bc.appendChild(crumb(rootLabel, root))
  let acc = root === '/' ? '' : root
  for (const part of parts) {
    acc = acc + '/' + part
    bc.appendChild(sep())
    bc.appendChild(crumb(part, acc.replace(/\/+/g, '/')))
  }

  function crumb(label: string, target: string): HTMLSpanElement {
    const el = document.createElement('span')
    el.className = 'crumb' + (target === state.cwd ? ' current' : '')
    el.textContent = label
    el.title = target
    el.onclick = () => {
      if (target !== state.cwd) void navigate(target)
    }
    // allow drop uploads directly onto crumbs
    el.addEventListener('dragover', (e) => {
      e.preventDefault()
      el.classList.add('drop-target')
    })
    el.addEventListener('dragleave', () => el.classList.remove('drop-target'))
    el.addEventListener('drop', (e) => {
      el.classList.remove('drop-target')
      void handleDrop(e, target)
    })
    return el
  }
  function sep(): HTMLSpanElement {
    const s = document.createElement('span')
    s.className = 'crumb-sep'
    s.textContent = '/'
    return s
  }
}

function renderRows(): void {
  const tbody = $<HTMLTableSectionElement>('#file-rows')

  // Rebuilding the table destroys the <tr> under the cursor, which breaks
  // native double-click synthesis (Chromium won't emit dblclick onto a
  // replacement node). So only rebuild when the listing itself changed;
  // otherwise just sync selection styling in place.
  const signature = state.cwd + '|' + state.entries.map((e) => `${e.name}:${e.type}`).join(',')
  const rebuild = signature !== renderedListing
  renderedListing = signature

  if (rebuild) {
    tbody.innerHTML = ''
    for (const entry of state.entries) {
      tbody.appendChild(buildRow(entry))
    }
  }

  // SAFETY: every child appended to tbody is a <tr> built by buildRow().
  const rows = Array.from(tbody.children) as HTMLTableRowElement[]
  for (const tr of rows) {
    tr.classList.toggle('selected', state.selection.has(tr.dataset.name ?? ''))
  }

  $<HTMLElement>('#empty-hint').hidden = state.entries.length > 0 || !state.mount
  updateSelectionInfo()
}

let renderedListing = '\u0000initial'

function buildRow(entry: DirEntry): HTMLTableRowElement {
  const tr = document.createElement('tr')
  tr.className = 'file-row'
  tr.dataset.name = entry.name
  tr.dataset.type = entry.type
  if (state.selection.has(entry.name)) tr.classList.add('selected')

  tr.innerHTML = `
    <td class="col-icon">${fileIcon(entry.type)}</td>
    <td><span class="fname">${escapeHtml(entry.name)}${
      entry.type === 'symlink'
        ? `<span class="symlink-target">→ ${escapeHtml(entry.linkTarget || '?')}</span>`
        : ''
    }</span></td>
    <td class="col-size">${entry.type === 'dir' ? '—' : formatSize(entry.size)}</td>
    <td class="col-date">${formatDate(entry.modified)}</td>
    <td class="col-perms">${entry.perms}</td>`

  tr.addEventListener('mousedown', (e) => handleRowMouseDown(e, tr, entry))
  tr.addEventListener('dblclick', () => {
    void activateEntry(entry)
  })

  // folders accept drops to upload into them
  if (entry.type === 'dir') {
    tr.addEventListener('dragover', (e) => {
      e.preventDefault()
      e.stopPropagation()
      tr.classList.add('drop-target')
    })
    tr.addEventListener('dragleave', () => tr.classList.remove('drop-target'))
    tr.addEventListener('drop', (e) => {
      e.stopPropagation()
      tr.classList.remove('drop-target')
      void handleDrop(e, joinPath(state.cwd, entry.name))
    })
  }

  tr.addEventListener('contextmenu', (e) => {
    e.preventDefault()
    if (!state.selection.has(entry.name)) {
      state.selection.clear()
      state.selection.add(entry.name)
      renderRows()
    }
    showEntryMenu(e.clientX, e.clientY, entry)
  })

  return tr
}

// ---------------------------------------------------------------------------
// host-style file icons (Finder-like inline SVGs)
// ---------------------------------------------------------------------------

const FOLDER_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M1.5 4c0-.83.67-1.5 1.5-1.5h3.09c.4 0 .78.16 1.06.44l1.06 1.06h5.29c.83 0 1.5.67 1.5 1.5v6.5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5V4z" fill="#5aa9e6"/>' +
  '<path d="M1.5 5.5h13v6.5c0 .83-.67 1.5-1.5 1.5H3c-.83 0-1.5-.67-1.5-1.5v-6z" fill="#7fc2f8"/></svg>'

const FILE_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="#fdfdfd" stroke="#9aa1a9" stroke-width="0.8"/>' +
  '<path d="M9.5 1.5v3h3" fill="#eceef0" stroke="#9aa1a9" stroke-width="0.8"/></svg>'

const LINK_SVG =
  '<svg viewBox="0 0 16 16" aria-hidden="true">' +
  '<path d="M3.5 1.5h6l3 3v9a1 1 0 0 1-1 1h-8a1 1 0 0 1-1-1v-11a1 1 0 0 1 1-1z" fill="#fdfdfd" stroke="#9aa1a9" stroke-width="0.8"/>' +
  '<path d="M9.5 1.5v3h3" fill="#eceef0" stroke="#9aa1a9" stroke-width="0.8"/>' +
  '<path d="M4.5 12.5c3 0 4.5-1.5 4.9-3.6m0 0L8 10.2m1.4-1.3 1.4 1.6" fill="none" stroke="#3572d8" stroke-width="1.1" stroke-linecap="round"/></svg>'

function fileIcon(type: DirEntry['type']): string {
  if (type === 'dir') return FOLDER_SVG
  if (type === 'symlink') return LINK_SVG
  return FILE_SVG
}

// ---------------------------------------------------------------------------
// selection & activation
// ---------------------------------------------------------------------------

function handleRowMouseDown(e: MouseEvent, _tr: HTMLTableRowElement, entry: DirEntry): void {
  if (e.button !== 0) return
  if (e.metaKey || e.ctrlKey) {
    toggleSelect(entry.name)
  } else if (!state.selection.has(entry.name)) {
    state.selection.clear()
    state.selection.add(entry.name)
  }
  renderRows()

  // begin potential OS drag-out
  const startX = e.clientX
  const startY = e.clientY
  let dragging = false
  const move = (ev: MouseEvent): void => {
    if (!dragging && Math.hypot(ev.clientX - startX, ev.clientY - startY) > 5) {
      dragging = true
      cleanup()
      void beginDragOut()
    }
  }
  const up = (): void => cleanup()
  function cleanup(): void {
    window.removeEventListener('mousemove', move)
    window.removeEventListener('mouseup', up)
  }
  window.addEventListener('mousemove', move)
  window.addEventListener('mouseup', up)
}

function toggleSelect(name: string): void {
  if (state.selection.has(name)) state.selection.delete(name)
  else state.selection.add(name)
}

async function beginDragOut(): Promise<void> {
  const sel = mountSel()
  if (!sel || state.selection.size === 0) return
  const names = [...state.selection]
  setStatus(`Preparing “${names.join(', ')}” for drag…`)
  try {
    await backend.dragStart({ sel, dir: state.cwd, names })
    setStatus(`Dropped copy of ${names.length} item(s)`)
    setTimeout(() => setStatus(describeMount(state.mount)), 2500)
  } catch (e) {
    showError(e as Error)
  }
}

async function activateEntry(entry: DirEntry): Promise<void> {
  if (entry.type === 'dir') {
    await navigate(joinPath(state.cwd, entry.name))
    return
  }
  // open files locally in a staged temp location
  const sel = mountSel()
  if (!sel) return
  try {
    busy(true)
    setStatus(`Opening ${entry.name}…`)
    const localPath = await backend.openRemote({ sel, dir: state.cwd, name: entry.name })
    setStatus(`Opened ${entry.name}`)
    void localPath
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

function updateSelectionInfo(): void {
  let count = 0
  let size = 0
  for (const entry of state.entries) {
    if (state.selection.has(entry.name)) {
      count++
      if (entry.type !== 'dir') size += entry.size
    }
  }
  $('#selection-info').textContent =
    count > 0 ? `${count} selected · ${formatSize(size)}` : `${state.entries.length} items`
}

// ---------------------------------------------------------------------------
// drag & drop uploads
// ---------------------------------------------------------------------------

let dragHintActive = false

function setDragHint(active: boolean): void {
  if (dragHintActive === active) return
  dragHintActive = active
  setStatus(
    active
      ? `Release to upload into ${state.mount ? describeMount(state.mount) : state.cwd}`
      : describeMount(state.mount),
  )
}

document.addEventListener('dragover', (e) => {
  if (!hasFiles(e)) return
  e.preventDefault()
  setDragHint(true)
})
document.addEventListener('dragleave', (e) => {
  // relatedTarget is null once the pointer leaves the window entirely
  if (e.relatedTarget === null) setDragHint(false)
})

document.addEventListener('drop', () => {
  for (const el of Array.from(document.querySelectorAll('.drop-target'))) {
    el.classList.remove('drop-target')
  }
})

function hasFiles(e: DragEvent): boolean {
  return !!e.dataTransfer && Array.from(e.dataTransfer.types || []).includes('Files')
}

async function handleDrop(e: DragEvent, targetDir: string): Promise<void> {
  e.preventDefault()
  e.stopPropagation()
  setDragHint(false)
  const files = Array.from(e.dataTransfer?.files ?? [])
  const paths = files.map((f) => window.api.pathForFile(f)).filter((p): p is string => !!p)
  if (paths.length === 0) return
  const sel = mountSel()
  if (!sel) return
  try {
    busy(true)
    setStatus(`Uploading ${paths.length} item(s) to ${targetDir} …`)
    await backend.uploadPaths(sel, targetDir, paths)
    if (targetDir === state.cwd || isInside(targetDir, state.cwd)) await refresh()
  } catch (err) {
    showError(err as Error)
  } finally {
    busy(false)
  }
}

function isInside(parent: string, child: string): boolean {
  return child.startsWith(parent === '/' ? '/' : parent + '/')
}

// ---------------------------------------------------------------------------
// context menu
// ---------------------------------------------------------------------------

let menuEl: HTMLElement | null = null

function closeMenu(): void {
  if (menuEl) {
    menuEl.remove()
    menuEl = null
  }
}
window.addEventListener('click', closeMenu)
window.addEventListener('blur', closeMenu)
window.addEventListener('keydown', (e) => {
  if (e.key === 'Escape') closeMenu()
})

interface MenuItem {
  label: string
  action: () => void
  danger?: boolean
}

function buildMenu(x: number, y: number, items: (MenuItem | '-')[]): void {
  closeMenu()
  menuEl = document.createElement('div')
  menuEl.id = 'ctx-menu'
  for (const item of items) {
    if (item === '-') {
      const hr = document.createElement('hr')
      menuEl.appendChild(hr)
      continue
    }
    const btn = document.createElement('button')
    btn.textContent = item.label
    if (item.danger) btn.classList.add('danger')
    btn.onclick = () => {
      closeMenu()
      item.action()
    }
    menuEl.appendChild(btn)
  }
  document.body.appendChild(menuEl)
  const r = menuEl.getBoundingClientRect()
  menuEl.style.left = Math.min(x, innerWidth - r.width - 8) + 'px'
  menuEl.style.top = Math.min(y, innerHeight - r.height - 8) + 'px'
}

function showEntryMenu(x: number, y: number, entry: DirEntry): void {
  const names = [...state.selection]
  const many = names.length > 1
  const items: (MenuItem | '-')[] = []
  if (!many && entry.type === 'dir') {
    items.push({ label: 'Open', action: () => void activateEntry(entry) })
    items.push({ label: 'Download as ZIP…', action: () => void downloadEntryAsZip(entry) })
  }
  if (!many && entry.type !== 'dir')
    items.push({ label: 'Open locally', action: () => void activateEntry(entry) })
  items.push('-')
  items.push({
    label: many ? `Download ${names.length} items…` : 'Download…',
    action: () => void downloadSelected(names),
  })
  if (!many) items.push({ label: 'Rename…', action: () => void renameEntry(entry) })
  items.push('-')
  items.push({
    label: many ? `Delete ${names.length} items` : 'Delete',
    danger: true,
    action: () => void deleteSelected(names),
  })
  buildMenu(x, y, items)
}

$('#file-area').addEventListener('contextmenu', (e: MouseEvent) => {
  const target = e.target
  if (!(target instanceof HTMLElement)) return
  if (target.closest('.file-row')) return
  if (!state.mount) return
  e.preventDefault()
  buildMenu(e.clientX, e.clientY, [
    { label: 'New folder…', action: () => void newFolder() },
    { label: 'Upload files/folders…', action: () => void uploadViaDialog() },
    '-',
    { label: 'Refresh', action: () => void refresh() },
  ])
})

$('#file-area').addEventListener('mousedown', (e: MouseEvent) => {
  const target = e.target
  if (!(target instanceof HTMLElement)) return
  if (target.closest('.file-row')) return
  state.selection.clear()
  renderRows()
})

// ---------------------------------------------------------------------------
// actions
// ---------------------------------------------------------------------------

async function refresh(): Promise<void> {
  await navigate(state.cwd)
}

/** Let the user pick a kubeconfig file; on success reload the whole cluster cascade. */
async function chooseKubeconfig(): Promise<void> {
  try {
    busy(true)
    const res = await backend.chooseKubeconfig()
    if (res.canceled) {
      setStatus(describeMount(state.mount))
      return
    }
    if (res.error) {
      showError(new Error(res.error))
      return
    }
    $('#welcome-kubeconfig').textContent = `kubeconfig: ${res.path}`
    setStatus(`Using kubeconfig: ${res.path} — reloading…`)
    state.currentContext = null
    await loadNamespaces()
    setStatus(`Using kubeconfig: ${res.path}`)
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

async function downloadSelected(names: string[]): Promise<void> {
  const sel = mountSel()
  if (!sel || names.length === 0) return
  const paths = names.map((n) => joinPath(state.cwd, n))
  try {
    busy(true)
    await backend.download(sel, paths)
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

async function downloadEntryAsZip(entry: DirEntry): Promise<void> {
  const sel = mountSel()
  if (!sel || entry.type !== 'dir') return
  try {
    busy(true)
    const res = (await backend.downloadZip(
      sel,
      joinPath(state.cwd, entry.name),
      entry.name,
    )) as unknown as { canceled: boolean; savedTo?: string; error?: string }
    if (res?.error) {
      showError(new Error(res.error))
      return
    }
    if (!res?.canceled) setStatus(describeMount(state.mount))
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

async function uploadViaDialog(): Promise<void> {
  const sel = mountSel()
  if (!sel) return
  try {
    busy(true)
    const ok = await backend.uploadDialog(sel, state.cwd)
    if (ok) await refresh()
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

async function newFolder(): Promise<void> {
  const name = await promptModal('New folder', 'Folder name', 'Untitled')
  if (!name) return
  const sel = mountSel()
  try {
    busy(true)
    await backend.mkdir(sel!, state.cwd, name)
    await refresh()
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

async function renameEntry(entry: DirEntry): Promise<void> {
  const name = await promptModal('Rename', 'New name', entry.name)
  if (!name || name === entry.name) return
  const sel = mountSel()
  try {
    busy(true)
    await backend.rename(sel!, state.cwd, entry.name, name)
    await refresh()
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

async function deleteSelected(names: string[]): Promise<void> {
  const ok = await confirmModal(
    `Delete ${names.length === 1 ? `“${names[0]}”` : `${names.length} items`} from the volume?\n\nThis cannot be undone.`,
  )
  if (!ok) return
  const sel = mountSel()
  try {
    busy(true)
    await backend.remove(sel!, state.cwd, names)
    state.selection.clear()
    await refresh()
  } catch (e) {
    showError(e as Error)
  } finally {
    busy(false)
  }
}

// ---------------------------------------------------------------------------
// modal prompts (window.prompt is unavailable in Electron)
// ---------------------------------------------------------------------------

type BodyBuilder<T> = (body: HTMLDivElement) => (() => T) | null

function promptModal(title: string, label: string, value: string): Promise<string | false> {
  return openModal<string>(title, (body) => {
    const lbl = document.createElement('label')
    lbl.textContent = label
    const input = document.createElement('input')
    input.value = value
    input.style.width = '100%'
    lbl.appendChild(input)
    body.appendChild(lbl)
    setTimeout(() => {
      input.focus()
      input.select()
    })
    return () => input.value.trim()
  })
}

function confirmModal(message: string): Promise<boolean> {
  return openModal<boolean>(
    'Confirm',
    (body) => {
      const p = document.createElement('p')
      p.textContent = message
      p.style.whiteSpace = 'pre-line'
      p.style.userSelect = 'text'
      body.appendChild(p)
      return () => true
    },
    { okText: 'Delete', danger: true },
  )
}

interface ModalOptions {
  okText?: string
  danger?: boolean
}

function openModal<T>(
  title: string,
  buildBody: BodyBuilder<T>,
  { okText = 'OK', danger = false }: ModalOptions = {},
): Promise<T | false> {
  return new Promise((resolve) => {
    const backdrop = document.createElement('div')
    backdrop.id = 'modal-backdrop'
    backdrop.tabIndex = -1
    const box = document.createElement('div')
    box.id = 'modal'
    const h = document.createElement('h3')
    h.textContent = title
    const body = document.createElement('div')
    body.className = 'modal-body'
    const row = document.createElement('div')
    row.className = 'modal-actions'

    const cancel = document.createElement('button')
    cancel.textContent = 'Cancel'
    cancel.onclick = done(null)
    const ok = document.createElement('button')
    ok.textContent = okText
    if (danger) ok.classList.add('danger-btn')
    ok.onclick = done(true)

    box.appendChild(h)
    box.appendChild(body)
    row.appendChild(cancel)
    row.appendChild(ok)
    box.appendChild(row)
    backdrop.appendChild(box)
    document.body.appendChild(backdrop)

    const getVal = buildBody(body)

    backdrop.addEventListener('keydown', (e) => {
      if (e.key === 'Enter') {
        e.preventDefault()
        done(!!getVal)()
      }
      if (e.key === 'Escape') {
        e.preventDefault()
        done(false)()
      }
    })
    setTimeout(() => backdrop.focus())

    function done(isOk: boolean | null): () => void {
      return () => {
        backdrop.remove()
        resolve(isOk && getVal ? getVal() : false)
      }
    }
  })
}

// ---------------------------------------------------------------------------
// helpers
// ---------------------------------------------------------------------------

function joinPath(a: string, b: string): string {
  return (a.replace(/\/+$/, '') + '/' + b).replace(/\/+/g, '/')
}

const ESCAPE_MAP: Record<string, string> = {
  '&': '&amp;',
  '<': '&lt;',
  '>': '&gt;',
  '"': '&quot;',
  "'": '&#39;',
}

function escapeHtml(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ESCAPE_MAP[c] ?? c)
}

function formatSize(n: number | null): string {
  if (n == null) return ''
  if (n < 1024) return n + ' B'
  const units = ['KB', 'MB', 'GB', 'TB']
  let v = n
  let i = -1
  do {
    v /= 1024
    i++
  } while (v >= 1024 && i < units.length - 1)
  return v.toFixed(v >= 100 ? 0 : 1) + ' ' + units[i]
}

function formatDate(ts: number | null): string {
  if (!ts) return ''
  const d = new Date(ts)
  const pad = (x: number): string => String(x).padStart(2, '0')
  return `${d.getFullYear()}-${pad(d.getMonth() + 1)}-${pad(d.getDate())} ${pad(d.getHours())}:${pad(d.getMinutes())}`
}

type SelectItem = string | [string, string]

function fillSelect(el: HTMLSelectElement, items: SelectItem[], selected?: string | null): void {
  el.innerHTML = ''
  const list = items.map((i): [string, string] => (Array.isArray(i) ? i : [i, i]))
  for (const [val, label] of list) {
    const opt = document.createElement('option')
    opt.value = val
    opt.textContent = label
    opt.title = label
    el.appendChild(opt)
  }
  if (selected != null && list.some(([v]) => v === String(selected))) el.value = String(selected)
}

function enable(sel: string): void {
  setDisabled(sel, false)
}

function disableAll(...sels: string[]): void {
  for (const s of sels) setDisabled(s, true)
}

function setDisabled(sel: string, disabled: boolean): void {
  // SAFETY: every selector passed here is a static button/select id from this module.
  const el = document.querySelector(sel) as HTMLButtonElement | HTMLSelectElement
  el.disabled = disabled
}

function resetFileView(): void {
  state.cwd = '/'
  state.entries = []
  state.selection.clear()
  state.mount = null
  renderAll()
  $<HTMLElement>('#welcome').hidden = false
}

// ---------------------------------------------------------------------------
// wire up toolbar events
// ---------------------------------------------------------------------------

function selectValue(e: Event): string | null {
  const el = e.currentTarget
  return el instanceof HTMLSelectElement ? el.value : null
}

$<HTMLSelectElement>('#sel-context').addEventListener('change', async (e) => {
  state.currentContext = selectValue(e) || null
  await loadNamespaces()
})
$<HTMLSelectElement>('#sel-namespace').addEventListener('change', async (e) => {
  state.namespace = selectValue(e) || null
  await loadPods()
})
$<HTMLSelectElement>('#sel-pod').addEventListener('change', async (e) => {
  state.pod = selectValue(e) || null
  await loadMounts()
})
$<HTMLSelectElement>('#sel-mount').addEventListener('change', async (e) => {
  const idx = Number(selectValue(e))
  state.mount = state.mounts[idx] || null
  if (state.mount) await navigate(state.mount.mountPath)
})

$<HTMLButtonElement>('#btn-kubeconfig').addEventListener('click', () => void chooseKubeconfig())
$<HTMLButtonElement>('#btn-refresh').addEventListener('click', () => void refresh())
$<HTMLButtonElement>('#btn-newfolder').addEventListener('click', () => void newFolder())

window.addEventListener('keydown', (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'r') {
    e.preventDefault()
    void refresh()
  }
  if ((e.metaKey || e.ctrlKey) && e.key.toLowerCase() === 'a') {
    if (document.activeElement?.tagName === 'INPUT') return
    e.preventDefault()
    state.selection = new Set(state.entries.map((en) => en.name))
    renderRows()
  }
  if (e.key === 'Backspace') {
    if (document.activeElement?.tagName === 'INPUT') return
    if (state.cwd && state.cwd !== state.mount?.mountPath) {
      const parent = state.cwd.split('/').slice(0, -1).join('/') || state.mount!.mountPath
      void navigate(parent)
    }
  }
  if (e.key === 'Delete' || (e.metaKey && e.key === 'Backspace')) {
    if (state.selection.size > 0) void deleteSelected([...state.selection])
  }
})

// exposed for console debugging and automated tests
window.__fm = { state, navigate, refresh, renderAll, backend }

void init()
