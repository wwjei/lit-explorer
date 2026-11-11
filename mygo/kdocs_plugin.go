package main

// 参考官方公开脚本及 CLI 目录协议，原生实现四个读取工具，不依赖外部程序。
import (
	"bytes"
	"context"
	"crypto/rand"
	"crypto/sha256"
	"encoding/hex"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"os"
	"path/filepath"
	"sync"
	"time"
	"unicode"
)

type kdocsProtocol struct {
	Version           string `json:"version"`
	AuthorizationPage string `json:"authorizationPage"`
	ExchangeEndpoint  string `json:"exchangeEndpoint"`
	ToolEndpoint      string `json:"toolEndpoint"`
}
type kdocsCredential struct {
	Token      string `json:"token"`
	ExpiresAt  int64  `json:"expiresAt"`
	Persistent bool   `json:"-"`
}
type kdocsAttempt struct {
	code, phase       string
	ctx               context.Context
	cancel            context.CancelFunc
	expiresAt, nextAt time.Time
	busy              bool
	epoch             int
}
type kdocsPlugin struct {
	clientID   string
	mu         sync.Mutex
	protocol   kdocsProtocol
	credential *kdocsCredential
	loaded     bool
	epoch      int
	attempts   map[string]*kdocsAttempt
	file       string
	client     *http.Client
	now        func() time.Time
	seal       func([]byte) ([]byte, error)
	unseal     func([]byte) ([]byte, error)
}

func newKdocsPlugin(file string, client *http.Client) *kdocsPlugin {
	c := &kdocsPlugin{file: file, client: client, now: time.Now, attempts: map[string]*kdocsAttempt{}, seal: protectKdocsCredential, unseal: unprotectKdocsCredential}
	identifier := make([]byte, 8)
	if _, err := rand.Read(identifier); err == nil {
		c.clientID = hex.EncodeToString(identifier)
	}
	raw, _ := frontendFS.ReadFile("frontend/src/shared/kdocs-skill.json")
	_ = json.Unmarshal(raw, &c.protocol)
	return c
}
func kdocsSecret(v any) string {
	s := directoryText(v, 16384)
	for _, r := range s {
		if unicode.IsSpace(r) {
			return ""
		}
	}
	return s
}
func kdocsIdentity(token string) string {
	sum := sha256.Sum256([]byte(token))
	return hex.EncodeToString(sum[:])
}
func (c *kdocsPlugin) loadLocked() {
	if c.loaded {
		return
	}
	c.loaded = true
	raw, err := os.ReadFile(c.file)
	if err != nil || len(raw) > 65536 {
		return
	}
	plain, err := c.unseal(raw)
	if err != nil {
		return
	}
	var value kdocsCredential
	if json.Unmarshal(plain, &value) == nil && kdocsSecret(value.Token) != "" && value.ExpiresAt > c.now().UnixMilli() {
		value.Persistent = true
		c.credential = &value
	}
}
func (c *kdocsPlugin) ensure(ctx context.Context) error {
	if ctx.Err() != nil {
		return fmt.Errorf("SUPERSEDED")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.loadLocked()
	return nil
}
func (c *kdocsPlugin) identity(ctx context.Context) (string, error) {
	if err := c.ensure(ctx); err != nil {
		return "", err
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	if c.credential == nil || c.credential.ExpiresAt <= c.now().UnixMilli() {
		return "", fmt.Errorf("AUTH_REQUIRED")
	}
	return kdocsIdentity(c.credential.Token), nil
}
func (c *kdocsPlugin) removeLocked() error {
	if c.file == "" {
		return nil
	}
	err := os.Remove(c.file)
	if os.IsNotExist(err) {
		return nil
	}
	return err
}
func (c *kdocsPlugin) saveLocked(value *kdocsCredential) (bool, error) {
	if c.file == "" {
		return false, nil
	}
	plain, _ := json.Marshal(value)
	raw, err := c.seal(plain)
	if err != nil {
		if c.removeLocked() != nil {
			return false, fmt.Errorf("CREDENTIAL_STORAGE")
		}
		return false, nil
	}
	if os.MkdirAll(filepath.Dir(c.file), 0700) != nil {
		return false, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	temp, err := os.CreateTemp(filepath.Dir(c.file), "kdocs-*.tmp")
	if err != nil {
		return false, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	defer os.Remove(temp.Name())
	_ = temp.Chmod(0600)
	_, writeErr := temp.Write(raw)
	closeErr := temp.Close()
	if writeErr != nil || closeErr != nil || os.Rename(temp.Name(), c.file) != nil {
		return false, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	return true, nil
}
func (c *kdocsPlugin) post(parent context.Context, endpoint string, input any, token string, limit int64) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(parent, 15*time.Second)
	defer cancel()
	if parent.Err() != nil {
		return nil, fmt.Errorf("SUPERSEDED")
	}
	raw, _ := json.Marshal(input)
	req, err := http.NewRequestWithContext(ctx, "POST", endpoint, bytes.NewReader(raw))
	if err != nil {
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("Authorization", "Bearer "+token)
		req.Header.Set("X-Cli-Version", c.protocol.Version)
		req.Header.Set("X-Client-Id", c.clientID)
		identifier := make([]byte, 8)
		if _, err := rand.Read(identifier); err == nil {
			req.Header.Set("X-Run-Id", hex.EncodeToString(identifier))
		}
		req.Header.Set("X-Client-Source", "lit-explorer")
		req.Header.Set("X-Request-Source", "lit-explorer")
	}
	resp, err := c.client.Do(req)
	if err != nil {
		if parent.Err() != nil {
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
		if endpoint == c.protocol.ExchangeEndpoint {
			return nil, fmt.Errorf("KDOCS_PERSONAL_ONLY")
		}
		return nil, fmt.Errorf("FORBIDDEN")
	case 409:
		return nil, fmt.Errorf("AUTH_DENIED")
	case 429:
		return nil, fmt.Errorf("RATE_LIMITED")
	}
	if resp.StatusCode < 200 || resp.StatusCode >= 300 {
		return nil, fmt.Errorf("NETWORK")
	}
	data, err := io.ReadAll(io.LimitReader(resp.Body, limit+1))
	if err != nil {
		return nil, fmt.Errorf("NETWORK")
	}
	if int64(len(data)) > limit {
		return nil, fmt.Errorf("RESPONSE_TOO_LARGE")
	}
	var result map[string]any
	if json.Unmarshal(data, &result) != nil || result == nil {
		return nil, fmt.Errorf("BAD_RESPONSE")
	}
	if parent.Err() != nil {
		return nil, fmt.Errorf("SUPERSEDED")
	}
	return result, nil
}
func (c *kdocsPlugin) clearLocked() {
	c.epoch++
	for _, a := range c.attempts {
		a.cancel()
	}
	c.attempts = map[string]*kdocsAttempt{}
}
func (c *kdocsPlugin) clear() { c.mu.Lock(); defer c.mu.Unlock(); c.clearLocked() }
func (c *kdocsPlugin) cancel(id string) {
	c.mu.Lock()
	defer c.mu.Unlock()
	if a := c.attempts[id]; a != nil {
		a.cancel()
		delete(c.attempts, id)
	}
}
func (c *kdocsPlugin) viewLocked(id string, a *kdocsAttempt) map[string]any {
	target := ""
	if a.phase != "ready" {
		target = c.protocol.AuthorizationPage + "?auth_code=" + url.QueryEscape(a.code)
	}
	return map[string]any{"authId": id, "phase": a.phase, "url": target, "interval": 1, "expiresAt": a.expiresAt.UnixMilli(), "persistent": c.credential != nil && c.credential.Persistent}
}
func (c *kdocsPlugin) start(input map[string]any) (any, error) {
	id := directoryText(input["attemptId"], 128)
	if !directoryID.MatchString(id) {
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	c.mu.Lock()
	defer c.mu.Unlock()
	c.clearLocked()
	c.loadLocked()
	random := make([]byte, 16)
	if _, err := rand.Read(random); err != nil {
		return nil, fmt.Errorf("NETWORK")
	}
	random[6] = (random[6] & 15) | 64
	random[8] = (random[8] & 63) | 128
	code := fmt.Sprintf("%x-%x-%x-%x-%x", random[:4], random[4:6], random[6:8], random[8:10], random[10:])
	ctx, cancel := context.WithCancel(context.Background())
	a := &kdocsAttempt{code: code, phase: "authorization", ctx: ctx, cancel: cancel, expiresAt: c.now().Add(300 * time.Second), nextAt: c.now().Add(time.Second), epoch: c.epoch}
	force, _ := input["forceLogin"].(bool)
	if !force && c.credential != nil && c.credential.ExpiresAt > c.now().Add(30*time.Second).UnixMilli() {
		a.phase = "ready"
	}
	c.attempts[id] = a
	return c.viewLocked(id, a), nil
}
func (c *kdocsPlugin) poll(id string) (any, error) {
	c.mu.Lock()
	a := c.attempts[id]
	if a == nil {
		c.mu.Unlock()
		return nil, fmt.Errorf("AUTH_REQUIRED")
	}
	if a.busy {
		c.mu.Unlock()
		return nil, fmt.Errorf("BUSY")
	}
	if a.phase == "ready" {
		result := c.viewLocked(id, a)
		c.mu.Unlock()
		return result, nil
	}
	if !c.now().Before(a.expiresAt) {
		a.cancel()
		delete(c.attempts, id)
		c.mu.Unlock()
		return nil, fmt.Errorf("AUTH_EXPIRED")
	}
	if c.now().Before(a.nextAt) {
		result := c.viewLocked(id, a)
		c.mu.Unlock()
		return result, nil
	}
	a.busy = true
	c.mu.Unlock()
	body, err := c.post(a.ctx, c.protocol.ExchangeEndpoint, map[string]string{"code": a.code}, "", 65536)
	c.mu.Lock()
	defer c.mu.Unlock()
	a.busy = false
	if a.ctx.Err() != nil || a.epoch != c.epoch {
		err = fmt.Errorf("SUPERSEDED")
	}
	if err == nil && !c.now().Before(a.expiresAt) {
		err = fmt.Errorf("AUTH_EXPIRED")
	}
	if err == nil {
		payload, _ := body["data"].(map[string]any)
		code := body["code"]
		if payload["code"] != nil {
			code = payload["code"]
		}
		switch code {
		case float64(202):
			a.nextAt = c.now().Add(time.Second)
		case float64(403), float64(403001):
			err = fmt.Errorf("KDOCS_PERSONAL_ONLY")
		case float64(409):
			err = fmt.Errorf("AUTH_DENIED")
		case float64(200):
			token := kdocsSecret(payload["token"])
			if token == "" {
				token = kdocsSecret(body["token"])
			}
			expiry := payload["expires_in"]
			if expiry == nil {
				expiry = body["expires_in"]
			}
			seconds, ok := expiry.(float64)
			if token == "" || !ok || seconds <= 0 || seconds > 366*86400 || seconds != float64(int64(seconds)) {
				err = fmt.Errorf("BAD_RESPONSE")
			} else {
				next := &kdocsCredential{Token: token, ExpiresAt: c.now().Add(time.Duration(seconds) * time.Second).UnixMilli()}
				next.Persistent, err = c.saveLocked(next)
				if err == nil {
					c.credential = next
					a.phase = "ready"
				}
			}
		default:
			err = fmt.Errorf("AUTH_FAILED")
		}
	}
	if err != nil {
		a.cancel()
		delete(c.attempts, id)
		return nil, err
	}
	return c.viewLocked(id, a), nil
}
func (c *kdocsPlugin) logout() (any, error) {
	c.mu.Lock()
	defer c.mu.Unlock()
	c.clearLocked()
	c.credential = nil
	c.loaded = true
	if c.removeLocked() != nil {
		return nil, fmt.Errorf("CREDENTIAL_STORAGE")
	}
	return true, nil
}
func (c *kdocsPlugin) invoke(ctx context.Context, operation string, node directoryNode, cursor, expectedIdentity string) (map[string]any, error) {
	if err := c.ensure(ctx); err != nil {
		return nil, err
	}
	c.mu.Lock()
	if c.credential == nil || c.credential.ExpiresAt <= c.now().UnixMilli() {
		c.mu.Unlock()
		return nil, fmt.Errorf("AUTH_REQUIRED")
	}
	token := c.credential.Token
	identity := kdocsIdentity(token)
	c.mu.Unlock()
	if expectedIdentity != "" && identity != expectedIdentity {
		return nil, fmt.Errorf("AUTH_REQUIRED")
	}
	tool := ""
	args := map[string]any{}
	switch operation {
	case "list":
		tool = "list_files"
		args["page_size"] = 100
		if cursor != "" {
			args["page_token"] = cursor
		}
		if node.ID == "@my-documents" {
			tool = "list_my_files"
		} else {
			args["parent_id"] = node.ID
			if node.ScopeID != "" {
				args["drive_id"] = node.ScopeID
			}
		}
	case "details":
		tool = "get_file_info"
		args["file_id"] = node.ID
	case "open":
		tool = "get_file_link"
		args["file_id"] = node.ID
	default:
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	body, err := c.post(ctx, c.protocol.ToolEndpoint, map[string]any{"tool": tool, "args": args}, token, 2*1024*1024)
	if err == nil {
		code := body["code"]
		switch code {
		case float64(400006), float64(401), float64(401001):
			err = fmt.Errorf("AUTH_REQUIRED")
		case float64(403001):
			err = fmt.Errorf("KDOCS_PERSONAL_ONLY")
		case float64(403):
			err = fmt.Errorf("FORBIDDEN")
		case float64(404):
			err = fmt.Errorf("NOT_FOUND")
		case float64(429):
			err = fmt.Errorf("RATE_LIMITED")
		case float64(0):
		default:
			err = fmt.Errorf("PROVIDER_ERROR")
		}
	}
	if err != nil {
		if err.Error() == "AUTH_REQUIRED" {
			c.mu.Lock()
			if c.credential != nil && kdocsIdentity(c.credential.Token) == identity {
				c.credential = nil
				_ = c.removeLocked()
			}
			c.mu.Unlock()
		}
		return nil, err
	}
	payload, ok := body["data"].(map[string]any)
	if !ok {
		return nil, fmt.Errorf("BAD_RESPONSE")
	}
	if operation == "list" {
		payload["has_more"] = payload["next_page_token"] != nil && payload["next_page_token"] != ""
	}
	if operation == "details" {
		body["data"] = map[string]any{"items": []any{payload}}
	}
	return body, nil
}
