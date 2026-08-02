# Pi Workspace 私网部署

Pi Workspace 没有应用层登录，并且底层 Pi Agent 可以读写代码、运行命令。只应部署在 Tailscale、WireGuard 等私网中，不能把端口直接映射到公网。

## 准备持久化目录

```bash
cp .env.example .env
mkdir -p data/pi-agent data/workspaces data/ssh
sudo chown -R 1000:1000 data/pi-agent data/workspaces data/ssh
chmod 700 data/ssh
```

私有 Git 仓库需要 SSH 时，把只读私钥和预先生成的 `known_hosts` 放进 `data/ssh/`。也可以在 Pi 的配置界面使用 HTTPS 凭据。不要把凭据提交进 Git。

## 绑定私网地址

编辑 `.env`：

```dotenv
PI_WEB_BIND_ADDRESS=100.x.y.z
PI_WEB_PORT=30141
PI_WEB_ALLOWED_HOSTS=pi-workspace.internal
```

`PI_WEB_BIND_ADDRESS` 应是服务器的私网/VPN 地址。若由同机的私网反向代理转发，则保持 `127.0.0.1`，并把代理使用的精确主机名写入 `PI_WEB_ALLOWED_HOSTS`。

## 启动

```bash
docker compose up -d --build
docker compose ps
docker compose logs -f pi-workspace
```

手机连接同一个 VPN 后，打开 `http://<私网地址>:30141`。数据分别保存在：

- `data/pi-agent`：Pi 模型、认证、skills、packages 与 Conversations；
- `data/workspaces`：Workspace、工作项、知识库、回收站与 Git 工作副本；
- `data/ssh`：只读 SSH 配置与私钥。

容器以 UID 1000 的非 root 用户运行，应用根文件系统只读，只挂载上面列出的数据目录。删除容器或重新构建镜像不会删除持久化数据。

## 更新与备份

```bash
git pull
docker compose up -d --build
tar -czf pi-workspace-backup.tgz data/pi-agent data/workspaces
```

备份包含模型认证信息和可能的仓库凭据，必须按敏感数据保管。
