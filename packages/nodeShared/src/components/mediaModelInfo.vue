<template>
  <div v-if="providerId === 'akc'" class="mediaModelInfo nodrag nopan nowheel" @pointerdown.stop @wheel.stop @keydown.stop>
    <div v-if="loading" role="status">正在查询模型参数与价格…</div>
    <div v-else-if="error" class="modelError">{{ error }} <el-button text size="small" @click="load">重新查询</el-button></div>
    <template v-else-if="detail">
      <div class="modelHeader"><div><img v-if="detail.icon" :src="detail.icon" alt="" /><strong>{{ detail.label }}</strong></div><el-tag size="small" :type="detail.available === false ? 'info' : 'success'">{{ detail.languageProtocol === 'unsupported' ? '暂不支持此协议' : detail.available === false ? '此 Key 未开通' : '此 Key 可用' }}</el-tag></div>
      <div class="modelTags"><span v-for="tag in detail.tags" :key="tag">{{ tag }}</span></div>
      <p v-if="detail.description" class="modelDescription" :title="detail.description">{{ detail.description }}</p>
      <div class="priceSummary"><div><span class="priceLabel">当前可用起价</span><strong>{{ startingPrice }}</strong></div><span class="priceUnit">单位：算力</span></div>
      <p class="priceHint">起价供比较，实际费用随档位、素材与渠道变化。</p>
      <details v-if="detail.pricing" class="channelSection" :open="expandedPricing">
        <summary>渠道价格 <span>{{ priceGroups.length }} 个渠道 · 可用优先</span></summary>
        <div class="priceTable" tabindex="0" aria-label="渠道价格表，可横向滚动">
          <table>
            <caption>当前模型各渠道的档位单价、Key 可用状态与限制</caption>
            <thead><tr><th scope="col">渠道</th><th scope="col">计费</th><th scope="col">档位 / 单价</th><th scope="col">补充费用与限制</th></tr></thead>
            <tbody>
              <tr v-for="group in priceGroups" :key="group.group_id" :class="{ unavailable: !usable(group) }">
                <th scope="row"><strong>{{ group.group_name }}</strong><span class="channelState" :class="{ usable: usable(group) }">{{ !group.is_active ? '暂未启用' : group.excluded_for_this_key || group.in_key_whitelist === false ? 'Key 不可用' : '可用' }}</span></th>
                <td class="billingCell">{{ group.billing_method }}</td>
                <td class="quoteCell"><div v-for="(price, index) in group.option_prices" :key="index" class="quoteRow"><span>{{ price.option_label || price.option_value || '默认' }}</span><strong>{{ group.billing_method === '按token' ? `入 ${price.final_input_token_price ?? group.input_token_price ?? '未知'} / 出 ${price.final_output_token_price ?? group.output_token_price ?? '未知'}` : price.final_price ?? '未知' }}</strong></div><div v-if="!group.option_prices?.length" class="quoteRow"><span>默认</span><strong>{{ group.billing_method === '按token' ? `入 ${group.input_token_price ?? '未知'} / 出 ${group.output_token_price ?? '未知'}` : group.min_price ?? '未知' }}</strong></div><small>{{ unit(group.billing_method) }}</small></td>
                <td class="limitCell"><div v-if="group.input_image_price">参考图超过 {{ group.input_image_free_count ?? 0 }} 张：{{ group.input_image_price }} 算力/张</div><div v-if="group.reference_video_billed_as_output">参考视频另按输出秒价计费</div><div v-else-if="group.reference_video_price_per_second">参考视频：{{ group.reference_video_price_per_second }} 算力/秒</div><div v-for="text in group.unsupported" :key="text">{{ text }}</div><span v-if="!group.input_image_price && !group.reference_video_billed_as_output && !group.reference_video_price_per_second && !group.unsupported?.length">—</span></td>
              </tr>
              <tr v-if="!priceGroups.length"><td colspan="4">暂无渠道报价</td></tr>
            </tbody>
          </table>
        </div>
        <p v-if="detail.pricing.key_channel_strategy" class="channelStrategy">渠道策略：{{ detail.pricing.key_channel_strategy }} · 平台自动派单</p>
        <details class="pricingNote"><summary>完整计费说明</summary><p class="fullNote">{{ detail.pricing.pricing_note }}</p></details>
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
type Detail = Pick<NodeMediaModel, "label" | "icon" | "description" | "tags" | "parameters" | "available"> & { languageProtocol?: string; id?: string; pricing?: { channel_groups?: PriceGroup[]; pricing_note?: string; key_channel_strategy?: string }; fetchedAt?: string };
const props = defineProps<{ providerId: string; modelId: string; editable?: boolean; disabled?: boolean; expandedPricing?: boolean }>();
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
function usable(group: PriceGroup) { return group.is_active && !group.excluded_for_this_key && group.in_key_whitelist !== false; }
const priceGroups = computed(() => [...(detail.value?.pricing?.channel_groups ?? [])].sort((a, b) => Number(usable(b)) - Number(usable(a))));
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
.mediaModelInfo { padding: 0; font-size: 12px; line-height: 1.6; color: var(--el-text-color-regular);
  .modelHeader { display: flex; align-items: center; justify-content: space-between; gap: 12px;
    > div { display: flex; align-items: center; gap: 8px; min-width: 0; }
    img { width: 22px; height: 22px; }
    strong { font-size: 17px; font-weight: 650; color: var(--el-text-color-primary); overflow-wrap: anywhere; }
    .el-tag { flex-shrink: 0; }
  }
  .modelTags { display: flex; flex-wrap: wrap; gap: 5px; margin-top: 10px;
    span { padding: 1px 6px; border-radius: 4px; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); font-size: 10px; }
  }
  p { margin: 9px 0; }
  .modelDescription { color: var(--el-text-color-secondary); font-size: 12px; display: -webkit-box; -webkit-line-clamp: 3; -webkit-box-orient: vertical; overflow: hidden; }
  .priceSummary { display: flex; align-items: flex-end; justify-content: space-between; gap: 10px; padding-top: 6px;
    > div { display: grid; gap: 3px; }
    .priceLabel, .priceUnit { font-size: 10px; color: var(--el-text-color-secondary); }
    strong { font-size: 18px; color: var(--el-text-color-primary); font-weight: 650; font-variant-numeric: tabular-nums; }
  }
  .priceHint { color: var(--el-text-color-secondary); font-size: 11px; }
  summary { cursor: pointer; padding: 6px 0; font-size: 12px; }
  .channelSection { margin-top: 18px;
    > summary { font-weight: 600; color: var(--el-text-color-primary); padding-bottom: 10px;
      span { font-size: 10px; font-weight: 400; color: var(--el-text-color-secondary); margin-left: 6px; }
    }
    .priceTable { overflow: auto; max-height: 440px; border: 1px solid var(--el-border-color-lighter); border-radius: 6px;
      &:focus-visible { outline: 2px solid var(--el-color-primary); outline-offset: 2px; }
      table { border-collapse: collapse; width: 100%; min-width: 530px; font-size: 11px;
        caption { position: absolute; width: 1px; height: 1px; padding: 0; overflow: hidden; clip-path: inset(50%); }
        th, td { border-bottom: 1px solid var(--el-border-color-lighter); padding: 10px; text-align: left; vertical-align: top; }
        thead th { position: sticky; top: 0; z-index: 1; background: var(--el-fill-color-light); color: var(--el-text-color-secondary); white-space: nowrap; font-weight: 500; }
        tbody { tr:last-child th, tr:last-child td { border-bottom: 0; }
          tr:hover { background: var(--el-fill-color-lighter); }
          th { width: 21%; font-weight: 500; strong { display: block; font-size: 11px; font-weight: 500; } }
          .channelState { display: inline-block; margin-top: 5px; font-size: 10px; color: var(--el-text-color-placeholder);
            &.usable { color: var(--el-color-success); }
          }
          .billingCell { white-space: nowrap; width: 10%; color: var(--el-text-color-secondary); }
          .quoteCell { width: 37%; font-variant-numeric: tabular-nums;
            .quoteRow { display: flex; justify-content: space-between; align-items: baseline; gap: 10px; margin-bottom: 5px;
              span { color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
              strong { white-space: nowrap; font-weight: 600; color: var(--el-text-color-primary); }
            }
            small { display: block; color: var(--el-text-color-placeholder); font-size: 9px; }
          }
          .limitCell { font-size: 10px; line-height: 1.7; color: var(--el-text-color-secondary); overflow-wrap: anywhere; }
          .unavailable { .quoteCell strong { color: var(--el-text-color-secondary); } th { color: var(--el-text-color-secondary); } }
        }
      }
    }
    .channelStrategy { font-size: 10px; color: var(--el-text-color-secondary); }
    .pricingNote > summary { font-size: 11px; color: var(--el-text-color-secondary); }
  }
  .fullNote { white-space: pre-wrap; color: var(--el-text-color-secondary); font-size: 11px; }
  .modelError { color: var(--el-color-danger); }
  @media (max-width: 760px) { .modelDescription { -webkit-line-clamp: 2; font-size: 11px; } .channelSection { margin-top: 12px; } }
  .parameterPanel { margin-top: 6px;
    .parameterRow { display: grid; gap: 4px; margin: 10px 0; }
    .parameterHint { color: var(--el-text-color-secondary); white-space: pre-wrap; }
  }
}
</style>
