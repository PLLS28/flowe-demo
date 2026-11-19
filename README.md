# For you

一个完全在浏览器本地运行的手势互动花朵网站。摄像头画面不会上传；MediaPipe HandLandmarker 在浏览器内识别拇指与食指的捏合距离，连续控制花朵从花苞绽放到盛放，也会随手指捏合自然闭合。

花朵动画使用视频抽取的 30 张连续画面。拖动滑块时，页面在相邻画面之间实时交叉淡化，因此不依赖浏览器视频定位，避免画面跟不上手指或一下跳到盛开。

## 功能

- 30 张连续花朵画面，按 0% 到 100% 的开放度逐级显示。
- 相邻画面实时交叉淡化，拖动进度条时能看到完整绽放过程。
- 电脑摄像头手势控制，拇指与食指张开增加开放度，捏合降低开放度。
- 手势距离使用食指尖、拇指尖以及手掌宽度归一化，减少人物远近造成的差异。
- 手离开画面后，花朵停在最后的开放度。
- 摄像头不可用时可用滑块完整控制 0% 到 100%。
- 支持“手动 / 手势”切换、关闭摄像头、加载状态和明确的错误状态。
- 桌面与移动端响应式布局，桌面端不产生页面滚动。
- MediaPipe WASM、HandLandmarker 模型和 Lucide 图标均已放在项目内，正式运行不依赖 CDN。

## 花朵画面

原始视频保存在：

```text
花朵生长阶段/
└─ 花朵绽放视频.mp4
```

网站实际播放的画面序列：

```text
assets/growth-frames/
├─ frames.json
├─ frame-00.webp
├─ frame-01.webp
├─ ...
└─ frame-29.webp
```

`frames.json` 保存画面顺序和原视频时长。JavaScript 根据开放度计算当前帧和下一帧，在两帧之间连续交叉淡化，因此视觉过渡仍然按屏幕刷新率更新。

视频副本和首帧海报保存在：

```text
assets/video/
├─ flower-bloom.mp4
└─ flower-bloom-poster.webp
```

网页运行时主要读取 `assets/growth-frames/`；视频副本保留为原始素材，不参与拖动定位。

若替换花朵视频，请从新视频均匀抽取 30 张画面并覆盖 `frame-00.webp` 到 `frame-29.webp`，同时更新 `frames.json` 中的 `duration`。画面应保持相同的 960×720 尺寸和从花苞到盛放的顺序。

## 第一次运行

需要 Node.js 18 或更高版本。项目运行时不依赖 npm 包，不需要先执行 `npm install`。

Windows 可直接双击 `start.bat`。脚本会启动本地服务器并打开浏览器。

也可以在 PowerShell 或命令提示符中运行：

```powershell
npm start
```

访问：

```text
http://localhost:4173/
```

若端口已被占用，服务器会自动尝试 `4174`、`4175` 等后续端口，终端会显示实际地址。不要直接双击 `index.html`，浏览器的模块、模型和画面加载需要通过 HTTP 服务运行。

## 摄像头权限

1. 点击页面中的“开启摄像头”。
2. 在 Chrome 或 Edge 的权限询问中选择“允许”。
3. 首次会载入本地手势模型；载入完成后将一只手放到画面中。
4. 拇指与食指张开控制花瓣展开，捏合控制花瓣闭合。

若曾误点拒绝，可在地址栏左侧的网站设置中重新允许摄像头，然后刷新页面。

## 手动控制

滑块始终可用，键盘方向键也可以调整开放度：

- `0%`：第一张画面，花苞。
- `50%`：第 14、15 张画面之间，半开。
- `100%`：最后一张画面，盛放。

拖动滑块会自动切回手动模式，并把手动值作为新的目标值。画面会在目标位置之前经过中间帧，不会直接跳到终点。

## 推荐浏览器

推荐最新版 Chrome 或 Edge。使用电脑摄像头时建议开启浏览器硬件加速，以获得更稳定的 MediaPipe GPU 推理性能。GPU 初始化失败时，网站会自动尝试 CPU。

## 本地启动

```powershell
npm start
```

或：

```powershell
node server.js
```

本地服务器同时支持 HTTP Range 请求，便于以后直接预览或替换视频素材；当前花朵动画本身不依赖视频定位。

## 正式部署

把整个项目目录作为静态网站部署即可，不需要后端。需要保证以下文件随项目一起发布：

- `index.html`、`styles.css`、`app.js`
- `assets/growth-frames/`
- `assets/video/flower-bloom-poster.webp`
- `assets/models/`
- `assets/vendor/`

可使用 Nginx、IIS、Vercel、Netlify 或 Cloudflare Pages，并配置 HTTPS。托管平台需要为 `.webp` 返回图片 MIME 类型，为 `.mjs` 返回 JavaScript MIME 类型，为 `.wasm` 返回 `application/wasm`。

## HTTPS 与摄像头

浏览器只允许网站在安全上下文中访问摄像头：

- `http://localhost` 可以在本机开发时使用摄像头。
- 通过局域网 IP 或正式域名访问时，必须使用 `https://`。
- 普通远程 `http://` 页面会被浏览器禁止调用摄像头，网站会提示改用 HTTPS；滑块仍可继续使用。

## 常见问题

**没有摄像头**

使用滑块即可体验全部开合过程。页面会显示“未找到可用摄像头”。

**摄像头被其他软件占用**

关闭正在使用摄像头的会议软件、相机应用或浏览器标签页，再点击“开启摄像头”。

**权限被拒绝**

在 Chrome 或 Edge 的网站设置中允许摄像头权限，然后刷新页面。

**光线不足或手离得太远**

让手掌完整进入画面，保证拇指与食指清晰可见。手离开画面时花朵会停在原位，不会突然闭合。

**拖动滑块还是没有过程**

确认 `assets/growth-frames/` 中的 30 张 WebP 和 `frames.json` 均已部署，并检查浏览器控制台是否有图片载入错误。

**手势方向感觉不灵敏**

保持手掌朝向摄像头，让拇指和食指完整可见。脸部和手部不要严重逆光，手与镜头保持约一臂距离。

## 隐私

- 摄像头视频只在当前浏览器的内存中处理。
- 花朵画面是项目内本地文件。
- 不录制、不上传、不持久化摄像头画面。
- 没有账号、后端或分析埋点。
- 手势推理所需模型从本站本地文件加载。

## 目录

```text
index.html
styles.css
app.js
server.js
start.bat
package.json
assets/
├─ growth-frames/
│  ├─ frames.json
│  └─ frame-00.webp ... frame-29.webp
├─ video/
│  ├─ flower-bloom.mp4
│  └─ flower-bloom-poster.webp
├─ models/hand_landmarker.task
└─ vendor/
   ├─ lucide.min.js
   └─ mediapipe/
花朵生长阶段/        # 原始视频
```

MediaPipe Tasks Vision 使用 Apache-2.0 许可，Lucide 使用 ISC 许可。
