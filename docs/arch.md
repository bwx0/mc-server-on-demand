# 按需 Minecraft Server 控制面 — 系统架构

```mermaid
flowchart TB

  subgraph vps["AWS 常驻 VPS"]
    CP["控制面\nNode.js API + Web UI"]
    Nginx["Nginx 反代"]
  end
  subgraph clients["终端"]
    Player["玩家\n（Minecraft Java 客户端）"]
    Browser["控制面板页面\n（浏览器）"]
  end

  subgraph aliyun["阿里云"]
    subgraph observability["可观测"]
      PGW["Prometheus Pushgateway"]
      Prom["托管 Prometheus"]
    end

    POP["OpenAPI\nECI / ECS / EIP / 块存储等"]

    subgraph compute["按需游戏运行时"]
      ECI["ECI 容器组"]
    end

    ACR["容器镜像服务 ACR"]
    EIP["弹性公网 EIP\n玩家连接入口"]
    Storage["ECS 块存储\n（游戏存档）"]
  end

  Browser --> Nginx
  Nginx --> CP
  CP -->|"RAM AK 调用生命周期"| POP

  Player -->|"TCP 25565"| EIP
  EIP --> ECI

  POP --> ECI

  ECI -->|"镜像拉取"| ACR

  ECI --> Storage

  CP -.->|"RCON 优雅关停"| EIP

  ECI -.->|"心跳、状态"| CP

  ECI -->|"PROM_PUSHGATEWAY_URL\n指标推送"| PGW
  PGW --> Prom
  CP -->|"PROM_HTTP_API"| Prom
```

## 图例说明

- **控制面（VPS）**：常驻进程，通过 OpenAPI 创建/删除 ECI 或 ECS，读状态、预检；浏览器经 Token 访问 API/UI。
- **按需计算**：默认 **ECI** 起容器；**ECS** 为云盘分区等场景的备选。
- **ACR**：运行时镜像仓库；ECI/ECS 启动时拉取 `RUNTIME_IMAGE`。
- **EIP + 存储**：EIP 绑定到运行时供玩家域名解析；云盘/NAS 挂载为 `/data` 持久化。
- **Pushgateway + Prometheus**：容器内监控进程推送指标到 Pushgateway；托管 Prometheus 汇聚后，由**控制面服务端**拉查询 API 画图，浏览器不持有云监控 AK。
