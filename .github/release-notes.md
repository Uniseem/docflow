## 下载

| 系统 | 下载 |
| --- | --- |
| Windows 10 2004 或更高版本（x64） | `DocFlow-win-x64.zip` |
| macOS 14 或更高版本，Apple 芯片（M 系列） | `DocFlow-macos-arm64.pkg` |
| macOS 14 或更高版本，Intel 芯片 | `DocFlow-macos-x86_64.pkg` |

不确定 Mac 是哪种芯片：点按左上角的苹果菜单 →“关于本机”，写着 Apple M… 的是 Apple 芯片，写着 Intel 的是 Intel 芯片。下错了版本，安装器会直接提示该下载哪一个。

## 安装

**Windows**：解压 zip，运行其中的 `DocFlow.exe`，不需要管理员权限，也不需要另外安装 .NET 或 Visual C++ 运行库。第一次运行时如果出现“Windows 已保护你的电脑”，点“更多信息 → 仍要运行”即可。

**macOS**：双击安装包，按提示安装到“应用程序”文件夹。安装包没有经过 Apple 公证时，第一次打开会提示无法验证开发者，手动允许一次即可：

- macOS 15 及以后：双击安装包，在提示中点“完成”；打开“系统设置 → 隐私与安全性”，在页面下方点“仍要打开”并输入登录密码，再点“打开”。
- macOS 14：按住 Control 点按安装包，选“打开”，再点“打开”。

由安装器装好的 DocFlow 打开时不会再有任何提示。

`SHA256SUMS.txt` 列出了每个文件的 SHA-256 校验值。使用说明、系统要求和常见问题见 [README](https://github.com/Uniseem/docflow/blob/v__VERSION__/README.md)。
