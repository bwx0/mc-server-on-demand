# Minecraft On-Demand Control Plane

This project runs a small web control plane on a low-cost VPS and creates a high-spec Aliyun runtime only when friends want to play Minecraft Java.

## What It Does

- Shows server status at `mcc.dzxyim.top`.
- Starts an Aliyun ECI runtime by default: 8 vCPU, 16 GiB memory, existing EIP, persistent `/data` volume.
- Provides an ECS fallback path for disks that cannot be mounted by ECI.
- Stops safely through Minecraft RCON: announce, `save-all flush`, `stop`, then release the cloud runtime.
- Accepts runtime heartbeats with player list, memory, load average, and disk usage.
- Sends email or webhook alert when zero players remain online for `IDLE_ALERT_MINUTES`, then safely stops after `IDLE_STOP_MINUTES` when `IDLE_AUTO_STOP=true`.

## Important Storage Decision

ECI cloud-disk mounting is strict:

- The disk must be in the same region and zone as the ECI instance.
- One disk can be mounted by only one runtime at a time.
- Do not let the disk be deleted with the runtime.
- ECI FlexVolume may not accept an existing disk with partitions.

If your migrated 40 GiB disk already has a partition table, set `STORAGE_DISK_HAS_PARTITION=true`. The preflight check will fail for ECI unless `ALLOW_ECI_PARTITIONED_DISK=true`. In that case, use one of these options:

- Migrate the Minecraft folder to a new unpartitioned cloud disk for ECI.
- Move the server folder to NAS and set `STORAGE_MODE=nas`.
- Use `RUNTIME_PROVIDER=ecs` with `ECS_FALLBACK_ENABLED=true`.

## Setup

1. Copy `.env.example` to `.env` on the VPS and fill in all Aliyun IDs.
2. Build and push the runtime image in `runtime/` to your Aliyun Container Registry.
3. Copy `runtime/server-init.sh` into the persistent disk at `/data/server-init.sh`.
4. Put your Minecraft server folder at `/data/mc`; the existing `/data/mc/run.sh` will be used if executable.
5. Enable RCON in `server.properties`, or let `server-init.sh` patch it from `MINECRAFT_RCON_PASSWORD`.
6. Start the control plane with `npm start`.

VPS deployment examples are in `deploy/mcc.service` and `deploy/nginx-mcc.conf`. A short Chinese deployment manual is available at `docs/deployment-guide.zh-CN.md`; operational procedures are in `docs/ops-runbook.md`.

For local testing, load the environment first:

```powershell
$env:ALIYUN_ACCESS_KEY_ID="..."
$env:ALIYUN_ACCESS_KEY_SECRET="..."
npm start
```

## API

- `GET /healthz` returns basic process health.
- `GET /api/status` returns local state and cloud runtime status.
- `GET /api/preflight` checks provider, disk, zone, and EIP settings.
- `POST /api/start` creates the runtime if stopped.
- `POST /api/stop` stops safely by default. Send `{ "force": true }` to release the runtime without RCON.
- `POST /api/runtime/heartbeat` is called by the runtime monitor with `x-runtime-token`.

Browser API calls require `x-control-token`. Use `ADMIN_TOKEN` to see full JSON details and run preflight checks. Use `USER_TOKEN` for normal start/stop/status access without the lower JSON details. `CONTROL_TOKEN` remains a backward-compatible admin token alias.

## DNS and Network

- Keep `mc.dzxyim.top` pointing at the existing EIP address.
- Point `mcc.dzxyim.top` at the low-cost VPS that runs this control plane.
- The security group must allow Minecraft TCP `25565` from players and RCON TCP `25575` only from the control plane if possible.

## RAM Permissions

Create a RAM user or RAM role with the smallest practical scope:

- ECI: `CreateContainerGroup`, `DescribeContainerGroups`, `DeleteContainerGroup`.
- ECS/EIP/disk preflight: `DescribeDisks`, `DescribeEipAddresses`.
- ECS fallback: `RunInstances`, `DescribeInstances`, `AttachDisk`, `AssociateEipAddress`, `UnassociateEipAddress`, `DeleteInstance`.

Restrict these permissions by region, resource group, and tags where possible.

## Operations

- Keep automatic snapshots for the persistent disk before enabling automatic shutdown.
- Use `IDLE_STOP_MINUTES=10` to control how long a running server may stay empty before safe auto-stop.
- Set `IDLE_AUTO_STOP=false` temporarily if you want empty-server detection to alert without stopping.
- If `/data/server-init.sh` is missing or not executable, the runtime container stays alive for manual inspection instead of deleting itself immediately.
