// 与空间接口一致；表单提交前校验，禁止把用户的非法输入静默替换为默认值。
export function rackInputError(value) {
  if(['w','h','d'].some(key=>!Number.isFinite(value[key])||value[key]<=0))return '宽、高、深必须是大于0的有效数值';
  if(['rows','cols'].some(key=>!Number.isInteger(value[key])||value[key]<1||value[key]>100))return '层列数须为1至100的整数';
  return '';
}
