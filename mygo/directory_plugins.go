package main

// 目录插件清单与 Electron 共用；认证、网络、挂载授权均由宿主管理。
import (
	"bytes"
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"reflect"
	"regexp"
	"strings"
	"sync"
	"time"
	"unicode"
	"unicode/utf8"
)

type directoryOperation struct {
	Node    string            `json:"node"`
	Method  string            `json:"method"`
	Path    string            `json:"path"`
	Query   map[string]any    `json:"query"`
	Body    any               `json:"body"`
	Entries string            `json:"entries"`
	Cursor  string            `json:"cursor"`
	HasMore string            `json:"hasMore"`
	Fields  map[string]string `json:"fields"`
}
type directoryProvider struct {
	InputHint string `json:"inputHint"`
	Root      struct {
		Kind        string            `json:"kind"`
		DefaultType string            `json:"defaultType"`
		URLTypes    map[string]string `json:"urlTypes"`
	} `json:"root"`
	Initialize *directoryOperation `json:"initialize"`
	Success    struct {
		Field string `json:"field"`
		Value any    `json:"value"`
	} `json:"success"`
	ID            string             `json:"id"`
	Name          string             `json:"name"`
	Version       string             `json:"version"`
	APIOrigin     string             `json:"apiOrigin"`
	DocumentHosts []string           `json:"documentHosts"`
	DirectoryType string             `json:"directoryType"`
	AuthCodes     []int              `json:"authCodes"`
	List          directoryOperation `json:"list"`
	Details       directoryOperation `json:"details"`
}
type directoryMount struct {
	RootType   string `json:"rootType,omitempty"`
	ID         string `json:"id"`
	ProviderID string `json:"providerId"`
	RootID     string `json:"rootId"`
	Name       string `json:"name"`
}
type directoryNode struct {
	HasChildren  *bool  `json:"hasChildren,omitempty"`
	DocumentID   string `json:"documentId,omitempty"`
	DocumentType string `json:"documentType,omitempty"`
	ScopeID      string `json:"scopeId,omitempty"`
	ID           string `json:"id"`
	Name         string `json:"name"`
	Type         string `json:"type"`
	Kind         string `json:"kind"`
	URL          string `json:"url,omitempty"`
	ModifiedAt   string `json:"modifiedAt,omitempty"`
}
type directoryPage struct {
	Directory  directoryNode   `json:"directory"`
	Entries    []directoryNode `json:"entries"`
	NextCursor string          `json:"nextCursor"`
}
type directoryCache struct {
	page  directoryPage
	until time.Time
}
type directorySession struct {
	credential *feishuFlow
	scopeID    string
	attemptID  string
	cursors    map[string]map[string]bool
	mount      directoryMount
	provider   directoryProvider
	token      string
	seq        int
	ctx        context.Context
	cancel     context.CancelFunc
	nodes      map[string]directoryNode
	cache      map[string]directoryCache
	pending    int
}
type directoryPluginService struct {
	auth          *feishuAuth
	providerOrder []string
	connecting    map[*directorySession]bool
	mu            sync.Mutex
	root          string
	seq           int
	providers     map[string]directoryProvider
	sessions      map[string]*directorySession
	client        *http.Client
}

var directoryID = regexp.MustCompile(`^[A-Za-z0-9_-]{1,256}$`)
var directoryPath = regexp.MustCompile(`^/[a-zA-Z0-9_/$:.-]+$`)

func directoryText(v any, max int) string {
	s, ok := v.(string)
	if !ok || utf8.RuneCountInString(s) > max {
		return ""
	}
	for _, r := range s {
		if r < 32 || r == 127 {
			return ""
		}
	}
	return s
}
func directoryRemoteID(value string) bool {
	for _, r := range value {
		if unicode.IsSpace(r) {
			return false
		}
	}
	return directoryText(value, 256) != "" && value != "." && value != ".." && !strings.ContainsAny(value, "/\\ \t\r\n?#")
}
func directoryGet(v any, path string) any {
	for _, key := range strings.Split(path, ".") {
		obj, ok := v.(map[string]any)
		if !ok {
			return nil
		}
		v = obj[key]
	}
	return v
}
func directorySubstitute(v any, vars map[string]string) any {
	switch x := v.(type) {
	case string:
		if strings.HasPrefix(x, "$") {
			return vars[strings.TrimPrefix(x, "$")]
		}
		return x
	case []any:
		out := []any{}
		for _, el := range x {
			out = append(out, directorySubstitute(el, vars))
		}
		return out
	case map[string]any:
		out := map[string]any{}
		for k, el := range x {
			out[k] = directorySubstitute(el, vars)
		}
		return out
	default:
		return v
	}
}
func directoryURL(raw string, p directoryProvider) (string, error) {
	if directoryText(raw, 4096) == "" {
		return "", fmt.Errorf("UNSAFE_URL")
	}
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || (u.Port() != "" && u.Port() != "443") {
		return "", fmt.Errorf("UNSAFE_URL")
	}
	host := strings.ToLower(u.Hostname())
	for _, allowed := range p.DocumentHosts {
		if host == allowed || strings.HasSuffix(host, "."+allowed) {
			return u.String(), nil
		}
	}
	return "", fmt.Errorf("UNSAFE_URL")
}
func directoryNormalize(raw any, p directoryProvider, fields map[string]string) (directoryNode, error) {
	value := func(k string, max int) string {
		field := fields[k]
		if strings.HasPrefix(field, "=") {
			return strings.TrimPrefix(field, "=")
		}
		return directoryText(directoryGet(raw, field), max)
	}
	n := directoryNode{DocumentID: value("documentId", 256), DocumentType: value("documentType", 256), ScopeID: value("scopeId", 256), ID: value("id", 256), Name: value("name", 256), Type: value("type", 256), URL: value("url", 4096), ModifiedAt: value("modifiedAt", 256), Kind: "document"}
	if !directoryRemoteID(n.ID) || n.Name == "" || !directoryRemoteID(n.Type) {
		return n, fmt.Errorf("BAD_RESPONSE")
	}
	if field, ok := fields["hasChildren"]; ok {
		if value, ok := directoryGet(raw, field).(bool); ok {
			n.HasChildren = &value
		}
	}
	if n.Type == p.DirectoryType && (n.HasChildren == nil || *n.HasChildren) {
		n.Kind = "directory"
	}
	if n.URL != "" {
		var err error
		n.URL, err = directoryURL(n.URL, p)
		if err != nil {
			return n, err
		}
	}
	return n, nil
}
func newDirectoryPlugins() *directoryPluginService {
	s := &directoryPluginService{connecting: map[*directorySession]bool{}, providers: map[string]directoryProvider{}, sessions: map[string]*directorySession{}, client: &http.Client{Timeout: 15 * time.Second, CheckRedirect: func(*http.Request, []*http.Request) error { return fmt.Errorf("REDIRECT_DENIED") }}}
	s.auth = newFeishuAuth(s.client)
	raw, err := frontendFS.ReadFile("frontend/src/shared/directory-providers.json")
	if err != nil {
		return s
	}
	var catalog struct {
		APIVersion int                 `json:"apiVersion"`
		Providers  []directoryProvider `json:"providers"`
	}
	if json.Unmarshal(raw, &catalog) != nil || catalog.APIVersion != 1 {
		return s
	}
	for _, p := range catalog.Providers {
		origin, err := url.Parse(p.APIOrigin)
		if err != nil || origin.Scheme != "https" || origin.User != nil || origin.Host == "" || origin.Path != "" || origin.RawQuery != "" || origin.Fragment != "" || !directoryID.MatchString(p.ID) || len(p.DocumentHosts) == 0 || p.Success.Field == "" || (p.Root.Kind != "directory" && p.Root.Kind != "document") {
			continue
		}
		valid := true
		operations := []directoryOperation{p.List, p.Details}
		if p.Initialize != nil {
			operations = append(operations, *p.Initialize)
		}
		for _, op := range operations {
			if (op.Method != "GET" && op.Method != "POST") || (strings.HasPrefix(op.Path, "//") || strings.Contains(op.Path, "/../") || !directoryPath.MatchString(op.Path)) || op.Entries == "" || len(op.Fields) == 0 {
				valid = false
			}
		}
		if valid {
			s.providers[p.ID] = p
			s.providerOrder = append(s.providerOrder, p.ID)
		}
	}
	return s
}
func (s *directoryPluginService) activate(root string) {
	s.auth.clear()
	s.mu.Lock()
	defer s.mu.Unlock()
	for _, session := range s.sessions {
		session.cancel()
	}
	for session := range s.connecting {
		session.cancel()
	}
	s.connecting = map[*directorySession]bool{}
	s.sessions = map[string]*directorySession{}
	s.root = root
	s.seq++
}
func (s *directoryPluginService) savedLocked() []directoryMount {
	out := []directoryMount{}
	all, _ := loadState()["directoryMounts"].(map[string]any)
	list, _ := all[strings.ToLower(s.root)].([]any)
	for _, raw := range list {
		if len(out) >= 32 {
			break
		}
		data, _ := json.Marshal(raw)
		var m directoryMount
		if json.Unmarshal(data, &m) == nil && directoryID.MatchString(m.ID) && directoryRemoteID(m.RootID) && directoryText(m.Name, 256) != "" {
			if _, ok := s.providers[m.ProviderID]; ok {
				out = append(out, m)
			}
		}
	}
	return out
}
func (s *directoryPluginService) persistLocked(next []directoryMount) {
	all, _ := loadState()["directoryMounts"].(map[string]any)
	if all == nil {
		all = map[string]any{}
	}
	values := []any{}
	for _, m := range next {
		data, _ := json.Marshal(m)
		var value any
		json.Unmarshal(data, &value)
		values = append(values, value)
	}
	all[strings.ToLower(s.root)] = values
	patchInternal(map[string]any{"directoryMounts": all})
}
func (s *directoryPluginService) mounts() []map[string]any {
	s.mu.Lock()
	defer s.mu.Unlock()
	out := []map[string]any{}
	for _, m := range s.savedLocked() {
		_, connected := s.sessions[m.ID]
		out = append(out, map[string]any{"id": m.ID, "providerId": m.ProviderID, "rootId": m.RootID, "name": m.Name, "rootKind": s.providers[m.ProviderID].Root.Kind, "connected": connected})
	}
	return out
}
func (s *directoryPluginService) request(session *directorySession, op directoryOperation, node directoryNode, cursor string) (output map[string]any, failure error) {
	defer func() {
		if failure != nil && failure.Error() == "AUTH_REQUIRED" {
			s.mu.Lock()
			if s.sessions[session.mount.ID] == session {
				session.cancel()
				delete(s.sessions, session.mount.ID)
			}
			s.mu.Unlock()
		}
	}()
	s.mu.Lock()
	if session.seq != s.seq || session.ctx.Err() != nil {
		s.mu.Unlock()
		return nil, fmt.Errorf("SUPERSEDED")
	}
	if session.pending >= 4 {
		s.mu.Unlock()
		return nil, fmt.Errorf("BUSY")
	}
	session.pending++
	s.mu.Unlock()
	defer func() { s.mu.Lock(); session.pending--; s.mu.Unlock() }()
	space := node.ScopeID
	if space == "" {
		space = session.scopeID
	}
	docID, docType := node.DocumentID, node.DocumentType
	if docID == "" {
		docID = node.ID
	}
	if docType == "" {
		docType = node.Type
	}
	vars := map[string]string{"nodeId": node.ID, "nodeType": node.Type, "cursor": cursor, "scopeId": space, "documentId": docID, "documentType": docType}
	path := op.Path
	for key, value := range vars {
		path = strings.ReplaceAll(path, "$"+key, url.PathEscape(value))
	}
	target, _ := url.Parse(session.provider.APIOrigin + path)
	query := target.Query()
	for key, value := range op.Query {
		v := directorySubstitute(value, vars)
		if v != "" {
			query.Set(key, fmt.Sprint(v))
		}
	}
	target.RawQuery = query.Encode()
	var body io.Reader
	if op.Body != nil {
		data, _ := json.Marshal(directorySubstitute(op.Body, vars))
		body = bytes.NewReader(data)
	}
	ctx, cancel := context.WithTimeout(session.ctx, 15*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, op.Method, target.String(), body)
	if err != nil {
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	token := session.token
	if session.credential != nil {
		token, err = s.auth.token(session.credential, session.ctx)
		if err != nil {
			return nil, err
		}
	}
	req.Header.Set("Authorization", "Bearer "+token)
	req.Header.Set("Content-Type", "application/json")
	resp, err := s.client.Do(req)
	if err != nil {
		if session.ctx.Err() != nil {
			return nil, fmt.Errorf("SUPERSEDED")
		}
		if ctx.Err() != nil {
			return nil, fmt.Errorf("TIMEOUT")
		}
		return nil, fmt.Errorf("NETWORK")
	}
	defer resp.Body.Close()
	switch resp.StatusCode {
	case 401:
		return nil, fmt.Errorf("AUTH_REQUIRED")
	case 403:
		return nil, fmt.Errorf("FORBIDDEN")
	case 404:
		return nil, fmt.Errorf("NOT_FOUND")
	case 429:
		return nil, fmt.Errorf("RATE_LIMITED")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("NETWORK")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, 2*1024*1024+1))
	if err != nil {
		return nil, fmt.Errorf("NETWORK")
	}
	if len(data) > 2*1024*1024 {
		return nil, fmt.Errorf("RESPONSE_TOO_LARGE")
	}
	var result map[string]any
	if json.Unmarshal(data, &result) != nil {
		return nil, fmt.Errorf("BAD_RESPONSE")
	}
	code := directoryGet(result, session.provider.Success.Field)
	for _, auth := range session.provider.AuthCodes {
		if reflect.DeepEqual(code, float64(auth)) {
			return nil, fmt.Errorf("AUTH_REQUIRED")
		}
	}
	if !reflect.DeepEqual(code, session.provider.Success.Value) {
		return nil, fmt.Errorf("PROVIDER_ERROR")
	}

	if session.ctx.Err() != nil {
		return nil, fmt.Errorf("SUPERSEDED")
	}
	return result, nil
}
func (s *directoryPluginService) getNode(mountID, nodeID string) (*directorySession, directoryNode, error) {
	s.mu.Lock()
	defer s.mu.Unlock()
	session := s.sessions[mountID]
	if session == nil {
		return nil, directoryNode{}, fmt.Errorf("AUTH_REQUIRED")
	}
	node, ok := session.nodes[nodeID]
	if !ok {
		return nil, node, fmt.Errorf("OUTSIDE_MOUNT")
	}
	return session, node, nil
}
func (s *directoryPluginService) page(session *directorySession, nodeID, cursor string, refresh bool) (directoryPage, error) {
	s.mu.Lock()
	node, ok := session.nodes[nodeID]
	cached, hit := session.cache[nodeID+":"+cursor]
	allowedCursor := cursor == "" || session.cursors[nodeID][cursor]
	s.mu.Unlock()
	empty := directoryPage{}
	if !ok || !allowedCursor {
		return empty, fmt.Errorf("OUTSIDE_MOUNT")
	}
	if node.Kind != "directory" || (cursor != "" && directoryText(cursor, 2048) == "") {
		return empty, fmt.Errorf("BAD_REQUEST")
	}
	if !refresh && hit && time.Now().Before(cached.until) {
		return cached.page, nil
	}
	result, err := s.request(session, session.provider.List, node, cursor)
	if err != nil {
		return empty, err
	}
	raw, ok := directoryGet(result, session.provider.List.Entries).([]any)
	if !ok || len(raw) > 200 {
		return empty, fmt.Errorf("BAD_RESPONSE")
	}
	entries := []directoryNode{}
	for _, value := range raw {
		n, err := directoryNormalize(value, session.provider, session.provider.List.Fields)
		if err != nil {
			return empty, err
		}
		entries = append(entries, n)
	}
	next := ""
	more, _ := directoryGet(result, session.provider.List.HasMore).(bool)
	if more {
		next = directoryText(directoryGet(result, session.provider.List.Cursor), 2048)
		if next == "" || next == cursor {
			return empty, fmt.Errorf("BAD_RESPONSE")
		}
	}
	page := directoryPage{Directory: node, Entries: entries, NextCursor: next}
	s.mu.Lock()
	defer s.mu.Unlock()
	if session.seq != s.seq || session.ctx.Err() != nil {
		return empty, fmt.Errorf("SUPERSEDED")
	}
	if len(session.nodes)+len(entries) > 10000 {
		return empty, fmt.Errorf("LIMIT")
	}
	for _, n := range entries {
		session.nodes[n.ID] = n
	}
	if next != "" {
		if session.cursors[nodeID] == nil {
			session.cursors[nodeID] = map[string]bool{}
		}
		session.cursors[nodeID][next] = true
	}
	if len(session.cache) >= 128 {
		for key := range session.cache {
			delete(session.cache, key)
			break
		}
	}
	session.cache[nodeID+":"+cursor] = directoryCache{page, time.Now().Add(time.Minute)}
	return page, nil
}
func directoryRootConfig(provider directoryProvider, raw string) (string, string, error) {
	root, typeID := raw, provider.Root.DefaultType
	if strings.HasPrefix(strings.ToLower(raw), "https:") {
		safe, err := directoryURL(raw, provider)
		if err != nil {
			return "", "", err
		}
		u, _ := url.Parse(safe)
		path := strings.Trim(u.EscapedPath(), "/")
		found := false
		for prefix, kind := range provider.Root.URLTypes {
			if strings.HasPrefix(path, prefix+"/") {
				root, err = url.PathUnescape(strings.TrimPrefix(path, prefix+"/"))
				if err != nil {
					return "", "", fmt.Errorf("BAD_REQUEST")
				}
				typeID = kind
				found = true
				break
			}
		}
		if !found {
			return "", "", fmt.Errorf("BAD_REQUEST")
		}
	}
	if !directoryRemoteID(root) || !directoryRemoteID(typeID) {
		return "", "", fmt.Errorf("BAD_REQUEST")
	}
	return root, typeID, nil
}
func (s *directoryPluginService) connect(input map[string]any) (any, error) {
	s.mu.Lock()
	seq := s.seq
	if s.root == "" {
		s.mu.Unlock()
		return nil, fmt.Errorf("NO_WORKSPACE")
	}
	saved := s.savedLocked()
	mountID := directoryText(input["id"], 256)
	m := directoryMount{ProviderID: directoryText(input["providerId"], 256), RootID: directoryText(input["rootId"], 4096), Name: directoryText(input["name"], 256)}
	if mountID != "" {
		for _, one := range saved {
			if one.ID == mountID {
				m = one
			}
		}
		if m.ID == "" {
			s.mu.Unlock()
			return nil, fmt.Errorf("NOT_FOUND")
		}
	}
	p, exists := s.providers[m.ProviderID]
	s.mu.Unlock()
	if exists && mountID == "" {
		root, rootType, err := directoryRootConfig(p, m.RootID)
		if err != nil {
			return nil, err
		}
		m.RootID = root
		m.RootType = rootType
	}
	token := directoryText(input["token"], 4096)
	authID := directoryText(input["authId"], 4096)
	if !exists || !directoryRemoteID(m.RootID) || (authID == "" && (token == "" || strings.ContainsAny(token, " \t\r\n"))) || (authID != "" && (p.APIOrigin != "https://open.feishu.cn" || !strings.HasPrefix(p.ID, "feishu-"))) {
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	if m.ID == "" {
		buf := make([]byte, 16)
		if _, err := rand.Read(buf); err != nil {
			return nil, fmt.Errorf("NETWORK")
		}
		m.ID = hex.EncodeToString(buf)
	}
	if m.Name == "" {
		m.Name = "云文档"
	}
	ctx, cancel := context.WithCancel(context.Background())
	rootType := m.RootType
	if rootType == "" {
		rootType = p.Root.DefaultType
	}
	root := directoryNode{ID: m.RootID, Name: m.Name, Type: rootType, Kind: p.Root.Kind}
	session := &directorySession{attemptID: directoryText(input["attemptId"], 128), cursors: map[string]map[string]bool{}, mount: m, provider: p, token: token, seq: seq, ctx: ctx, cancel: cancel, nodes: map[string]directoryNode{root.ID: root}, cache: map[string]directoryCache{}}
	if authID != "" {
		var err error
		session.credential, err = s.auth.take(authID)
		if err != nil {
			cancel()
			return nil, err
		}
	}
	s.mu.Lock()
	s.connecting[session] = true
	s.mu.Unlock()
	defer func() { s.mu.Lock(); delete(s.connecting, session); s.mu.Unlock() }()
	if p.Initialize != nil {
		body, err := s.request(session, *p.Initialize, root, "")
		if err != nil {
			cancel()
			return nil, err
		}
		resolved, err := directoryNormalize(directoryGet(body, p.Initialize.Node), p, p.Initialize.Fields)
		if err != nil {
			cancel()
			return nil, err
		}
		if resolved.ID != root.ID {
			cancel()
			return nil, fmt.Errorf("BAD_RESPONSE")
		}
		root = resolved
		root.Kind = p.Root.Kind
		root.Name = m.Name
		session.nodes[root.ID] = root
		session.scopeID = root.ScopeID
	}
	if root.Kind == "directory" {
		if _, err := s.page(session, root.ID, "", false); err != nil {
			cancel()
			return nil, err
		}
	} else {
		detail, err := s.documentDetails(session, root)
		if err == nil {
			_, err = directoryURL(detail.URL, p)
		}
		if err != nil {
			cancel()
			return nil, err
		}
	}

	s.mu.Lock()
	defer s.mu.Unlock()
	if seq != s.seq {
		cancel()
		return nil, fmt.Errorf("SUPERSEDED")
	}
	next := s.savedLocked()
	found := false
	for _, one := range next {
		if one.ID == m.ID {
			found = true
		}
	}
	if !found {
		if mountID != "" {
			cancel()
			return nil, fmt.Errorf("NOT_FOUND")
		}
		if len(next) >= 32 {
			cancel()
			return nil, fmt.Errorf("LIMIT")
		}
		next = append(next, m)
	}
	s.persistLocked(next)
	if old := s.sessions[m.ID]; old != nil {
		old.cancel()
	}
	s.sessions[m.ID] = session
	return map[string]any{"id": m.ID, "providerId": m.ProviderID, "rootId": m.RootID, "name": m.Name, "rootKind": p.Root.Kind, "connected": true}, nil
}
func (s *directoryPluginService) documentDetails(session *directorySession, node directoryNode) (directoryNode, error) {
	result, err := s.request(session, session.provider.Details, node, "")
	if err != nil {
		return node, err
	}
	entries, ok := directoryGet(result, session.provider.Details.Entries).([]any)
	if !ok || len(entries) == 0 {
		return node, fmt.Errorf("FORBIDDEN")
	}
	detail, err := directoryNormalize(entries[0], session.provider, session.provider.Details.Fields)
	if err != nil {
		return node, err
	}
	docID, docType := node.DocumentID, node.DocumentType
	if docID == "" {
		docID = node.ID
	}
	if docType == "" {
		docType = node.Type
	}
	if detail.ID != docID || detail.Type != docType {
		return node, fmt.Errorf("BAD_RESPONSE")
	}
	node.Name = detail.Name
	node.URL = detail.URL
	node.ModifiedAt = detail.ModifiedAt
	return node, nil
}
func (s *directoryPluginService) details(mountID, nodeID string) (directoryNode, error) {
	session, node, err := s.getNode(mountID, nodeID)
	if err != nil {
		return node, err
	}
	if node.Kind != "directory" {
		return s.documentDetails(session, node)
	}
	if session.provider.Initialize == nil {
		return node, nil
	}
	result, err := s.request(session, *session.provider.Initialize, node, "")
	if err != nil {
		return node, err
	}
	detail, err := directoryNormalize(directoryGet(result, session.provider.Initialize.Node), session.provider, session.provider.Initialize.Fields)
	if err != nil {
		return node, err
	}
	if detail.ID != node.ID {
		return node, fmt.Errorf("BAD_RESPONSE")
	}
	return detail, nil
}
func (s *directoryPluginService) open(mountID, nodeID string) (any, error) {
	session, node, err := s.getNode(mountID, nodeID)
	if err != nil {
		return nil, err
	}
	if node.Kind != "document" && node.DocumentID == "" {
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	detail, err := s.documentDetails(session, node)
	if err != nil {
		return nil, err
	}
	target, err := directoryURL(detail.URL, session.provider)
	if err != nil {
		return nil, err
	}
	return map[string]any{"name": detail.Name, "url": target}, nil
}
func (s *directoryPluginService) remove(id string) {
	s.mu.Lock()
	defer s.mu.Unlock()
	next := []directoryMount{}
	for _, m := range s.savedLocked() {
		if m.ID != id {
			next = append(next, m)
		}
	}
	s.persistLocked(next)
	if session := s.sessions[id]; session != nil {
		session.cancel()
	}
	delete(s.sessions, id)
}
func (a *App) directoryService() *directoryPluginService {
	a.directoryMu.Lock()
	defer a.directoryMu.Unlock()
	if a.directoryPlugins == nil {
		a.directoryPlugins = newDirectoryPlugins()
	}
	return a.directoryPlugins
}
func (a *App) DirectoryCall(method string, args map[string]any) map[string]any {
	s := a.directoryService()
	var value any
	var err error
	mountID, nodeID := directoryText(args["mountId"], 256), directoryText(args["nodeId"], 256)
	switch method {
	case "providers":
		list := []map[string]any{}
		for _, providerID := range s.providerOrder {
			p := s.providers[providerID]
			list = append(list, map[string]any{"id": p.ID, "name": p.Name, "version": p.Version, "rootKind": p.Root.Kind, "inputHint": p.InputHint, "apiVersion": 1})
		}
		value = list
	case "mounts":
		value = s.mounts()
	case "cancel":
		s.auth.cancelFlow(directoryText(args["attemptId"], 4096))
		s.mu.Lock()
		for session := range s.connecting {
			if session.attemptID == directoryText(args["attemptId"], 128) {
				session.cancel()
			}
		}
		s.mu.Unlock()
		value = true
	case "authStart":
		s.mu.Lock()
		hasRoot := s.root != ""
		seq := s.seq
		s.mu.Unlock()
		if !hasRoot {
			err = fmt.Errorf("NO_WORKSPACE")
		} else {
			value, err = s.auth.start(args)
			s.mu.Lock()
			stale := seq != s.seq
			s.mu.Unlock()
			if stale {
				s.auth.cancelFlow(directoryText(args["attemptId"], 4096))
				value = nil
				err = fmt.Errorf("SUPERSEDED")
			}
		}
	case "authPoll":
		value, err = s.auth.poll(directoryText(args["authId"], 4096))
	case "connect":
		value, err = s.connect(args)
	case "list":
		var session *directorySession
		session, _, err = s.getNode(mountID, nodeID)
		if err == nil {
			refresh, _ := args["refresh"].(bool)
			value, err = s.page(session, nodeID, directoryText(args["cursor"], 2048), refresh)
		}
	case "details":
		value, err = s.details(mountID, nodeID)
	case "open":
		value, err = s.open(mountID, nodeID)
	case "remove":
		s.remove(mountID)
		value = true
	default:
		err = fmt.Errorf("BAD_REQUEST")
	}
	if err != nil {
		return map[string]any{"error": err.Error()}
	}
	return map[string]any{"value": value}
}
