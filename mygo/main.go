package main

// lit explorer 的 MyGo 版：用系统 WebView2 承载同一份渲染层，
// Go 侧重新实现 preload 暴露的那些能力（文件系统、状态、菜单、协议、窗口）。
//
// 能力屏蔽：内嵌网页（Electron 的 WebContentsView）在 MyGo 上没有对应物，
// web 快捷访问改为交给系统浏览器打开，相关 pv.* 接口在 bridge.js 里是空实现。

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
	"net"
	"net/http"
	"net/url"
	"os"
	"os/exec"
	"path/filepath"
	"strconv"
	"strings"
	"sync"
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
)

type App struct {
	win     *mygo.Window
	seq     int
	seqMu   sync.Mutex
	saveTim *time.Timer
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
				if res := app.openWorkspace(root); res["error"] != nil {
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
	w, h := 1440, 900
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
		if a.win == nil || a.win.IsDestroyed() || a.win.IsMinimized() {
			return
		}
		b := a.win.Bounds()
		patchInternal(map[string]any{"window": map[string]any{
			"width": b.Width, "height": b.Height, "x": b.X, "y": b.Y,
		}})
	})
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
	abs, err := filepath.Abs(dir)
	if err != nil {
		return map[string]any{"error": "NOT_A_DIRECTORY"}
	}
	st, err := os.Stat(abs)
	if err != nil || !st.IsDir() {
		return map[string]any{"error": "NOT_A_DIRECTORY"}
	}
	real, err := realPath(abs)
	if err != nil {
		return map[string]any{"error": "NOT_A_DIRECTORY"}
	}

	a.seqMu.Lock()
	a.seq++
	seq := a.seq
	a.seqMu.Unlock()

	resetAllowedRoots()
	allowResolvedRoot(real)
	offerRoot(real)
	if seq != a.seq {
		return map[string]any{"error": "SUPERSEDED"}
	}

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
	if a.win != nil && !a.win.IsDestroyed() {
		a.win.SetTitle(baseName(real) + " · lit explorer")
		evOpenRoot.Emit(a.win, real)
	}
	return map[string]any{"root": real}
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
	if err := exec.Command("cmd", "/c", "start", "", abs).Start(); err != nil {
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

func (a *App) OpenExternalURL(raw string) map[string]any {
	u, err := url.Parse(strings.TrimSpace(raw))
	if err != nil || (u.Scheme != "http" && u.Scheme != "https") || u.User != nil {
		return map[string]any{"error": "BAD_URL"}
	}
	if err := exec.Command("cmd", "/c", "start", "", u.String()).Start(); err != nil {
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
			{Label: "重新扫描目录", Accelerator: "F5", Click: func(*mygo.MenuItem, *mygo.Window) {
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
	items = append(items, &mygo.MenuItem{Label: "重新扫描目录", Accelerator: "F5", Click: func(*mygo.MenuItem, *mygo.Window) {
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
		mygo.Separator(),
		{Label: "重新扫描目录", Accelerator: "F5", Click: func(*mygo.MenuItem, *mygo.Window) { evRescan.Emit(a.win, struct{}{}) }},
		{Label: "聚焦搜索框", Accelerator: "Ctrl+F", Click: func(*mygo.MenuItem, *mygo.Window) { evFocusSearch.Emit(a.win, struct{}{}) }},
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
		{Label: "示例项目目录", Click: func(*mygo.MenuItem, *mygo.Window) { a.openWorkspace(a.GetSampleRoot()) }},
	}
	mygo.NewMenu(items).Popup(a.win)
	return map[string]any{"ok": true}
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
	_ = exec.Command("cmd", "/c", "start", "", path).Start()
}

func reveal(path string) {
	_ = exec.Command("explorer", "/select,"+path).Start()
}

func copyText(text string) {
	_ = mygo.Clipboard.Write(transfer.TextData(text))
}

func openExternal(raw string) {
	if u, err := url.Parse(raw); err == nil && (u.Scheme == "http" || u.Scheme == "https") {
		_ = exec.Command("cmd", "/c", "start", "", u.String()).Start()
	}
}
