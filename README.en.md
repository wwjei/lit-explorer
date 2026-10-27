# lit explorer

<img src="assets/icon.svg" width="88" height="88" alt="lit explorer">

A local project file browser for developers: Miller-column directory navigation on the left,
instant in-app preview on the right, double-click to open a file with the system default app.

**Windows only** (x64). There are no macOS or Linux build targets and no cross-platform plans.

> The main documentation is in Chinese: [README.md](README.md). This page is a summary for
> readers who don't read Chinese.

## Install

Download from [Releases](https://github.com/wwjei/lit-explorer/releases):

- `Lit-Explorer-Setup-<version>.exe` — NSIS installer, install directory is selectable (~122 MB)
- `Lit-Explorer-<version>-portable.exe` — no installation required (~111 MB)
- `Lit-Explorer-MyGo-Setup-<version>.exe` — MyGo build, uses the system WebView2 (~5.5 MB)
- `Lit-Explorer-MyGo-<version>-portable.exe` — MyGo portable build (~18 MB)
- `SHA256SUMS.txt` — checksums for the four above

The two builds share the same UI and can coexist. The MyGo build needs the WebView2 Runtime
(bundled with Windows 11; usually present on Windows 10 via Edge).

Builds are **not code-signed**, so Windows SmartScreen will warn about an unknown publisher.
You can verify a download yourself:

```bash
sha256sum -c SHA256SUMS.txt
```

## What it does

| | |
| --- | --- |
| Navigation | Click a folder to open a new column; root column stays pinned on horizontal scroll |
| Preview | Markdown (rendered + source), code with syntax highlighting (40+ languages), images, PDF, HTML, Word / PowerPoint, plain text |
| In-preview find | `Ctrl+F` inside Markdown and Word / PowerPoint previews |
| Images | Sequential preview of a directory, zoom levels, fit to width |
| Pinning | Pin a preview column so it survives further navigation; several pinned columns can sit side by side |

Full feature list and known limitations: [FEATURES.md](FEATURES.md) (Chinese).

## Security model

The renderer has no Node access (`contextIsolation: true`, `nodeIntegration: false`,
`sandbox: true`). The main process is the only entry point to the filesystem and is
**read-only**. All paths are checked against the current workspace using their `realpath`,
so junctions and symlinks cannot escape it.

Preview content is always treated as untrusted: docx `altChunk` is not rendered, document DOM
is sanitized after parsing, Markdown links go through a protocol allowlist, and HTML previews
run in an opaque-origin iframe.

To report a vulnerability, see [SECURITY.md](SECURITY.md) — please don't open a public issue.

## Privacy

No account, no telemetry, no crash reporting, no update check. The app never contacts a server
on its own. The only network activity comes from files you preview (a script in an HTML preview,
a remote image in Markdown) and behaves like it would in a browser.

## Development

```bash
npm install
npm start          # build renderer bundles, then launch
npm test           # unit + integration
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for conventions and the project's few hard rules
(Chinese).

## License

[MIT](LICENSE). Third-party code bundled into the build is listed in
`resources/notices/THIRD-PARTY-NOTICES.md` inside the installer.
