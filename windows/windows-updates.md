# Windows 更新与发布

Windows 客户端默认自动检查更新，也可以在系统托盘菜单手动检查。发现新版本时，用户可打开下载页，自行下载安装；客户端不会自动下载或安装更新。

## 版本信息

客户端从 `https://codex.air-inc.top/download/windows/latest-manual.json` 和同路径下的 `latest-manual.json.sig` 读取签名版本信息。清单包含版本号、构建号和发布日期，不包含安装包。客户端使用内置公钥验证 ECDSA P-256 / SHA-256 签名，并按构建号判断是否有新版本；下载页地址内置于客户端。

自动检查默认开启，在启动后和运行期间定期检查。用户可以在托盘菜单关闭自动检查，手动检查仍可使用。未配置更新源的旧客户端需先手动安装支持此功能的版本。

## 构建与发布

1. 更新 [version.json](version.json) 中的版本号和严格递增的构建号，确认更新源和公钥配置正确。
2. 使用匹配的 PKCS#8 ECDSA P-256 私钥构建。私钥不得提交到仓库或上传到下载服务器。构建脚本依次读取 `CODEX_PHONE_WINDOWS_UPDATE_PRIVATE_KEY` 和 `%USERPROFILE%\.codex\secrets\codex-phone-windows-update-ecdsa.pk8`。
3. 运行以下命令，在真实 Windows 上验证安装包和更新提示：

   ```powershell
   npm ci
   npm test
   npm run build:windows
   ```

4. 将 `build/windows/codex-phone-assistant-windows-x64-setup.exe` 放到下载渠道，确认用户可以获取。
5. 发布 `build/windows/latest-manual.json` 和 `build/windows/latest-manual.json.sig`，核对公网文件及签名，再用旧版客户端验证检查更新和打开下载页。

清单和签名必须来自同一次构建；上传后不要修改清单字节。发布构建会校验签名，签名失败时不能将该清单用于发布。仅供本地调试时可使用 `windows/build.ps1 -Force -SkipUpdateSigning`，此时不能发布未签名的清单。

Windows 更新与 macOS Sparkle 分别配置。构建脚本还会运行更新服务和旧更新助手的自测；这些模拟测试不能代替真实 Windows 上的安装和跨版本检查。
