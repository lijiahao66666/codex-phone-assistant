# 下载页更新补丁

下载站既有目录为 `/opt/codex-phone-download`，与 relay 的 `public` 分开。`index.html` 的按钮由 `downloads.js` 设置。只更新页面、下载资源和更新源不需要重启 relay。

`scripts/prepare-download-page.py` 只在新的本地目录生成候选文件、统一补丁和前后 SHA-256 清单，不访问服务器、钥匙串，不上传或发布。

先将公开下载页当前的 `index.html` 和 `downloads.js` 保存到本地基线目录。最终 Mac 发布包使用 `scripts/prepare-macos-release.py` 的完整输出。本工具核对输出的文件大小、摘要与校验清单。签名验证仍由打包工具负责。

```sh
python3 scripts/prepare-download-page.py \
  --baseline /tmp/codex-download-baseline \
  --release /tmp/codex-macos-final-release \
  --output /tmp/codex-download-page-review \
  --release-date 2026-11-10 \
  --release-notes-url https://github.com/lijiahao66666/codex-phone-assistant/releases/tag/stable48
```

发布日期和版本说明地址必须与实际发布一致。仓库私有时，GitHub 版本说明可能需要登录有权限的账号。

输出中的 `candidate/` 是候选页面和 JS，`baseline/` 保留输入原文。`download-page.patch` 可直接审阅，`manifest.json` 记录当前基线及候选摘要。修改范围为 Mac 卡片、Mac 下载链接和 JS 引用的缓存版本。Windows 配置、演示和安装教程保持原文。已有修改后的页面或不匹配的结构会拒绝处理，需要重新核对更新位置。

执行发布时，先通过既有 p2 服务器入口核对实际目录与基线摘要，并备份被覆盖文件；若与 `manifest.json` 的 `beforeSHA256` 不符，应重新获取基线和生成补丁。先上传带版本名的 DMG、ZIP、发布回执与校验清单，核对服务器及公网完整文件的大小和摘要。保留固定 DMG 别名作为旧入口。ZIP 可下载且校验无误后，再发布已签名的 `appcast.xml`，最后以同目录临时文件和原子替换方式更新 JS 和页面。不要修改签名后的更新文件。

页面使用带版本名的 DMG，并显示版本、构建号、日期、完整 DMG 摘要、校验清单与说明链接。下载页发布后，应实际点击按钮并检查校验链接，确认无缓存 GET 返回新内容。更新源应核对签名、构建号和 enclosure 地址。GitHub 附件应与相同发布包的 SHA-256 一致。该流程不证明真实用户任务在升级后正常，仍需按已授权验收范围验证。

隔离验证：

```sh
PYTHONDONTWRITEBYTECODE=1 python3 scripts/test-prepare-download-page.py
```
