# Linux 中“分区”和“不分区”的区别

这篇说明用你当前的 Minecraft 云盘场景来解释：为什么旧盘在 ECS 上可以挂载到 `/data`，但在 ECI 中会出现 `wrong fs type, bad superblock`。

## 1. 块设备、分区、文件系统分别是什么

Linux 看到一块云盘时，首先看到的是一个“块设备”。例如：

```text
/dev/vdb
/dev/nvme1n3
```

块设备只是代表一整块磁盘。它本身不一定能直接存文件。要存文件，通常还需要文件系统，例如 `ext4`、`xfs`。

常见结构有两种。

第一种是“有分区”：

```text
/dev/nvme1n3      整块磁盘
└─/dev/nvme1n3p1  第一个分区，里面是 ext4 文件系统
```

这时真正能挂载的是分区：

```bash
mount /dev/nvme1n3p1 /data
```

第二种是“不分区，整盘直接做文件系统”：

```text
/dev/vdb          整块磁盘，同时也是 ext4 文件系统
```

这时可以直接挂载整块盘：

```bash
mount /dev/vdb /data
```

## 2. 有分区的磁盘是什么样

有分区的磁盘会先在磁盘开头写入一份分区表，例如 MBR 或 GPT。分区表记录：

- 这块盘上有几个分区。
- 每个分区从哪里开始。
- 每个分区到哪里结束。
- 每个分区的类型信息。

文件系统不是直接从整块盘开头开始，而是在某个分区里面。例如：

```text
整块盘 /dev/nvme1n3

+----------------+-------------------------------+
| 分区表          | 分区 /dev/nvme1n3p1            |
| MBR 或 GPT      | ext4 文件系统和真实文件数据     |
+----------------+-------------------------------+
```

所以如果对整块盘执行：

```bash
mount -t ext4 /dev/nvme1n3 /data
```

Linux 会从整块盘开头寻找 ext4 的 superblock。但整块盘开头是分区表，不是 ext4 文件系统，因此会失败。

正确挂载方式是：

```bash
mount -t ext4 /dev/nvme1n3p1 /data
```

你的旧盘就是这种情况：

```text
/dev/nvme1n3p1
14.9 GiB
ext4
/data
```

这说明 ext4 文件系统在 `p1` 分区里，而不是在整块盘 `/dev/nvme1n3` 上。

## 3. 不分区的磁盘是什么样

不分区的磁盘没有 MBR/GPT 分区表，直接把文件系统写在整块设备上。例如：

```bash
mkfs.ext4 /dev/vdb
```

磁盘结构类似：

```text
整块盘 /dev/vdb

+-----------------------------------------------+
| ext4 文件系统和真实文件数据                    |
+-----------------------------------------------+
```

这时挂载整块盘就是正确的：

```bash
mount -t ext4 /dev/vdb /data
```

很多容器平台或云厂商的自动挂载逻辑更喜欢这种形式，因为它只需要知道“挂载这块盘”，不需要再判断里面哪个分区才是目标文件系统。

## 4. 为什么 ECI 会挂载失败

你遇到的错误里有这一段：

```text
mount -t ext4 ... /dev/disk/by-id/virtio-... /var/lib/kubelet/.../mc-data
wrong fs type, bad option, bad superblock on /dev/vdb
```

含义是：

1. ECI 已经把云盘作为设备接到了宿主机上。
2. ECI 尝试把整块设备 `/dev/vdb` 当作 `ext4` 挂载。
3. 但这块盘真正的 ext4 在第一个分区里，相当于 `/dev/vdb1`。
4. ECI 没有去挂 `/dev/vdb1`，所以挂载失败。

这不是 Minecraft 数据损坏，也不是云盘一定坏了。它更像是“挂载目标选错层级”。

## 5. 为什么 ECS 能挂，ECI 不能直接挂

ECS 是完整虚拟机，你可以自己写挂载命令：

```bash
mount /dev/nvme1n3p1 /data
```

也可以在 `/etc/fstab` 里指定分区 UUID：

```text
UUID=xxxx-xxxx /data ext4 defaults 0 2
```

也就是说，ECS 允许你明确选择分区。

ECI 的云盘挂载是通过平台自动完成的。你传给它的是云盘 ID，例如：

```json
{"volumeId":"d-xxxxxxxx"}
```

ECI 平台拿到的是“整块云盘”，它的自动挂载流程通常会尝试挂载整块设备。对于已有分区表的旧盘，它未必会自动进入分区再挂 `/dev/vdb1`。

因此：

- ECS 更适合复用旧服务器迁下来的分区盘。
- ECI 更适合使用整盘直接格式化的新数据盘，或 NAS。

## 6. 如何查看一块盘是否有分区

使用：

```bash
lsblk -f
```

有分区的输出类似：

```text
NAME        FSTYPE MOUNTPOINT
nvme1n3
└─nvme1n3p1 ext4   /data
```

重点是：`FSTYPE` 出现在 `p1` 上，而不是整块盘上。

不分区的输出类似：

```text
NAME     FSTYPE MOUNTPOINT
nvme2n1  ext4   /mnt/newdata
```

重点是：`FSTYPE` 直接出现在整块盘上。

还可以用：

```bash
blkid
```

有分区时通常会看到：

```text
/dev/nvme1n3p1: UUID="..." TYPE="ext4"
```

不分区时通常会看到：

```text
/dev/nvme2n1: UUID="..." TYPE="ext4"
```

## 7. 两种方式的优缺点

有分区的优点：

- 更符合传统服务器磁盘管理习惯。
- 一块盘可以划分多个区域。
- 适合 ECS、物理机、长期运行的虚拟机。
- 扩容、迁移、修复时工具链成熟。

有分区的缺点：

- 自动化平台需要知道应该挂哪个分区。
- 对 ECI 这类容器实例自动挂云盘场景不够友好。
- 如果平台只挂整盘，就会出现 `wrong fs type`。

不分区的优点：

- 结构简单，整块盘就是一个文件系统。
- 很适合 ECI 这类“按云盘 ID 自动挂载”的场景。
- 挂载命令简单：`mount /dev/vdb /data`。
- 自动化脚本不需要处理 `/dev/vdb1`、`/dev/nvme1n1p1` 这类设备名差异。

不分区的缺点：

- 一块盘只能直接作为一个文件系统使用。
- 不适合需要多分区布局的场景。
- 对习惯传统磁盘分区管理的人来说不够直观。

## 8. 和当前项目的关系

当前项目的 ECI 配置会把云盘作为 `mc-data` 挂载到容器的 `/data`：

```text
云盘 ID -> ECI FlexVolume -> /data
```

ECI 期望这块盘可以被整盘挂载。如果你的盘是：

```text
/dev/vdb1 ext4
```

就容易失败。

更适合 ECI 的新盘应该是：

```text
/dev/vdb ext4
```

因此继续使用 ECI 的推荐迁移方式是：

1. 新建一块云盘。
2. 挂到临时 ECS。
3. 不创建分区，直接 `mkfs.ext4 /dev/新盘`。
4. 把旧 `/data/` 内容 `rsync` 到新盘。
5. 卸载新盘。
6. 在 `.env` 中把 `ALIYUN_DISK_ID` 改成新盘 ID。
7. 重新用 ECI 启动。

## 9. 重要警告

不要对旧盘执行：

```bash
mkfs.ext4 /dev/nvme1n3
mkfs.ext4 /dev/nvme1n3p1
```

`mkfs` 会创建新的空文件系统，等价于清空原有 Minecraft 世界数据。

如果要继续用 ECI，应只对“新建的空云盘”执行 `mkfs.ext4`，然后把旧盘数据复制过去。
