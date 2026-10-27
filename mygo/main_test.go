package main

import (
	"os"
	"path/filepath"
	"sync"
	"testing"
	"time"

	"github.com/egoist/mygo"
)

func waitWorkspace[T any](t *testing.T, ch <-chan T) T {
	t.Helper()
	select {
	case value := <-ch:
		return value
	case <-time.After(5 * time.Second):
		t.Fatal("workspace request did not reach the expected stage")
		var zero T
		return zero
	}
}

func TestWorkspaceLatestRequestWins(t *testing.T) {
	isolateState(t)
	a := &App{}
	old, middle, latest := t.TempDir(), t.TempDir(), t.TempDir()
	realLatest, err := resolveWorkspaceRoot(latest)
	if err != nil {
		t.Fatal(err)
	}
	writeTestState(t, map[string]any{"lastRoot": "previous", "recentRoots": []any{"previous"}})
	allowResolvedRoot("previous")

	oldStarted, middleStarted := make(chan struct{}), make(chan struct{})
	releaseOld, releaseMiddle := make(chan struct{}, 1), make(chan struct{}, 1)
	resolve := func(dir string) (string, error) {
		switch dir {
		case old:
			close(oldStarted)
			<-releaseOld
		case middle:
			close(middleStarted)
			<-releaseMiddle
		}
		return resolveWorkspaceRoot(dir)
	}
	var events []string
	opened := func(root string) {
		// 事件不能先于授权和持久化；这里观察提交在外部可见的结果。
		assertJSONEqual(t, allowedRootList(), []string{root})
		if state := loadState(); state["lastRoot"] != root {
			t.Errorf("lastRoot at opened event = %v, want %q", state["lastRoot"], root)
		}
		events = append(events, root)
	}
	var wg sync.WaitGroup
	defer func() {
		close(releaseOld)
		close(releaseMiddle)
		wg.Wait()
	}()
	start := func(dir string) <-chan map[string]any {
		result := make(chan map[string]any, 1)
		wg.Add(1)
		go func() {
			defer wg.Done()
			result <- a.openWorkspaceWith(dir, resolve, opened)
		}()
		return result
	}

	oldResult := start(old)
	waitWorkspace(t, oldStarted)
	middleResult := start(middle)
	waitWorkspace(t, middleStarted)
	assertJSONEqual(t, a.openWorkspaceWith(latest, resolve, opened), map[string]any{"root": realLatest})
	// 后发的中间请求先返回，最早的请求最后返回，两者都不能倒灌。
	releaseMiddle <- struct{}{}
	assertJSONEqual(t, waitWorkspace(t, middleResult), map[string]any{"error": "SUPERSEDED"})
	releaseOld <- struct{}{}
	assertJSONEqual(t, waitWorkspace(t, oldResult), map[string]any{"error": "SUPERSEDED"})

	assertJSONEqual(t, allowedRootList(), []string{realLatest})
	assertJSONEqual(t, events, []string{realLatest})
	state := loadState()
	assertJSONEqual(t, state["recentRoots"], []any{realLatest, "previous"})
	if state["lastRoot"] != realLatest {
		t.Errorf("lastRoot = %v, want %q", state["lastRoot"], realLatest)
	}
	for _, dir := range []string{old, middle} {
		if isOfferedRoot(dir) {
			t.Errorf("superseded root %q was offered", dir)
		}
		if _, err := assertAllowed(dir); codeOf(err) != "EACCES_ROOT" {
			t.Errorf("assertAllowed(%q) = %v, want EACCES_ROOT", dir, err)
		}
	}
}

func TestWorkspaceFailedLatestRequestSupersedesPending(t *testing.T) {
	isolateState(t)
	a := &App{}
	current, pending := t.TempDir(), t.TempDir()
	if result := a.openWorkspace(current); result["error"] != nil {
		t.Fatal(result)
	}
	before, err := os.ReadFile(statePath())
	if err != nil {
		t.Fatal(err)
	}
	started, release := make(chan struct{}), make(chan struct{}, 1)
	result := make(chan map[string]any, 1)
	var wg sync.WaitGroup
	defer func() { close(release); wg.Wait() }()
	wg.Add(1)
	go func() {
		defer wg.Done()
		result <- a.openWorkspaceWith(pending, func(dir string) (string, error) {
			close(started)
			<-release
			return resolveWorkspaceRoot(dir)
		}, func(root string) { t.Errorf("stale opened event for %q", root) })
	}()
	waitWorkspace(t, started)
	assertJSONEqual(t, a.openWorkspace(filepath.Join(current, "missing")), map[string]any{"error": "NOT_A_DIRECTORY"})
	release <- struct{}{}
	assertJSONEqual(t, waitWorkspace(t, result), map[string]any{"error": "SUPERSEDED"})
	assertFileContent(t, statePath(), string(before))
	realCurrent, err := resolveWorkspaceRoot(current)
	if err != nil {
		t.Fatal(err)
	}
	assertJSONEqual(t, allowedRootList(), []string{realCurrent})
	if isOfferedRoot(pending) {
		t.Error("superseded pending root was offered")
	}
}

type fakeWebView struct {
	rect      mygo.Rectangle
	visible   bool
	destroyed bool
}

func (v *fakeWebView) SetRect(r mygo.Rectangle) { v.rect = r }
func (v *fakeWebView) SetVisible(on bool)       { v.visible = on }
func (v *fakeWebView) Reload()                  {}
func (v *fakeWebView) Destroy()                 { v.destroyed = true }

func TestWebViewFailureStaysHiddenUntilLoaded(t *testing.T) {
	const url = "https://example.com/"
	view := &fakeWebView{}
	rec := &webViewRec{view: view, status: "loading"}
	a := &App{webViews: map[string]*webViewRec{url: rec}}
	syncView := func(visible bool) {
		t.Helper()
		result := a.syncWebViews([]webSyncItem{{URL: url, Visible: visible,
			Rect: &webSyncRect{X: 40, Y: 80, Width: 420, Height: 600}}})
		assertJSONEqual(t, result, map[string]any{"ok": true})
	}
	state := func(status, wantStatus string, wantVisible bool) {
		t.Helper()
		payload := rec.applyState(mygo.ChildWebViewState{
			URL: url, Status: status, CurrentURL: url + "next", Code: "FAIL", Desc: "failed",
		})
		if payload["status"] != wantStatus || view.visible != wantVisible {
			t.Fatalf("%s: payload = %v, visible = %v; want %s, %v", status, payload, view.visible, wantStatus, wantVisible)
		}
		if status == "loaded" && payload["currentUrl"] != url+"next" {
			t.Errorf("currentUrl = %v", payload["currentUrl"])
		}
	}

	syncView(true)
	if view.visible {
		t.Fatal("loading native view covers the host card")
	}
	state("loaded", "loaded", true)
	if view.rect != (mygo.Rectangle{X: 40, Y: 80, Width: 420, Height: 600}) {
		t.Fatalf("view rect = %v", view.rect)
	}
	for _, failure := range []string{"error", "gone"} {
		state(failure, failure, false)
		for _, visible := range []bool{true, false, true} {
			syncView(visible)
			if view.visible {
				t.Fatalf("%s view reappeared after WebSync(visible=%v)", failure, visible)
			}
		}
		// 与 WebReload 相同，先 loading 清错误，再等待 loaded 恢复原生层。
		state("loading", "loading", false)
		syncView(true)
		if view.visible {
			t.Fatal("retry showed native view before load completed")
		}
		state("loaded", "navigated", true)
	}
	// 隐藏 / 弹层遮挡时完成加载，不能自行显示；恢复布局后再显示。
	syncView(false)
	state("loading", "loading", false)
	state("loaded", "navigated", false)
	syncView(true)
	if !view.visible {
		t.Fatal("loaded view did not reappear when host became visible")
	}
	a.syncWebViews(nil)
	if !view.destroyed || len(a.webViews) != 0 {
		t.Fatalf("removed view: destroyed = %v, records = %d", view.destroyed, len(a.webViews))
	}
}

func TestWebViewInitialFailureKeepsFirstLoadedEvent(t *testing.T) {
	view := &fakeWebView{}
	rec := &webViewRec{view: view, visible: true}
	for _, status := range []string{"loading", "error", "loading", "gone", "loading"} {
		rec.applyState(mygo.ChildWebViewState{Status: status})
		if view.visible {
			t.Fatalf("native view visible during %s", status)
		}
	}
	payload := rec.applyState(mygo.ChildWebViewState{Status: "loaded"})
	if payload["status"] != "loaded" || !view.visible {
		t.Fatalf("first successful load after errors: payload = %v, visible = %v", payload, view.visible)
	}
}

type fakeWindowGeometry struct {
	bounds                          mygo.Rectangle
	destroyed, minimized, maximized bool
}

func (w *fakeWindowGeometry) IsDestroyed() bool      { return w.destroyed }
func (w *fakeWindowGeometry) IsMinimized() bool      { return w.minimized }
func (w *fakeWindowGeometry) IsMaximized() bool      { return w.maximized }
func (w *fakeWindowGeometry) Bounds() mygo.Rectangle { return w.bounds }

func TestWindowBoundsPreserveRestoreGeometry(t *testing.T) {
	isolateState(t)
	win := &fakeWindowGeometry{bounds: mygo.Rectangle{X: 80, Y: 100, Width: 1200, Height: 800}}
	saveWindowBounds(win)
	before, err := os.ReadFile(statePath())
	if err != nil {
		t.Fatal(err)
	}
	win.bounds = mygo.Rectangle{X: -8, Y: -8, Width: 2560, Height: 1440}
	win.maximized = true
	saveWindowBounds(win)
	assertFileContent(t, statePath(), string(before))
	win.maximized, win.minimized = false, true
	saveWindowBounds(win)
	assertFileContent(t, statePath(), string(before))
	win.minimized, win.destroyed = false, true
	saveWindowBounds(win)
	assertFileContent(t, statePath(), string(before))
	win.destroyed = false
	win.bounds = mygo.Rectangle{X: 120, Y: 160, Width: 1300, Height: 850}
	saveWindowBounds(win)
	assertJSONEqual(t, loadState()["window"], map[string]any{"x": 120, "y": 160, "width": 1300, "height": 850})
}
