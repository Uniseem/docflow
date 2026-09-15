# DocFlow
## 功能说明
本软件提供两种翻译方式：
1. 原生 PDF 解析后翻译，然后替换文本，再重新包装回去。最终排版和源文件一致，文本被替换为中文翻译
2. 使用 MinerU 进行 OCR 扫描，之后返回 markdown 并且进行翻译。

二者均需要自行接入大模型的 API，推荐使用 DeepSeek，便宜且快速。MinerU 方式还需自行去 MinerU 官网申请免费的 api。

## 安装说明

### Windows

从 Release 里面下载安装程序进行安装。

没有买证书，需要手动点无视风险继续安装。

### macOS

打开“终端”，粘贴下面这行命令并按回车，然后输入这台 Mac 的登录密码（输入时不显示字符）再按回车：

```bash
curl -fL -o /tmp/DocFlow.pkg "https://github.com/Uniseem/docflow/releases/latest/download/DocFlow-macos-$([ "$(sysctl -n hw.optional.arm64 2>/dev/null)" = 1 ] && echo arm64 || echo x86_64).pkg" && sudo installer -pkg /tmp/DocFlow.pkg -target / && rm -f /tmp/DocFlow.pkg
```

命令会下载适合这台 Mac（Apple 芯片或 Intel）的最新版本，并安装到“应用程序”文件夹；终端显示 `The install was successful.` 就完成了。之后在“应用程序”文件夹里打开 DocFlow 即可。

不要使用 Release 直接安装，因为没有买证书，会被直接阻断。


## 许可

DocFlow 本身以 [MIT 许可证](LICENSE)发布。构建产物中内置的 BabelDOC 与 PyMuPDF 以 **GNU AGPL v3** 发布，因此包含 PDF 原生翻译运行环境的应用包整体不能视为仅适用 MIT；再分发或修改这些组件时须遵守其许可证与源码提供要求。
