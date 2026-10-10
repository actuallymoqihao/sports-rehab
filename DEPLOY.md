# 部署到 GitHub Pages（手机独立运行，不依赖电脑）

做完这一步，你会得到一个**公网 HTTPS 地址**，手机打开后「添加到主屏幕」就是一个图标，
点开即用；电脑关机、换 Wi-Fi 都不影响；首次打开后还能离线使用。

全程只需要一个 GitHub 账号，不用买域名、不用服务器、不用备案。

---

## 一、建仓库并上传

1. 打开 <https://github.com/new>
2. 仓库名填 `sports-rehab`，可见性选 **Public**（Private 用 Pages 需要付费）
3. 不要勾选 "Add a README file"，直接 **Create repository**
4. 在新页面点 **uploading an existing file**
5. 把本文件夹（`deploy`）里的**全部文件**拖进去，注意：
   - `index.html`、`core.js`、`plan.js`、`video.js`
   - `manifest.webmanifest`、`icon.svg`、`sw.js`
   - `.nojekyll`（这是隐藏文件，**必须上传**，否则 GitHub 会用 Jekyll 处理而丢掉部分文件）
   - `samples/` 文件夹（可选，2 MB，用来验证手机上能不能正常解码）
6. 点 **Commit changes**

> `.nojekyll` 在 Windows 资源管理器里可能看不见。如果拖拽时漏了它，
> 直接在 GitHub 页面上点 **Add file → Create new file**，文件名填 `.nojekyll`，内容留空，提交即可。

## 二、打开 Pages

1. 仓库页 → **Settings** → 左侧 **Pages**
2. **Source** 选 `Deploy from a branch`
3. **Branch** 选 `main`，目录选 `/ (root)`，点 **Save**
4. 等 1–2 分钟，刷新该页，顶部会出现地址：

```
https://<你的用户名>.github.io/sports-rehab/
```

## 三、装到手机上

**iPhone（Safari）**
1. 用 **Safari** 打开上面的地址（必须 Safari，Chrome 加不了）
2. 底部 **分享** → **添加到主屏幕** → 添加
3. 主屏幕出现图标，点开是全屏、没有地址栏，和原生 App 一样

**安卓（Chrome）**
1. 用 Chrome 打开地址
2. 右上角 **⋮** → **添加到主屏幕** / **安装应用**
3. 主屏幕出现图标

装好后**首次联网打开一次**，之后就离线可用了（Service Worker 会缓存界面代码；视频文件不缓存，不会占空间）。

---

## 四、安全与隐私

- 这是**纯静态页面**，所有计算都在你手机本地完成
- **没有任何数据上传到服务器**——你的身高、体重、视频都不会离开手机
- 唯一在公网上的东西是「程序代码」本身，不含任何个人数据
- 网页里没有摄像头权限请求（设计上就用系统相机拍、再选文件），所以不需要任何敏感授权

如果你不想公开代码，可以：
- 建 **Private** 仓库 + 用 Cloudflare Pages / Netlify（免费版支持私有仓库）
- 或者只用单文件 `sports-rehab.html` 拷到手机本地打开（见下）

---

## 五、懒人方案：不部署，直接把单文件拷到手机

如果你不想碰 GitHub：

1. 电脑上打开 <http://127.0.0.1:8787/sports-rehab.html>，另存为文件
2. 传到手机（微信发给自己 / 数据线 / 网盘均可）
3. 手机上打开这个 `.html`

**注意平台差异：**
- **安卓**：文件管理器点开 → 选择用 Chrome 打开，能正常运行
- **iPhone**：iOS 对本地 HTML 限制很严，文件 App 点开往往只是预览、脚本不执行。
  建议装 **Documents by Readdle**，用它内置的浏览器打开，或者干脆走上面的 Pages 方案

所以：**iPhone 用户强烈建议走 GitHub Pages**；安卓用户单文件就够。

---

## 六、更新 App

改了代码（比如调阈值、改方案模板）之后：

- **Pages 方案**：重新上传改动的文件即可。但如果改了 `core.js` 等被缓存的文件，
  记得把 `sw.js` 里的 `CACHE = 'sports-rehab-v1'` 改成 `v2`，否则手机会一直用旧版本。
- **单文件方案**：重新跑 `node build-single.mjs`，再传一次 `sports-rehab.html`。
