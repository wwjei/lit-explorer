package main

import (
	"os"
	"path/filepath"
	"testing"
)

func TestProductDataMigration(t *testing.T) {
	base := t.TempDir()
	old := filepath.Join(base, "Lit Explorer MyGo")
	if err := os.MkdirAll(filepath.Join(old, "credentials"), 0700); err != nil {
		t.Fatal(err)
	}
	os.WriteFile(filepath.Join(old, "state.json"), []byte(`{"theme":"dark","lastRoot":"project"}`), 0600)
	os.WriteFile(filepath.Join(old, "credentials", "kdocs.bin"), []byte("protected-token"), 0600)
	if err := migrateProductData(base); err != nil {
		t.Fatal(err)
	}
	next := filepath.Join(base, productName)
	data, _ := os.ReadFile(filepath.Join(next, "credentials", "kdocs.bin"))
	if string(data) != "protected-token" {
		t.Fatal("credential not migrated")
	}
	if _, err := os.Stat(filepath.Join(old, "state.json")); err != nil {
		t.Fatal("source was removed")
	}
	os.WriteFile(filepath.Join(next, "state.json"), []byte("new"), 0600)
	os.Remove(filepath.Join(next, "credentials", "kdocs.bin"))
	if err := migrateProductData(base); err != nil {
		t.Fatal(err)
	}
	data, _ = os.ReadFile(filepath.Join(next, "state.json"))
	if string(data) != "new" {
		t.Fatal("current settings overwritten")
	}
	if _, err := os.Stat(filepath.Join(next, "credentials", "kdocs.bin")); !os.IsNotExist(err) {
		t.Fatal("logged-out credential restored")
	}
}
func TestProductMigrationFromFormerRuntime(t *testing.T) {
	base := t.TempDir()
	old := filepath.Join(base, "lit-explorer")
	os.MkdirAll(filepath.Join(old, "credentials"), 0700)
	os.WriteFile(filepath.Join(old, "state.json"), []byte("settings"), 0600)
	os.WriteFile(filepath.Join(old, "credentials", "kdocs.bin"), []byte("incompatible"), 0600)
	if err := migrateProductData(base); err != nil {
		t.Fatal(err)
	}
	if _, err := os.Stat(filepath.Join(base, productName, "credentials", "kdocs.bin")); !os.IsNotExist(err) {
		t.Fatal("incompatible credential copied")
	}
}
func TestProductMigrationDoesNotCopyLinks(t *testing.T) {
	base := t.TempDir()
	old := filepath.Join(base, "Lit Explorer MyGo")
	os.MkdirAll(old, 0700)
	outside := filepath.Join(base, "outside")
	os.WriteFile(outside, []byte("private"), 0600)
	if err := os.Symlink(outside, filepath.Join(old, "state.json")); err != nil {
		t.Skip(err)
	}
	if err := migrateProductData(base); err == nil {
		t.Fatal("symbolic settings accepted")
	}
	if _, err := os.Stat(filepath.Join(base, productName)); !os.IsNotExist(err) {
		t.Fatal("partial migration committed")
	}
}
