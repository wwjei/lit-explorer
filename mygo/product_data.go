package main

// 历史名称只用于首次升级迁移；产品目录、窗口和快捷方式始终使用 Lit Explorer。
import (
	"fmt"
	"os"
	"path/filepath"
)

const productName = "Lit Explorer"

// 仅在新目录尚无内容时迁移。通过同目录临时目录 + rename 一次提交，失败不留下半份设置。
// 不迁移浏览器缓存；旧目录和所有源文件保留，已有的新目录永不覆盖。
func migrateProductData(base string) error {
	target := filepath.Join(base, productName)
	if entries, err := os.ReadDir(target); err == nil {
		if len(entries) > 0 {
			return nil
		}
	} else if !os.IsNotExist(err) {
		return err
	}
	for _, legacy := range []struct {
		name        string
		credentials bool
	}{{"Lit Explorer MyGo", true}, {"lit-explorer", false}} {
		source := filepath.Join(base, legacy.name)
		state, err := os.Lstat(filepath.Join(source, "state.json"))
		if os.IsNotExist(err) {
			continue
		}
		if err != nil {
			return err
		}
		if !state.Mode().IsRegular() {
			return fmt.Errorf("旧设置不是普通文件")
		}
		stage, err := os.MkdirTemp(base, ".lit-settings-")
		if err != nil {
			return err
		}
		defer os.RemoveAll(stage)
		files := []string{"state.json"}
		if legacy.credentials {
			files = append(files, filepath.Join("credentials", "kdocs.bin"))
		}
		for _, rel := range files {
			original := filepath.Join(source, rel)
			info, err := os.Lstat(original)
			if os.IsNotExist(err) {
				continue
			}
			if err != nil {
				return err
			}
			if !info.Mode().IsRegular() {
				return fmt.Errorf("旧设置不是普通文件: %s", rel)
			}
			data, err := os.ReadFile(original)
			if err != nil {
				return err
			}
			destination := filepath.Join(stage, rel)
			if err := os.MkdirAll(filepath.Dir(destination), 0700); err != nil {
				return err
			}
			if err := os.WriteFile(destination, data, 0600); err != nil {
				return err
			}
		}
		// 只能移除空目录，避免覆盖本轮启动期间意外出现的新设置。
		if err := os.Remove(target); err != nil && !os.IsNotExist(err) {
			return err
		}
		return os.Rename(stage, target)
	}
	return nil
}
