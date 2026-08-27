# K8s Volume Explorer

An Electron file manager for Kubernetes volumes. Browse the contents of any
PVC, `hostPath` or `emptyDir` volume mounted by a running pod — and copy
files in and out via drag & drop.

## How it works

Kubernetes volumes can only be accessed through a pod that mounts them, so
this app drives your local `kubectl`:

- **Browse** — `kubectl exec … ls -la` (with a fallback for BusyBox images)
- **Download / drag out** — `kubectl cp` (falls back to streamed `cat` for
  containers without tar)
- **Upload / drop in** — `kubectl cp` (falls back to streamed stdin write)
- **Delete / new folder / rename** — `kubectl exec` shell commands

It uses your existing kubeconfig (`~/.kube/config`, `KUBECONFIG`, in-cluster
configs are untouched). The pods list is filtered to _Running_ pods that
mount at least one interesting volume.

## Requirements

- Node.js ≥ 18
- A `kubectl` binary on your `PATH`
- RBAC allowing `get pods` in the namespace and `create pods/exec`

## Command line options

```sh
npm start [options]          # development
k8s-volume-explorer [opts]   # packaged app

Options:
  -h, --help                  Show this help and exit
  -k, --kubeconfig <file>     Use this kubeconfig file instead of the default
                              (~/.kube/config, honoring $KUBECONFIG).
                              Also accepts --kubeconfig=<file>.
```

Examples:

```sh
npm start -- --kubeconfig ~/clusters/staging.yaml
./dist/K8sVolumeExplorer --kubeconfig=/etc/rancher/kubeconfig.yaml
```

Without `--kubeconfig`, kubectl's own default resolution applies
(`$KUBECONFIG` or `~/.kube/config`). The file in use is shown on the app's
start screen. The **⛁ Config…** toolbar button switches the kubeconfig at
runtime — candidate files are validated with `kubectl config get-contexts`
before the app reloads its cluster state.

## Run

```sh
npm install
npm start          # lint + esbuild build + launch
npm run check      # full gate: oxlint + tsc + prettier + stylelint
npm run lint       # oxlint incl. vendored anti-slop rules (warnings fail)
npm run typecheck  # tsc --noEmit
npm run format     # prettier --write .
npm run stylelint  # CSS lint (stylelint-config-standard)
npm run build      # compile to dist/ without launching
```

Linting uses [oxlint](https://oxc.rs) plus the opinionated
[anti-slop](https://github.com/dmmulroy/anti-slop) rules, **vendored** at
`tools/oxlint/anti-slop/` (not an npm dependency — edit them to taste) and
registered via `oxlint.config.ts`. Type assertions need a preceding
`// SAFETY:` comment explaining the invariant; prefer narrowing (`instanceof`)
or generics over casts.

Formatting is enforced by [Prettier](https://prettier.io) (`.prettierrc.json`,
see `.prettierignore` — the vendored plugin is excluded), CSS quality by
[Stylelint](https://stylelint.io) with `stylelint-config-standard`
(`.stylelintrc.json`; `no-descending-specificity` is off because the
stylesheet intentionally layers state/override selectors after base ones).
CI runs all four gates on every push/PR.

Then pick a context → namespace → pod → volume mount from the toolbar.

## Development

TypeScript throughout; `tsconfig.json` is check-only (`noEmit`) — esbuild
strips types into `dist/` at build time. Sources:

```
src/
├── main.ts            Electron main process: kubectl plumbing + IPC
├── preload.ts         contextBridge API exposed to the renderer
├── shared/types.ts    domain + API contract types shared by both processes
├── types/window.d.ts  renderer globals (window.api, window.__fm)
└── renderer/
    ├── app.ts         file manager logic, selection, DnD
    ├── index.html     UI skeleton
    └── styles.css
```

## Packaging

[electron-builder](https://www.electron.build) is configured in
`package.json` (`build` key) for native apps on all three platforms:

```sh
npm run dist:mac     # dmg + zip  (unsigned by default, see below)
npm run dist:win     # NSIS installer + portable exe
npm run dist:linux   # AppImage + deb
npm run dist         # everything electron-builder can build on this OS
```

Output lands in `release/`. The app icon lives in `assets/icon.png`
(512×512; electron-builder converts it per platform).

Notes:

- macOS builds skip code signing (`identity: null`) so local builds work
  without a Developer ID certificate. For distribution, set
  `CSC_LINK`/`CSC_NAME` (or remove `identity` from the config) and rebuild.
- Cross-building: Linux targets build fine on macOS/Windows; Windows NSIS
  builds from macOS may require [Wine](https://www.winehq.org) depending on
  your electron-builder version. Building on the target OS is always the
  safest option.

## Releasing

See [docs/release.md](docs/release.md) for version bumping, builds, and
publishing a GitHub release.

## Usage

| Action                       | How                                                                                                                                        |
| ---------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| Navigate                     | Double-click folders, click breadcrumbs                                                                                                    |
| Download                     | Drag files/folders out of the window onto Finder/desktop, or right-click → _Download…_                                                     |
| Download folder as ZIP       | Right-click a folder → _Download as ZIP…_                                                                                                  |
| Upload                       | Drag files/folders from Finder onto the window (drop onto a folder row to target it), or right-click empty space → _Upload files/folders…_ |
| Open locally                 | Double-click a file (staged to a temp dir)                                                                                                 |
| New folder / Rename / Delete | Right-click menu                                                                                                                           |
| Switch kubeconfig            | ⛁ Config… button (validated with kubectl before switching), or `--kubeconfig` at launch                                                    |
| Multi-select                 | ⌘-click, ⌘A                                                                                                                                |
| Go up                        | ⌫                                                                                                                                          |

## Notes & limitations

- `kubectl cp` requires a POSIX shell plus `tar` in the container image;
  minimal/distroless images fall back to per-file streaming for single
  files only (directory upload/download needs tar).
- Symlinks are listed but followed only if the target resolves inside the
  same directory operations.
- Dragging out stages files in a temp directory first, so there's a delay
  before the OS drag starts; keep holding the mouse button.
- Deleted files bypass any trash — they're gone.
