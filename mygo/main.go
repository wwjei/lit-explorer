package main

// lit explorer 的 MyGo 版：用系统 WebView2 承载同一份渲染层，
// Go 侧重新实现 preload 暴露的那些能力（文件系统、状态、菜单、协议、窗口）。
// 内嵌网页由 fork 的 ChildWebView 承载，状态与可见性在 UI 线程上同步。

import (
	"crypto/rand"
	"embed"
	"encoding/base64"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"image"
	"image/gif"
	"image/jpeg"
	"image/png"
	"io/fs"
	"log"
	"math"
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
	"sync/atomic"
	"time"

	"github.com/egoist/mygo"
	"github.com/egoist/mygo/transfer"
	"golang.org/x/image/draw"
	_ "golang.org/x/image/webp"
)

//go:embed all:frontend
var frontendFS embed.FS

//go:embed bridge.js
var bridgeJS string

var (
	evMeta           = mygo.NewEvent[map[string]any]("pv:meta")
	evOpenRoot       = mygo.NewEvent[string]("pv:open-root")
	evNoWorkspace    = mygo.NewEvent[struct{}]("pv:no-workspace")
	evTheme          = mygo.NewEvent[string]("pv:theme")
	evTogglePreview  = mygo.NewEvent[struct{}]("pv:toggle-preview")
	evRescan         = mygo.NewEvent[struct{}]("pv:rescan")
	evFocusSearch    = mygo.NewEvent[struct{}]("pv:focus-search")
	evToggleFavorite = mygo.NewEvent[map[string]any]("pv:toggle-favorite")
	evEditWeb        = mygo.NewEvent[map[string]any]("pv:edit-web")
	evPreviewPrefs   = mygo.NewEvent[map[string]any]("pv:preview-prefs")
	evMaximized      = mygo.NewEvent[bool]("pv:maximized")
	evWebState       = mygo.NewEvent[map[string]any]("pv:web-state")
)

type App struct {
	referenceRoot string
	references    []string
	win           *mygo.Window
	seq           int
	seqMu         sync.Mutex
	saveTim       *time.Timer

	// 网页窗格：按地址保活一个子 webview（对应 Electron 的 web-views.js）
	webMu    sync.Mutex
	webViews map[string]*webViewRec
}

type webSyncRect struct {
	X      float64 `json:"x"`
	Y      float64 `json:"y"`
	Width  float64 `json:"width"`
	Height float64 `json:"height"`
}

type webSyncItem struct {
	URL     string       `json:"url"`
	Visible bool         `json:"visible"`
	Rect    *webSyncRect `json:"rect"`
}

type webView interface {
	SetRect(mygo.Rectangle)
	SetVisible(bool)
	Reload()
	Destroy()
}

type webViewRec struct {
	view    webView
	loaded  atomic.Bool // 只记录是否曾加载成功，用于区分 loaded / navigated
	status  string
	visible bool // 宿主希望显示；实际显示还取决于加载状态
}

func (rec *webViewRec) syncVisibility() {
	rec.view.SetVisible(rec.visible && rec.status == "loaded")
}

var app = &App{}

func main() {
	openArg := argValue("--open=")
	evalArg := argValue("--eval=")
	delay := 1500
	if v := argValue("--delay="); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			delay = n
		}
	}
	// --hold 让窗口在 eval 之后多留一会儿，供外部截图；0 表示立即退出
	hold := 0
	if v := argValue("--hold="); v != "" {
		if n, err := strconv.Atoi(v); err == nil {
			hold = n
		}
	}

	web, err := fs.Sub(frontendFS, "frontend")
	if err != nil {
		log.Fatal(err)
	}
	// 与 Electron 版一样只允许一个实例：第二次启动把已有窗口叫到前台
	if !mygo.App.RequestSingleInstanceLock() {
		return
	}
	mygo.App.OnSecondInstance(func(args []string, wd string) {
		for _, arg := range args {
			if strings.HasPrefix(arg, "--open=") {
				app.openWorkspace(strings.TrimPrefix(arg, "--open="))
			}
		}
		if app.win != nil && !app.win.IsDestroyed() {
			app.win.Show()
			app.win.Focus()
		}
	})
	mygo.SetFrontend(web)

	if err := mygo.Protocol.HandleFunc("pv", servePreview); err != nil {
		log.Fatal(err)
	}
	mygo.BindAs("App", app)

	mygo.App.WhenReady(func() {
		if err := startPreviewServer(); err != nil {
			log.Fatal(err)
		}
		state := loadState()
		offerRoot(openArg)
		if root, _ := state["lastRoot"].(string); root != "" {
			offerRoot(root)
		}
		if recent, ok := state["recentRoots"].([]any); ok {
			for _, r := range recent {
				if s, ok := r.(string); ok {
					offerRoot(s)
				}
			}
		}
		if projects, ok := state["projects"].([]any); ok {
			for _, p := range projects {
				if m, ok := p.(map[string]any); ok {
					if s, ok := m["path"].(string); ok {
						offerRoot(s)
					}
				}
			}
		}
		createWindow(state)

		root := openArg
		if root == "" {
			root, _ = state["lastRoot"].(string)
		}
		app.win.Page().OnDidFinishLoad(func() {
			if root != "" {
				if res := app.openWorkspace(root); res["error"] != nil && res["error"] != "SUPERSEDED" {
					evNoWorkspace.Emit(app.win, struct{}{})
				}
			}
			if evalArg != "" {
				go runEval(evalArg, delay, hold)
			}
		})
	})

	if err := mygo.App.Run(); err != nil {
		log.Fatal(err)
	}
}

func createWindow(state map[string]any) {
	w, h, x, y, hasPos := windowBounds(state["window"])
	opts := mygo.WindowOptions{
		Title:     "lit explorer",
		URL:       "/src/renderer/index.html",
		Width:     w,
		Height:    h,
		MinWidth:  900,
		MinHeight: 560,
		Hidden:    true,
		Frameless: true,
		Page:      mygo.PageOptions{PreloadScript: bridgeJS},
	}
	if hasPos {
		opts.X, opts.Y = x, y
	}
	app.win = mygo.NewWindow(opts)
	app.win.OnReadyToShow(func() { app.win.Show() })
	app.win.OnResize(func() { app.scheduleSaveBounds() })
	app.win.OnMove(func() { app.scheduleSaveBounds() })
	app.win.OnMaximize(func() { evMaximized.Emit(app.win, true) })
	app.win.OnUnmaximize(func() { evMaximized.Emit(app.win, false) })
	app.win.OnFileDrop(func(e *mygo.FileDropEvent) {
		for _, p := range e.Paths {
			if st, err := os.Stat(p); err == nil && st.IsDir() {
				offerRoot(p)
				app.openWorkspace(p)
				return
			}
		}
	})
}

func runEval(file string, delay, hold int) {
	time.Sleep(time.Duration(delay) * time.Millisecond)
	code, err := os.ReadFile(file)
	if err != nil {
		fmt.Println("[eval] " + err.Error())
		mygo.App.Quit()
		return
	}
	val, err := app.win.Page().Eval(string(code))
	if err != nil {
		fmt.Println("[eval] error: " + err.Error())
	} else {
		raw, _ := json.Marshal(val)
		fmt.Println("[eval] " + string(raw))
	}
	if hold > 0 {
		time.Sleep(time.Duration(hold) * time.Millisecond)
	} else {
		time.Sleep(300 * time.Millisecond)
	}
	mygo.App.Quit()
}

func windowBounds(value any) (int, int, int, int, bool) {
	w, h := 1280, 900
	m, ok := value.(map[string]any)
	if !ok {
		return w, h, 0, 0, false
	}
	if n, ok := number(m["width"]); ok && n >= 200 {
		w = int(clamp(n, 200, 10000))
	}
	if n, ok := number(m["height"]); ok && n >= 200 {
		h = int(clamp(n, 200, 10000))
	}
	x, okX := number(m["x"])
	y, okY := number(m["y"])
	if !okX || !okY {
		return w, h, 0, 0, false
	}
	return w, h, int(clamp(x, -100000, 100000)), int(clamp(y, -100000, 100000)), true
}

func (a *App) scheduleSaveBounds() {
	if a.saveTim != nil {
		a.saveTim.Stop()
	}
	a.saveTim = time.AfterFunc(300*time.Millisecond, func() {
		mygo.RunOnMain(func() {
			if a.win != nil {
				saveWindowBounds(a.win)
			}
		})
	})
}

type windowGeometry interface {
	IsDestroyed() bool
	IsMinimized() bool
	IsMaximized() bool
	Bounds() mygo.Rectangle
}

// 在 UI 线程上一起检查状态和读取几何，避免最大化切入两者之间。
func saveWindowBounds(win windowGeometry) {
	if win.IsDestroyed() || win.IsMinimized() || win.IsMaximized() {
		return
	}
	b := win.Bounds()
	patchInternal(map[string]any{"window": map[string]any{
		"width": b.Width, "height": b.Height, "x": b.X, "y": b.Y,
	}})
}

func argValue(prefix string) string {
	for _, a := range os.Args[1:] {
		if strings.HasPrefix(a, prefix) {
			return strings.TrimPrefix(a, prefix)
		}
	}
	return ""
}

func appPathUserData() (string, error) {
	return mygo.App.Path(mygo.PathUserData)
}

/* ------------------------------------------------------------------ *
 * 工作区
 * ------------------------------------------------------------------ */

func (a *App) openWorkspace(dir string) map[string]any {
	return a.openWorkspaceWith(dir, resolveWorkspaceRoot, func(real string) {
		if a.win != nil && !a.win.IsDestroyed() {
			a.win.SetTitle(baseName(real) + " · lit explorer")
			evOpenRoot.Emit(a.win, real)
		}
	})
}

func resolveWorkspaceRoot(dir string) (string, error) {
	abs, err := filepath.Abs(dir)
	if err != nil {
		return "", err
	}
	st, err := os.Stat(abs)
	if err != nil {
		return "", err
	}
	if !st.IsDir() {
		return "", fmt.Errorf("not a directory: %s", abs)
	}
	return realPath(abs)
}

func (a *App) openWorkspaceWith(dir string, resolve func(string) (string, error), opened func(string)) map[string]any {
	// 在任何文件系统等待之前登记次序，慢的旧请求不能成为最后一次切换。
	a.seqMu.Lock()
	a.seq++
	seq := a.seq
	a.seqMu.Unlock()
	real, err := resolve(dir)
	references := []string{}
	if err == nil {
		references = savedReferences(real)
	}

	var result map[string]any
	commit := func() {
		a.seqMu.Lock()
		defer a.seqMu.Unlock()
		if seq != a.seq {
			result = map[string]any{"error": "SUPERSEDED"}
			return
		}
		if err != nil {
			result = map[string]any{"error": "NOT_A_DIRECTORY"}
			return
		}

		// 检查、授权、持久化和事件是一次提交；被取代的请求不能留下副作用。
		resetAllowedRoots()
		allowResolvedRoot(real)
		a.referenceRoot = real
		a.references = references
		for _, p := range references {
			allowReferenceRoot(p)
		}
		offerRoot(real)
		state := loadState()
		recent := []any{real}
		if old, ok := state["recentRoots"].([]any); ok {
			for _, r := range old {
				if s, ok := r.(string); ok && !strings.EqualFold(s, real) && len(recent) < 8 {
					recent = append(recent, s)
				}
			}
		}
		patchInternal(map[string]any{"lastRoot": real, "recentRoots": recent})
		opened(real)
		result = map[string]any{"root": real}
	}
	if a.win != nil {
		// 先到 UI 线程再取锁，避免菜单 / 拖放在 UI 线程等锁而提交又等 UI。
		mygo.RunOnMain(commit)
	} else {
		commit()
	}
	return result
}

func (a *App) OpenRoot(dir string) map[string]any {
	if !isOfferedRoot(dir) {
		return map[string]any{"error": "NOT_OFFERED"}
	}
	return a.openWorkspace(dir)
}

func (a *App) PickFolder() map[string]any {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent: a.win, Title: "选择项目目录", Directory: true,
	})
	if err != nil {
		return map[string]any{"error": "EPICK", "message": err.Error()}
	}
	if len(paths) == 0 {
		return map[string]any{"canceled": true}
	}
	return a.openWorkspace(paths[0])
}

func (a *App) GetSampleRoot() string {
	dir, err := appPathUserData()
	if err != nil {
		return ""
	}
	dest := filepath.Join(dir, "sample-project")
	if _, err := os.Stat(dest); err != nil {
		if err := extractEmbedded("sample-project", dest); err != nil {
			return ""
		}
	}
	return offerRoot(dest)
}

func extractEmbedded(prefix, dest string) error {
	src, err := fs.Sub(frontendFS, "frontend/"+prefix)
	if err != nil {
		return err
	}
	return fs.WalkDir(src, ".", func(p string, d fs.DirEntry, err error) error {
		if err != nil {
			return err
		}
		target := filepath.Join(dest, filepath.FromSlash(p))
		if d.IsDir() {
			return os.MkdirAll(target, 0o755)
		}
		data, err := fs.ReadFile(src, p)
		if err != nil {
			return err
		}
		return os.WriteFile(target, data, 0o644)
	})
}

/* ------------------------------------------------------------------ *
 * 文件系统
 * ------------------------------------------------------------------ */

func (a *App) List(dir string) map[string]any {
	abs, entries, err := listDir(dir)
	if err != nil {
		return map[string]any{"error": codeOf(err), "message": err.Error()}
	}
	statEntries(abs, entries, func(dir string, metas map[string]any) {
		if a.win != nil && !a.win.IsDestroyed() {
			evMeta.Emit(a.win, map[string]any{"dir": dir, "metas": metas})
		}
	})
	return map[string]any{"dir": abs, "entries": entries}
}

func (a *App) Read(path string) readResult {
	res, _ := readFileForPreview(path)
	return res
}

func (a *App) ReadBytes(path string) bytesResult {
	return readFileBytes(path)
}

func (a *App) Stat(target string) statResult {
	return statPath(target)
}

func (a *App) WriteSvg(path, content string, expected map[string]any) map[string]any {
	size, okSize := number(expected["size"])
	mtime, okMtime := number(expected["mtime"])
	return writeSvgFile(path, content, int64(size), mtime, okSize && okMtime)
}

func (a *App) PreviewURL(path string) map[string]any {
	abs, err := assertAllowed(path)
	if err != nil {
		return map[string]any{"error": codeOf(err)}
	}
	version := ""
	if st, err := os.Stat(abs); err == nil {
		version = previewVersion(st)
	}
	return map[string]any{"url": toPreviewURL(abs) + version}
}

type imageItem struct {
	Src   string `json:"src"`
	URL   string `json:"url,omitempty"`
	Error string `json:"error,omitempty"`
}

func (a *App) ResolveImages(mdPath string, srcs []string) map[string]any {
	items := []imageItem{}
	base, err := assertAllowed(mdPath)
	if err != nil {
		return map[string]any{"error": codeOf(err), "items": items}
	}
	dir := filepath.Dir(base)
	rootList := allowedRootList()
	root := ""
	if len(rootList) > 0 {
		root = rootList[0]
	}
	if len(srcs) > maxMdImages {
		srcs = srcs[:maxMdImages]
	}
	for _, raw := range srcs {
		clean := cleanImageSrc(raw)
		if clean == "" {
			items = append(items, imageItem{Src: raw, Error: "EBAD_SRC"})
			continue
		}
		var abs string
		if (strings.HasPrefix(clean, "/") || strings.HasPrefix(clean, `\`)) && root != "" {
			abs = filepath.Join(root, strings.TrimLeft(clean, `/\`))
		} else {
			abs = filepath.Join(dir, clean)
		}
		real, err := assertAllowed(abs)
		if err != nil {
			items = append(items, imageItem{Src: raw, Error: codeOf(err)})
			continue
		}
		st, err := os.Stat(real)
		if err != nil {
			items = append(items, imageItem{Src: raw, Error: "ESTAT"})
			continue
		}
		if st.IsDir() {
			items = append(items, imageItem{Src: raw, Error: "ENOT_FILE"})
			continue
		}
		if st.Size() > imgMaxBytes {
			items = append(items, imageItem{Src: raw, Error: "ETOO_LARGE"})
			continue
		}
		if k := kindFor(real); k != "image" && k != "svg" {
			items = append(items, imageItem{Src: raw, Error: "ENOT_IMAGE"})
			continue
		}
		items = append(items, imageItem{Src: raw, URL: toPreviewURL(real) + previewVersion(st)})
	}
	return map[string]any{"items": items}
}

func cleanImageSrc(raw string) string {
	s := strings.TrimSpace(raw)
	if len(s) > imgSrcMax {
		return ""
	}
	if strings.HasPrefix(s, "<") && strings.HasSuffix(s, ">") {
		s = strings.TrimSpace(s[1 : len(s)-1])
	}
	if i := strings.IndexAny(s, "?#"); i >= 0 {
		s = s[:i]
	}
	if decoded, err := url.PathUnescape(s); err == nil {
		s = decoded
	}
	if s == "" {
		return ""
	}
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return ""
		}
	}
	if i := strings.Index(s, ":"); i > 1 {
		return ""
	}
	if i := strings.Index(s, ":"); i >= 0 && i <= 1 && len(s) > i+1 {
		// 单字母盘符之外，冒号后不是路径分隔符的一律当协议头
		if s[i+1] != '/' && s[i+1] != '\\' {
			return ""
		}
	}
	if strings.HasPrefix(s, "//") || strings.HasPrefix(s, `\\`) {
		return ""
	}
	return s
}

func previewVersion(st fs.FileInfo) string {
	return "?v=" + strconv.FormatInt(st.ModTime().UnixMilli(), 10) + "-" + strconv.FormatInt(st.Size(), 10)
}

// WebView2 只把主框架发起的请求交给自定义 scheme，iframe 里的相对资源
// （HTML 预览的 css/js）根本到不了 Go 处理器。这里改用只绑 127.0.0.1 的
// 一次性预览服务：地址带随机令牌，仍按工作区白名单校验真实路径。
var previewBase string

func startPreviewServer() error {
	ln, err := net.Listen("tcp", "127.0.0.1:0")
	if err != nil {
		return err
	}
	buf := make([]byte, 16)
	if _, err := rand.Read(buf); err != nil {
		return err
	}
	token := hex.EncodeToString(buf)
	prefix := "/" + token + "/"
	mux := http.NewServeMux()
	mux.HandleFunc(prefix, func(w http.ResponseWriter, r *http.Request) {
		p := strings.TrimPrefix(r.URL.Path, prefix)
		p = strings.TrimPrefix(p, "/")
		if os.Getenv("MYGO_DEBUG") != "" {
			log.Printf("pv %s path=%q", r.Method, p)
		}
		abs, err := assertAllowed(p)
		if err != nil {
			http.Error(w, "forbidden", http.StatusForbidden)
			return
		}
		data, err := os.ReadFile(abs)
		if err != nil {
			http.Error(w, "not found", http.StatusNotFound)
			return
		}
		w.Header().Set("Content-Type", mimeFor(abs))
		w.Header().Set("Cache-Control", "no-store")
		w.Header().Set("Access-Control-Allow-Origin", "*")
		_, _ = w.Write(data)
	})
	go func() { _ = http.Serve(ln, mux) }()
	previewBase = "http://127.0.0.1:" + strconv.Itoa(ln.Addr().(*net.TCPAddr).Port) + prefix
	return nil
}

func toPreviewURL(abs string) string {
	normalized := filepath.ToSlash(abs)
	segs := strings.Split(normalized, "/")
	for i := range segs {
		segs[i] = url.PathEscape(segs[i])
	}
	return previewBase + strings.Join(segs, "/")
}

func servePreview(w http.ResponseWriter, r *http.Request) {
	p := r.URL.Path
	if os.Getenv("MYGO_DEBUG") != "" {
		log.Printf("pv %s host=%s path=%q", r.Method, r.Host, p)
	}
	if strings.HasPrefix(p, "/") && len(p) >= 3 && p[2] == ':' {
		p = p[1:]
	}
	abs, err := assertAllowed(p)
	if err != nil {
		http.Error(w, "forbidden", http.StatusForbidden)
		return
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		http.Error(w, "not found", http.StatusNotFound)
		return
	}
	w.Header().Set("Content-Type", mimeFor(abs))
	w.Header().Set("Cache-Control", "no-store")
	w.Header().Set("Access-Control-Allow-Origin", "*")
	_, _ = w.Write(data)
}

/* ------------------------------------------------------------------ *
 * 系统集成
 * ------------------------------------------------------------------ */

func (a *App) OpenPath(path string) map[string]any {
	abs, err := assertAllowed(path)
	if err != nil {
		return map[string]any{"error": codeOf(err), "message": err.Error()}
	}
	if err := mygo.Shell.OpenPath(abs); err != nil {
		return map[string]any{"error": "OPEN_FAILED", "message": err.Error()}
	}
	return map[string]any{"ok": true}
}

func (a *App) Reveal(path string) map[string]any {
	abs, err := assertAllowed(path)
	if err != nil {
		return map[string]any{"error": codeOf(err), "message": err.Error()}
	}
	if err := exec.Command("explorer", "/select,"+abs).Start(); err != nil {
		return map[string]any{"error": "EREVEAL", "message": err.Error()}
	}
	return map[string]any{"ok": true}
}

func (a *App) CopyText(text string) map[string]any {
	if err := mygo.Clipboard.Write(transfer.TextData(text)); err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"ok": true}
}

const maxWebViews = 6

// WebSync 对应 Electron 的 web:sync：按地址保活子 webview，并更新矩形 / 可见性。
// 地址不在列表里的视图销毁；同一地址只留一份（与 web-views.js 一致）。
func (a *App) WebSync(list []webSyncItem) map[string]any {
	var result map[string]any
	mygo.RunOnMain(func() { result = a.syncWebViews(list) })
	return result
}

// 与 OnState / WebReload 同在 UI 线程，状态改变与 SetVisible 不会交错。
func (a *App) syncWebViews(list []webSyncItem) map[string]any {
	desired := map[string]webSyncItem{}
	for _, raw := range list {
		if len(desired) >= maxWebViews {
			break
		}
		if !validWebURL(raw.URL) {
			continue
		}
		want := webSyncItem{URL: raw.URL, Visible: raw.Visible && raw.Rect != nil, Rect: raw.Rect}
		if prev, ok := desired[raw.URL]; ok && (prev.Visible || !want.Visible) {
			continue
		}
		desired[raw.URL] = want
	}

	a.webMu.Lock()
	existing := make(map[string]*webViewRec, len(a.webViews))
	for u, rec := range a.webViews {
		existing[u] = rec
	}
	a.webMu.Unlock()

	for url, rec := range existing {
		if _, keep := desired[url]; !keep {
			rec.view.Destroy()
			a.webMu.Lock()
			delete(a.webViews, url)
			a.webMu.Unlock()
		}
	}

	for url, want := range desired {
		rec := existing[url]
		if rec == nil {
			// 先以空矩形创建，加载成功前不让原生窗口盖住宿主卡片。
			view, err := a.win.NewChildWebView(mygo.ChildWebViewOptions{URL: url})
			if err != nil {
				evWebState.Emit(a.win, map[string]any{
					"url": url, "status": "error", "code": "VIEW_FAILED", "desc": err.Error(),
				})
				continue
			}
			rec = &webViewRec{view: view, status: "loading"}
			view.OnState(func(st mygo.ChildWebViewState) { a.emitWebState(rec, st) })
			a.webMu.Lock()
			if a.webViews == nil {
				a.webViews = map[string]*webViewRec{}
			}
			a.webViews[url] = rec
			a.webMu.Unlock()
		}
		rec.visible = want.Visible
		if want.Visible && want.Rect != nil {
			rec.view.SetRect(rectOf(*want.Rect))
		}
		rec.syncVisibility()
	}
	return map[string]any{"ok": true}
}

func rectOf(r webSyncRect) mygo.Rectangle {
	return mygo.Rectangle{
		X: int(math.Round(r.X)), Y: int(math.Round(r.Y)),
		Width: int(math.Round(r.Width)), Height: int(math.Round(r.Height)),
	}
}

func (a *App) emitWebState(rec *webViewRec, st mygo.ChildWebViewState) {
	if st.Status == "popup" {
		// 页面要开新窗口：与 Electron 一样交给系统浏览器
		openExternal(st.CurrentURL)
		return
	}
	evWebState.Emit(a.win, rec.applyState(st))
}

func (rec *webViewRec) applyState(st mygo.ChildWebViewState) map[string]any {
	switch st.Status {
	case "loading", "loaded", "error", "gone":
		rec.status = st.Status
		rec.syncVisibility()
	}
	payload := map[string]any{"url": st.URL, "status": st.Status}
	switch st.Status {
	case "loaded":
		if rec.loaded.Swap(true) {
			payload["status"] = "navigated"
		}
		payload["currentUrl"] = st.CurrentURL
	case "error":
		payload["code"] = st.Code
		payload["desc"] = st.Desc
	case "gone":
		payload["reason"] = st.Desc
	}
	return payload
}

func (a *App) WebReload(raw string) map[string]any {
	result := map[string]any{"ok": false}
	mygo.RunOnMain(func() {
		a.webMu.Lock()
		rec := a.webViews[raw]
		a.webMu.Unlock()
		if rec == nil {
			return
		}
		// 主动清掉失败卡片，仍等 loaded 后再显示；loaded 不重置，保留 navigated 语义。
		a.emitWebState(rec, mygo.ChildWebViewState{URL: raw, Status: "loading"})
		rec.view.Reload()
		result["ok"] = true
	})
	return result
}

func (a *App) OpenExternalURL(raw string) map[string]any {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return map[string]any{"error": "BAD_URL"}
	}
	if err := mygo.Shell.OpenExternal(u.String()); err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"ok": true}
}

func (a *App) PickProjectIcon() map[string]any {
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{
		Parent: a.win, Title: "选择项目图标",
		Filters: []mygo.FileFilter{{Name: "图片", Extensions: []string{"png", "jpg", "jpeg", "gif", "webp"}}},
	})
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	if len(paths) == 0 {
		return map[string]any{"canceled": true}
	}
	f, err := os.Open(paths[0])
	if err != nil {
		return map[string]any{"error": "BAD_IMAGE"}
	}
	defer f.Close()
	var img image.Image
	switch strings.ToLower(filepath.Ext(paths[0])) {
	case ".jpg", ".jpeg":
		img, err = jpeg.Decode(f)
	case ".gif":
		img, err = gif.Decode(f)
	default:
		img, err = png.Decode(f)
		if err != nil {
			if _, seekErr := f.Seek(0, 0); seekErr == nil {
				img, err = jpeg.Decode(f)
			}
		}
	}
	if err != nil || img == nil {
		return map[string]any{"error": "BAD_IMAGE"}
	}
	b := img.Bounds()
	scale := 64.0 / float64(maxInt(b.Dx(), b.Dy()))
	dst := image.NewRGBA(image.Rect(0, 0, maxInt(1, int(float64(b.Dx())*scale)), maxInt(1, int(float64(b.Dy())*scale))))
	draw.CatmullRom.Scale(dst, dst.Bounds(), img, b, draw.Over, nil)
	var buf strings.Builder
	if err := png.Encode(&stringWriter{&buf}, dst); err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"dataUrl": "data:image/png;base64," + base64.StdEncoding.EncodeToString([]byte(buf.String()))}
}

type stringWriter struct{ b *strings.Builder }

func (s *stringWriter) Write(p []byte) (int, error) {
	return s.b.Write(p)
}

func maxInt(a, b int) int {
	if a > b {
		return a
	}
	return b
}

/* ------------------------------------------------------------------ *
 * 设置与窗口
 * ------------------------------------------------------------------ */

func (a *App) GetState() map[string]any {
	return loadState()
}

func (a *App) SetState(changes map[string]any) map[string]any {
	return patchFromPage(changes)
}

func (a *App) Minimize() map[string]any {
	a.win.Minimize()
	return map[string]any{"ok": true}
}

func (a *App) ToggleMaximize() bool {
	if a.win.IsMaximized() {
		a.win.Unmaximize()
	} else {
		a.win.Maximize()
	}
	return a.win.IsMaximized()
}

func (a *App) CloseWindow() map[string]any {
	a.win.Close()
	return map[string]any{"ok": true}
}

func (a *App) IsMaximized() bool {
	return a.win.IsMaximized()
}

/* ------------------------------------------------------------------ *
 * 菜单
 * ------------------------------------------------------------------ */

func (a *App) OpenContextMenu(payload map[string]any) map[string]any {
	kind, _ := payload["kind"].(string)
	target, _ := payload["path"].(string)

	if kind == "web" {
		raw, _ := payload["url"].(string)
		if !validWebURL(raw) {
			return map[string]any{"ok": false}
		}
		name, _ := payload["name"].(string)
		if name == "" {
			name = raw
		}
		items := []*mygo.MenuItem{
			{Label: "在浏览器中打开", Click: func(*mygo.MenuItem, *mygo.Window) { openExternal(raw) }},
			{Label: "复制链接", Click: func(*mygo.MenuItem, *mygo.Window) { copyText(raw) }},
			{Label: "编辑链接…", Click: func(*mygo.MenuItem, *mygo.Window) {
				evEditWeb.Emit(a.win, map[string]any{"url": raw, "name": name})
			}},
			mygo.Separator(),
			{Label: "从快速访问中移除", Click: func(*mygo.MenuItem, *mygo.Window) {
				evToggleFavorite.Emit(a.win, map[string]any{"url": raw, "name": name, "kind": "web"})
			}},
			mygo.Separator(),
			{Label: "刷新已变化内容", Accelerator: "F5", Click: func(*mygo.MenuItem, *mygo.Window) {
				evRescan.Emit(a.win, struct{}{})
			}},
		}
		mygo.NewMenu(items).Popup(a.win)
		return map[string]any{"ok": true}
	}

	var items []*mygo.MenuItem
	if target != "" && kind == "file" {
		items = append(items,
			&mygo.MenuItem{Label: "用默认程序打开", Click: func(*mygo.MenuItem, *mygo.Window) { openPath(target) }},
			mygo.Separator())
	} else if target != "" && kind == "folder" {
		items = append(items,
			&mygo.MenuItem{Label: "在资源管理器中打开", Click: func(*mygo.MenuItem, *mygo.Window) { openPath(target) }},
			mygo.Separator())
	}
	if target != "" {
		favorited, _ := payload["favorited"].(bool)
		label := "添加到快速访问"
		if favorited {
			label = "从快速访问中移除"
		}
		items = append(items,
			&mygo.MenuItem{Label: label, Click: func(*mygo.MenuItem, *mygo.Window) {
				evToggleFavorite.Emit(a.win, map[string]any{
					"path": target, "name": baseName(target), "isDir": kind == "folder",
				})
			}},
			mygo.Separator(),
			&mygo.MenuItem{Label: "复制路径", Click: func(*mygo.MenuItem, *mygo.Window) { copyText(target) }},
			&mygo.MenuItem{Label: "复制名称", Click: func(*mygo.MenuItem, *mygo.Window) { copyText(baseName(target)) }},
			&mygo.MenuItem{Label: "在资源管理器中显示", Click: func(*mygo.MenuItem, *mygo.Window) { reveal(target) }},
			mygo.Separator())
	}
	items = append(items, &mygo.MenuItem{Label: "刷新已变化内容", Accelerator: "F5", Click: func(*mygo.MenuItem, *mygo.Window) {
		evRescan.Emit(a.win, struct{}{})
	}})
	mygo.NewMenu(items).Popup(a.win)
	return map[string]any{"ok": true}
}

func (a *App) OpenAppMenu() map[string]any {
	state := loadState()
	docx := state["previewDocx"] != false
	pptx := state["previewPptx"] != false
	items := []*mygo.MenuItem{
		{Label: "打开文件夹…", Accelerator: "Ctrl+O", Click: func(*mygo.MenuItem, *mygo.Window) { a.PickFolder() }},
		{Label: "打开示例项目", Click: func(*mygo.MenuItem, *mygo.Window) { a.openWorkspace(a.GetSampleRoot()) }},
		{Label: "注册文件夹右键菜单", Click: func(*mygo.MenuItem, *mygo.Window) { a.configureFolderMenu(true) }},
		{Label: "取消文件夹右键菜单", Click: func(*mygo.MenuItem, *mygo.Window) { a.configureFolderMenu(false) }},
		mygo.Separator(),
		{Label: "刷新已变化内容", Accelerator: "F5", Click: func(*mygo.MenuItem, *mygo.Window) { evRescan.Emit(a.win, struct{}{}) }},
		{Label: "在当前文件中查找", Accelerator: "Ctrl+F", Click: func(*mygo.MenuItem, *mygo.Window) { evFocusSearch.Emit(a.win, struct{}{}) }},
		{Label: "快捷键", Submenu: []*mygo.MenuItem{
			{Label: "↑ / ↓　选择", Disabled: true},
			{Label: "→　进入目录", Disabled: true},
			{Label: "←　返回上级", Disabled: true},
			{Label: "⏎　打开文件", Disabled: true},
			{Label: "Ctrl+F　预览内查找", Disabled: true},
			{Label: "双击　用默认程序打开", Disabled: true},
		}},
		mygo.Separator(),
		{Label: "显示 / 隐藏预览面板", Accelerator: "Ctrl+B", Click: func(*mygo.MenuItem, *mygo.Window) { evTogglePreview.Emit(a.win, struct{}{}) }},
		{Label: "切换明暗主题", Accelerator: "Ctrl+Shift+L", Click: func(*mygo.MenuItem, *mygo.Window) { a.toggleTheme() }},
		mygo.Separator(),
		{Label: "启用 Word (.docx) 内嵌预览", Type: mygo.MenuItemCheckbox, Checked: docx, Click: func(*mygo.MenuItem, *mygo.Window) {
			a.togglePreviewPref("previewDocx")
		}},
		{Label: "启用 PPT (.pptx) 内嵌预览", Type: mygo.MenuItemCheckbox, Checked: pptx, Click: func(*mygo.MenuItem, *mygo.Window) {
			a.togglePreviewPref("previewPptx")
		}},
		mygo.Separator(),
		{Label: "开发者工具", Accelerator: "F12", Click: func(*mygo.MenuItem, *mygo.Window) { a.win.Page().OpenDevTools() }},
		mygo.Separator(),
		{Label: "功能特性说明", Click: func(*mygo.MenuItem, *mygo.Window) { a.openBundled("FEATURES.md") }},
		{Label: "第三方许可", Click: func(*mygo.MenuItem, *mygo.Window) {
			a.openBundled("notices/THIRD-PARTY-NOTICES.md")
		}},
		{Label: "示例项目目录", Click: func(*mygo.MenuItem, *mygo.Window) { a.openWorkspace(a.GetSampleRoot()) }},
	}
	mygo.NewMenu(items).Popup(a.win)
	return map[string]any{"ok": true}
}

// openBundled 把随二进制分发的文档（FEATURES.md、第三方许可）落到 userData 再交给
// 系统默认程序。每次都重写：升级后 exe 里的是新版本，别让旧副本留在磁盘上。
// 它们不在工作区内，所以不走 assertAllowed。
func (a *App) openBundled(name string) {
	dir, err := appPathUserData()
	if err != nil {
		return
	}
	data, err := fs.ReadFile(frontendFS, "frontend/"+name)
	if err != nil {
		return
	}
	dest := filepath.Join(dir, "bundled", filepath.FromSlash(name))
	if err := os.MkdirAll(filepath.Dir(dest), 0o755); err != nil {
		return
	}
	if err := os.WriteFile(dest, data, 0o644); err != nil {
		return
	}
	openPath(dest)
}

func (a *App) toggleTheme() {
	state := loadState()
	theme := "dark"
	if state["theme"] == "dark" {
		theme = "light"
	}
	patchInternal(map[string]any{"theme": theme})
	evTheme.Emit(a.win, theme)
}

func (a *App) togglePreviewPref(key string) {
	state := loadState()
	next := state[key] == false
	patchInternal(map[string]any{key: next})
	state = loadState()
	evPreviewPrefs.Emit(a.win, map[string]any{
		"previewDocx": state["previewDocx"] != false,
		"previewPptx": state["previewPptx"] != false,
	})
}

func openPath(path string) {
	_ = mygo.Shell.OpenPath(path)
}

func reveal(path string) {
	_ = exec.Command("explorer", "/select,"+path).Start()
}

func copyText(text string) {
	_ = mygo.Clipboard.Write(transfer.TextData(text))
}

func openExternal(raw string) {
	if u, err := url.Parse(raw); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
		_ = mygo.Shell.OpenExternal(u.String())
	}
}

// 注册项只使用当前用户的注册表，不提升权限。
func (a *App) configureFolderMenu(enable bool) {
	key := `HKCU\Software\Classes\Directory\shell\LitExplorerMyGo`
	exe, err := os.Executable()
	if err != nil {
		log.Print(err)
		return
	}
	commands := [][]string{{"delete", key, "/f"}}
	if enable {
		commands = [][]string{
			{"add", key, "/ve", "/d", "用 Lit MyGo 打开", "/f"},
			{"add", key, "/v", "Icon", "/d", exe, "/f"},
			{"add", key + `\command`, "/ve", "/d", `"` + exe + `" "--open=%1"`, "/f"},
		}
	}
	for _, args := range commands {
		if out, err := exec.Command("reg.exe", args...).CombinedOutput(); err != nil {
			log.Printf("文件夹菜单设置失败: %v %s", err, out)
			mygo.Dialog.Message(mygo.MessageOptions{Parent: a.win, Message: "文件夹菜单设置失败", Detail: string(out), Buttons: []string{"确定"}})
			return
		}
	}
}
