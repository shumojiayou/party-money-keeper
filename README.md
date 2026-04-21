# 局中银行助手

一个适合聚会桌游的大富翁记账 H5。玩家进入同一个房间后，可以查看所有人的财富、给其他玩家转账、向银行付款，银行管理员也可以代表银行给玩家发钱。

## 当前能力

- 房主创建房间，自动成为首任银行管理员
- 玩家通过 6 位房间码加入
- 所有人实时查看余额、银行余额、财富排行榜和最近流水
- 玩家可以给其他玩家转账，也可以向银行付款
- 房主可以切换银行管理员
- 银行管理员可以从银行账户向任意玩家出款

## 本地开发

默认使用 `SQLite`，不需要额外数据库：

```powershell
cd C:\Users\mjh\Desktop\explore_codex
& C:\Users\mjh\AppData\Local\Programs\Python\Python312\python.exe .\server.py --host 0.0.0.0 --port 8000
```

访问：

```text
http://127.0.0.1:8000
```

如果要让同一局域网里的手机访问，确保手机和电脑在同一个 Wi-Fi，然后用：

```text
http://你的电脑局域网IP:8000
```

本地数据会保存在当前目录下的 `game.db`。

## 上传到 GitHub

当前目录已经初始化成 `git` 仓库，但这台机器还没有配置 Git 身份，也没有安装 GitHub CLI。所以第一次上传建议按下面顺序做：

### 1. 配置 Git 提交身份

把下面两行里的名字和邮箱换成你自己的：

```powershell
git config --global user.name "你的名字"
git config --global user.email "你的邮箱"
```

### 2. 在 GitHub 网站创建空仓库

在 GitHub 新建一个空仓库，例如：

```text
explore-codex-party-money-keeper
```

注意：

- 不要勾选自动创建 `README`
- 不要勾选 `license`
- 不要勾选 `.gitignore`

### 3. 在本地提交并推送

把下面的 `你的用户名` 和 `你的仓库名` 改掉：

```powershell
cd C:\Users\mjh\Desktop\explore_codex
git add .
git commit -m "Initial cloud-ready party money keeper"
git remote add origin https://github.com/你的用户名/你的仓库名.git
git push -u origin main
```

如果你已经在浏览器里登录 GitHub，一般会弹出认证流程；如果没有，就按 Git 提示完成登录。

如果你想少敲命令，也可以直接运行项目里带的脚本：

```powershell
cd C:\Users\mjh\Desktop\explore_codex
.\publish_to_github.ps1 -RepoUrl https://github.com/你的用户名/你的仓库名.git
```

## 云端部署思路

这套项目已经支持两种数据库模式：

- 本地开发：自动使用 `SQLite`
- 云端部署：只要设置 `DATABASE_URL`，就自动切换到 `PostgreSQL`

也就是说，代码层已经改成“本地用 SQLite，线上用 Postgres”的结构了。上线时不需要再维护两套代码。

## 推荐部署方案：Render

项目根目录已经带了 [render.yaml](./render.yaml)，可以直接按这个结构上云：

- 一个 Python Web Service
- 一个 PostgreSQL 数据库
- Web 服务通过环境变量 `DATABASE_URL` 连接数据库
- Render 通过 `/api/health` 做健康检查

### 部署步骤

1. 把这个项目推到 GitHub 仓库。
2. 登录 Render。
3. 在 Render 里选择 `New +` -> `Blueprint`。
4. 连接你的 GitHub 仓库。
5. Render 会读取仓库根目录的 `render.yaml`，自动创建：
   - `party-money-keeper` Web 服务
   - `party-money-keeper-db` PostgreSQL 数据库
6. 等部署完成后，打开 Render 分配的域名即可。

### 首次部署后要检查的 4 件事

1. 打开 `https://你的域名/api/health`，确认返回 `status: ok`
2. 在网页里创建一个测试房间
3. 用另一台设备加入房间
4. 试一笔玩家转账和一笔银行付款，确认数据会同步

### 如果你不用 Blueprint

也可以在 Render 控制台手动创建：

1. `New +` -> `Postgres`
2. 创建完成后复制内部连接串
3. `New +` -> `Web Service`
4. 连接 GitHub 仓库
5. 设置：
   - Build Command: `pip install -r requirements.txt`
   - Start Command: `python server.py`
   - Environment Variable: `DATABASE_URL=<你的 Postgres 连接串>`
6. 部署完成后访问 `/api/health`

### Render 启动逻辑

Render 会执行：

```text
buildCommand: pip install -r requirements.txt
startCommand: python server.py
```

应用启动时会自动建表，不需要你手动跑迁移。

## 如果不用 Render

这套项目现在只依赖一个关键环境变量：

```text
DATABASE_URL
```

所以你也可以部署到 Railway、Fly.io 或自己的云服务器，只要满足这几点：

- 启动命令能运行 `python server.py`
- 平台会注入 `PORT`
- 你提供一个 PostgreSQL 数据库，并把连接串写进 `DATABASE_URL`

示例见 [.env.example](./.env.example)。

## 目录

- `server.py`: HTTP 服务、API 路由、SQLite/PostgreSQL 双数据库支持
- `static/index.html`: H5 页面
- `static/styles.css`: 手机优先样式
- `static/app.js`: 前端交互和轮询同步
- `render.yaml`: Render 蓝图配置
- `requirements.txt`: Python 依赖
