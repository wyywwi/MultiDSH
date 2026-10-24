# MultiDSH Icon

图标直接采用用户提供的两版 DeepSeek 风格三鲸鱼 SVG（`dsh6.svg` = 深色界面版，
`dsh5.svg` = 浅色界面版）：

| 文件 | 用途 |
|---|---|
| `dsh-dark.svg` | 深色模式源文件（浅色鲸鱼，`dsh6.svg` 原样） |
| `dsh-light.svg` | 浅色/日间模式源文件（深色鲸鱼，`dsh5.svg` 原样） |
| `icon-dark-16…1024.png` / `icon-dark.png` | 深色版各尺寸 PNG（透明背景，白色鲸鱼） |
| `icon-light-16…1024.png` / `icon-light.png` | 浅色版各尺寸 PNG（透明背景，黑色鲸鱼） |
| `icon.ico` | Windows 多尺寸图标（深色版，备用） |
| `icon-black.ico` | Windows 多尺寸图标（浅色版黑色鲸鱼，exe / 窗口 / 任务栏 / 任务管理器默认使用） |
| `tray.png` / `tray-16.png` | 托盘图标：黑色鲸鱼 + 不透明白色圆角底 |
| `preview-512.png` | 预览（深色版） |
| `render-legacy-geometry.py` | 旧版"几何生成三鲸鱼"脚本，仅留档，不再使用 |

## 重新生成

```powershell
cd multidsh
.\packages\desktop\node_modules\electron\dist\electron.exe scripts\render-icons.cjs --no-sandbox
python scripts\make-ico.py
python scripts\make-tray.py
```

- `render-icons.cjs`：用 Electron（Chromium）把两个 SVG 分别渲染成 16–1024 的
  PNG，背景透明；
- `make-ico.py`：用 Pillow 生成深色版 `icon.ico` 和黑色版 `icon-black.ico`；
- `make-tray.py`：生成白底黑鲸鱼的托盘 PNG；
- 改完图标后要重新打包（`node scripts/package-desktop.mjs`）才会更新 exe 图标；
  打包脚本会用 `scripts/vendor/rcedit.exe` 把 Electron 运行时 exe 的图标/文件描述
  也改成 MultiDSH。

## 桌面端品牌图标

`packages/desktop/src/renderer/brand-dark.svg` / `brand-light.svg` 是同一份
源文件的副本。`index.html` 同时挂两个 `<img>`，`styles.css` 按
`:root[data-theme="light"]` 切换显示——所以设置里切深色/浅色时，
"MultiDSH"左边的鲸鱼会换成对应版本的设计。
