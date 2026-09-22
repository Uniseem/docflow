# 字体

译文写回 PDF 时嵌入的中文字体。来源：[notofonts/noto-cjk](https://github.com/notofonts/noto-cjk)，`Sans/SubsetOTF/SC/`，许可证 SIL Open Font License 1.1（见 `LICENSE-OFL.txt`）。

| 文件                     | SHA-256                                                            | 大小      |
| ------------------------ | ------------------------------------------------------------------ | --------- |
| `NotoSansSC-Regular.otf` | `faa6c9df652116dde789d351359f3d7e5d2285a2b2a1f04a2d7244df706d5ea9` | 8,331,336 |
| `NotoSansSC-Bold.otf`    | `c6cb5a93abaa9edc8ee7463b7ebb7f42d618d40e6ed2f7a5371c97b0b64767c0` | 8,543,168 |

嵌入时用 fontkit 做子集化，最终 PDF 只带用到的字形。`scripts/verify-fonts.mjs` 会在 `npm run check` 里核对以上校验和。
