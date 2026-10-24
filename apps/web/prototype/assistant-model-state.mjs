export function assistantModelState(health){
  const state=health.state||(health.warming?'warming':health.available?'ready':'unavailable');
  const labels={disabled:'未启用',unconfigured:'未配置',idle:'待连接',checking:'连接中',warming:'准备中',ready:'已就绪',unavailable:'暂不可用'};
  const hints={disabled:'智能模型未启用，基础仓储与操作指引照常使用。',unconfigured:'请管理员在管理设置中填写模型服务地址。',idle:'打开助手后自动连接，需要时加载模型。',checking:'正在检测模型服务，普通作业可继续使用。',warming:'模型正在加载，请稍候；普通作业可继续使用。',ready:'模型服务已连接，可以描述需求生成预览。',unavailable:health.error||'暂时无法连接模型，将自动重试；普通作业可继续使用。'};
  return {state,label:labels[state]||'暂不可用',hint:hints[state]||hints.unavailable};
}
