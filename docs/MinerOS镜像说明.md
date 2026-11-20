# MinerOS 镜像说明（把系统装到 U 盘，像 Hive OS 一样用）

MinerOS 是给矿机用的 **Debian 12 定制 Linux**：U 盘/SSD 即插即跑、内置 NVIDIA 驱动与 Node.js、开机自动注册到本项目的控制台、屏幕显示状态、每 6 小时自动更新采集端。

> 它是本仓库的一部分，与 Windows 采集端共用同一套协议，矿机在控制台里"无差别"管理。

---

## 1. 它长什么样

```
U 盘（GPT + 混合启动）
├── ISO 9660 / El Torito 分区   ← MinerOS 主体（只读 squashfs，约 2.5 GB）
│   └── live/ filesystem.squashfs
├── EFI 分区（FAT32）            ← UEFI 启动
└── MINEROS-DATA（FAT32/ext4）   ← 可选：rig.conf / 离线采集端 / 矿工
                                   首次启动后挂载为 /data，保存配置与矿工
```

启动流程：

```
BIOS/UEFI → GRUB/ISOLINUX → live-boot 挂载 squashfs（overlay 可写）
  → mineros-firstboot.service
       ├─ 找 U 盘上的 rig.conf（SERVER_URL / RIG_NAME / RIG_PASSWD …）
       ├─ 写 /etc/mineros/agent.json
       ├─ 有 MINEROS-DATA 分区 → 挂 /data，配置/状态/矿工放这里（重刷镜像不丢）
       └─ 安装采集端（U 盘离线包 > 服务器下载）
  → mineros-agent.service      ← 采集端（systemd 守护，崩溃自动重启）
  → mineros-console.service    ← 本地 Web 控制台 :4000
  → mineros-panel.service      ← tty1 状态面板（IP / GPU / 矿工 / 日志）
  → mineros-update.timer       ← 每 6 小时检查采集端更新
```

---

## 2. 构建（一次性，Linux 环境）

ISO 必须在 Linux 下用 `live-build` 构建。三种方式：

### A. WSL2（Windows 最省事）

```powershell
# 管理员 PowerShell，一次性
wsl --install -d Ubuntu
# 进 Ubuntu 装依赖（一次）
sudo apt update && sudo apt install -y live-build debootstrap xorriso mtools dosfstools squashfs-tools \
  syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin rsync curl wget gnupg xz-utils zstd parted ca-certificates

# 构建（约 20-40 分钟，首次下载较多）
cd D:\ds WORK\web-miner-monitor
.\os\tools\build.ps1
```

### B. Docker（任意有 Docker 的系统）

```powershell
.\os\tools\build.ps1 -Docker
# 或 Linux/macOS：
bash os/build/build-docker.sh
```

### C. 原生 Debian/Ubuntu

```bash
sudo bash os/build/build.sh            # 完整构建
sudo bash os/build/build.sh --clean    # 清理后重建
sudo bash os/build/build.sh --no-iso   # 只构建 chroot（调试）
```

产物：

```
os/dist/mineros-1.0.0-amd64.iso
os/dist/mineros-1.0.0-amd64.iso.sha256
```

构建日志：`os/build/build.log`。

### 构建做了什么

| 阶段 | 内容 |
|---|---|
| `auto/config` | `lb config`：Debian 12 amd64、non-free 源、isolinux + grub-efi、xz 压缩、systemd |
| `package-lists/base` | 最小系统（systemd、网络、console、ssh 客户端） |
| `package-lists/firmware` | 常见网卡/无线固件（Realtek/Intel/BCM/Atheros） |
| `package-lists/mining` | NVIDIA 驱动、OpenCL、lm-sensors、内核与 headers |
| `hooks/0100-mineros-base` | 时区、用户（root/mineros，默认密码 `mineros`）、目录、SSH、NetworkManager、自动登录、sysctl、`mineros-status`、fstab 可写 tmpfs |
| `hooks/0150-nodejs` | 下载 Node.js v24 官方包并校验 sha256，装到 `/opt/mineros/node` |
| `hooks/0200-nvidia-dkms` | 对镜像内核预编译 NVIDIA DKMS 模块（失败不阻断，AMD 机器也能用） |
| `hooks/0300-finalize` | 权限、清缓存、版本文件、motd |
| `includes.chroot/` | 采集端代码（由 build.sh 拷入）、systemd 单元、首启/更新脚本、本地控制台、状态面板 |
| `verify-image.sh` | 构建后自检：启动结构、关键文件、systemd 单元、可执行位 |

---

## 3. 烧录到 U 盘（Windows）

管理员 PowerShell：

```powershell
# 1. 烧录 ISO（会清空 U 盘；16GB+ 推荐）
.\os\tools\flash-usb.ps1 -Iso .\os\dist\mineros-1.0.0-amd64.iso

# 2. 给这台矿机生成 rig.conf（在控制台也有了下载入口）
.\os\tools\make-rigconf.ps1 -Server http://192.168.1.10:8787 -RigName 机房A-01 -Out .\rig-A01.conf

# 3. 建数据分区 + 写 rig.conf + 可选离线采集端/矿工
.\os\tools\provision-usb.ps1 -DriveNumber 2 -RigConf .\rig-A01.conf `
    -Bundle .\os\dist\mineros-agent.tar.gz
```

也可以一步到位：

```powershell
.\os\tools\flash-usb.ps1 -Iso ...\mineros-1.0.0-amd64.iso -RigConf .\rig-A01.conf
```

Linux 烧录：

```bash
sudo dd if=os/dist/mineros-1.0.0-amd64.iso of=/dev/sdX bs=8M status=progress conv=fsync
```

### rig.conf 格式

```ini
SERVER_URL=http://192.168.1.10:8787
RIG_NAME=机房A-01
ALLOW_REBOOT=true
ALLOW_RUN=true
# 可选：带上密钥，矿机就绑定到指定记录（不带则自动注册）
RIG_PASSWD=rig_xxxxxxxx
RIG_ID=xxxxxxxx
```

- 放在 U 盘根目录即可；也可以放 `mineros/rig.conf`
- 控制台「系统镜像」页可以直接为每台矿机下载（含密钥）
- 不写 rig.conf 也能用：矿机自动注册，出现在「待分组」

---

## 4. 首次启动

1. 插 U 盘，BIOS 里设 USB 优先（或按 F12/F8 选启动项）
2. 等 30-60 秒，屏幕出现状态面板：

```
  ⛏  MinerOS  v1.1.0   矿机控制台
  ───────────────────────────────────────
  矿机名称  机房A-01
  服务器    http://192.168.1.10:8787   已注册
  IP 地址   192.168.1.123   本地控制台 http://192.168.1.123:4000
  ...
  GPU
  #0 NVIDIA GeForce RTX 4080   62°C  99%  160/250W  5200/12288 MB
  矿工
  ● 运行中  PID 1234  xmrig -o pool.supportxmr.com:3333 ...
```

3. 浏览器打开 `http://<矿机IP>:4000` 看本地面板；主要管理仍在服务器控制台
4. 在控制台「飞行表」给这台矿机分配配置，采集端会自动启动矿工

---

## 5. 本地控制台（:4000）

无显示器也能用手机/笔记本现场管理：

- 状态：主机名、服务器、注册状态、IP、CPU 温度、内存、磁盘、矿工 PID
- GPU 表：型号/温度/风扇/利用率/功耗/显存
- 网络：查看接口与可用 WiFi，**填写 SSID/密码直接连接**（NetworkManager）
- 操作：重启采集端、重启矿工、重启矿机、关机
- 采集端最近 30 行日志

> 无鉴权，仅限可信内网。公网环境请勿暴露 4000 端口。

---

## 6. 持久化与升级

| 目录 | 内容 | 持久化 |
|---|---|---|
| `/etc/mineros/agent.json` | 采集端配置 | 有数据分区 → `/data/etc`，否则 tmpfs（重启丢） |
| `/var/lib/mineros` | 采集端状态、矿工日志 | 有数据分区 → `/data/state` |
| `/opt/mineros/miners` | 矿工二进制 | 有数据分区 → `/data/miners` |
| `/opt/mineros/agent` | 采集端代码 | 镜像内（自动更新会覆盖） |

- **采集端自动更新**：`mineros-update.timer` 每 6 小时请求 `/api/os/manifest`，版本变化时下载并重启采集端
- **系统升级**：重新烧录新 ISO；配置/矿工在数据分区里会保留
- 克隆矿机：烧同一 ISO，把 `rig.conf` 里的 RIG_NAME 改掉即可（新机器自动注册）

---

## 7. 默认账号与安全

| 项 | 默认值 |
|---|---|
| root 密码 | `mineros`（**首次登录务必 `passwd` 修改**） |
| miner 用户 | `mineros`（sudo 组） |
| SSH | 22 端口，允许密码登录 |
| 本地控制台 | :4000，无鉴权 |
| 采集端 | root 运行（需要 nvidia-smi 调功耗/风扇） |

硬化建议：

1. 改 root 密码，或禁用 SSH 密码登录（放公钥到 `/root/.ssh/authorized_keys`）
2. 只在内网/ VPN 使用；不要在公网暴露 4000/22
3. 数据分区里不要放明文钱包私钥（本项目只存钱包地址）

---

## 8. 排错

| 现象 | 排查 |
|---|---|
| 开机黑屏/不进系统 | BIOS 关闭 Secure Boot（未签名内核模块）；确认 U 盘按 UEFI 或 Legacy 启动 |
| 卡在 `live-boot` | U 盘写入不完整 → 重新烧录并校验 sha256 |
| 屏幕出现 `MinerOS` 但无 IP | 网线/WiFi 未连；用 :4000 页面连 WiFi，或插网线 |
| 采集端未注册 | `journalctl -u mineros-firstboot`、`cat /var/log/mineros-firstboot.log`；服务器地址不对/防火墙挡 8787 |
| GPU 无数据 | `nvidia-smi` 是否可用；`dkms status` 看模块是否编译；`lsmod | grep nvidia` |
| 矿工不启动 | 控制台是否分配飞行表；`/opt/mineros/miners/<矿工>/<可执行文件>` 是否存在且有 `x` 权限 |
| 矿工日志 | `journalctl -u mineros-agent -f`、`/var/lib/mineros/logs/miner/miner.log` |
| 重启后配置丢失 | 没建数据分区（MINEROS-DATA）；运行 `provision-usb.ps1` 补上 |
| 想换服务器地址 | 改 U 盘 `rig.conf` 后重启，或 `nano /etc/mineros/agent.json` 后 `systemctl restart mineros-agent` |

---

## 9. 目录结构

```
os/
├── build/
│   ├── build.sh              # Linux 构建入口
│   ├── build-docker.sh       # Docker 构建
│   ├── verify-image.sh       # 镜像自检
│   └── cache/                # 可选：离线 Node / 矿工包
├── live-build/
│   ├── auto/config           # lb config 参数
│   └── config/
│       ├── common, mineros   # 镜像变量
│       ├── package-lists/    # 包清单
│       ├── hooks/            # chroot 构建钩子
│       └── includes.chroot/  # 直接打进镜像的文件
│           ├── etc/systemd/system/mineros-*.service
│           ├── etc/mineros/         # 运行时配置目录
│           ├── usr/local/bin/       # 首启 / 更新 / 状态脚本
│           └── opt/mineros/         # 采集端 + 本地控制台 + 状态面板 + Node
└── tools/
    ├── build.ps1             # Windows 构建入口（WSL2/Docker）
    ├── flash-usb.ps1         # 烧录 U 盘
    ├── make-rigconf.ps1      # 生成 rig.conf
    └── provision-usb.ps1     # 数据分区 + 离线包
```

---

## 10. 已知限制

- **Secure Boot**：NVIDIA 闭源模块未签名，需在 BIOS 关闭 Secure Boot
- **镜像未签名**：内网自用；对外分发请自行签名并校验 sha256
- **NVIDIA 驱动版本**：随 Debian 12 的 `nvidia-driver`（约 535 系）；非常新的 50 系卡可能需要换源或手动装 NVIDIA 官方驱动
- **AMD**：镜像能跑，但温度/功耗依赖矿工 API（PeakMiner 等），系统层只有 amdgpu 的 sysfs 读数
- **首次构建**需要下载约 1.5-2 GB 包，耗时取决于网络
- 本项目在 Windows 上开发，ISO 构建与真实启动需要 Linux 环境；`tests/os-verify.mjs` 用模拟 `/proc`、`/sys` 覆盖了采集端逻辑与构建配置的静态检查

## 11. 实际构建记录（2026-11-20 已验证）
本次已在本机 WSL2 中真实构建并验证过，命令如下（可复现）：

```bash
# 1) 建 Debian 12 chroot（一次）
sudo debootstrap --variant=minbase --include=ca-certificates,curl,gnupg,xz-utils \
  bookworm /root/mineros-bookworm http://deb.debian.org/debian/
sudo chroot /root/mineros-bookworm /bin/bash -c \
  'apt-get update && apt-get install -y live-build debootstrap xorriso mtools dosfstools squashfs-tools syslinux syslinux-common isolinux grub-pc-bin grub-efi-amd64-bin rsync curl wget gnupg xz-utils zstd parted ca-certificates'

# 2) 预下载 Node（构建钩子会用）
mkdir -p os/build/cache
curl -L -o os/build/cache/node-v24.11.0-linux-x64.tar.xz \
  https://nodejs.org/dist/v24.11.0/node-v24.11.0-linux-x64.tar.xz

# 3) chroot 内构建（项目拷到 /build/mineros）
sudo chroot /root/mineros-bookworm /bin/bash -lc \
  'cd /build/mineros && bash os/build/build.sh'

# 4) 后处理（把 Node / systemd 使能 / 用户等定制真正写进 squashfs，再重打包 ISO）
sudo bash os/build/postprocess-iso.sh \
  os/dist/mineros-1.0.0-amd64.iso os/dist/mineros-1.0.0-amd64.iso
```

> 为什么需要 postprocess：live-build 4.x 在 Debian 12 下对 `config/hooks/*.hook.chroot` 的处理不可靠（部分阶段被跳过），
> 于是把「安装 Node、创建用户、启用 systemd 单元、写网络/时区」这些动作做成对 squashfs 的确定性后处理，
> 保证每次产出的镜像内容一致。

### 当前镜像（2026-11-20 18:23 重建）

| 项目 | 值 |
| --- | --- |
| 文件 | `os/dist/mineros-1.0.0-amd64.iso`（1.28 GB） |
| SHA256 | `8c86af156fb50bb409f8c9972fd5725df39185643478b9753888dd805deb509f` |
| 采集端 | v1.2.0（内置 `updater.js`，支持在线升级） |
| 内核 | 6.1.0-50-amd64 + NVIDIA 535.261.03（DKMS 预编译） |
| 实测 | QEMU UEFI+KVM 启动 → 自动注册上线（agent 1.2.0、osImage MinerOS 1.0.0） |

> 镜像里的采集端已带在线升级模块，烧好 U 盘后就可以在控制台里给矿机推送采集端/挖矿程序/系统组件的更新，
> 不用为了升级再重刷 U 盘。详见 [在线升级与币种扩展.md](在线升级与币种扩展.md)。

### 启动验证（QEMU UEFI + KVM）

```bash
qemu-system-x86_64 -enable-kvm -cpu host -smp 2 -m 4096 \
  -kernel /root/vmlinuz -initrd /root/initrd.img \
  -append "boot=live components console=ttyS0,115200n8 noeject noprompt persistence=none" \
  -drive file=os/dist/mineros-1.0.0-amd64.iso,format=raw,if=virtio,readonly=on \
  -drive file=rig.img,format=raw,if=virtio \
  -netdev user,id=net0 -device virtio-net-pci,netdev=net0 \
  -display none -serial file:serial.log
```

实测结果：

- `multi-user.target` 正常到达，`mineros-firstboot` / `mineros-agent` / `mineros-console` / `mineros-panel` 全部启动，无失败单元
- 通过 U 盘 `rig.conf`（预置 `RIG_ID` + `RIG_PASSWD`）启动后，矿机在控制台 **自动上线**（`agent 1.1.0`、OS 显示 `MinerOS 1.0.0`、IP `10.0.2.15`）
- 未连接 NVIDIA 时 `nvidia-persistenced` 会自动跳过（ConditionPathExistsGlob），不再报错
- 产物：`os/dist/mineros-1.0.0-amd64.iso`（约 1.25 GB，sha256 见同目录 `.sha256`）

`os/build/postprocess-iso.sh` 会打印每个关键文件的校验结果（agent / Node / 工具 / 单元文件），
构建脚本 `build.sh` 本身也带镜像自检（`verify-image.sh`）。
