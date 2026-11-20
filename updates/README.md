# 升级包目录

把升级包放在这里，或在控制台「在线升级中心 → 上传升级包」上传。

结构：
  updates/agent/<version>/           采集端（包内含 agent/ 与 shared/）
  updates/miner/<minerId>/<version>/ 挖矿程序（包内含可执行文件）
  updates/system/<component>/<version>/ 系统组件（包内含 install.sh / install.ps1）

每个版本目录里放一个 manifest.json（可选，缺省会用目录名推断）：
{ "version": "1.0.0", "platform": "win32|linux|any", "sha256": "...", "entry": "xmrig.exe", "notes": "..." }

生成升级包：
  node scripts/make-update-package.js --id xmrig --version 6.26.0 --platform win32 --dir C:\miners\xmrig-6.26
