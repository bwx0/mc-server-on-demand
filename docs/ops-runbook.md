# Operations Runbook

## First Boot Checklist

1. Create or select the EIP used by `mc.dzxyim.top`.
2. Confirm the disk, EIP, vSwitch, security group, and runtime zone are in the same region.
3. Run `GET /api/preflight` from the web page before the first start.
4. Start with `IDLE_AUTO_STOP=false` so idle detection only alerts.
5. Verify a manual safe stop successfully saves the world before enabling automatic stop.

## Storage Validation

For ECI cloud-disk mode, use a data disk that ECI can mount directly. If the existing 40 GiB disk came from a Linux server and has a partition table, ECI may reject it. Prefer one of these paths:

- Copy `/data/mc` to a new unpartitioned disk that ECI mounts as `/data`.
- Use NAS if you want container recreation without disk attach constraints.
- Use ECS fallback if you must reuse the old partitioned disk.

Keep automatic snapshots enabled and take a manual snapshot before migration or changing runtime provider.

## Safe Stop Flow

The control plane safe stop performs:

1. RCON `say Server is stopping in 15 seconds. World will be saved.`
2. Wait 15 seconds.
3. RCON `save-all flush`.
4. RCON `stop`.
5. Wait `STOP_GRACE_SECONDS`.
6. Delete the ECI container group or ECS instance.

Use forced stop only when the Java process is already dead or RCON is broken and you accept the latest unsaved changes risk.

## Idle Alerts

The runtime monitor sends a heartbeat every 30 seconds. When `playerCount` remains zero for `IDLE_ALERT_MINUTES`, the control plane sends configured email/webhook alerts. Set `IDLE_AUTO_STOP=true` only after you trust the RCON stop flow.

## Manual Failure Handling

If `/data/server-init.sh` or `/data/mc` is missing, the runtime container intentionally stays alive. Inspect logs from Aliyun, fix the disk contents, then restart or force stop from the control page.

If EIP binding fails, check whether the EIP is still associated with another instance. The control plane state remains `failed` so you can retry after cleanup.

## Security Notes

- Use a RAM role/user with only the listed ECI, ECS, EIP, and disk permissions.
- Keep `CONTROL_TOKEN`, `RUNTIME_TOKEN`, and `MINECRAFT_RCON_PASSWORD` different.
- Do not expose RCON to the public internet. Restrict port `25575` to the VPS security group or private network where possible.
