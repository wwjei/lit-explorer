package main

// 飞书官方 CLI 公开设备协议的实验实现；凭据仅留在本机宿主内存。
import (
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
	"unicode"
)

type feishuAuthConfig struct {
	AccountsOrigin   string `json:"accountsOrigin"`
	RegistrationPath string `json:"registrationPath"`
	DevicePath       string `json:"devicePath"`
	TokenPath        string `json:"tokenPath"`
	Scopes           string `json:"scopes"`
}
type feishuFlow struct {
	mu                                                     sync.Mutex
	id, phase, deviceCode, appID, appSecret, userCode, url string
	accessToken, refreshToken                              string
	expiresAt, nextAt, tokenExpiresAt                      time.Time
	interval                                               int
	ctx                                                    context.Context
	cancel                                                 context.CancelFunc
}
type feishuAuth struct {
	mu     sync.Mutex
	flows  map[string]*feishuFlow
	client *http.Client
	config feishuAuthConfig
	now    func() time.Time
}

func newFeishuAuth(client *http.Client) *feishuAuth {
	a := &feishuAuth{flows: map[string]*feishuFlow{}, client: client, now: time.Now}
	raw, _ := frontendFS.ReadFile("frontend/src/shared/feishu-auth.json")
	_ = json.Unmarshal(raw, &a.config)
	return a
}
func feishuSecret(v any) string {
	s := directoryText(v, 4096)
	for _, r := range s {
		if unicode.IsSpace(r) {
			return ""
		}
	}
	return s
}
func feishuVerification(raw string) (string, error) {
	u, err := url.Parse(raw)
	if err != nil || u.Scheme != "https" || u.User != nil || u.Port() != "" || (u.Host != "accounts.feishu.cn" && u.Host != "open.feishu.cn") {
		return "", fmt.Errorf("UNSAFE_URL")
	}
	return u.String(), nil
}
func feishuSeconds(v any, fallback, max int) int {
	n, ok := v.(float64)
	if !ok || n <= 0 || n != float64(int(n)) {
		return fallback
	}
	if n > float64(max) {
		return max
	}
	return int(n)
}
func (a *feishuAuth) post(ctx context.Context, path string, values url.Values, basic string) (map[string]any, error) {
	ctx, cancel := context.WithTimeout(ctx, 15*time.Second)
	defer cancel()
	if ctx.Err() != nil {
		return nil, fmt.Errorf("SUPERSEDED")
	}
	req, err := http.NewRequestWithContext(ctx, "POST", a.config.AccountsOrigin+path, strings.NewReader(values.Encode()))
	if err != nil {
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	req.Header.Set("Content-Type", "application/x-www-form-urlencoded")
	if basic != "" {
		req.Header.Set("Authorization", "Basic "+base64.StdEncoding.EncodeToString([]byte(basic)))
	}
	resp, err := a.client.Do(req)
	if err != nil {
		if ctx.Err() != nil {
			return nil, fmt.Errorf("SUPERSEDED")
		}
		return nil, fmt.Errorf("NETWORK")
	}
	defer resp.Body.Close()
	raw, err := io.ReadAll(io.LimitReader(resp.Body, 65537))
	if err != nil {
		return nil, fmt.Errorf("NETWORK")
	}
	var body map[string]any
	if len(raw) > 65536 || json.Unmarshal(raw, &body) != nil || body == nil {
		return nil, fmt.Errorf("BAD_RESPONSE")
	}
	if ctx.Err() != nil {
		return nil, fmt.Errorf("SUPERSEDED")
	}
	if resp.StatusCode == 429 {
		return nil, fmt.Errorf("RATE_LIMITED")
	}
	if body["error"] == nil && (resp.StatusCode < 200 || resp.StatusCode >= 300 || (body["code"] != nil && body["code"] != float64(0))) {
		return nil, fmt.Errorf("AUTH_FAILED")
	}
	return body, nil
}
func feishuError(body map[string]any) error {
	code, _ := body["error"].(string)
	switch code {
	case "":
		return nil
	case "access_denied":
		return fmt.Errorf("AUTH_DENIED")
	case "expired_token", "invalid_grant":
		return fmt.Errorf("AUTH_EXPIRED")
	default:
		return fmt.Errorf("AUTH_FAILED")
	}
}
func (f *feishuFlow) view() map[string]any {
	return map[string]any{"authId": f.id, "phase": f.phase, "url": f.url, "userCode": f.userCode, "interval": f.interval, "expiresAt": f.expiresAt.UnixMilli()}
}
func (a *feishuAuth) pending(f *feishuFlow, body map[string]any, registration bool) error {
	f.deviceCode = feishuSecret(body["device_code"])
	if f.deviceCode == "" || (registration && feishuSecret(body["user_code"]) == "") {
		return fmt.Errorf("BAD_RESPONSE")
	}
	f.phase = "authorization"
	raw := directoryText(body["verification_uri_complete"], 4096)
	if raw == "" {
		raw = directoryText(body["verification_uri"], 4096)
	}
	f.userCode = directoryText(body["user_code"], 128)
	if registration {
		f.phase = "registration"
		raw = "https://open.feishu.cn/page/cli?user_code=" + url.QueryEscape(f.userCode)
	}
	var err error
	f.url, err = feishuVerification(raw)
	if err != nil {
		return err
	}
	f.interval = feishuSeconds(body["interval"], 5, 60)
	expiry := body["expire_in"]
	if expiry == nil {
		expiry = body["expires_in"]
	}
	f.expiresAt = a.now().Add(time.Duration(feishuSeconds(expiry, 600, 1800)) * time.Second)
	f.nextAt = a.now().Add(time.Duration(f.interval) * time.Second)
	return nil
}
func (a *feishuAuth) authorize(f *feishuFlow) error {
	body, err := a.post(f.ctx, a.config.DevicePath, url.Values{"client_id": {f.appID}, "scope": {a.config.Scopes}}, f.appID+":"+f.appSecret)
	if err != nil {
		return err
	}
	if err = feishuError(body); err != nil {
		return err
	}
	return a.pending(f, body, false)
}
func (a *feishuAuth) tokens(f *feishuFlow, body map[string]any) error {
	if err := feishuError(body); err != nil {
		return err
	}
	token := feishuSecret(body["access_token"])
	expiry := feishuSeconds(body["expires_in"], 0, 86400)
	refresh := feishuSecret(body["refresh_token"])
	if token == "" || expiry == 0 || (body["refresh_token"] != nil && body["refresh_token"] != "" && refresh == "") {
		return fmt.Errorf("BAD_RESPONSE")
	}
	kind := directoryText(body["token_type"], 128)
	if kind != "" && !strings.EqualFold(kind, "Bearer") {
		return fmt.Errorf("AUTH_UNSUPPORTED")
	}
	f.accessToken = token
	f.refreshToken = refresh
	f.tokenExpiresAt = a.now().Add(time.Duration(expiry) * time.Second)
	f.phase = "ready"
	f.url = ""
	f.userCode = ""
	f.deviceCode = ""
	return nil
}
func (a *feishuAuth) start(input map[string]any) (any, error) {
	id := feishuSecret(input["attemptId"])
	if len(id) > 128 || !directoryID.MatchString(id) {
		return nil, fmt.Errorf("BAD_REQUEST")
	}
	ctx, cancel := context.WithCancel(context.Background())
	f := &feishuFlow{id: id, ctx: ctx, cancel: cancel}
	a.mu.Lock()
	for _, old := range a.flows {
		old.cancel()
	}
	a.flows = map[string]*feishuFlow{}
	a.flows[id] = f
	a.mu.Unlock()
	f.mu.Lock()
	defer f.mu.Unlock()
	var err error
	if input["mode"] == "personal" {
		var body map[string]any
		body, err = a.post(ctx, a.config.RegistrationPath, url.Values{"action": {"begin"}, "archetype": {"PersonalAgent"}, "auth_method": {"client_secret"}, "request_user_info": {"open_id tenant_brand"}}, "")
		if err == nil {
			err = feishuError(body)
		}
		if err == nil {
			err = a.pending(f, body, true)
		}
	} else if input["mode"] == "application" && (len(feishuSecret(input["appId"])) <= 256 && directoryID.MatchString(feishuSecret(input["appId"])) && strings.HasPrefix(feishuSecret(input["appId"]), "cli_")) && feishuSecret(input["appSecret"]) != "" {
		f.appID = feishuSecret(input["appId"])
		f.appSecret = feishuSecret(input["appSecret"])
		err = a.authorize(f)
	} else {
		err = fmt.Errorf("BAD_REQUEST")
	}
	if err != nil {
		a.cancelFlow(id)
		return nil, err
	}
	return f.view(), nil
}
func (a *feishuAuth) poll(id string) (any, error) {
	a.mu.Lock()
	f := a.flows[id]
	a.mu.Unlock()
	if f == nil {
		return nil, fmt.Errorf("AUTH_REQUIRED")
	}
	if !f.mu.TryLock() {
		return nil, fmt.Errorf("BUSY")
	}
	defer f.mu.Unlock()
	if f.ctx.Err() != nil {
		return nil, fmt.Errorf("SUPERSEDED")
	}
	if f.phase == "ready" {
		return f.view(), nil
	}
	if !a.now().Before(f.expiresAt) {
		a.cancelFlow(id)
		return nil, fmt.Errorf("AUTH_EXPIRED")
	}
	if a.now().Before(f.nextAt) {
		return f.view(), nil
	}
	body, err := map[string]any(nil), error(nil)
	if f.phase == "registration" {
		body, err = a.post(f.ctx, a.config.RegistrationPath, url.Values{"action": {"poll"}, "device_code": {f.deviceCode}}, "")
	} else {
		body, err = a.post(f.ctx, a.config.TokenPath, url.Values{"grant_type": {"urn:ietf:params:oauth:grant-type:device_code"}, "device_code": {f.deviceCode}, "client_id": {f.appID}, "client_secret": {f.appSecret}}, "")
	}
	if err == nil && !a.now().Before(f.expiresAt) {
		err = fmt.Errorf("AUTH_EXPIRED")
	}
	if err == nil {
		user, _ := body["user_info"].(map[string]any)
		if brand := directoryText(user["tenant_brand"], 64); brand != "" && brand != "feishu" {
			err = fmt.Errorf("AUTH_UNSUPPORTED")
		}
	}
	if err == nil {
		switch body["error"] {
		case "authorization_pending":
		case "slow_down":
			f.interval += 5
			if f.interval > 60 {
				f.interval = 60
			}
		default:
			err = feishuError(body)
			if err == nil {
				if f.phase == "registration" {
					if feishuSecret(body["client_id"]) != "" && feishuSecret(body["client_secret"]) != "" {
						f.appID = feishuSecret(body["client_id"])
						f.appSecret = feishuSecret(body["client_secret"])
						err = a.authorize(f)
					}
				} else {
					err = a.tokens(f, body)
				}
			}
		}
	}
	if err != nil {
		a.cancelFlow(id)
		return nil, err
	}
	f.nextAt = a.now().Add(time.Duration(f.interval) * time.Second)
	return f.view(), nil
}
func (a *feishuAuth) take(id string) (*feishuFlow, error) {
	a.mu.Lock()
	f := a.flows[id]
	a.mu.Unlock()
	if f == nil {
		return nil, fmt.Errorf("AUTH_REQUIRED")
	}
	f.mu.Lock()
	defer f.mu.Unlock()
	if f.phase != "ready" || f.ctx.Err() != nil {
		return nil, fmt.Errorf("AUTH_REQUIRED")
	}
	a.mu.Lock()
	defer a.mu.Unlock()
	if a.flows[id] != f {
		return nil, fmt.Errorf("AUTH_REQUIRED")
	}
	delete(a.flows, id)
	return f, nil
}
func (a *feishuAuth) token(f *feishuFlow, ctx context.Context) (string, error) {
	f.mu.Lock()
	defer f.mu.Unlock()
	if ctx.Err() != nil {
		return "", fmt.Errorf("SUPERSEDED")
	}
	if a.now().Before(f.tokenExpiresAt.Add(-30 * time.Second)) {
		return f.accessToken, nil
	}
	if f.refreshToken == "" {
		if a.now().Before(f.tokenExpiresAt) {
			return f.accessToken, nil
		}
		return "", fmt.Errorf("AUTH_REQUIRED")
	}
	body, err := a.post(ctx, a.config.TokenPath, url.Values{"grant_type": {"refresh_token"}, "refresh_token": {f.refreshToken}, "client_id": {f.appID}, "client_secret": {f.appSecret}}, "")
	if err == nil {
		err = a.tokens(f, body)
	}
	if err != nil {
		switch err.Error() {
		case "AUTH_EXPIRED", "AUTH_DENIED", "AUTH_FAILED", "AUTH_UNSUPPORTED":
			f.accessToken = ""
			f.refreshToken = ""
			f.tokenExpiresAt = time.Time{}
			return "", fmt.Errorf("AUTH_REQUIRED")
		}
		return "", err
	}
	return f.accessToken, nil
}
func (a *feishuAuth) cancelFlow(id string) {
	a.mu.Lock()
	defer a.mu.Unlock()
	if f := a.flows[id]; f != nil {
		f.cancel()
		delete(a.flows, id)
	}
}
func (a *feishuAuth) clear() {
	a.mu.Lock()
	defer a.mu.Unlock()
	for _, f := range a.flows {
		f.cancel()
	}
	a.flows = map[string]*feishuFlow{}
}
