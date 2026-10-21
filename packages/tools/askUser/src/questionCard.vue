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
    <div v-if="approvalKey && (waiting || automaticAnswer)" class="automaticApproval">
      <el-checkbox v-model="autoApprove" :disabled="submitting">自动批准后续同类确认（本次对话）</el-checkbox>
      <el-text size="small" type="info">首次提交后记住选择，刷新或重开页面仍生效，直到手动关闭。可能持续消耗算力；含补充说明时请逐次确认。</el-text>
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
import type { ToolCall } from "@toonflow/tools-scaffold/runtime";

type AutomaticAnswer = { answer?: string; values?: Record<string, string> };
// ACT: 保存在当前浏览器、当前站点，按对话、表单结构和选项隔离；不保存 API Key，不跨浏览器同步。
const automaticAnswersStorageKey = "toonflow.askUser.automaticAnswers.v1";
const automaticAnswers = ref(new Map<string, AutomaticAnswer>());
const automaticallySubmitted = new Set<string>();

function readAutomaticAnswers(raw: string | null): Map<string, AutomaticAnswer> {
  const entries: unknown = JSON.parse(raw || "[]");
  if (!Array.isArray(entries)) throw new Error("自动批准设置格式错误");
  const answers = new Map<string, AutomaticAnswer>();
  for (const entry of entries) {
    if (!Array.isArray(entry) || entry.length !== 2 || typeof entry[0] !== "string" || !entry[0]) continue;
    const value = entry[1];
    if (!value || typeof value !== "object" || Array.isArray(value)) continue;
    if (typeof value.answer === "string" && value.answer.trim() && value.answer.length <= 8000) {
      answers.set(entry[0], { answer: value.answer });
    } else if (value.values && typeof value.values === "object" && !Array.isArray(value.values)) {
      const fields = Object.entries(value.values);
      if (fields.length === 1 && fields.every(([key, answer]) => key && typeof answer === "string" && answer.trim() && answer.length <= 8000)) {
        answers.set(entry[0], { values: Object.fromEntries(fields) as Record<string, string> });
      }
    }
  }
  return answers;
}

function saveAutomaticAnswer(key: string, value?: AutomaticAnswer): boolean {
  try {
    const answers = readAutomaticAnswers(window.localStorage.getItem(automaticAnswersStorageKey));
    if (value) answers.set(key, value);
    else answers.delete(key);
    window.localStorage.setItem(automaticAnswersStorageKey, JSON.stringify([...answers]));
    automaticAnswers.value = answers;
    return true;
  } catch {
    ElMessage.error("自动批准设置保存失败，请检查浏览器是否允许本地存储后重试");
    return false;
  }
}

try {
  automaticAnswers.value = readAutomaticAnswers(window.localStorage.getItem(automaticAnswersStorageKey));
} catch {
  ElMessage.error("无法读取自动批准设置，请检查浏览器本地存储");
}
window.addEventListener("storage", event => {
  if (event.key !== automaticAnswersStorageKey && event.key !== null) return;
  try {
    automaticAnswers.value = readAutomaticAnswers(event.newValue);
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
const rememberChoice = ref(false);
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
  if (!scope) return "";
  const fields = props.tool.question?.fields;
  if (fields?.length) {
    const choices = fields.filter(field => field.type === "radio" || field.type === "select");
    if (choices.length !== 1 || fields.some(field => field !== choices[0] && (field.required || !["input", "textarea"].includes(field.type)))) return "";
    return JSON.stringify([props.directory, scope, fields.map(({ field, title, type, required, options }) => ({ field, title, type, required, options }))]);
  }
  return options.value.length ? JSON.stringify([props.directory, scope, title.value, options.value]) : "";
});
const automaticAnswer = computed(() => automaticAnswers.value.get(approvalKey.value));
const autoApprove = computed({
  get: () => rememberChoice.value || !!automaticAnswer.value,
  set(value: boolean) {
    if (!value && !saveAutomaticAnswer(approvalKey.value)) return;
    rememberChoice.value = value;
  },
});
const statusText = computed(() => {
  if (props.tool.status === "error") return "待重新生成";
  if (skipped.value) return "已跳过";
  if (answer.value) return submittedAutomatically.value || toolResult.value?.autoApproved ? "已自动批准" : "已回答";
  if (props.tool.status === "interrupted") return "已停止";
  return waiting.value ? "等待回答" : "提问记录";
});

function reusableAnswer(values?: Record<string, unknown>): AutomaticAnswer | undefined {
  if (!approvalKey.value) return;
  if (!formRules.value.length) return options.value.includes(selected.value) && !text.value.trim() ? { answer: selected.value } : undefined;
  const fields = props.tool.question!.fields!;
  const choice = fields.find(field => field.type === "radio" || field.type === "select")!;
  const value = values?.[choice.field];
  if (typeof value !== "string" || !choice.options?.includes(value)
    || fields.some(field => field !== choice && typeof values?.[field.field] === "string" && String(values[field.field]).trim())) return;
  return { values: { [choice.field]: value } };
}

async function submitAnswer(skip: boolean, automatic = false) {
  const callId = props.tool.question?.callId;
  const value = draftAnswer.value;
  if (!waiting.value || submitting.value || (!props.toolSessionId && !props.directory) || !callId) return;
  if (!skip && !automatic && !formRules.value.length && (!value || value.length > 8000)) return;
  const key = approvalKey.value;
  const preset = automaticAnswer.value;
  if (automatic && !preset) return;
  submitting.value = true;
  try {
    if (!skip && !automatic && formRules.value.length && !(await formApi.value?.validate().catch(() => false))) return;
    const values = !skip && !automatic && formRules.value.length ? formApi.value!.formData() : undefined;
    const remembered = reusableAnswer(values);
    if (!skip && !automatic && rememberChoice.value && !remembered) throw new Error("自动批准需要选择一个选项，并将补充说明留空");
    const response = await axios.post(props.toolSessionId ? "/api/singleAgent/answer" : "/api/agent/answer", {
      ...(props.toolSessionId ? { sessionId: props.toolSessionId } : { directory: props.directory }),
      callId,
      ...(skip ? { skipped: true } : automatic ? { ...preset, autoApproved: true } : formRules.value.length ? { values } : { answer: value }),
    }, { headers: { "x-toonflow-workspace": "1" } });
    if (response.data.code !== 200) throw new Error(response.data.message || "提交回答失败");
    submittedAnswer.value = response.data.data.answer;
    submittedSkipped.value = response.data.data.skipped === true;
    submittedAutomatically.value = automatic;
    if (!skip && !automatic && rememberChoice.value && remembered) saveAutomaticAnswer(key, remembered);
    rememberChoice.value = false;
  } catch (error) {
    const message = axios.isAxiosError(error) ? error.response?.data?.message : undefined;
    ElMessage.error(message || (error instanceof Error ? error.message : "提交回答失败"));
  } finally {
    submitting.value = false;
  }
}

watch([waiting, approvalKey, automaticAnswer], () => {
  const callId = props.tool.question?.callId;
  if (!waiting.value || !automaticAnswer.value || !callId || automaticallySubmitted.has(callId)) return;
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
