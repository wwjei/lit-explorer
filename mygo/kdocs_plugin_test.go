package main

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"os"
	"path/filepath"
	"strings"
	"testing"
	"time"
)

func kdocsFixture(t *testing.T) map[string]json.RawMessage {
	t.Helper()
	raw, err := os.ReadFile("../test/fixtures/kdocs-skill.json")
	if err != nil {
		t.Fatal(err)
	}
	var fixture map[string]json.RawMessage
	if json.Unmarshal(raw, &fixture) != nil {
		t.Fatal("invalid fixture")
	}
	return fixture
}
func fixtureKdocsSeal(raw []byte) ([]byte, error) {
	out := append([]byte(nil), raw...)
	for i := range out {
		out[i] ^= 170
	}
	return out, nil
}
func TestKdocsNativeDirectory(t *testing.T) {
	isolateState(t)
	fixture := kdocsFixture(t)
	service := newDirectoryPlugins()
	service.activate("native-kdocs")
	service.kdocs.file = filepath.Join(t.TempDir(), "credential.bin")
	service.kdocs.seal = fixtureKdocsSeal
	service.kdocs.unseal = fixtureKdocsSeal
	clock := time.Unix(100, 0)
	service.kdocs.now = func() time.Time { return clock }
	mode := ""
	tools := []string{}
	service.client.Transport = directoryRoundTrip(func(req *http.Request) (*http.Response, error) {
		var body struct {
			Tool string         `json:"tool"`
			Args map[string]any `json:"args"`
		}
		_ = json.NewDecoder(req.Body).Decode(&body)
		response := fixture[mode]
		if req.URL.Host == "api.wps.cn" {
			response = fixture["authorized"]
		} else {
			if req.URL.Host != "mcp-center.wps.cn" || req.URL.Path != "/skill_hub/api/v1/tool" || req.Header.Get("Authorization") != "Bearer skill-fixture-secret" {
				t.Fatal("unexpected request or credential boundary")
			}
			tools = append(tools, body.Tool)
			if response == nil {
				switch body.Tool {
				case "get_file_link":
					response = fixture["link"]
				case "get_file_info":
					response = fixture["fileDetails"]
					if body.Args["file_id"] == "folder_A" {
						response = fixture["folderDetails"]
					}
				case "list_files":
					if body.Args["drive_id"] != "drive_A" {
						t.Fatal("lost drive identity")
					}
					response = fixture["nestedPage"]
				case "list_my_files":
					response = fixture["firstPage"]
					if body.Args["page_token"] != nil {
						response = fixture["lastPage"]
					}
				default:
					t.Fatal("unexpected tool", body.Tool)
				}
			}
		}
		return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(response)))}, nil
	})
	app := &App{directoryPlugins: service}
	started := app.DirectoryCall("kdocsAuthStart", map[string]any{"attemptId": "native"})
	if started["error"] != nil {
		t.Fatal(started)
	}
	if !strings.HasPrefix(started["value"].(map[string]any)["url"].(string), "https://mcp-center.wps.cn/kdocs-auth/auth-guide?auth_code=") {
		t.Fatal("wrong auth guide")
	}
	clock = clock.Add(time.Second)
	result := app.DirectoryCall("kdocsAuthPoll", map[string]any{"authId": "native"})
	if result["error"] != nil {
		t.Fatal(result)
	}
	public, _ := json.Marshal(result)
	if strings.Contains(string(public), "skill-fixture-secret") {
		t.Fatal("credential escaped bridge")
	}
	raw, _ := os.ReadFile(service.kdocs.file)
	if strings.Contains(string(raw), "skill-fixture-secret") {
		t.Fatal("plaintext credentials")
	}
	result = app.DirectoryCall("connect", map[string]any{"providerId": "kdocs-skill", "name": "金山文档"})
	if result["error"] != nil {
		t.Fatal(result)
	}
	mount := result["value"].(map[string]any)
	id, root := mount["id"].(string), mount["rootId"].(string)
	session, _, _ := service.getNode(id, root)
	page, err := service.page(session, root, "", false)
	if err != nil || page.NextCursor != "next-page" {
		t.Fatal(page, err)
	}
	page, err = service.page(session, root, page.NextCursor, false)
	if err != nil || page.NextCursor != "" || page.Entries[0].ID != "file_B" {
		t.Fatal(page, err)
	}
	if _, err = service.page(session, root, "forged", false); err == nil {
		t.Fatal("forged page")
	}
	if _, err = service.page(session, "folder_A", "", false); err != nil {
		t.Fatal(err)
	}
	detail, err := service.details(id, "file_A")
	if err != nil || detail.Name != "接口说明" {
		t.Fatal(detail, err)
	}
	pinned, err := service.pin(id, "folder_A")
	if err != nil {
		t.Fatal(err)
	}
	pinnedID := pinned.(map[string]any)["id"].(string)
	duplicate, err := service.pin(id, "folder_A")
	if err != nil || duplicate.(map[string]any)["id"] != pinnedID {
		t.Fatal("duplicate shortcut")
	}
	if _, err = service.pin(id, "file_A"); err == nil {
		t.Fatal("file mounted as directory")
	}
	service.remove(id)
	opened, err := service.open(pinnedID, "file_A")
	if err != nil || opened.(map[string]any)["url"] != "https://www.kdocs.cn/l/fixtureDoc" {
		t.Fatal(opened, err)
	}
	serialized, _ := json.Marshal(loadState())
	if strings.Contains(string(serialized), "skill-fixture-secret") {
		t.Fatal("persisted token in settings")
	}
	service.activate("other")
	ready, err := service.kdocs.start(map[string]any{"attemptId": "restored"})
	if err != nil || ready.(map[string]any)["phase"] != "ready" {
		t.Fatal("did not reuse authorization", ready, err)
	}
	mode = "expired"
	if _, err = service.kdocs.invoke(context.Background(), "list", directoryNode{ID: root}, "", ""); err == nil || err.Error() != "AUTH_REQUIRED" {
		t.Fatal("did not expire", err)
	}
	if _, err = os.Stat(service.kdocs.file); !os.IsNotExist(err) {
		t.Fatal("expired credentials not removed")
	}
}
func TestKdocsNativeAuthBoundaries(t *testing.T) {
	fixture := kdocsFixture(t)
	for _, test := range []struct{ name, reply, expected string }{{"cancel", "cancelled", "AUTH_DENIED"}, {"enterprise", "enterprise", "KDOCS_PERSONAL_ONLY"}, {"timeout", "pending", "AUTH_EXPIRED"}} {
		t.Run(test.name, func(t *testing.T) {
			client := &http.Client{Transport: directoryRoundTrip(func(*http.Request) (*http.Response, error) {
				return &http.Response{StatusCode: 200, Body: io.NopCloser(strings.NewReader(string(fixture[test.reply])))}, nil
			})}
			plugin := newKdocsPlugin("", client)
			clock := time.Unix(100, 0)
			plugin.now = func() time.Time { return clock }
			if _, err := plugin.start(map[string]any{"attemptId": "test"}); err != nil {
				t.Fatal(err)
			}
			clock = clock.Add(time.Second)
			if test.name == "timeout" {
				clock = clock.Add(301 * time.Second)
			}
			if _, err := plugin.poll("test"); err == nil || err.Error() != test.expected {
				t.Fatal(test.expected, err)
			}
		})
	}
	client := &http.Client{Transport: directoryRoundTrip(func(req *http.Request) (*http.Response, error) {
		<-req.Context().Done()
		return nil, req.Context().Err()
	})}
	plugin := newKdocsPlugin("", client)
	clock := time.Unix(100, 0)
	plugin.now = func() time.Time { return clock }
	_, _ = plugin.start(map[string]any{"attemptId": "cancel"})
	clock = clock.Add(time.Second)
	result := make(chan error, 1)
	go func() { _, err := plugin.poll("cancel"); result <- err }()
	plugin.clear()
	err := <-result
	if err == nil || (err.Error() != "AUTH_REQUIRED" && err.Error() != "SUPERSEDED") {
		t.Fatal("pending auth not cancelled", err)
	}
}
