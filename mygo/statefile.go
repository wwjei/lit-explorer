package main

// 设置持久化：对应 src/main/store.js + state-sanitize.js。
// 渲染进程只能改界面偏好；window / lastRoot / recentRoots 由 Go 侧自己维护。

import (
	"encoding/json"
	"os"
	"path/filepath"
	"strings"
	"sync"
)

const (
	maxProjects  = 5
	maxFavItems  = 20
	maxFavKeys   = 200
	maxPathChars = 4096
	maxNavLevels = 16
	maxPins      = 3
	maxPanesCol  = 2
)

func defaultState() map[string]any {
	return map[string]any{
		"theme":          "light",
		"previewOpen":    true,
		"previewWidth":   float64(0),
		"lastRoot":       "",
		"window":         nil,
		"recentRoots":    []any{},
		"projects":       []any{},
		"hideDot":        false,
		"favorites":      map[string]any{},
		"favTop":         false,
		"leftSplitRatio": 2.0 / 3.0,
		"previewDocx":    true,
		"previewPptx":    true,
	}
}

var stateMu sync.Mutex

func statePath() string {
	dir, err := appPathUserData()
	if err != nil {
		return "state.json"
	}
	return filepath.Join(dir, "state.json")
}

func loadState() map[string]any {
	stateMu.Lock()
	defer stateMu.Unlock()
	return loadStateLocked()
}

func loadStateLocked() map[string]any {
	out := defaultState()
	raw, err := os.ReadFile(statePath())
	if err != nil {
		return out
	}
	var saved map[string]any
	if json.Unmarshal(raw, &saved) != nil {
		return out
	}
	for k, v := range saved {
		out[k] = v
	}
	out["projects"] = sanitizeProjects(out["projects"])
	out["favorites"] = sanitizeFavorites(out["favorites"])
	return out
}

func saveStateLocked(state map[string]any) {
	raw, err := json.MarshalIndent(state, "", "  ")
	if err != nil {
		return
	}
	path := statePath()
	if err := os.MkdirAll(filepath.Dir(path), 0o755); err != nil {
		return
	}
	tmp := path + ".tmp"
	if err := os.WriteFile(tmp, raw, 0o644); err != nil {
		return
	}
	_ = os.Rename(tmp, path)
}

// patchInternal 由 Go 侧维护字段（lastRoot / recentRoots / window）时使用。
func patchInternal(changes map[string]any) map[string]any {
	stateMu.Lock()
	defer stateMu.Unlock()
	state := loadStateLocked()
	for k, v := range changes {
		state[k] = v
	}
	saveStateLocked(state)
	return state
}

// patchFromPage 收敛渲染进程提交的补丁，对应 sanitizePatch()。
func patchFromPage(changes map[string]any) map[string]any {
	stateMu.Lock()
	defer stateMu.Unlock()
	state := loadStateLocked()
	if v, ok := changes["theme"].(string); ok && (v == "light" || v == "dark") {
		state["theme"] = v
	}
	for _, key := range []string{"previewOpen", "hideDot", "favTop", "previewDocx", "previewPptx"} {
		if v, ok := changes[key].(bool); ok {
			state[key] = v
		}
	}
	if v, ok := number(changes["previewWidth"]); ok {
		state["previewWidth"] = clamp(round(v), 0, 10000)
	}
	if v, ok := number(changes["leftSplitRatio"]); ok {
		state["leftSplitRatio"] = clamp(v, 0.08, 0.92)
	}
	if _, ok := changes["projects"]; ok {
		state["projects"] = sanitizeProjects(changes["projects"])
	}
	if _, ok := changes["favorites"]; ok {
		state["favorites"] = sanitizeFavorites(changes["favorites"])
	}
	saveStateLocked(state)
	return state
}

func sanitizeProjects(value any) []any {
	list, ok := value.([]any)
	if !ok {
		return []any{}
	}
	out := []any{}
	for _, raw := range list {
		if len(out) >= maxProjects {
			break
		}
		p, ok := raw.(map[string]any)
		if !ok {
			continue
		}
		path, _ := p["path"].(string)
		if path == "" || len(path) > maxPathChars || !isOfferedRoot(path) {
			continue
		}
		name, _ := p["name"].(string)
		if name == "" {
			name = baseName(path)
		}
		item := map[string]any{"path": path, "name": truncate(name, 120)}
		if icon := sanitizeIcon(p["icon"]); icon != nil {
			item["icon"] = icon
		} else {
			item["icon"] = nil
		}
		item["nav"] = sanitizeNav(p["nav"])
		out = append(out, item)
	}
	return out
}

func sanitizeIcon(value any) any {
	icon, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	switch icon["type"] {
	case "glyph":
		id, _ := icon["id"].(string)
		if id != "" && len(id) <= 40 {
			return map[string]any{"type": "glyph", "id": id}
		}
	case "image":
		data, _ := icon["data"].(string)
		if len(data) > 0 && len(data) <= maxIconDataChar && strings.HasPrefix(data, "data:image/") {
			return map[string]any{"type": "image", "data": data}
		}
	case "text":
		raw, _ := icon["text"].(string)
		runes := []rune(strings.TrimSpace(raw))
		if len(runes) > 2 {
			runes = runes[:2]
		}
		if text := strings.TrimSpace(string(runes)); text != "" {
			return map[string]any{"type": "text", "text": text}
		}
	}
	return nil
}

func sanitizeNav(value any) any {
	nav, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	dirs := []any{}
	if raw, ok := nav["path"].([]any); ok {
		for _, d := range raw {
			if len(dirs) >= maxNavLevels {
				break
			}
			if s, ok := d.(string); ok && len(s) <= maxPathChars {
				dirs = append(dirs, s)
			}
		}
	}
	sel, _ := nav["sel"].(string)
	if len(sel) > maxPathChars {
		sel = ""
	}
	out := map[string]any{"path": dirs, "sel": sel, "mode": "preview"}
	if nav["mode"] == "source" {
		out["mode"] = "source"
	}
	if layout := sanitizeLayout(nav["layout"]); layout != nil {
		out["layout"] = layout
	}
	return out
}

// sanitizeLayout 收敛每个项目的固定列：顺序、宽度、分屏比例与每格内容。
func sanitizeLayout(value any) any {
	layout, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	pins := []any{}
	if raw, ok := layout["pins"].([]any); ok {
		for _, item := range raw {
			if len(pins) >= maxPins {
				break
			}
			col, ok := item.(map[string]any)
			if !ok {
				continue
			}
			panes := []any{}
			if saved, ok := col["panes"].([]any); ok {
				for _, p := range saved {
					if len(panes) >= maxPanesCol {
						break
					}
					if pane := sanitizePinnedPane(p); pane != nil {
						panes = append(panes, pane)
					}
				}
			}
			if len(panes) == 0 {
				continue
			}
			pins = append(pins, map[string]any{
				"w":     clampNum(col["w"], 0, 10000),
				"split": clampNumF(col["split"], 0.2, 0.8),
				"panes": panes,
			})
		}
	}
	mainFloor := int(clampNum(layout["mainFloor"], 0, 10000))
	if len(pins) == 0 && mainFloor == 0 {
		return nil
	}
	return map[string]any{"mainFloor": mainFloor, "pins": pins}
}

func sanitizePinnedPane(value any) any {
	raw, ok := value.(map[string]any)
	if !ok {
		return nil
	}
	mode := "preview"
	if raw["mode"] == "source" {
		mode = "source"
	}
	zoom := clampNumF(raw["zoom"], 0, 8)
	continuous := raw["continuous"] == true
	if raw["kind"] == "web" || raw["url"] != nil {
		rawURL, _ := raw["url"].(string)
		if rawURL == "" {
			rawURL, _ = raw["path"].(string)
		}
		if !validWebURL(rawURL) {
			return nil
		}
		name, _ := raw["name"].(string)
		if name == "" {
			name = rawURL
		}
		return map[string]any{
			"path": rawURL, "name": truncate(name, 120), "kind": "web", "url": rawURL,
			"mode": mode, "zoom": zoom, "continuous": continuous,
		}
	}
	path, _ := raw["path"].(string)
	if path == "" || len(path) > maxPathChars {
		return nil
	}
	kind, _ := raw["kind"].(string)
	name, _ := raw["name"].(string)
	if name == "" {
		name = baseName(path)
	}
	if kind == "" {
		kind = "txt"
	}
	return map[string]any{
		"path": path, "name": truncate(name, 255), "kind": kind,
		"mode": mode, "zoom": zoom, "continuous": continuous,
	}
}

func sanitizeFavorites(value any) map[string]any {
	favs, ok := value.(map[string]any)
	if !ok {
		return map[string]any{}
	}
	out := map[string]any{}
	n := 0
	for key, list := range favs {
		if n >= maxFavKeys {
			break
		}
		if len(key) > maxPathChars {
			continue
		}
		items, ok := list.([]any)
		if !ok {
			continue
		}
		kept := []any{}
		seenWeb := map[string]bool{}
		for _, raw := range items {
			if len(kept) >= maxFavItems {
				break
			}
			item, ok := raw.(map[string]any)
			if !ok {
				continue
			}
			kind, _ := item["kind"].(string)
			if kind == "web" {
				url, _ := item["url"].(string)
				if !validWebURL(url) || seenWeb[url] {
					continue
				}
				seenWeb[url] = true
				name, _ := item["name"].(string)
				if name == "" {
					name = url
				}
				kept = append(kept, map[string]any{
					"url": url, "name": truncate(name, 120), "isDir": false, "kind": "web",
				})
				continue
			}
			path, _ := item["path"].(string)
			if path == "" || len(path) > maxPathChars {
				continue
			}
			name, _ := item["name"].(string)
			if name == "" {
				name = baseName(path)
			}
			kept = append(kept, map[string]any{
				"path": path, "name": truncate(name, 255), "isDir": item["isDir"] == true, "kind": kind,
			})
		}
		out[key] = kept
		n++
	}
	return out
}

func validWebURL(raw string) bool {
	s := strings.TrimSpace(raw)
	if s == "" || len(s) > 4096 {
		return false
	}
	lower := strings.ToLower(s)
	if !strings.HasPrefix(lower, "http://") && !strings.HasPrefix(lower, "https://") {
		return false
	}
	// 不完整校验，只挡住控制字符与带账号密码的地址；渲染进程用的是浏览器 URL 解析
	for _, r := range s {
		if r < 0x20 || r == 0x7f {
			return false
		}
	}
	rest := s[strings.Index(s, "://")+3:]
	if at := strings.Index(rest, "@"); at >= 0 {
		slash := strings.IndexAny(rest, "/?#")
		if slash < 0 || at < slash {
			return false
		}
	}
	return true
}

func number(v any) (float64, bool) {
	switch n := v.(type) {
	case float64:
		return n, true
	case int:
		return float64(n), true
	case int64:
		return float64(n), true
	}
	return 0, false
}

func clampNum(v any, min, max float64) float64 {
	if n, ok := number(v); ok {
		return clamp(n, min, max)
	}
	return 0
}

func clampNumF(v any, min, max float64) float64 {
	if n, ok := number(v); ok {
		return clamp(n, min, max)
	}
	return (min + max) / 2
}

func clamp(v, min, max float64) float64 {
	if v < min {
		return min
	}
	if v > max {
		return max
	}
	return v
}

func round(v float64) float64 {
	if v < 0 {
		return -round(-v)
	}
	return float64(int64(v + 0.5))
}

func truncate(s string, max int) string {
	r := []rune(s)
	if len(r) <= max {
		return s
	}
	return string(r[:max])
}

func baseName(path string) string {
	clean := strings.TrimRight(path, `\/`)
	if clean == "" {
		return path
	}
	if i := strings.LastIndexAny(clean, `\/`); i >= 0 {
		return clean[i+1:]
	}
	return clean
}
