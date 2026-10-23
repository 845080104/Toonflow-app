<template>
  <div v-if="providerId === 'akc'" class="mediaModelInfo nodrag nopan nowheel" @pointerdown.stop @wheel.stop @keydown.stop>
    <div v-if="loading" role="status">正在查询模型参数与价格…</div>
    <div v-else-if="error" class="modelError">{{ error }} <el-button text size="small" @click="load">重新查询</el-button></div>
    <template v-else-if="detail">
      <div class="modelHeader"><img v-if="detail.icon" :src="detail.icon" alt="" /><strong>{{ detail.label }}</strong><el-tag size="small" :type="detail.available === false ? 'danger' : 'success'">{{ detail.available === false ? '此 Key 未开通' : '此 Key 可用' }}</el-tag></div>
      <div class="modelTags"><el-tag v-for="tag in detail.tags" :key="tag" size="small" type="info">{{ tag }}</el-tag></div>
      <p v-if="detail.description">{{ detail.description }}</p>
      <div class="priceSummary"><strong>{{ startingPrice }}</strong><span>价格单位：算力</span></div>
      <p class="priceHint">起价仅作比较；分辨率、参考素材及密钥渠道策略会影响费用。实际扣费以任务记录为准。</p>
      <details v-if="detail.pricing">
        <summary>查看渠道、档位价格与限制</summary>
        <div class="priceTable">
          <table><thead><tr><th>渠道 / 状态</th><th>计费与起价</th><th>档位单价 / 限制</th></tr></thead>
            <tbody><tr v-for="group in detail.pricing.channel_groups" :key="group.group_id">
              <td>{{ group.group_name }}<br />{{ group.is_active ? '在线' : '暂未启用' }}{{ group.excluded_for_this_key || group.in_key_whitelist === false ? ' · 此 Key 不可用' : '' }}</td>
              <td>{{ group.billing_method }}<br />{{ groupPrice(group) }}</td>
              <td><div v-for="(price, index) in group.option_prices" :key="index">{{ price.option_label || price.option_value }}：{{ group.billing_method === '按token' ? `输入 ${price.final_input_token_price ?? group.input_token_price} / 输出 ${price.final_output_token_price ?? group.output_token_price} 算力/百万 token` : `${price.final_price ?? '未知'} ${unit(group.billing_method)}` }}</div>
                <div v-if="group.input_image_price">参考图：超过 {{ group.input_image_free_count ?? 0 }} 张后 {{ group.input_image_price }} 算力/张</div>
                <div v-if="group.reference_video_billed_as_output">参考视频另按输出档位的秒价计费</div>
                <div v-else-if="group.reference_video_price_per_second">参考视频：{{ group.reference_video_price_per_second }} 算力/秒</div>
                <div v-for="text in group.unsupported" :key="text">{{ text }}</div>
              </td>
            </tr></tbody>
          </table>
        </div>
        <p v-if="detail.pricing.key_channel_strategy">密钥渠道策略：{{ detail.pricing.key_channel_strategy }}；平台自动派单，不能在这里锁定某一渠道。</p>
        <details><summary>平台完整计费说明</summary><p class="fullNote">{{ detail.pricing.pricing_note }}</p></details>
      </details>
      <details v-if="editable && detail.parameters?.some(p => p.name !== 'prompt')" class="parameterPanel">
        <summary>模型参数{{ requiredNames ? ` · 请填写：${requiredNames}` : '（按需调整）' }}</summary>
        <p class="priceHint">留空沿用通用设置和节点引用；填写后覆盖对应参数。素材直链可逐行填写。</p>
        <div v-for="parameter in detail.parameters.filter(p => p.name !== 'prompt')" :key="parameter.name" class="parameterRow">
          <label :for="`${inputId}-${parameter.name}`">{{ parameter.label || parameter.name }}{{ parameter.required ? ' *' : '' }}</label>
          <el-select v-if="parameter.options?.length" :id="`${inputId}-${parameter.name}`" :modelValue="scalar(values[parameter.name])" :disabled="disabled" clearable :aria-label="parameter.label || parameter.name" @update:modelValue="value => change(parameter.name, value)">
            <el-option v-for="option in parameter.options" :key="String(option.value)" :label="option.label || String(option.value)" :value="option.value" :disabled="option.currently_unavailable" />
          </el-select>
          <el-input-number v-else-if="parameter.type === 'number'" :id="`${inputId}-${parameter.name}`" :modelValue="typeof values[parameter.name] === 'number' ? values[parameter.name] as number : undefined" :disabled="disabled" @update:modelValue="value => change(parameter.name, value)" />
          <el-switch v-else-if="parameter.type === 'switch'" :id="`${inputId}-${parameter.name}`" :modelValue="values[parameter.name] === true" :disabled="disabled" @update:modelValue="value => change(parameter.name, value)" />
          <el-input v-else :id="`${inputId}-${parameter.name}`" :modelValue="typeof values[parameter.name] === 'string' ? values[parameter.name] as string : ''" :type="['textarea', 'upload'].includes(parameter.type) ? 'textarea' : 'text'" :disabled="disabled" :placeholder="parameter.type === 'upload' ? '引用节点素材，或填写公网直链' : '留空沿用通用设置'" @update:modelValue="value => change(parameter.name, value)" />
          <span v-if="parameter.description" class="parameterHint">{{ parameter.description }}</span>
        </div>
      </details>
    </template>
  </div>
</template>
<script setup lang="ts">
import { computed, onScopeDispose, ref, watch } from "vue";
import { ElButton, ElTag, ElSelect, ElOption, ElInput, ElInputNumber, ElSwitch } from "element-plus";
import type { NodeMediaModel } from "@toonflow/nodes-scaffold/runtime";
type PriceGroup = { group_id: number; group_name: string; is_active: boolean; in_key_whitelist?: boolean; excluded_for_this_key?: boolean; billing_method: string; min_price?: number; base_price?: number; input_token_price?: number; output_token_price?: number; input_image_price?: number; input_image_free_count?: number; reference_video_billed_as_output?: boolean; reference_video_price_per_second?: number; unsupported?: string[]; option_prices?: { option_label?: string; option_value?: string; final_price?: number; final_input_token_price?: number; final_output_token_price?: number }[] };
type Detail = Pick<NodeMediaModel, "label" | "icon" | "description" | "tags" | "parameters" | "available"> & { id?: string; pricing?: { channel_groups?: PriceGroup[]; pricing_note?: string; key_channel_strategy?: string }; fetchedAt?: string };
const props = defineProps<{ providerId: string; modelId: string; editable?: boolean; disabled?: boolean }>();
const values = defineModel<Record<string, unknown>>({ default: () => ({}) });
const emit = defineEmits<{ loaded: [detail: Detail] }>();
const detail = ref<Detail>();
const loading = ref(false);
const error = ref("");
const inputId = `modelParams${Math.random().toString(36).slice(2)}`;
let requestId = 0;
onScopeDispose(() => { ++requestId; });
function scalar(value: unknown) { return typeof value === "string" || typeof value === "number" || typeof value === "boolean" ? value : undefined; }
function unit(method: string) { return method === "按秒" ? "算力/秒" : method === "按次" ? "算力/次" : "算力/百万 token"; }
function groupPrice(group: PriceGroup) { return group.billing_method === "按token" ? `输入 ${group.input_token_price ?? '未知'} / 输出 ${group.output_token_price ?? '未知'} 算力/百万 token` : `${group.min_price ?? '未知'} ${unit(group.billing_method)}起`; }
const startingPrice = computed(() => {
  const groups = detail.value?.pricing?.channel_groups?.filter(group => group.is_active && !group.excluded_for_this_key && group.in_key_whitelist !== false) ?? [];
  const methods = [...new Set(groups.map(group => group.billing_method))];
  return methods.map(method => {
    const eligible = groups.filter(group => group.billing_method === method);
    if (method === "按token") return "按 token 计费，见渠道详情";
    const prices = eligible.map(group => group.min_price).filter((price): price is number => typeof price === "number" && Number.isFinite(price));
    return prices.length ? `${Math.min(...prices)} ${unit(method)}起` : "价格未知";
  }).join(" · ") || "暂无当前 Key 可用渠道报价";
});
const requiredNames = computed(() => detail.value?.parameters?.filter(p => p.required && !['prompt', 'duration', 'resolution', 'size', 'images', 'image_url', 'aspect_ratio', 'format', 'sample_rate'].includes(p.name) && values.value[p.name] === undefined).map(p => p.label || p.name).join("、"));
function change(name: string, value: unknown) { values.value = { ...values.value, [name]: value === '' ? undefined : value }; }
async function load() {
  const current = ++requestId;
  if (props.providerId !== "akc" || !props.modelId) { detail.value = undefined; return; }
  loading.value = true; error.value = "";
  try {
    const response = await fetch("/api/providers/media/details", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ providerId: props.providerId, modelId: props.modelId }) });
    const result = await response.json();
    if (!response.ok || result.code !== 200) throw new Error(result.message || "模型价格查询失败");
    if (current !== requestId) return;
    detail.value = result.data; emit("loaded", result.data);
  } catch (failure) { if (current === requestId) error.value = failure instanceof Error ? failure.message : "查询失败"; }
  finally { if (current === requestId) loading.value = false; }
}
watch(() => [props.providerId, props.modelId], load, { immediate: true });
</script>
<style scoped lang="scss">
.mediaModelInfo { padding: 10px 0; font-size: 12px; line-height: 1.6; color: var(--el-text-color-regular);
  .modelHeader { display: flex; align-items: center; gap: 8px; } img { width: 22px; height: 22px; }
  .modelTags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 6px; }
  p { margin: 7px 0; } .priceSummary { display: flex; flex-wrap: wrap; gap: 10px; } .priceHint { color: var(--el-text-color-secondary); }
  summary { cursor: pointer; padding: 4px 0; } .priceTable { max-height: 280px; overflow: auto; }
  table { border-collapse: collapse; width: 100%; font-size: 12px; } th, td { border-bottom: 1px solid var(--el-border-color); padding: 6px; text-align: left; vertical-align: top; } th { white-space: nowrap; }
  .fullNote { white-space: pre-wrap; } .modelError { color: var(--el-color-danger); }
  .parameterPanel { margin-top: 6px; } .parameterRow { display: grid; gap: 4px; margin: 10px 0; } .parameterHint { color: var(--el-text-color-secondary); white-space: pre-wrap; }
}
</style>
