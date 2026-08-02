# fast-generic 专属记忆

## 发布流程（v1.3.0 起验证）

- 版本发布标准流程：`git add -A` → `git commit -F .git/COMMIT_MSG_TMP`（多行 commit message 必须写临时文件，禁止 `-m` 单行拼接）→ 核验 `git log -1 --format=%B` → `git push` → `git tag -a v<版本> -m "<说明>"` → `git push origin v<版本>`
- 打包命令：`npm run pack:versioned:ca`（等价 `npm run dist` 但带 `-UseSystemCA`；pack-versioned.ps1 支持 -UseSystemCA 参数），输出到 `release\v<版本>\`，产物三种：NSIS 安装包（KimiCodeDesktop-Setup-<v>.exe）+ 便携版（KimiCodeDesktop-Portable-<v>.exe）+ 7z 自解压（KimiCodeDesktop-<v>-x64.7z），另有 blockmap/latest.yml
- Release 创建：`gh release create v<版本> --title "<标题>" --notes-file RELEASE_NOTES.md <三个产物路径>`

## 项目约定

- commit 标题格式：`<emoji> <type>:` + 空行 + 阿拉伯数字编号列表，中文分号结尾（末条句号）；项目实际使用 `✨ feat:`（新功能）、`📝 docs:`（文档）
- RELEASE_NOTES.md 用分类标题：新功能/改进/其他；无破坏性变更时不写 ⚠️
