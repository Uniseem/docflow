## 安装

**Windows 10 2004 或更高版本（x64）**：下载 `DocFlow-win-x64-setup.exe`，双击运行，按提示完成安装。不需要管理员权限，也不需要另外安装 .NET 或 Visual C++ 运行库；更新时直接运行新版本的安装程序，文档库和设置都会保留。第一次运行时如果出现“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”即可。

**macOS 14 或更高版本（Apple 芯片或 Intel）**：打开“终端”，粘贴下面这行命令并按回车，然后输入这台 Mac 的登录密码。它会下载适合这台 Mac 的版本并安装到“应用程序”文件夹，不会出现“无法验证开发者”之类的提示：

```bash
curl -fL -o /tmp/DocFlow.pkg "https://github.com/Uniseem/docflow/releases/download/v__VERSION__/DocFlow-macos-$([ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && echo arm64 || echo x86_64).pkg" && sudo installer -pkg /tmp/DocFlow.pkg -target / && rm -f /tmp/DocFlow.pkg
```

也可以下载对应芯片的 `.pkg`（Apple 芯片用 arm64，Intel 用 x86_64）双击安装，第一次打开时需要在“系统设置 → 隐私与安全性”中点“仍要打开”。

`SHA256SUMS.txt` 列出了每个文件的 SHA-256 校验值。使用说明、系统要求和常见问题见 [README](https://github.com/Uniseem/docflow/blob/v__VERSION__/README.md)。
