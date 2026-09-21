## 安装

### Windows

下载 `DocFlow-__VERSION__-win-x64-setup.exe` 双击安装。安装包没有代码签名，Windows 可能提示「Windows 已保护你的电脑」，点「更多信息 → 仍要运行」即可。更新时直接安装新版本，文档库和设置都会保留。

### macOS

打开「终端」，粘贴下面这行命令并回车，然后输入这台 Mac 的登录密码：

```bash
curl -fL -o /tmp/DocFlow.pkg "https://github.com/Uniseem/docflow/releases/download/v__VERSION__/DocFlow-__VERSION__-macos-$([ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && echo arm64 || echo x64).pkg" && sudo installer -pkg /tmp/DocFlow.pkg -target / && rm -f /tmp/DocFlow.pkg
```

用终端安装的应用不会被 Gatekeeper 拦下。也可以下载 `.dmg` 拖到「应用程序」，但第一次打开时需要到「系统设置 → 隐私与安全性」点「仍要打开」。

## 校验

`SHA256SUMS.txt` 里是每个文件的 SHA-256。
