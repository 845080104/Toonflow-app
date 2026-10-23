<template>
  <el-card class="questionCard" shadow="never" @keydown.stop @keyup.stop>
    <div class="questionHeader">
      <icon-message-question :size="18" />
      <span class="questionTitle">{{ title }}</span>
      <el-tag size="small" :type="answer && !skipped ? 'success' : 'info'">{{ statusText }}</el-tag>
    </div>
    <template v-if="tool.status === 'error'">
      <p class="questionText">表单暂时未生成，请 AI 重新整理。</p>
      <details v-if="tool.result" class="errorDetails">
        <summary>查看错误详情</summary>
        <pre class="errorText">{{ tool.result }}</pre>
      </details>
    </template>
    <p v-else-if="question" class="questionText">{{ question }}</p>
    <template v-if="waiting">
      <form-create v-if="formRules.length" v-model="formValues" v-model:api="formApi" :rule="formRules" :option="formOptions" />
      <template v-else>
        <el-radio-group v-if="options.length" v-model="selected" class="questionOptions" :disabled="submitting" :aria-label="question">
          <el-radio v-for="option in options" :key="option" :value="option" border>{{ option }}</el-radio>
          <el-radio value="" border>自行填写</el-radio>
        </el-radio-group>
        <el-input
          v-model="text"
          type="textarea"
          :autosize="{ minRows: 2, maxRows: 6 }"
          :disabled="submitting"
          :maxlength="8000"
          :placeholder="options.length ? '也可以直接回答或补充说明' : '输入你的回答'"
          aria-label="回答问题" />
        <el-text v-if="draftAnswer.length > 8000" type="danger">回答（含选项）不能超过 8000 字</el-text>
      </template>
      <div class="questionActions">
        <el-button type="primary" :loading="submitting" :disabled="(!toolSessionId && !directory) || (formRules.length ? !formApi : !draftAnswer || draftAnswer.length > 8000)" @click="submitAnswer(false)">
          提交回答
        </el-button>
        <el-button :disabled="(!toolSessionId && !directory) || submitting" @click="submitAnswer(true)">跳过</el-button>
      </div>
    </template>
    <p v-else-if="answer" class="answerText">{{ answer }}</p>
    <div v-if="approvalKey" class="automaticApproval">
      <el-checkbox v-model="autoApprove" :disabled="submitting">本会话自动批准并继续</el-checkbox>
      <el-text size="small" type="info">勾选立即生效，本会话后续确认自动同意，可能持续消耗算力。刷新或重开仍保留，直到手动关闭。</el-text>
      <el-text v-if="waiting && autoApprove && automaticPlan.reason" size="small" type="warning">{{ automaticPlan.reason }}；自动批准保持开启。</el-text>
    </div>
  </el-card>
</template>

<script lang="ts">
import { computed, ref, shallowRef, watch } from "vue";
import axios from "axios";
import formCreate, { type Api, type Options, type Rule } from "@form-create/element-ui";
import {
  ElCard, ElTag, ElButton, ElText,
  ElMessage, ElForm, ElFormItem, ElRow, ElCol,
  ElInput, ElInputNumber, ElSwitch, ElSelect,
  ElOption, ElCheckbox, ElCheckboxGroup, ElRadio, ElRadioGroup,
} from "element-plus";
import "element-plus/es/components/base/style/css";
import "element-plus/es/components/card/style/css";
import "element-plus/es/components/tag/style/css";
import "element-plus/es/components/button/style/css";
import "element-plus/es/components/text/style/css";
import "element-plus/es/components/form/style/css";
import "element-plus/es/components/form-item/style/css";
import "element-plus/es/components/row/style/css";
import "element-plus/es/components/col/style/css";
import "element-plus/es/components/input/style/css";
import "element-plus/es/components/input-number/style/css";
import "element-plus/es/components/switch/style/css";
import "element-plus/es/components/select/style/css";
import "element-plus/es/components/option/style/css";
import "element-plus/es/components/checkbox/style/css";
import "element-plus/es/components/checkbox-group/style/css";
import "element-plus/es/components/radio/style/css";
import "element-plus/es/components/radio-group/style/css";
import { IconMessageQuestion } from "@tabler/icons-vue";
import type { QuestionAnswer, QuestionRequest, ToolCall } from "@toonflow/tools-scaffold/runtime";

type AutomaticAnswer = Pick<QuestionAnswer, "values"> & { answer?: string };
// ACT: 只保存当前浏览器的会话开关，不再按题目、表单或选项记忆答案。
const automaticApprovalStorageKey = "toonflow.askUser.conversationApproval.v2";
const automaticApprovals = ref(new Set<string>());
const automaticallySubmitted = new Set<string>();

function confirmationOption(options: string[]): string | undefined {
  // ACT: 只识别唯一的明确同意/继续选项；模型、风格等实际选择仍需用户提供信息。
  const matches = options.filter(option => {
    const value = option.trim().replace(/^[A-Z][.、:：)）]\s*/i, "");
    return !/^(不|暂不|否|取消|拒绝|停止|暂停|稍后|返回|修改|调整|重做|自行)/.test(value)
      && /^(同意|确认|批准|通过|审阅通过|继续|开始|生成|采用|按.{0,20}(方案|计划|提示词|分镜|默认)|直接|使用默认|无需修改|无须修改|没问题|可以|好的|是(?:的|[，,。！!]|$)|yes\b|approve\b|confirm\b|continue\b|proceed\b)/i.test(value);
  });
  return matches.length === 1 ? matches[0] : undefined;
}

function planAutomaticAnswer(request: QuestionRequest, current: Record<string, unknown>, draft: string): { response?: AutomaticAnswer; reason?: string } {
  if (draft.trim()) return { reason: "你已填写回答，请手动提交" };
  if (!request.fields?.length) {
    const option = confirmationOption(request.options ?? []);
    return option ? { response: { answer: option } } : { reason: "此处需要填写信息或作出具体选择，请手动回答" };
  }
  const values: NonNullable<QuestionAnswer["values"]> = {};
  for (const field of request.fields) {
    const value = current[field.field];
    if (value != null && value !== false && !(typeof value === "string" && !value.trim()) && !(Array.isArray(value) && !value.length)) {
      return { reason: "你已填写回答，请手动提交" };
    }
    if (["radio", "select", "checkbox"].includes(field.type)) {
      const option = confirmationOption(field.options ?? []);
      if (!option) return { reason: `“${field.title}”需要你作出具体选择` };
      values[field.field] = field.type === "checkbox" ? [option] : option;
    } else if (field.type === "switch" && confirmationOption([field.title])) {
      values[field.field] = true;
    } else if (field.required) {
      return { reason: `需要填写“${field.title}”` };
    }
  }
  return Object.keys(values).length ? { response: { values } } : { reason: "此处需要你提供信息，请手动回答" };
}

function readAutomaticApprovals(raw: string | null): Set<string> {
  const entries: unknown = JSON.parse(raw ?? "[]");
  if (!Array.isArray(entries)) throw new Error("自动批准设置格式错误");
  return new Set(entries.filter((key): key is string => typeof key === "string" && !!key));
}

function loadAutomaticApprovals(): Set<string> {
  const stored = window.localStorage.getItem(automaticApprovalStorageKey);
  if (stored !== null) return readAutomaticApprovals(stored);
  const approvals = new Set<string>();
  const legacy: unknown = JSON.parse(window.localStorage.getItem("toonflow.askUser.automaticAnswers.v1") ?? "[]");
  // ACT: 迁移旧版已记住的同意选项；新版即使为空也优先，关闭后不再被旧记录重新开启。
  if (Array.isArray(legacy)) for (const entry of legacy) {
    if (!Array.isArray(entry) || typeof entry[0] !== "string") continue;
    try {
      const scope: unknown = JSON.parse(entry[0]);
      const value = entry[1];
      const answers: unknown[] = value?.values ? Object.values(value.values) : [value?.answer];
      if (Array.isArray(scope) && typeof scope[1] === "string" && scope[1]
        && answers.some(answer => typeof answer === "string" && confirmationOption([answer]))) {
        approvals.add(JSON.stringify(scope.slice(0, 2)));
      }
    } catch { /* 忽略单条损坏的旧记录，保留其他会话设置。 */ }
  }
  window.localStorage.setItem(automaticApprovalStorageKey, JSON.stringify([...approvals]));
  return approvals;
}

function saveAutomaticApproval(key: string, enabled: boolean) {
  try {
    const approvals = loadAutomaticApprovals();
    if (enabled) approvals.add(key);
    else approvals.delete(key);
    window.localStorage.setItem(automaticApprovalStorageKey, JSON.stringify([...approvals]));
    automaticApprovals.value = approvals;
  } catch {
    ElMessage.error("自动批准设置保存失败，请检查浏览器是否允许本地存储后重试");
  }
}

try {
  automaticApprovals.value = loadAutomaticApprovals();
} catch {
  ElMessage.error("无法读取自动批准设置，请检查浏览器本地存储");
}
window.addEventListener("storage", event => {
  if (event.key !== automaticApprovalStorageKey && event.key !== null) return;
  try {
    automaticApprovals.value = readAutomaticApprovals(window.localStorage.getItem(automaticApprovalStorageKey));
  } catch {
    ElMessage.error("无法读取自动批准设置，请检查浏览器本地存储");
  }
});

for (const component of [
  ElForm, ElFormItem, ElRow, ElCol, ElInput, ElInputNumber, ElSwitch,
  ElSelect, ElOption, ElCheckbox, ElCheckboxGroup, ElRadio, ElRadioGroup,
]) formCreate.component(component);
</script>

<script setup lang="ts">
const props = defineProps<{ tool: ToolCall; directory?: string; toolSessionId?: string; conversationId?: string }>();
const title = computed(() => props.tool.question?.title || (typeof props.tool.args?.title === "string" ? props.tool.args.title.trim() : "") || "请确认");
const selected = ref("");
const text = ref("");
const submitting = ref(false);
const submittedAnswer = ref("");
const submittedSkipped = ref(false);
const submittedAutomatically = ref(false);
const formApi = shallowRef<Api>();
const formValues = ref<Record<string, unknown>>({});
const formOptions = computed<Options>(() => ({ form: { labelPosition: "top", disabled: submitting.value }, submitBtn: false, resetBtn: false }));
const formRules = computed<Rule[]>(() => (props.tool.question?.fields ?? []).map(field => ({
  type: field.type === "textarea" ? "input" : field.type,
  field: field.field,
  title: field.title,
  value: field.type === "checkbox" ? [] : field.type === "switch" ? false : field.type === "inputNumber" ? undefined : "",
  props: {
    placeholder: field.placeholder,
    ...(field.type === "textarea" ? { type: "textarea", autosize: { minRows: 2, maxRows: 6 } } : {}),
    ...(["input", "textarea"].includes(field.type) ? { maxlength: 8000 } : {}),
    ...(field.type === "select" ? { clearable: true } : {}),
  },
  options: field.options?.map(value => ({ label: value, value })),
  validate: field.required ? [{
    required: true,
    type: field.type === "checkbox" ? "array" : field.type === "inputNumber" ? "number" : field.type === "switch" ? "boolean" : "string",
    message: `请填写${field.title}`,
    ...(field.type === "checkbox" ? { min: 1 } : {}),
    ...(["input", "textarea"].includes(field.type) ? { whitespace: true } : {}),
  }] : [],
})));
const question = computed(() => props.tool.question?.question ?? (typeof props.tool.args?.question === "string" ? props.tool.args.question : ""));
const options = computed(() => {
  const values = props.tool.question?.options ?? props.tool.args?.options;
  return Array.isArray(values) ? [...new Set(values.filter((value): value is string => typeof value === "string" && value.trim().length > 0))] : [];
});
const toolResult = computed(() => {
  if (props.tool.status !== "success" || !props.tool.result) return;
  try {
    return JSON.parse(props.tool.result) as { answer?: unknown; skipped?: boolean; autoApproved?: boolean };
  } catch { return; }
});
const skipped = computed(() => submittedSkipped.value || toolResult.value?.skipped === true);
const answer = computed(() => {
  if (submittedAnswer.value) return submittedAnswer.value;
  if (props.tool.status !== "success") return "";
  return typeof toolResult.value?.answer === "string" ? toolResult.value.answer : props.tool.result ?? "";
});
const waiting = computed(() => props.tool.status === "running" && !!props.tool.question?.callId && !answer.value);
const draftAnswer = computed(() => [selected.value, text.value.trim()].filter(Boolean).join("\n"));
const approvalKey = computed(() => {
  const scope = props.toolSessionId || props.conversationId;
  return scope ? JSON.stringify([props.directory, scope]) : "";
});
const autoApprove = computed({
  get: () => automaticApprovals.value.has(approvalKey.value),
  set: (value: boolean) => { if (approvalKey.value) saveAutomaticApproval(approvalKey.value, value); },
});
const automaticPlan = computed(() => planAutomaticAnswer({
  title: title.value,
  question: question.value,
  options: options.value,
  fields: props.tool.question?.fields,
}, formValues.value, draftAnswer.value));
const statusText = computed(() => {
  if (props.tool.status === "error") return "待重新生成";
  if (skipped.value) return "已跳过";
  if (answer.value) return submittedAutomatically.value || toolResult.value?.autoApproved ? "已自动批准" : "已回答";
  if (props.tool.status === "interrupted") return "已停止";
  return waiting.value ? "等待回答" : "提问记录";
});

async function submitAnswer(skip: boolean, automatic = false) {
  const callId = props.tool.question?.callId;
  const value = draftAnswer.value;
  if (!waiting.value || submitting.value || (!props.toolSessionId && !props.directory) || !callId) return;
  if (!skip && !automatic && !formRules.value.length && (!value || value.length > 8000)) return;
  const preset = automaticPlan.value.response;
  if (automatic && (!autoApprove.value || !preset)) return;
  submitting.value = true;
  try {
    if (!skip && !automatic && formRules.value.length && !(await formApi.value?.validate().catch(() => false))) return;
    const values = !skip && !automatic && formRules.value.length ? formApi.value!.formData() : undefined;
    const response = await axios.post(props.toolSessionId ? "/api/singleAgent/answer" : "/api/agent/answer", {
      ...(props.toolSessionId ? { sessionId: props.toolSessionId } : { directory: props.directory }),
      callId,
      ...(skip ? { skipped: true } : automatic ? { ...preset, autoApproved: true } : formRules.value.length ? { values } : { answer: value }),
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (response.data.code !== 200) throw new Error(response.data.message || "提交回答失败");
    submittedAnswer.value = response.data.data.answer;
    submittedSkipped.value = response.data.data.skipped === true;
    submittedAutomatically.value = automatic;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message : undefined;
    ElMessage.error(message || (error instanceof Error ? error.message : "提交回答失败"));
  } finally {
    submitting.value = false;
  }
}

watch([waiting, autoApprove, automaticPlan], () => {
  const callId = props.tool.question?.callId;
  if (!waiting.value || !autoApprove.value || !automaticPlan.value.response || !callId || automaticallySubmitted.has(callId)) return;
  automaticallySubmitted.add(callId);
  void submitAnswer(false, true);
}, { immediate: true, flush: "post" });
</script>

<style scoped lang="scss">
.questionCard {
  .automaticApproval {
    display: flex;
    flex-direction: column;
    align-items: flex-start;
    gap: 4px;
    margin-top: 12px;

    :deep(.el-checkbox__label) { white-space: normal; }
  }
  .questionHeader {
    display: flex;
    align-items: center;
    gap: 8px;

    .questionTitle {
      min-width: 0;
      overflow-wrap: anywhere;
    }

    .el-tag {
      margin-left: auto;
      flex-shrink: 0;
    }
  }

  .questionText,
  .answerText,
  .errorText {
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }

  .errorDetails {
    color: var(--el-text-color-secondary);
    font-size: 12px;

    summary {
      cursor: pointer;
    }

    .errorText {
      max-height: 240px;
      margin-bottom: 0;
      overflow: auto;
      font-family: var(--el-font-family);
    }
  }

  .questionOptions {
    display: flex;
    flex-direction: column;
    align-items: stretch;
    gap: 8px;
    margin-bottom: 12px;

    .el-radio {
      width: 100%;
      height: auto;
      margin: 0;
      padding: 8px 12px;

      :deep(.el-radio__label) {
        white-space: normal;
        overflow-wrap: anywhere;
      }
    }
  }

  .questionActions {
    display: flex;
    align-items: center;
    gap: 12px;
    margin-top: 12px;

    .el-button {
      margin: 0;
    }
  }
}
</style>
