import {capacityProducts,capacityProduct,productKey,capacityRule,skuCapacity,capacitySummary} from '../../../packages/three-kit/sku-capacity.mjs';

export function mountSkuCapacity(host,{changed,products=()=>[],canManage=()=>true}) {
  host.innerHTML=`<strong>SKU 容量</strong><label>容量对应货品<select aria-label="容量对应货品"></select></label>
    <label>计算方式<select aria-label="容量计算方式"><option value="auto">按包装尺寸估算</option><option value="manual">现场核定容量</option></select></label>
    <label>核定最大存放量<input aria-label="核定最大存放量" type="number" min="0" step="1" placeholder="例如：100"></label>
    <p class="muted" role="status"></p><small class="muted">标准按 SKU、库存单位和格位尺寸保存，换货品不会沿用其他 SKU 的标准。</small>`;
  host.style.cssText='display:grid;gap:8px;padding:12px;border:1px solid var(--border);border-radius:8px';
  const [picker,mode]=host.querySelectorAll('select'),input=host.querySelector('input'),message=host.querySelector('p');
  let entry={},choices=new Map(),dirty=false;
  const selected=()=>choices.get(picker.value);
  function describe() {
    const product=selected();
    input.disabled=!canManage() || mode.value!=='manual' || !product;
    input.parentElement.hidden=mode.value!=='manual';mode.disabled=!canManage() || !product;
    if(!product){message.textContent='选择容量对应的 SKU；未登记资料时可以先办理库存业务。';return;}
    const value=skuCapacity({items:entry.items,meta:entry.meta,dimensions:entry.dimensions,target:product});
    if(mode.value==='auto') {
      const automatic=skuCapacity({items:entry.items,meta:{...entry.meta,capacity_rules:[]},dimensions:entry.dimensions,target:product});
      message.textContent=capacitySummary(automatic)+(automatic.estimate?' · '+automatic.note+'，请核对现场净空。':'；可在“存放资料”登记包装尺寸，或选择现场核定。');
    } else message.textContent=`此标准仅适用于 ${product.sku || product.name}，单位：${product.unit}。`;
    if(capacityProducts(entry.items).length>1)message.textContent+=' 当前格位混放，总体满载率不计算。';
    if(entry.meta?.capacity!=null && value.capacity===null && !(entry.meta.capacity_rules || []).length)message.textContent+=` 旧参考容量 ${entry.meta.capacity} 尚未关联 SKU。`;
  }
  function selectProduct() {
    const rule=selected() && capacityRule(entry.meta || {},selected(),entry.dimensions);
    mode.value=rule?'manual':'auto';input.value=rule?.capacity ?? '';describe();
  }
  picker.onchange=()=>{selectProduct();dirty=true;changed();};
  mode.onchange=()=>{describe();dirty=true;changed();};
  input.oninput=()=>{dirty=true;changed();};
  return {
    fill(value) {
      entry=value || {};dirty=false;choices=new Map();
      for(const item of [...capacityProducts(entry.items),...(entry.meta?.capacity_rules || []).map(r=>r.product),...capacityProducts(products())]) {
        const product=capacityProduct(item);if(product&&(!choices.has(productKey(product)) || !choices.get(productKey(product)).storage_profile && product.storage_profile))choices.set(productKey(product),product);
      }
      picker.replaceChildren();
      for(const [key,product] of [['',null],...choices]) {
        const option=document.createElement('option');option.value=key;
        option.textContent=product?`${product.sku || product.name} · ${product.name} · ${product.unit}${product.source?' · '+product.source:''}`:'选择 SKU';picker.append(option);
      }
      const current=capacityProducts(entry.items);picker.value=current.length===1?productKey(current[0]):'';
      picker.disabled=!canManage();selectProduct();
    },
    change() {
      if(!dirty)return {};
      const product=selected();if(!product)throw Error('请选择容量对应的货品 SKU');
      const capacity=mode.value==='auto'?null:input.value===''?NaN:Number(input.value);
      if(capacity!==null && (!Number.isInteger(capacity)||capacity<0))throw Error('请填写此 SKU 的核定容量，须为非负整数');
      return {capacity_rule:{product,capacity}};
    }
  };
}
