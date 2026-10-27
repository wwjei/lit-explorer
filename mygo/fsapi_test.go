package main

import (
	"encoding/json"
	"fmt"
	"os"
	"path/filepath"
	"testing"

	"github.com/egoist/mygo"
)

func TestWithin(t *testing.T) {
	root := `C:\work`
	cases := []struct {
		abs  string
		want bool
	}{
		{`C:\work`, true},
		{`C:\work\a\b.txt`, true},
		{`c:\WORK\a`, true},
		{`C:\workshop`, false},
		{`C:\work2\x`, false},
	}
	for _, c := range cases {
		if got := within(root, c.abs); got != c.want {
			t.Errorf("within(%q, %q) = %v, want %v", root, c.abs, got, c.want)
		}
	}
}

func TestKindFor(t *testing.T) {
	cases := map[string]string{
		"a.md": "md", "b.MDX": "md", "Dockerfile": "txt", "x.docx": "docx",
		"y.pdf": "pdf", "z.png": "image", "noext": "txt", ".gitignore": "txt",
	}
	for name, want := range cases {
		if got := kindFor(name); got != want {
			t.Errorf("kindFor(%q) = %q, want %q", name, got, want)
		}
	}
}

func TestCleanImageSrc(t *testing.T) {
	ok := []string{"pic.png", "./a/b.png", `sub\img.jpg`, "C:/x/y.png", "有 空格.png"}
	bad := []string{"javascript:alert(1)", "http://x/y.png", "//host/x.png", `\\host\x`, "", "<>", "a\u0001b"}
	for _, s := range ok {
		if got := cleanImageSrc(s); got == "" {
			t.Errorf("cleanImageSrc(%q) = empty, want kept", s)
		}
	}
	for _, s := range bad {
		if got := cleanImageSrc(s); got != "" {
			t.Errorf("cleanImageSrc(%q) = %q, want empty", s, got)
		}
	}
}

func TestValidWebURL(t *testing.T) {
	for _, s := range []string{"http://example.com", "https://example.com/a?b=1"} {
		if !validWebURL(s) {
			t.Errorf("validWebURL(%q) = false", s)
		}
	}
	for _, s := range []string{"file:///x", "javascript:1", "http://user:pw@example.com", "ftp://x"} {
		if validWebURL(s) {
			t.Errorf("validWebURL(%q) = true", s)
		}
	}
}

func TestSanitizeLayoutKeepsWebPanes(t *testing.T) {
	layout := map[string]any{"pins": []any{
		map[string]any{"w": 400, "split": 0.5, "panes": []any{
			map[string]any{"path": "https://example.com/", "kind": "web", "url": "https://example.com/"},
		}},
		map[string]any{"w": 420, "split": 0.6, "panes": []any{
			map[string]any{"path": `C:\work\a.md`, "kind": "md", "name": "a.md"},
		}},
	}}
	out, _ := sanitizeLayout(layout).(map[string]any)
	pins := out["pins"].([]any)
	if len(pins) != 2 {
		t.Fatalf("pins = %d, want 2", len(pins))
	}
	web := pins[0].(map[string]any)["panes"].([]any)[0].(map[string]any)
	if web["kind"] != "web" || web["url"] != "https://example.com/" {
		t.Errorf("web pane = %v", web)
	}
	file := pins[1].(map[string]any)["panes"].([]any)[0].(map[string]any)
	if file["kind"] != "md" {
		t.Errorf("file pane kind = %v, want md", file["kind"])
	}
}

func TestWriteSvgBoundaries(t *testing.T) {
	dir := t.TempDir()
	resetAllowedRoots()
	allowResolvedRoot(dir)
	defer resetAllowedRoots()

	target := filepath.Join(dir, "a.svg")
	if err := os.WriteFile(target, []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	st, err := os.Stat(target)
	if err != nil {
		t.Fatal(err)
	}
	ok := writeSvgFile(target, `<svg xmlns="http://www.w3.org/2000/svg"/>`, st.Size(), mtimeMs(st), true)
	if ok["ok"] != true {
		t.Fatalf("writeSvgFile = %v, want ok", ok)
	}
	// 用旧基线再写一次必须报 CONFLICT
	stale := writeSvgFile(target, `<svg/>`, st.Size(), mtimeMs(st), true)
	if stale["error"] != "CONFLICT" {
		t.Fatalf("stale write = %v, want CONFLICT", stale)
	}
	// 工作区外不可写
	outside := filepath.Join(t.TempDir(), "b.svg")
	if err := os.WriteFile(outside, []byte("<svg/>"), 0o644); err != nil {
		t.Fatal(err)
	}
	ost, _ := os.Stat(outside)
	denied := writeSvgFile(outside, `<svg/>`, ost.Size(), mtimeMs(ost), true)
	if denied["error"] != "EACCES_ROOT" {
		t.Fatalf("outside write = %v, want EACCES_ROOT", denied)
	}
}

func isolateRoots(t *testing.T) {
	t.Helper()
	roots.Lock()
	allowed, offered := roots.allowed, roots.offered
	roots.allowed = map[string]string{}
	roots.offered = map[string]bool{}
	roots.Unlock()
	t.Cleanup(func() {
		roots.Lock()
		roots.allowed, roots.offered = allowed, offered
		roots.Unlock()
	})
}

func assertFileContent(t *testing.T, path, want string) {
	t.Helper()
	data, err := os.ReadFile(path)
	if err != nil {
		t.Fatal(err)
	}
	if string(data) != want {
		t.Errorf("file %q = %q, want %q", path, data, want)
	}
}

func statFileSnapshot(t *testing.T, path string) os.FileInfo {
	t.Helper()
	file, err := os.Open(path)
	if err != nil {
		t.Fatal(err)
	}
	// Windows 的 os.Stat 延迟读取文件 ID，改用句柄立即固定替换前的身份。
	info, statErr := file.Stat()
	closeErr := file.Close()
	if statErr != nil {
		t.Fatal(statErr)
	}
	if closeErr != nil {
		t.Fatal(closeErr)
	}
	return info
}

func TestWriteSvgPreservesExistingTemp(t *testing.T) {
	for _, hardlink := range []bool{false, true} {
		t.Run(fmt.Sprintf("hardlink=%v", hardlink), func(t *testing.T) {
			isolateRoots(t)
			base := t.TempDir()
			dir := filepath.Join(base, "workspace")
			if err := os.Mkdir(dir, 0o755); err != nil {
				t.Fatal(err)
			}
			real, err := realPath(dir)
			if err != nil {
				t.Fatal(err)
			}
			allowResolvedRoot(real)
			target := filepath.Join(dir, "a.svg")
			tmp := filepath.Join(dir, ".a.svg.tmp")
			outside := filepath.Join(base, "outside.txt")
			const original = "unrelated valuable content"
			const edited = "<svg>edited</svg>"
			if err := os.WriteFile(target, []byte("<svg/>"), 0o644); err != nil {
				t.Fatal(err)
			}
			if hardlink {
				if err := os.WriteFile(outside, []byte(original), 0o644); err != nil {
					t.Fatal(err)
				}
				if err := os.Link(outside, tmp); err != nil {
					t.Fatal(err)
				}
			} else if err := os.WriteFile(tmp, []byte(original), 0o644); err != nil {
				t.Fatal(err)
			}
			before := statFileSnapshot(t, target)
			tmpBefore := statFileSnapshot(t, tmp)
			result := writeSvgFile(target, edited, before.Size(), mtimeMs(before), true)
			if result["ok"] != true {
				t.Fatalf("writeSvgFile = %v, want ok", result)
			}
			assertFileContent(t, target, edited)
			if hardlink {
				assertFileContent(t, outside, original)
			}
			assertFileContent(t, tmp, original)
			tmpAfter, err := os.Stat(tmp)
			if err != nil {
				t.Fatal(err)
			}
			if !os.SameFile(tmpBefore, tmpAfter) {
				t.Error("existing temp was replaced")
			}
			after, err := os.Stat(target)
			if err != nil {
				t.Fatal(err)
			}
			if os.SameFile(before, after) {
				t.Error("SVG was overwritten in place, want replacement by rename")
			}
			entries, err := os.ReadDir(dir)
			if err != nil {
				t.Fatal(err)
			}
			if len(entries) != 2 {
				t.Errorf("workspace entries = %v, want only SVG and existing temp", entries)
			}
		})
	}
}

func isolateState(t *testing.T) {
	t.Helper()
	isolateRoots(t)
	mygo.App.SetPath(mygo.PathUserData, t.TempDir())
	t.Cleanup(func() { mygo.App.SetPath(mygo.PathUserData, "") })
}

func writeTestState(t *testing.T, state map[string]any) {
	t.Helper()
	raw, err := json.Marshal(state)
	if err != nil {
		t.Fatal(err)
	}
	if err := os.WriteFile(statePath(), raw, 0o644); err != nil {
		t.Fatal(err)
	}
}

func assertJSONEqual(t *testing.T, got, want any) {
	t.Helper()
	gotJSON, err := json.Marshal(got)
	if err != nil {
		t.Fatal(err)
	}
	wantJSON, err := json.Marshal(want)
	if err != nil {
		t.Fatal(err)
	}
	if string(gotJSON) != string(wantJSON) {
		t.Fatalf("got %s, want %s", gotJSON, wantJSON)
	}
}

func TestLoadStateKeepsProjectsOutsideRecentRoots(t *testing.T) {
	isolateState(t)
	dir := t.TempDir()
	project := filepath.Join(dir, "old-pinned-project")
	selected := filepath.Join(project, "readme.md")
	projects := []any{map[string]any{
		"path": project, "name": "custom project",
		"icon": map[string]any{"type": "text", "text": "AB"},
		"nav": map[string]any{
			"path": []any{project}, "sel": selected, "mode": "source",
			"layout": map[string]any{"mainFloor": 280, "pins": []any{
				map[string]any{"w": 400, "split": 0.6, "panes": []any{
					map[string]any{"path": selected, "name": "readme.md", "kind": "md",
						"mode": "source", "zoom": 1.25, "continuous": true},
				}},
			}},
		},
	}}
	recent := []any{}
	for i := 0; i < 8; i++ {
		recent = append(recent, filepath.Join(dir, fmt.Sprintf("recent-%d", i)))
	}
	state := defaultState()
	state["lastRoot"], state["recentRoots"], state["projects"] = recent[0], recent, projects
	writeTestState(t, state)

	// 启动先加载设置，再登记 lastRoot / 最近八项 / 固定项目。
	initial := loadState()
	assertJSONEqual(t, initial["projects"], projects)
	if isOfferedRoot(project) {
		t.Fatal("loading state must leave root registration to startup")
	}
	offerRoot(initial["lastRoot"].(string))
	for _, root := range initial["recentRoots"].([]any) {
		offerRoot(root.(string))
	}
	for _, item := range initial["projects"].([]any) {
		offerRoot(item.(map[string]any)["path"].(string))
	}
	if !isOfferedRoot(project) {
		t.Fatal("saved project outside recent roots was not offered at startup")
	}
	if _, err := assertAllowed(selected); codeOf(err) != "EACCES_ROOT" {
		t.Fatalf("offered project read = %v, want EACCES_ROOT before opening workspace", err)
	}
	patched := patchInternal(map[string]any{"lastRoot": recent[0], "recentRoots": recent})
	assertJSONEqual(t, patched["projects"], projects)
	assertJSONEqual(t, loadState()["projects"], projects)

	// 再次冷启动前触发内部保存，也不能因 offered 尚为空丢掉图标与布局。
	roots.Lock()
	roots.offered = map[string]bool{}
	roots.Unlock()
	patched = patchInternal(map[string]any{"window": map[string]any{"width": 1000, "height": 700}})
	assertJSONEqual(t, patched["projects"], projects)
	assertJSONEqual(t, loadState()["projects"], projects)
}

func TestPatchFromPageRejectsUnknownProject(t *testing.T) {
	isolateState(t)
	dir := t.TempDir()
	known, unknown := filepath.Join(dir, "known"), filepath.Join(dir, "unknown")
	offerRoot(known)
	state := patchFromPage(map[string]any{
		"projects": []any{
			map[string]any{"path": unknown, "name": "injected"},
			map[string]any{"path": known, "name": "known"},
		},
		"lastRoot": unknown, "recentRoots": []any{unknown},
	})
	want := []any{map[string]any{"path": known, "name": "known", "icon": nil, "nav": nil}}
	assertJSONEqual(t, state["projects"], want)
	assertJSONEqual(t, loadState()["projects"], want)
	if state["lastRoot"] != "" || len(state["recentRoots"].([]any)) != 0 || isOfferedRoot(unknown) {
		t.Fatalf("page expanded root authorization: %v, unknown offered=%v", state, isOfferedRoot(unknown))
	}
}

func TestRealPathResolvesJunctionTail(t *testing.T) {
	dir := t.TempDir()
	missing := filepath.Join(dir, "not-created.txt")
	real, err := realPath(missing)
	if err != nil {
		t.Fatal(err)
	}
	if real == "" || filepath.Base(real) != "not-created.txt" {
		t.Fatalf("realPath(%q) = %q", missing, real)
	}
}
