<template>
  <el-dialog v-model="visible" title="获取智核模型" width="980px" alignCenter appendToBody :closeOnClickModal="false" :style="{ maxWidth: 'calc(100vw - 24px)' }">
    <div class="catalogTools"><el-radio-group v-model="type" :disabled="saving"><el-radio-button value="text">语言</el-radio-button><el-radio-button value="video">视频</el-radio-button><el-radio-button value="image">图片</el-radio-button><el-radio-button value="audio">音频</el-radio-button></el-radio-group><el-input v-model="search" placeholder="搜索名称或标签" clearable /><el-button :loading="loading" @click="load">刷新目录</el-button></div>
    <p>只获取当前分类；仅导入你勾选的模型。右侧查看标签、能力、当前 Key 可用性及实时价格。</p>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="catalogBody">
      <div v-loading="loading" class="catalogList">
        <div v-for="model in filtered" :key="model.id" class="catalogRow" :class="{ active: focused?.id === model.id }">
          <el-checkbox :modelValue="selected.includes(model.id)" :disabled="model.available === false || saving" :aria-label="`导入 ${model.label}`" @update:modelValue="value => toggle(model.id, !!value)" />
          <button class="modelChoice" @click="focused = model"><strong>{{ model.label }}</strong><span>{{ model.id }}</span><span class="rowTags">{{ (model.tags as string[] | undefined)?.join(' · ') }}</span><span>{{ model.available === false ? (model.languageProtocol === 'unsupported' ? '当前客户端未支持此协议' : '此 Key 未开通') : provider?.models.some(item => item.id === model.id) ? '已导入 · 查看价格' : '查看参数与价格' }}</span></button>
        </div>
      </div>
      <div class="catalogDetail"><mediaModelInfo v-if="focused" :key="focused.id" providerId="akc" :modelId="focused.id" @loaded="detail => { if (detail.id) details[detail.id] = detail; }" /><div v-else>选择左侧模型查看详情</div></div>
    </div>
    <template #footer><span>已勾选 {{ selected.length }} 个{{ typeLabel }}模型</span><el-button @click="visible = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!selected.length || loading" @click="save">导入勾选模型</el-button></template>
  </el-dialog>
</template>
<script setup lang="ts">
import axios from "axios";
import { computed, ref, watch } from "vue";
import { saveSettings, type CustomProvider } from "@/stores/settings";
import { invalidateNodeModels } from "@toonflow/nodes-scaffold/nodeAi";
import { ElMessage } from "element-plus";
import mediaModelInfo from "@toonflow/node-shared/mediaModelInfo";
import type { MediaProvider, MediaProviderModel } from "./types";
const visible = defineModel<boolean>({ default: false });
const props = defineProps<{ provider?: MediaProvider; initialType?: "text" | "image" | "video" | "audio" }>();
const emit = defineEmits<{ saved: [provider: MediaProvider] }>();
const type = ref<"text" | "video" | "image" | "audio">("video");
const typeLabel = computed(() => ({ text: "语言", video: "视频", image: "图片", audio: "音频" })[type.value]);
const models = ref<MediaProviderModel[]>([]);
const focused = ref<MediaProviderModel>();
const details = ref<Record<string, Record<string, unknown>>>({});
const selected = ref<string[]>([]);
const loading = ref(false); const saving = ref(false); const error = ref(""); const search = ref("");
const filtered = computed(() => models.value.filter(model => `${model.label} ${model.id} ${(model.tags as string[] | undefined)?.join(' ')}`.toLowerCase().includes(search.value.toLowerCase())));
let requestId = 0;
function toggle(id: string, value: boolean) { selected.value = value ? [...new Set([...selected.value, id])] : selected.value.filter(item => item !== id); }
async function load() {
  if (!props.provider || !visible.value) return;
  const current = ++requestId;
  loading.value = true; error.value = ""; models.value = []; focused.value = undefined; selected.value = [];
  try {
    const { data } = await axios.post("/api/providers/media/catalog", { fileName: props.provider.fileName, type: type.value }, { timeout: 65000 });
    if (data.code !== 200 || !Array.isArray(data.data)) throw new Error(data.message || "获取模型失败");
    if (current !== requestId) return;
    models.value = data.data.filter((model: MediaProviderModel) => model.type === type.value);
    focused.value = models.value.find(model => props.provider?.models.some(item => item.id === model.id)) ?? models.value[0];
  } catch (failure) { if (current === requestId) error.value = failure instanceof Error ? failure.message : "获取失败"; }
  finally { if (current === requestId) loading.value = false; }
}
async function save() {
  const provider = props.provider;
  if (!provider || saving.value) return;
  saving.value = true; error.value = "";
  try {
    if (type.value === "text") {
      const { data } = await axios.post("/api/providers/akc/import", { models: selected.value });
      if (data.code !== 200) throw new Error(data.message || "导入语言模型失败");
      await saveSettings(current => {
        const existing = Array.isArray(current.customProviders) ? [...current.customProviders] as CustomProvider[] : [];
        for (const imported of data.data.providers as CustomProvider[]) {
          const index = existing.findIndex(item => item.id === imported.id);
          const previous = index < 0 ? undefined : existing[index];
          const merged = { ...previous, ...imported, models: [...(previous?.models ?? []).filter(item => !imported.models.some(model => model.id === item.id)), ...imported.models] };
          if (index < 0) existing.push(merged); else existing[index] = merged;
        }
        return { customProviders: existing };
      });
      invalidateNodeModels("language"); emit("saved", provider); visible.value = false; ElMessage.success("语言模型已按协议导入"); return;
    }
    const additions = models.value.filter(model => selected.value.includes(model.id) && model.type === type.value && model.available !== false).map(model => {
      const { pricing: _pricing, fetchedAt: _fetchedAt, ...detail } = details.value[model.id] ?? {};
      return { ...model, ...detail, id: model.id, type: model.type };
    });
    const merged = [...provider.models.filter(model => !additions.some(item => item.id === model.id)), ...additions];
    const { data } = await axios.put("/api/providers/media/save", { fileName: provider.fileName, revision: provider.revision, models: merged });
    if (data.code !== 200) throw new Error(data.message || "导入失败");
    emit("saved", data.data); visible.value = false; ElMessage.success(`已导入 ${additions.length} 个${typeLabel.value}模型`);
  } catch (failure) { error.value = axios.isAxiosError(failure) ? failure.response?.data?.message || failure.message : failure instanceof Error ? failure.message : "导入失败"; }
  finally { saving.value = false; }
}
watch(visible, value => {
  if (!value) { ++requestId; return; }
  const requested = props.initialType ?? "video";
  if (type.value !== requested) type.value = requested; else void load();
});
watch(type, () => { selected.value = []; focused.value = undefined; if (visible.value) void load(); });
</script>
<style scoped lang="scss">
.catalogTools { display: flex; gap: 12px; align-items: center; .el-input { flex: 1; } }
.catalogBody { display: grid; grid-template-columns: 320px minmax(0, 1fr); gap: 20px; height: min(580px, 65vh); }
.catalogList, .catalogDetail { overflow: auto; min-width: 0; } .catalogList { border-right: 1px solid var(--el-border-color-lighter); padding-right: 12px; }
.catalogRow { display: flex; align-items: flex-start; gap: 8px; padding: 10px; border-radius: 8px; &.active { background: var(--el-color-primary-light-9); } }
.modelChoice { display: grid; gap: 4px; flex: 1; border: 0; background: transparent; text-align: left; color: var(--el-text-color-primary); cursor: pointer; overflow-wrap: anywhere; span { font-size: 12px; color: var(--el-text-color-secondary); } .rowTags { color: var(--el-color-primary); } }
@media (max-width: 700px) { .catalogBody { grid-template-columns: 1fr; height: auto; } .catalogList { max-height: 260px; } .catalogDetail { max-height: 350px; } .catalogTools { flex-wrap: wrap; } }
</style>
