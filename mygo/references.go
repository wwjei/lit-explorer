package main

// 参考目录只能由系统选择框添加；页面设置不是目录授权来源。
import (
	"strings"

	"github.com/egoist/mygo"
)

func referenceMap(state map[string]any) map[string]any {
	m, _ := state["referenceDirs"].(map[string]any)
	if m == nil {
		m = map[string]any{}
	}
	return m
}

func savedReferences(root string) []string {
	list, _ := referenceMap(loadState())[strings.ToLower(root)].([]any)
	out := []string{}
	for i, raw := range list {
		if i >= 32 {
			break
		}
		if p, ok := raw.(string); ok {
			if real, err := resolveWorkspaceRoot(p); err == nil {
				out = append(out, real)
			}
		}
	}
	return out
}

func (a *App) ReferenceDirs() []string {
	a.seqMu.Lock()
	defer a.seqMu.Unlock()
	return append([]string{}, a.references...)
}

func (a *App) saveReferences(next []string) {
	m := referenceMap(loadState())
	list := []any{}
	for _, p := range next {
		list = append(list, p)
	}
	m[strings.ToLower(a.referenceRoot)] = list
	patchInternal(map[string]any{"referenceDirs": m})
	a.references = next
}

func (a *App) AddReferenceDir() map[string]any {
	a.seqMu.Lock()
	root, seq := a.referenceRoot, a.seq
	a.seqMu.Unlock()
	if root == "" {
		return map[string]any{"error": "NO_WORKSPACE"}
	}
	paths, err := mygo.Dialog.Open(mygo.OpenDialogOptions{Parent: a.win, Title: "添加外部参考目录", Directory: true})
	if err != nil {
		return map[string]any{"error": "EPICK", "message": err.Error()}
	}
	if len(paths) == 0 {
		return map[string]any{"canceled": true}
	}
	real, err := resolveWorkspaceRoot(paths[0])
	if err != nil {
		return map[string]any{"error": "NOT_A_DIRECTORY", "message": err.Error()}
	}
	a.seqMu.Lock()
	defer a.seqMu.Unlock()
	if root != a.referenceRoot || seq != a.seq {
		return map[string]any{"error": "SUPERSEDED"}
	}
	if len(a.references) >= 32 {
		return map[string]any{"error": "LIMIT"}
	}
	for _, p := range append(append([]string{}, a.references...), root) {
		if strings.EqualFold(p, real) {
			return map[string]any{"dirs": append([]string{}, a.references...)}
		}
	}
	a.saveReferences(append(append([]string{}, a.references...), real))
	allowReferenceRoot(real)
	return map[string]any{"dirs": append([]string{}, a.references...)}
}

func (a *App) RemoveReferenceDir(dir string) map[string]any {
	a.seqMu.Lock()
	defer a.seqMu.Unlock()
	if a.referenceRoot == "" {
		return map[string]any{"error": "NO_WORKSPACE"}
	}
	next := []string{}
	for _, p := range a.references {
		if !strings.EqualFold(p, dir) {
			next = append(next, p)
		}
	}
	a.saveReferences(next)
	resetAllowedRoots()
	allowResolvedRoot(a.referenceRoot)
	for _, p := range next {
		allowReferenceRoot(p)
	}
	return map[string]any{"dirs": next}
}
