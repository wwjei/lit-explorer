package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"testing"
	"time"
)

func authFixture(t *testing.T) (*feishuAuth, *[]string, *[]*http.Request, *time.Time) {
	t.Helper()
	raw, err := os.ReadFile("../test/fixtures/feishu-auth.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fixture)
	queue := []string{}
	calls := []*http.Request{}
	clock := time.Unix(100, 0)
	client := &http.Client{Transport: directoryRoundTrip(func(req *http.Request) (*http.Response, error) {
		calls = append(calls, req)
		if req.URL.Host != "accounts.feishu.cn" {
			t.Fatal("unexpected auth host")
		}
		if len(queue) == 0 {
			t.Fatal("unexpected request")
		}
		key := queue[0]
		queue = queue[1:]
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(fixture[key])))}, nil
	})}
	auth := newFeishuAuth(client)
	auth.now = func() time.Time { return clock }
	return auth, &queue, &calls, &clock
}
func TestFeishuDeviceRegistrationAndRefresh(t *testing.T) {
	auth, queue, calls, clock := authFixture(t)
	*queue = []string{"registration", "registered", "device", "pending", "slow", "token", "refreshed"}
	value, err := auth.start(map[string]any{"mode": "personal", "attemptId": "one"})
	if err != nil {
		t.Fatal(err)
	}
	if value.(map[string]any)["phase"] != "registration" {
		t.Fatal(value)
	}
	if _, err = auth.poll("one"); err != nil || len(*calls) != 1 {
		t.Fatal("early polling sent request", err)
	}
	*clock = clock.Add(time.Second)
	value, err = auth.poll("one")
	if err != nil || value.(map[string]any)["phase"] != "authorization" {
		t.Fatal(value, err)
	}
	_ = (*calls)[2].ParseForm()
	if (*calls)[2].Form.Get("scope") != auth.config.Scopes || !strings.HasPrefix((*calls)[2].Header.Get("Authorization"), "Basic ") {
		t.Fatal("device request")
	}
	*clock = clock.Add(time.Second)
	_, _ = auth.poll("one")
	*clock = clock.Add(time.Second)
	value, err = auth.poll("one")
	if err != nil || value.(map[string]any)["interval"] != 6 {
		t.Fatal(value, err)
	}
	*clock = clock.Add(6 * time.Second)
	value, err = auth.poll("one")
	if err != nil {
		t.Fatal(err)
	}
	data, _ := json.Marshal(value)
	if strings.Contains(string(data), "fixture") || strings.Contains(string(data), "secret") {
		t.Fatal("credential escaped to renderer")
	}
	credential, err := auth.take("one")
	if err != nil {
		t.Fatal(err)
	}
	if _, err = auth.take("one"); err == nil {
		t.Fatal("replayed authorization")
	}
	token, err := auth.token(credential, context.Background())
	if err != nil || token != "access-fixture" {
		t.Fatal(token, err)
	}
	*clock = clock.Add(100 * time.Second)
	var wg sync.WaitGroup
	for i := 0; i < 3; i++ {
		wg.Add(1)
		go func() {
			defer wg.Done()
			token, e := auth.token(credential, context.Background())
			if e != nil || token != "access-refreshed" {
				t.Error("refresh failed", e)
			}
		}()
	}
	wg.Wait()
	if len(*queue) != 0 {
		t.Fatal("refresh not performed")
	}
	ctx, cancel := context.WithCancel(context.Background())
	cancel()
	if _, err = auth.token(credential, ctx); err == nil {
		t.Fatal("cancelled credential used")
	}
}
func TestFeishuDeviceDenialExpiryAndCancel(t *testing.T) {
	for _, kind := range []string{"denied", "expired", "cancelled"} {
		t.Run(kind, func(t *testing.T) {
			auth, queue, _, clock := authFixture(t)
			*queue = []string{"device", "denied"}
			_, err := auth.start(map[string]any{"mode": "application", "attemptId": "one", "appId": "cli_fixture", "appSecret": "own-secret"})
			if err != nil {
				t.Fatal(err)
			}
			expected := "AUTH_DENIED"
			*clock = clock.Add(time.Second)
			if kind == "expired" {
				*clock = clock.Add(241 * time.Second)
				expected = "AUTH_EXPIRED"
			}
			if kind == "cancelled" {
				auth.clear()
				expected = "AUTH_REQUIRED"
			}
			_, err = auth.poll("one")
			if err == nil || err.Error() != expected {
				t.Fatalf("expected %s: %v", expected, err)
			}
		})
	}
	for _, raw := range []string{"https://evil.test/auth", "https://accounts.feishu.cn.evil.test", "https://x@accounts.feishu.cn", "http://accounts.feishu.cn"} {
		if _, err := feishuVerification(raw); err == nil {
			t.Fatal("unsafe auth URL accepted")
		}
	}
}

func TestDirectoryDeviceAuthConnection(t *testing.T) {
	isolateState(t)
	auth, queue, _, clock := authFixture(t)
	*queue = []string{"device", "token"}
	service := newDirectoryPlugins()
	service.auth = auth
	service.activate("auth-project")
	raw, err := os.ReadFile("../test/fixtures/feishu-directory.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	_ = json.Unmarshal(raw, &fixture)
	service.client.Transport = directoryRoundTrip(func(req *http.Request) (*http.Response, error) {
		if req.URL.Host != "open.feishu.cn" || req.Header.Get("Authorization") != "Bearer access-fixture" {
			t.Fatal("directory credential boundary")
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(fixture["firstPage"])))}, nil
	})
	app := &App{directoryPlugins: service}
	response := app.DirectoryCall("authStart", map[string]any{"mode": "application", "attemptId": "connect", "appId": "cli_fixture", "appSecret": "own-secret"})
	if response["error"] != nil {
		t.Fatal(response)
	}
	*clock = clock.Add(time.Second)
	response = app.DirectoryCall("authPoll", map[string]any{"authId": "connect"})
	if response["error"] != nil {
		t.Fatal(response)
	}
	response = app.DirectoryCall("connect", map[string]any{"providerId": "feishu-drive", "rootId": "root", "name": "授权文档", "authId": "connect"})
	if response["error"] != nil {
		t.Fatal(response)
	}
	persisted, _ := json.Marshal(loadState())
	for _, secret := range []string{"own-secret", "access-fixture", "refresh-fixture"} {
		if strings.Contains(string(persisted), secret) {
			t.Fatal("persisted credential")
		}
	}
	*clock = clock.Add(100 * time.Second)
	*queue = []string{"denied"}
	response = app.DirectoryCall("open", map[string]any{"mountId": response["value"].(map[string]any)["id"], "nodeId": "docA"})
	if response["error"] != "AUTH_REQUIRED" {
		t.Fatal("revoked refresh did not disconnect", response)
	}
	if len(service.sessions) != 0 {
		t.Fatal("expired session retained")
	}
}
