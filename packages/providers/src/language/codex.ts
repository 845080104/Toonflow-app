const rules = [{
  type: "input", field: "apiKey" as const, title: "本地连接凭证", value: "",
  props: { type: "password", showPassword: true, autocomplete: "off" },
}];

export default {
  id: "codex" as const,
  label: "Codex · 本机",
  icon: "",
  version: "0.1.0",
  apiUrl: "http://127.0.0.1:4319/v1",
  protocol: "openai-completions",
  readme: "通过本机 Codex 登录状态生成剧本和分镜。使用 `bun run start:codex` 启动时自动配置；无需另填 OpenAI API Key。模型调用使用当前 Codex 账号额度。",
  rules,
  models: [{ id: "gpt-6.1-sol", label: "Codex · GPT-6.1 Sol", type: "text" }],
} satisfies ProviderDefinition<typeof rules>;
