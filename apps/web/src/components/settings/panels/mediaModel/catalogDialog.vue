<template>
  <el-dialog v-model="visible" class="modelCatalogDialog" width="1120px" alignCenter appendToBody :closeOnClickModal="false" :style="{ maxWidth: 'calc(100vw - 32px)' }">
    <template #header><div class="catalogHeader"><h2>获取智核模型</h2><span>按类别发现 · 按需导入</span></div></template>
    <div class="catalogTools">
      <el-radio-group v-model="type" :disabled="saving" aria-label="模型分类"><el-radio-button value="text">语言</el-radio-button><el-radio-button value="video">视频</el-radio-button><el-radio-button value="image">图片</el-radio-button><el-radio-button value="audio">音频</el-radio-button></el-radio-group>
      <el-input v-model="search" placeholder="搜索模型或能力标签" clearable aria-label="搜索模型或能力标签" />
      <el-button :loading="loading" :disabled="saving" @click="load">刷新目录</el-button>
    </div>
    <el-alert v-if="error" :title="error" type="error" :closable="false" />
    <div class="catalogBody">
      <section class="catalogSidebar" aria-label="模型列表">
        <div class="listHeader"><span>{{ typeLabel }}模型 <b>{{ models.length }}</b></span><span v-if="fetchedAt && !loading">{{ fetchedAt }} 更新</span></div>
        <div v-loading="loading" class="catalogList" :aria-busy="loading">
          <div v-for="model in filtered" :key="model.id" class="catalogRow" :class="{ active: focused?.id === model.id, unavailable: model.available === false }">
            <el-checkbox :modelValue="selected.includes(model.id)" :disabled="model.available === false || saving" :aria-label="`导入 ${model.label}`" @update:modelValue="value => toggle(model.id, !!value)" />
            <button class="modelChoice" :aria-current="focused?.id === model.id ? 'true' : undefined" @click="focused = model">
              <span class="modelTitle"><strong>{{ model.label }}</strong><span v-if="recommendation?.model.id === model.id" class="recommendBadge">推荐</span></span>
              <span class="modelId">{{ model.id }}</span>
              <span class="rowTags" :title="tags(model).join(' · ')">{{ tags(model).slice(0, 3).join(' · ') }}{{ tags(model).length > 3 ? ` +${tags(model).length - 3}` : '' }}</span>
              <span class="modelState">{{ model.available === false ? (model.languageProtocol === 'unsupported' ? '暂不支持此协议' : '此 Key 未开通') : imported(model) ? '已导入' : '可用' }}</span>
            </button>
          </div>
          <p v-if="!loading && !filtered.length && !error" class="listEmpty">{{ search ? '没有匹配的模型' : '此分类暂无模型' }}</p>
        </div>
      </section>
      <section class="catalogDetail" aria-label="模型详情与渠道价格">
        <div v-if="focused && recommendation?.model.id === focused.id" class="recommendation" role="note">
          <div class="recommendHeading"><strong>本次推荐</strong><span>面向短剧{{ { video: '镜头', image: '素材', text: '编剧', audio: '配音' }[type] }}</span></div>
          <p>当前 Key 可用。{{ recommendation.reasons.length ? recommendation.reasons.join('；') + '。' : '目录未提供足够的能力标签，优先展示当前可用模型供你比较。' }}</p>
          <small>依据本次目录标签推荐，未比较全部价格或实测效果；不会自动勾选。</small>
        </div>
        <mediaModelInfo v-if="focused" :key="focused.id" providerId="akc" :modelId="focused.id" expandedPricing @loaded="detail => { if (detail.id) details[detail.id] = detail; }" />
        <p v-else class="detailEmpty">{{ loading ? '正在获取模型目录…' : '选择左侧模型查看渠道价格' }}</p>
      </section>
    </div>
    <template #footer><div class="catalogFooter"><span>已选 <strong>{{ selected.length }}</strong> 个{{ typeLabel }}模型<small>仅导入勾选项</small></span><div><el-button :disabled="saving" @click="visible = false">取消</el-button><el-button type="primary" :loading="saving" :disabled="!selected.length || loading" @click="save">导入所选{{ selected.length ? `（${selected.length}）` : '' }}</el-button></div></div></template>
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
function tags(model: MediaProviderModel): string[] { return Array.isArray(model.tags) ? model.tags.filter((tag): tag is string => typeof tag === "string") : []; }
function imported(model: MediaProviderModel) { return props.provider?.models.some(item => item.id === model.id); }
const recommendation = computed(() => {
  // ACT: 仅按当前目录的 Key 可用性和短剧常用能力推荐，不推断质量排名或跨计费方式比较价格。
  const rules = {
    video: [
      { pattern: /参考生|多图参考|多模态参考/, weight: 5, reason: "支持参考素材，便于延续人物与场景" },
      { pattern: /首尾帧/, weight: 3, reason: "支持首尾帧，方便控制镜头衔接" },
      { pattern: /有声|自带音频/, weight: 3, reason: "可直接生成有声片段" },
      { pattern: /2k|4k/i, weight: 2, reason: "提供高清输出档位" },
    ],
    image: [
      { pattern: /多图参考|多参考|角色一致|人物一致/, weight: 5, reason: "支持多图参考或角色一致性能力" },
      { pattern: /图生图|参考图/, weight: 4, reason: "支持参考图，适合角色和场景迭代" },
      { pattern: /4k|高清/i, weight: 2, reason: "提供高清出图能力" },
      { pattern: /编辑|局部/, weight: 1, reason: "支持图片编辑，方便局部修改" },
    ],
    text: [
      { pattern: /长上下文/, weight: 5, reason: "支持长上下文，便于整理剧本与人物设定" },
      { pattern: /多轮对话/, weight: 3, reason: "支持多轮对话，适合反复调整分镜" },
      { pattern: /多模态/, weight: 2, reason: "支持多模态，便于结合参考素材讨论" },
      { pattern: /深度思考|推理/, weight: 1, reason: "提供推理能力，可用于梳理剧情逻辑" },
    ],
    audio: [
      { pattern: /文字转语音|语音合成|TTS/i, weight: 5, reason: "支持文字转语音，适合短剧配音" },
      { pattern: /多情感|情绪/, weight: 4, reason: "支持情感表达，便于调整对白演绎" },
      { pattern: /语音克隆|音色复刻/, weight: 3, reason: "支持音色复用，便于保持角色声音" },
      { pattern: /多音色|多语言/, weight: 2, reason: "提供多种音色或语言选择" },
    ],
  }[type.value];
  return models.value.filter(model => model.available !== false && model.languageProtocol !== "unsupported").map(model => {
    const content = tags(model).join(" ");
    const matches = rules.filter(rule => rule.pattern.test(content));
    return { model, score: matches.reduce((sum, rule) => sum + rule.weight, 0), reasons: matches.slice(0, 3).map(rule => rule.reason) };
  }).sort((a, b) => b.score - a.score || a.model.id.localeCompare(b.model.id))[0];
});
const filtered = computed(() => models.value.filter(model => `${model.label} ${model.id} ${tags(model).join(" ")}`.toLowerCase().includes(search.value.trim().toLowerCase())).sort((a, b) =>
  Number(b.id === recommendation.value?.model.id) - Number(a.id === recommendation.value?.model.id) || Number(a.available === false) - Number(b.available === false)));
const fetchedAt = ref("");
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
    focused.value = recommendation.value?.model ?? models.value[0];
    fetchedAt.value = new Date().toLocaleTimeString("zh-CN", { hour: "2-digit", minute: "2-digit" });
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
watch(type, () => { search.value = ""; selected.value = []; focused.value = undefined; if (visible.value) void load(); });
</script>
<style scoped lang="scss">
.catalogHeader { display: flex; align-items: baseline; gap: 14px; padding-right: 24px;
  h2 { margin: 0; font-size: 19px; font-weight: 650; letter-spacing: -.3px; }
  > span { font-size: 12px; color: var(--el-text-color-secondary); }
}
.catalogTools { display: flex; gap: 12px; align-items: center; padding: 8px 0 18px;
  .el-input { flex: 1; min-width: 140px; }
}
.catalogBody { display: grid; grid-template-columns: 290px minmax(0, 1fr); height: min(640px, 65vh); border-top: 1px solid var(--el-border-color-lighter); border-bottom: 1px solid var(--el-border-color-lighter);
  .catalogSidebar { display: flex; flex-direction: column; min-height: 0; border-right: 1px solid var(--el-border-color-lighter); padding: 0 12px 0 0;
    .listHeader { display: flex; justify-content: space-between; align-items: center; padding: 14px 8px 12px; font-size: 12px; color: var(--el-text-color-secondary);
      b { color: var(--el-text-color-regular); margin-left: 4px; font-variant-numeric: tabular-nums; }
    }
    .catalogList { overflow: auto; min-height: 0; flex: 1; padding-bottom: 10px;
      .catalogRow { display: flex; align-items: flex-start; gap: 8px; padding: 11px 10px; margin-bottom: 3px; border-radius: 7px; border: 1px solid transparent; transition: background .15s ease, border-color .15s ease;
        &:hover { background: var(--el-fill-color-light); }
        &.active { background: var(--el-color-primary-light-9); border-color: var(--el-color-primary-light-7); }
        &.unavailable .modelChoice { opacity: .6; }
        .el-checkbox { height: 22px; margin: 0; }
        .modelChoice { display: grid; gap: 5px; flex: 1; min-width: 0; padding: 0; border: 0; font: inherit; background: transparent; text-align: left; color: var(--el-text-color-primary); cursor: pointer;
          &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 3px; border-radius: 3px; }
          .modelTitle { display: flex; align-items: center; justify-content: space-between; gap: 6px; font-size: 13px; line-height: 1.5;
            strong { font-weight: 600; overflow-wrap: anywhere; }
            .recommendBadge { flex-shrink: 0; color: var(--el-color-primary); background: var(--el-color-primary-light-8); padding: 1px 5px; border-radius: 4px; font-size: 10px; font-weight: 600; }
          }
          .modelId { font-size: 11px; color: var(--el-text-color-placeholder); overflow: hidden; text-overflow: ellipsis; white-space: nowrap; }
          .rowTags { font-size: 11px; line-height: 1.5; color: var(--el-text-color-secondary); }
          .modelState { font-size: 10px; color: var(--el-text-color-secondary); }
        }
      }
      .listEmpty { color: var(--el-text-color-secondary); text-align: center; padding: 28px 8px; font-size: 12px; }
    }
  }
  .catalogDetail { overflow: auto; min-width: 0; padding: 18px 0 18px 22px;
    .recommendation { border-left: 3px solid var(--el-color-primary); padding: 1px 12px; margin-bottom: 18px;
      .recommendHeading { display: flex; align-items: center; gap: 10px; font-size: 12px;
        strong { color: var(--el-color-primary); } span { color: var(--el-text-color-secondary); font-size: 11px; }
      }
      p { margin: 7px 0 4px; font-size: 12px; line-height: 1.7; color: var(--el-text-color-regular); }
      small { font-size: 10px; color: var(--el-text-color-secondary); line-height: 1.5; }
    }
    .detailEmpty { padding: 30px; text-align: center; font-size: 12px; color: var(--el-text-color-secondary); }
  }
}
.catalogFooter { display: flex; justify-content: space-between; align-items: center; padding-top: 2px;
  > span { font-size: 12px; color: var(--el-text-color-regular); strong { color: var(--el-color-primary); } small { margin-left: 10px; color: var(--el-text-color-secondary); font-size: 11px; } }
}
@media (max-width: 760px) {
  .catalogHeader > span { display: none; }
  .catalogTools { flex-wrap: wrap; gap: 8px; .el-radio-group { width: 100%; } }
  .catalogBody { grid-template-columns: 1fr; height: min(650px, 65vh); grid-template-rows: 110px minmax(0, 1fr);
    .catalogSidebar { border-right: 0; border-bottom: 1px solid var(--el-border-color-lighter); padding-right: 0; .listHeader { padding: 8px; } }
    .catalogDetail { padding: 12px 0; .recommendation { margin-bottom: 12px; p { font-size: 11px; margin: 4px 0; } small { font-size: 9px; } } }
    .catalogSidebar .catalogList .catalogRow { padding: 8px 10px; .modelChoice { gap: 3px; .rowTags, .modelState { display: none; } } }
  }
  .catalogFooter > span small { display: none; }
}
@media (prefers-reduced-motion: reduce) { .catalogBody .catalogSidebar .catalogList .catalogRow { transition: none; } }
</style>
