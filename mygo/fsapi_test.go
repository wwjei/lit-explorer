package main

import (
	"os"
	"path/filepath"
	"testing"
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
