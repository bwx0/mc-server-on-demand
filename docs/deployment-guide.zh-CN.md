# 部署用户手册

这份手册用于把按需 Minecraft 服务器部署到一台低配 VPS 上，并通过阿里云按需创建高配 ECI/ECS 运行游戏服。

## 1. 准备资源

先在阿里云准备以下资源：

- 一个已备案或可正常解析的控制面域名，例如 `mcc.dzxyim.top`。
- 一个玩家连接用域名，例如 `mc.dzxyim.top`，解析到已有 EIP。
- 一个 EIP，用于绑定到临时游戏运行时。
- 一个 VPC、vSwitch、安全组，且与云盘在同一地域和可用区。
- 一个持久化存储：优先使用可被 ECI 直接挂载的云盘；如果旧云盘已有分区，建议使用 ECS fallback 或迁移到新云盘/NAS。
- 一个阿里云 RAM 用户或 RAM 角色，授予 ECI、ECS、EIP、云盘相关的最小权限。

安全组至少需要放行：

- `25565/tcp`：Minecraft 玩家连接。
- `25575/tcp`：RCON，建议只允许控制面 VPS 访问。
- `80/443`：控制面网页访问，由 VPS 上的 Nginx 提供。

## 2. 准备运行时镜像

在本项目根目录构建运行时镜像：

```bash
docker build -t mc-runtime:latest runtime/
```

将镜像推送到阿里云容器镜像服务，并把最终镜像地址填入后续 `.env` 的 `RUNTIME_IMAGE`。

## 3. 准备 Minecraft 数据盘

把完整 Minecraft 服务端目录放到持久化存储的 `/data/mc` 下。

如果目录里已有启动脚本，确保它位于：

```bash
/data/mc/run.sh
```

并且有执行权限。然后把本项目的运行时初始化脚本复制到：

```bash
/data/server-init.sh
```

如果 `server.properties` 里没有启用 RCON，`server-init.sh` 会根据 `.env` 中的 `MINECRAFT_RCON_PASSWORD` 自动补齐基础配置。

## 4. 部署控制面到 VPS

在 VPS 上安装 Node.js 18 或更高版本，然后部署项目：

```bash
git clone <your-repo-url> /opt/ondemand_mc_server
cd /opt/ondemand_mc_server
npm install --omit=dev
cp .env.example .env
```

编辑 `.env`，至少填写：

- `PUBLIC_BASE_URL`
- `ADMIN_TOKEN`
- `USER_TOKEN`
- `RUNTIME_TOKEN`
- `ALIYUN_ACCESS_KEY_ID`
- `ALIYUN_ACCESS_KEY_SECRET`
- `ALIYUN_REGION_ID`
- `ALIYUN_ZONE_ID`
- `ALIYUN_VSWITCH_ID`
- `ALIYUN_SECURITY_GROUP_ID`
- `ALIYUN_EIP_INSTANCE_ID`
- `ALIYUN_EIP_ADDRESS`
- `RUNTIME_IMAGE`
- `ALIYUN_DISK_ID`
- `MINECRAFT_RCON_PASSWORD`

`ADMIN_TOKEN` 用于管理员页面，会显示下方 JSON 详情并允许执行预检。`USER_TOKEN` 用于普通开服/停服页面，只显示上方状态、在线人数、运行实例和更新时间，不显示下方 JSON 详情。`CONTROL_TOKEN` 仍可作为兼容旧配置的管理员令牌。

第一次上线建议保持：

```env
RUNTIME_PROVIDER=eci
IDLE_STOP_MINUTES=10
IDLE_AUTO_STOP=true
```

如果预检提示旧云盘不能被 ECI 挂载，再改用：

```env
RUNTIME_PROVIDER=ecs
ECS_FALLBACK_ENABLED=true
```

并补充 `ECS_IMAGE_ID` 等 ECS 配置。

## 5. 启动控制面服务

可以先直接运行确认配置：

```bash
npm start
```

确认无误后使用 systemd。项目提供了示例文件：

```bash
sudo cp deploy/mcc.service /etc/systemd/system/mcc.service
sudo systemctl daemon-reload
sudo systemctl enable --now mcc
```

再配置 Nginx 反向代理。示例文件在：

```bash
deploy/nginx-mcc.conf
```

部署后建议用 Certbot 或云厂商证书给 `mcc.dzxyim.top` 开启 HTTPS。

## 6. 第一次启动服务器

打开控制面网页：

```text
https://mcc.dzxyim.top
```

输入 `CONTROL_TOKEN`，按顺序操作：

1. 点击“预检”，确认 EIP、云盘、可用区、运行时配置通过。
2. 点击“启动服务器”，等待 ECI/ECS 创建完成。
3. 用 Minecraft 客户端连接 `mc.dzxyim.top`。
4. 至少完成一次“安全停止”，确认世界保存正常。
5. 确认安全停止正常；如需临时只告警不自动停服，可设置 `IDLE_AUTO_STOP=false`。

## 7. 日常使用

每次开服时，访问 `mcc.dzxyim.top` 点击启动即可。服务器进入 `running` 后，如果零玩家持续达到 `IDLE_ALERT_MINUTES` 会发送告警；持续达到 `IDLE_STOP_MINUTES` 且 `IDLE_AUTO_STOP=true` 时，会自动安全停服并释放计算资源。

遇到启动失败、EIP 绑定失败、RCON 停服失败等问题时，查看 `docs/ops-runbook.md`。
