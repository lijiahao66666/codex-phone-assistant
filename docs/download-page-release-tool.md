# 下载页发布说明

下载页位于 `https://codex.air-inc.top/download/`，提供 GitHub 发行版和百度网盘两个下载入口。安装包放在下载渠道；服务器只需保存页面、展示素材及两端签名版本信息。

发布前核对下载链接、安装说明和版本信息。修改页面时先备份线上文件，发布后检查桌面和手机布局；更新版本信息后核验公网文件和签名。更新信息的具体流程见 [macOS 更新说明](../macos/UPDATES.md)和 [Windows 更新说明](../windows/windows-updates.md)。

`scripts/prepare-download-page.py` 是旧版下载页生成工具，面向按平台展示安装包的旧页面结构，不适用于当前双渠道页面，不要用于覆盖现有页面。
