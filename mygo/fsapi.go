package main

// 文件系统访问层：把 src/main/fs-api.js 的授权模型与上限照搬过来。
// 所有对外路径先解析真实路径（junction / 符号链接也越不过工作区边界），
// 写能力仍然只有「覆盖工作区内已存在的 .svg」一个入口。

import (
	"encoding/base64"
	"errors"
	"io"
	"io/fs"
	"os"
	"path/filepath"
	"strings"
	"sync"
	"syscall"
	"unicode/utf8"

	"golang.org/x/text/encoding/simplifiedchinese"
)

const (
	maxTextBytes    = 5 * 1024 * 1024
	maxDocBytes     = 25 * 1024 * 1024
	maxSvgWrite     = 20 * 1024 * 1024
	sniffBytes      = 8192
	maxMdImages     = 60
	imgSrcMax       = 2048
	imgMaxBytes     = 32 * 1024 * 1024
	maxIconDataChar = 512 * 1024
)

var kindByExt = map[string]string{
	"html": "html", "htm": "html", "xhtml": "html",
	"md": "md", "markdown": "md", "mdx": "md",
	"docx": "docx", "pptx": "pptx", "pdf": "pdf",
	"js": "js", "mjs": "js", "cjs": "js", "jsx": "js", "ts": "js", "tsx": "js",
	"mts": "js", "cts": "js", "vue": "js", "svelte": "js",
	"json": "json", "jsonc": "json", "json5": "json", "yaml": "json", "yml": "json",
	"toml": "json", "xml": "json", "plist": "json",
	"css": "css", "scss": "css", "sass": "css", "less": "css", "styl": "css",
	"svg": "svg",
	"png": "image", "jpg": "image", "jpeg": "image", "gif": "image", "webp": "image",
	"bmp": "image", "ico": "image", "avif": "image",
	"txt": "txt", "log": "txt", "text": "txt", "csv": "txt", "tsv": "txt",
	"ini": "txt", "cfg": "txt", "conf": "txt", "properties": "txt", "env": "txt",
	"sh": "txt", "bash": "txt", "zsh": "txt", "fish": "txt", "ps1": "txt", "bat": "txt",
	"cmd": "txt", "sql": "txt", "py": "txt", "rb": "txt", "go": "txt", "rs": "txt",
	"java": "txt", "kt": "txt", "swift": "txt", "c": "txt", "h": "txt", "cc": "txt",
	"cpp": "txt", "hpp": "txt", "cs": "txt", "php": "txt", "lua": "txt", "r": "txt",
	"pl": "txt", "dart": "txt", "gradle": "txt", "lock": "txt", "map": "txt",
}

var kindByName = map[string]string{
	"dockerfile": "txt", "makefile": "txt", "cmakelists.txt": "txt",
	"license": "txt", "licence": "txt", "readme": "txt", "changelog": "txt",
	"notice": "txt", "procfile": "txt", ".gitignore": "txt", ".gitattributes": "txt",
	".npmrc": "txt", ".editorconfig": "txt", ".env": "txt",
	".babelrc": "json", ".eslintrc": "json",
}

var binaryExt = map[string]bool{
	"zip": true, "rar": true, "7z": true, "tar": true, "gz": true, "bz2": true,
	"xz": true, "exe": true, "dll": true, "so": true, "dylib": true, "bin": true,
	"dat": true, "db": true, "sqlite": true, "sqlite3": true, "woff": true,
	"woff2": true, "ttf": true, "otf": true, "eot": true, "mp3": true, "wav": true,
	"flac": true, "ogg": true, "mp4": true, "mov": true, "avi": true, "mkv": true,
	"webm": true, "pdf": true, "doc": true, "docx": true, "xls": true, "xlsx": true,
	"ppt": true, "pptx": true, "class": true, "jar": true, "pyc": true, "o": true,
	"obj": true, "lib": true, "node": true, "wasm": true, "iso": true, "dmg": true,
	"psd": true, "ai": true, "sketch": true, "apk": true, "ipa": true,
}

var mimeByExt = map[string]string{
	"html": "text/html; charset=utf-8", "htm": "text/html; charset=utf-8",
	"xhtml": "application/xhtml+xml; charset=utf-8", "md": "text/plain; charset=utf-8",
	"js": "text/javascript; charset=utf-8", "mjs": "text/javascript; charset=utf-8",
	"cjs": "text/javascript; charset=utf-8", "jsx": "text/javascript; charset=utf-8",
	"json": "application/json; charset=utf-8", "jsonc": "application/json; charset=utf-8",
	"map": "application/json; charset=utf-8", "yaml": "text/yaml; charset=utf-8",
	"yml": "text/yaml; charset=utf-8", "xml": "application/xml; charset=utf-8",
	"css": "text/css; charset=utf-8", "svg": "image/svg+xml", "txt": "text/plain; charset=utf-8",
	"png": "image/png", "jpg": "image/jpeg", "jpeg": "image/jpeg", "gif": "image/gif",
	"webp": "image/webp", "bmp": "image/bmp", "ico": "image/x-icon", "avif": "image/avif",
	"pdf": "application/pdf", "woff2": "font/woff2", "woff": "font/woff", "ttf": "font/ttf",
}

type rootsMu struct {
	sync.RWMutex
	// 键是小写真实路径，值保留原始大小写，用于 resolveImages 拼工作区相对地址
	allowed map[string]string
	offered map[string]bool
}

var roots = rootsMu{allowed: map[string]string{}, offered: map[string]bool{}}

func extOf(name string) string {
	return strings.ToLower(strings.TrimPrefix(filepath.Ext(name), "."))
}

func kindFor(name string) string {
	if ext := extOf(name); ext != "" {
		if k, ok := kindByExt[ext]; ok {
			return k
		}
	}
	if k, ok := kindByName[strings.ToLower(name)]; ok {
		return k
	}
	return "txt"
}

func mimeFor(path string) string {
	if m := mimeByExt[extOf(path)]; m != "" {
		return m
	}
	return "application/octet-stream"
}

func realPath(target string) (string, error) {
	abs, err := filepath.Abs(target)
	if err != nil {
		return "", err
	}
	probe := abs
	var tail []string
	for {
		real, err := filepath.EvalSymlinks(probe)
		if err == nil {
			for i := len(tail) - 1; i >= 0; i-- {
				real = filepath.Join(real, tail[i])
			}
			return real, nil
		}
		if !errors.Is(err, fs.ErrNotExist) && !errors.Is(err, syscall.ENOTDIR) {
			return "", err
		}
		parent := filepath.Dir(probe)
		if parent == probe {
			return abs, nil
		}
		tail = append(tail, filepath.Base(probe))
		probe = parent
	}
}

func within(root, abs string) bool {
	r, a := strings.ToLower(filepath.Clean(root)), strings.ToLower(filepath.Clean(abs))
	if r == a {
		return true
	}
	prefix := r
	if !strings.HasSuffix(prefix, string(filepath.Separator)) {
		prefix += string(filepath.Separator)
	}
	return strings.HasPrefix(a, prefix)
}

func allowedRootList() []string {
	roots.RLock()
	defer roots.RUnlock()
	out := make([]string, 0, len(roots.allowed))
	for _, v := range roots.allowed {
		out = append(out, v)
	}
	return out
}

func resetAllowedRoots() {
	roots.Lock()
	defer roots.Unlock()
	roots.allowed = map[string]string{}
}

func allowResolvedRoot(real string) {
	if real == "" {
		return
	}
	roots.Lock()
	defer roots.Unlock()
	roots.allowed[strings.ToLower(real)] = real
}

func offerRoot(dir string) string {
	if dir == "" {
		return ""
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return dir
	}
	roots.Lock()
	defer roots.Unlock()
	roots.offered[strings.ToLower(filepath.Clean(abs))] = true
	return dir
}

func isOfferedRoot(dir string) bool {
	if dir == "" {
		return false
	}
	abs, err := filepath.Abs(dir)
	if err != nil {
		return false
	}
	roots.RLock()
	defer roots.RUnlock()
	return roots.offered[strings.ToLower(filepath.Clean(abs))]
}

func isInsideAnyRoot(abs string) bool {
	roots.RLock()
	defer roots.RUnlock()
	for _, root := range roots.allowed {
		if within(root, abs) {
			return true
		}
	}
	return false
}

func assertAllowed(target string) (string, error) {
	abs, err := realPath(target)
	if err != nil {
		return "", &codedError{"EREAD", err.Error()}
	}
	if isInsideAnyRoot(abs) {
		return abs, nil
	}
	return "", &codedError{"EACCES_ROOT", "路径不在已授权的工作区内：" + abs}
}

type codedError struct {
	code string
	msg  string
}

func (e *codedError) Error() string { return e.msg }

func codeOf(err error) string {
	var ce *codedError
	if errors.As(err, &ce) {
		return ce.code
	}
	return "EIO"
}

type entry struct {
	Name    string `json:"name"`
	Path    string `json:"path"`
	IsDir   bool   `json:"isDir"`
	Kind    string `json:"kind"`
	Link    bool   `json:"link,omitempty"`
	Blocked bool   `json:"blocked,omitempty"`
	Broken  bool   `json:"broken,omitempty"`
}

func listDir(dir string) (string, []entry, error) {
	abs, err := assertAllowed(dir)
	if err != nil {
		return "", nil, err
	}
	dirents, err := os.ReadDir(abs)
	if err != nil {
		return "", nil, &codedError{"ELIST", err.Error()}
	}
	entries := make([]entry, 0, len(dirents))
	var links []int
	for _, d := range dirents {
		isDir := d.IsDir()
		e := entry{
			Name:  d.Name(),
			Path:  filepath.Join(abs, d.Name()),
			IsDir: isDir,
			Kind:  "folder",
		}
		if !isDir {
			e.Kind = kindFor(d.Name())
		}
		if d.Type()&os.ModeSymlink != 0 {
			e.Link = true
			links = append(links, len(entries))
		}
		entries = append(entries, e)
	}
	for _, i := range links {
		e := &entries[i]
		st, err := os.Stat(e.Path)
		if err != nil {
			e.Broken = true
			continue
		}
		e.IsDir = st.IsDir()
		if e.IsDir {
			e.Kind = "folder"
		} else {
			e.Kind = kindFor(e.Name)
		}
		if real, err := realPath(e.Path); err == nil && !isInsideAnyRoot(real) {
			e.Blocked = true
		}
	}
	return abs, entries, nil
}

type metaSink func(dir string, metas map[string]any)

func statEntries(dir string, entries []entry, emit metaSink) {
	abs, err := assertAllowed(dir)
	if err != nil {
		return
	}
	metas := map[string]any{}
	var mu sync.Mutex
	sem := make(chan struct{}, 24)
	var wg sync.WaitGroup
	for _, e := range entries {
		wg.Add(1)
		sem <- struct{}{}
		go func(e entry) {
			defer wg.Done()
			defer func() { <-sem }()
			st, err := os.Stat(filepath.Join(abs, e.Name))
			var v any
			if err == nil {
				v = map[string]any{"size": st.Size(), "mtime": mtimeMs(st)}
			}
			mu.Lock()
			metas[e.Path] = v
			mu.Unlock()
		}(e)
	}
	wg.Wait()
	if emit != nil {
		emit(abs, metas)
	}
}

func mtimeMs(info fs.FileInfo) float64 {
	return float64(info.ModTime().UnixNano()) / 1e6
}

type readResult struct {
	Text      string  `json:"text"`
	Binary    bool    `json:"binary,omitempty"`
	Size      int64   `json:"size"`
	Mtime     float64 `json:"mtime"`
	Truncated bool    `json:"truncated,omitempty"`
	Lossy     bool    `json:"lossy,omitempty"`
	Encoding  string  `json:"encoding,omitempty"`
	Path      string  `json:"path"`
	Error     string  `json:"error,omitempty"`
	Message   string  `json:"message,omitempty"`
}

func looksBinary(buf []byte) bool {
	head := buf
	if len(head) > sniffBytes {
		head = head[:sniffBytes]
	}
	control := 0
	for _, b := range head {
		if b == 0 {
			return true
		}
		if b < 9 || (b > 13 && b < 32) {
			control++
		}
	}
	return len(head) > 0 && float64(control)/float64(len(head)) > 0.3
}

func readFileForPreview(path string) (readResult, error) {
	abs, err := assertAllowed(path)
	if err != nil {
		return readResult{Error: codeOf(err), Message: err.Error()}, nil
	}
	st, err := os.Stat(abs)
	if err != nil {
		return readResult{Error: "EREAD", Message: err.Error()}, nil
	}
	if st.IsDir() {
		return readResult{Error: "IS_DIR"}, nil
	}
	size := st.Size()
	if binaryExt[extOf(abs)] {
		return readResult{Binary: true, Size: size, Mtime: mtimeMs(st), Path: abs}, nil
	}
	readLen := size
	if readLen > maxTextBytes {
		readLen = maxTextBytes
	}
	f, err := os.Open(abs)
	if err != nil {
		return readResult{Error: "EREAD", Message: err.Error()}, nil
	}
	defer f.Close()
	buf := make([]byte, readLen)
	n, err := io.ReadFull(f, buf)
	if err != nil && err != io.ErrUnexpectedEOF && err != io.EOF {
		return readResult{Error: "EREAD", Message: err.Error()}, nil
	}
	buf = buf[:n]
	if looksBinary(buf) {
		return readResult{Binary: true, Size: size, Mtime: mtimeMs(st), Path: abs}, nil
	}
	text := string(buf)
	lossy := false
	encoding := "utf8"
	if !utf8.Valid(buf) {
		if decoded, derr := simplifiedchinese.GBK.NewDecoder().Bytes(buf); derr == nil && utf8.Valid(decoded) {
			text, encoding = string(decoded), "gbk"
		} else {
			lossy = true
		}
	}
	return readResult{
		Text: text, Size: size, Mtime: mtimeMs(st), Path: abs,
		Truncated: size > readLen, Lossy: lossy, Encoding: encoding,
	}, nil
}

type bytesResult struct {
	Data     string `json:"data,omitempty"`
	Size     int64  `json:"size,omitempty"`
	Path     string `json:"path,omitempty"`
	TooLarge bool   `json:"tooLarge,omitempty"`
	Error    string `json:"error,omitempty"`
	Message  string `json:"message,omitempty"`
}

func readFileBytes(path string) bytesResult {
	abs, err := assertAllowed(path)
	if err != nil {
		return bytesResult{Error: codeOf(err), Message: err.Error()}
	}
	st, err := os.Stat(abs)
	if err != nil {
		return bytesResult{Error: "EREAD", Message: err.Error()}
	}
	if st.IsDir() {
		return bytesResult{Error: "IS_DIR"}
	}
	if st.Size() > maxDocBytes {
		return bytesResult{TooLarge: true, Size: st.Size(), Path: abs}
	}
	data, err := os.ReadFile(abs)
	if err != nil {
		return bytesResult{Error: "EREAD", Message: err.Error()}
	}
	return bytesResult{Data: base64.StdEncoding.EncodeToString(data), Size: st.Size(), Path: abs}
}

type statResult struct {
	Path    string  `json:"path,omitempty"`
	Size    int64   `json:"size,omitempty"`
	Mtime   float64 `json:"mtime,omitempty"`
	IsDir   bool    `json:"isDir,omitempty"`
	Error   string  `json:"error,omitempty"`
	Message string  `json:"message,omitempty"`
}

func statPath(target string) statResult {
	abs, err := assertAllowed(target)
	if err != nil {
		return statResult{Error: codeOf(err), Message: err.Error()}
	}
	st, err := os.Stat(abs)
	if err != nil {
		return statResult{Error: "ESTAT", Message: err.Error()}
	}
	return statResult{Path: abs, Size: st.Size(), Mtime: mtimeMs(st), IsDir: st.IsDir()}
}

func writeSvgFile(path, content string, expectedSize int64, expectedMtime float64, hasBaseline bool) map[string]any {
	abs, err := assertAllowed(path)
	if err != nil {
		return map[string]any{"error": codeOf(err), "message": err.Error()}
	}
	if strings.ToLower(filepath.Ext(abs)) != ".svg" {
		return map[string]any{"error": "ENOT_SVG", "message": "只允许保存 SVG：" + abs}
	}
	if len(content) > maxSvgWrite {
		return map[string]any{"error": "ETOO_LARGE", "message": "SVG 超过保存上限"}
	}
	st, err := os.Stat(abs)
	if err != nil || st.IsDir() {
		return map[string]any{"error": "ENOT_FILE", "message": "只能保存到普通文件"}
	}
	if !hasBaseline {
		return map[string]any{"error": "EBAD_BASELINE", "message": "缺少保存前的版本基线"}
	}
	if st.Size() != expectedSize || absFloat(mtimeMs(st)-expectedMtime) > 0.5 {
		return map[string]any{"error": "CONFLICT", "size": st.Size(), "mtime": mtimeMs(st)}
	}
	// 随机独占创建，避免覆盖已有临时文件或沿其硬链接写到工作区外。
	tmp, err := os.CreateTemp(filepath.Dir(abs), "."+filepath.Base(abs)+".*.tmp")
	if err != nil {
		return map[string]any{"error": "EWRITE", "message": err.Error()}
	}
	tmpPath := tmp.Name()
	defer os.Remove(tmpPath)
	n, err := tmp.WriteString(content)
	if err == nil && n != len(content) {
		err = io.ErrShortWrite
	}
	if closeErr := tmp.Close(); err == nil {
		err = closeErr
	}
	if err != nil {
		return map[string]any{"error": "EWRITE", "message": err.Error()}
	}
	if err := os.Rename(tmpPath, abs); err != nil {
		return map[string]any{"error": "EWRITE", "message": err.Error()}
	}
	after, err := os.Stat(abs)
	if err != nil {
		return map[string]any{"error": "EWRITE", "message": err.Error()}
	}
	return map[string]any{"ok": true, "path": abs, "size": after.Size(), "mtime": mtimeMs(after)}
}

func absFloat(v float64) float64 {
	if v < 0 {
		return -v
	}
	return v
}
