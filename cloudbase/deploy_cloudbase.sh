#!/usr/bin/env bash
# YIHOT 后端部署到腾讯云开发 CloudBase（需先：npm i -g @cloudbase/cli && tcb login）
# 用法：
#   ENV_ID=你的环境ID ./cloudbase/deploy_cloudbase.sh
set -e
ENV_ID="${ENV_ID:?请先设置 ENV_ID（云开发环境 ID，形如 cris-1gabcde1234）}"
FUNC=yihotApi
ROOT="$(cd "$(dirname "$0")" && pwd)"

echo "==> 0/2 检查源配置"
if [ ! -f "$ROOT/yihotApi/feeds.json" ]; then
  echo "!! 缺少 $ROOT/yihotApi/feeds.json（云端源清单，不进 Git）。"
  echo "!! 请参照 DEPLOY.md 的『源清单』一节重建后再部署。"
  exit 1
fi

echo "==> 1/2 部署云函数 $FUNC -> 环境 $ENV_ID（事件函数模式，勿加 --httpFn）"
(cd "$ROOT" && tcb fn deploy "$FUNC" --force --env-id "$ENV_ID")

echo "==> 2/2 完成"
echo "请在 CloudBase 控制台完成三件事："
echo "  1) 云函数 $FUNC -> 配置 -> 执行超时时间改为 60 秒、内存 256MB"
echo "  2) 云函数 $FUNC -> 环境变量："
echo "       YIHOT_TRANSLATE_BASE_URL = https://api.moonshot.cn/v1"
echo "       YIHOT_TRANSLATE_API_KEY  = 你的密钥（不要写进代码或提交到 Git）"
echo "       YIHOT_TRANSLATE_MODEL    = moonshot-v1-8k"
echo "  3) 创建【HTTP 触发】（触发路径 /），或使用【云接入】把路由（如 /yihotApi）指向此函数，"
echo "     并在跨域白名单加入：https://cochranek.github.io"
echo ""
echo "部署后前端 app.js 里的 YIHOT_API_BASE 应设为（地域后缀按控制台实际域名调整）："
echo "    https://$ENV_ID.ap-shanghai.app.tcloudbase.com/$FUNC"
