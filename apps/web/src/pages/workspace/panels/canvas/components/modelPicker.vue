<template>
  <el-popover v-model:visible="visible" trigger="click" placement="bottom-end" :width="360" :showArrow="false" :popperStyle="{ maxWidth: 'calc(100vw - 24px)', padding: '20px' }">
    <template #reference>
      <el-button class="modelPickerTrigger" :aria-expanded="visible" aria-label="选择语言、图片和视频模型">
        <icon-adjustments-horizontal :size="17" />
        <span>模型选择</span>
        <icon-chevron-down :size="14" />
      </el-button>
    </template>
    <div class="modelPicker" @keydown.stop @keyup.stop>
      <div class="pickerHeading">当前可用模型</div>
      <p class="pickerHint">仅显示已配置 API Key 的模型</p>
      <el-form labelPosition="top" @submit.prevent>
        <el-form-item v-for="item in modelTypes" :key="item.type">
          <template #label>
            <span class="modelLabel"><component :is="item.icon" :size="16" />{{ item.label }}模型</span>
            <el-button link type="primary" size="small" @click="openCatalog(item.type)">获取智核{{ item.label }}模型</el-button>
            <span class="modelCount">{{ choices[item.type].length }} 个可选</span>
          </template>
          <el-select
            :modelValue="selectedModel(item.type)"
            :disabled="loading || !!saving || !choices[item.type].length"
            :loading="loading || saving === item.type"
            :teleported="false"
            filterable
            :placeholder="loading ? '读取模型中…' : '暂无已配置模型'"
            :aria-label="`默认${item.label}模型`"
            noDataText="请先在设置中配置供应商 API Key"
            @change="value => selectModel(item.type, value)">
            <el-option-group v-for="group in modelGroups(item.type)" :key="group.id" :label="group.label">
              <el-option v-for="model in group.models" :key="model.value" :label="model.label" :value="model.value" @click="selectedModel(item.type) === model.value && selectModel(item.type, model.value)" />
            </el-option-group>
          </el-select>
          <mediaModelInfo v-if="selectedChoice(item.type)?.providerId.startsWith('akc')" providerId="akc" :modelId="selectedChoice(item.type)!.modelId" />
        </el-form-item>
      </el-form>
      <p v-if="loadError" class="pickerError" role="alert">{{ loadError }} <el-button link type="primary" @click="loadModels">重试</el-button></p>
      <p class="pickerFooter">切换后自动保存，应用到当前对话和当前画布的同类生成节点；新建节点沿用此选择。进行中的任务不受影响。</p>
    </div>
  </el-popover>
  <catalogDialog v-model="catalogVisible" :provider="catalogProvider" :initialType="catalogType" @saved="catalogSaved" />
</template>

<script setup lang="ts">
import { computed, onMounted, onScopeDispose, ref, watch } from "vue";
import { useVueFlow } from "@vue-flow/core";
import { ElMessage } from "element-plus";
import axios from "axios";
import catalogDialog from "@/components/settings/panels/mediaModel/catalogDialog.vue";
import type { MediaProvider } from "@/components/settings/panels/mediaModel/types";
import mediaModelInfo from "@toonflow/node-shared/mediaModelInfo";
import { IconAdjustmentsHorizontal, IconChevronDown, IconMessage, IconPhoto, IconMovie } from "@tabler/icons-vue";
import { invalidateNodeModels, useNodeAi, type NodeMediaModel } from "@toonflow/nodes-scaffold/nodeAi";
import { configuredProviders, defaultModels, modelChoices, saveSettings, type ModelType } from "@/stores/settings";

const visible = ref(false);
const catalogVisible = ref(false);
const catalogProvider = ref<MediaProvider>();
const catalogType = ref<"text" | "image" | "video" | "audio">("video");
async function openCatalog(type: string) {
  try {
    const { data } = await axios.get("/api/providers/media/list");
    const provider = data.data?.find((item: MediaProvider) => item.id === "akc");
    if (!provider) throw new Error("请先在设置中添加智核供应商并填写 API Key");
    catalogProvider.value = provider; catalogType.value = type === "language" ? "text" : type as "image" | "video" | "audio";
    visible.value = false; catalogVisible.value = true;
  } catch (error) { ElMessage.error(error instanceof Error ? error.message : "读取供应商失败"); }
}
async function catalogSaved() { await loadModels(); }
function openCatalogEvent(event: Event) { void openCatalog((event as CustomEvent<{ type: string }>).detail.type); }
onMounted(() => window.addEventListener("toonflow:open-model-catalog", openCatalogEvent));
onScopeDispose(() => window.removeEventListener("toonflow:open-model-catalog", openCatalogEvent));
const loading = ref(false);
const saving = ref<ModelType>();
const loadError = ref("");
const mediaModels = ref<NodeMediaModel[]>([]);
const ai = useNodeAi();
const { getNodes, updateNodeData } = useVueFlow();
const modelTypes = [
  { type: "language", label: "语言", icon: IconMessage },
  { type: "image", label: "图片", icon: IconPhoto },
  { type: "video", label: "视频", icon: IconMovie },
] as const;
const choices = computed(() => {
  const mediaChoices = (type: "image" | "video") => mediaModels.value.filter(model => model.type === type).map(model => ({
    value: JSON.stringify([model.providerId, model.modelId]), providerId: model.providerId, providerLabel: model.providerLabel, label: model.label, modelId: model.modelId,
  }));
  return {
    language: modelChoices.value.map(model => ({ ...model, providerLabel: configuredProviders.value.find(provider => provider.id === model.providerId)?.label ?? model.providerId })),
    image: mediaChoices("image"),
    video: mediaChoices("video"),
  };
});

function modelGroups(type: ModelType) {
  return [...Map.groupBy(choices.value[type], model => model.providerId)].map(([id, models]) => ({ id, label: models[0]!.providerLabel, models }));
}

function selectedChoice(type: ModelType) { return choices.value[type].find(model => model.value === selectedModel(type)); }

function selectedModel(type: ModelType) {
  return choices.value[type].find(model => model.value === defaultModels.value[type])?.value ?? choices.value[type][0]?.value ?? "";
}

async function loadModels() {
  if (loading.value) return;
  loading.value = true;
  loadError.value = "";
  try {
    invalidateNodeModels("media");
    mediaModels.value = await ai.getMediaModels();
  } catch (error) {
    mediaModels.value = [];
    loadError.value = error instanceof Error ? error.message : "模型读取失败";
  } finally { loading.value = false; }
}

async function selectModel(type: ModelType, value: string) {
  if (saving.value || !choices.value[type].some(model => model.value === value)) return;
  const nodeType = { language: "remote-textNode", image: "remote-imageGenerationNode", video: "remote-videoGenerationNode" }[type];
  const nodes = getNodes.value.filter(node => node.type === nodeType);
  saving.value = type;
  try {
    await saveSettings(current => ({ defaultModels: { ...(current.defaultModels as object ?? {}), [type]: value } }));
    // ACT: 只更新当前画布同类节点的模型字段；生成请求已在发起时取得参数快照。
    for (const node of nodes) if (getNodes.value.includes(node)) updateNodeData(node.id, { model: value });
    ElMessage.success(`${modelTypes.find(item => item.type === type)!.label}模型已切换并保存`);
  } catch (error) {
    ElMessage.error(error instanceof Error ? error.message : "模型保存失败");
  } finally { saving.value = undefined; }
}

onMounted(loadModels);
watch(visible, value => { if (value) void loadModels(); });
</script>

<style scoped lang="scss">
.modelPickerTrigger {
  height: 38px;
  padding: 0 14px;
  background: var(--el-bg-color);
  border-radius: 12px;
  :deep(> span) { display: flex; align-items: center; gap: 8px; }
}
.modelPicker {
  .pickerHeading { color: var(--el-text-color-primary); font-size: 16px; font-weight: 600; }
  .pickerHint { margin: 6px 0 20px; color: var(--el-text-color-secondary); font-size: 12px; }
  .el-form-item {
    margin-bottom: 18px;
    :deep(.el-form-item__label) { display: flex; align-items: center; justify-content: space-between; width: 100%; }
    .modelLabel { display: inline-flex; align-items: center; gap: 6px; }
    .modelCount { color: var(--el-text-color-secondary); font-size: 12px; font-weight: normal; }
    .el-select { width: 100%; }
  }
  .pickerError { color: var(--el-color-danger); font-size: 12px; }
  .pickerFooter { margin: 0; padding-top: 14px; border-top: 1px solid var(--el-border-color-lighter); color: var(--el-text-color-secondary); font-size: 12px; line-height: 1.7; }
}
</style>
