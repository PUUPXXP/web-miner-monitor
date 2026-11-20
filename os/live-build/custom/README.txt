#!/bin/sh
# ============================================================
# 自定义 live-build 配置文件（由 build.sh 在 lb config 之后覆盖）
# 这些文件不能直接放在 config/ 里，否则 lb config 会重置它们。
# 用法：build.sh 会把本目录内容 rsync 到 $WORK/config/
#
# 目录结构：
#   overlay/          覆盖到 config/ 的文件（package-lists、hooks、includes.chroot、common、mineros）
#   auto-config.sh    lb config 参数脚本（放在 build/ 下调用）
# ============================================================
