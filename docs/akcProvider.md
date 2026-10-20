# 智核AI超市 MiniMax H3

供应商 `akc` 已接入 Toonflow 媒体模型。设置 → 媒体模型 → 智核AI超市 → 编辑模型，填写该站 API Key 并保存。随后在视频生成节点选择「智核AI超市 / MiniMax H3」。

按 [站点文档](https://akc.kk0606.com/apidoc#model/minimax-h3) 的 MiniMax V2 格式调用：

- 默认 API 地址：`https://api.lk888.ai`，由公开文档配置接口返回。
- 提交：`POST /v2/video_generation`，模型 ID `MiniMax-H3`。
- 轮询：`GET /v2/query/video_generation/{task_id}`，每 5 秒查询一次，最多等待 30 分钟。
- 成功后取 `task.content.url`，由 Toonflow 原有下载流程保存到工作区。
- 文生、首帧/首尾帧、最多 9 张图片与 3 段音频参考；时长 4～15 秒，768P / 1080P / 2K / 4K，有声视频。
- 本地视频参考暂未开放：站点只接受公网视频 URL，而当前画布向供应商传入本地文件内容。

创建任务会计费；不自动重复提交。停止本地等待不能取消上游已创建任务，查询失败会保留任务 ID，重试前先到网站检查结果。

2026-10-20：供应商类型检查、完整服务端构建、宿主源码校验、供应商安装与模型列表查询已通过；无密钥查询端点返回预期的 HTTP 401。用户选择稍后自行填写 Key，因此尚未验证鉴权后的提交、轮询和真实出片。
